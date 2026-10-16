# 路徑： collector\cockpit\usage.py
# 帳號用量：Claude 的 5 小時／7 天由各 session 的狀態列寫進共用快取，Codex 取最新一次 rollout 額度回報；另存歷史樣本給 mod 畫走勢。
import json
import os

from . import common

USAGE_PATH = os.path.join(common.DATA_DIR, "usage.json")
HISTORY_PATH = os.path.join(common.DATA_DIR, "usage_history.jsonl")
CLAUDE_WINDOWS = ("five_hour", "seven_day")
SAMPLE_EVERY = 120          # 秒：歷史樣本最密兩分鐘一筆
HISTORY_KEEP = 8 * 86400    # 秒：保留 8 天（7 天視窗再多一天）
HISTORY_MAX_BYTES = 2 * 1024 * 1024


def record_claude(rate_limits):
    """狀態列收到的 rate_limits 是「該 session 最近一次 API 回應」的值；閒置 session 的值會過時。
    合併規則：重置時間較新代表已進入新視窗，直接取代；同一視窗內用量只增不減，取較大者。這樣任何一個 session 有新回應，大家都看得到最新值。"""
    if not isinstance(rate_limits, dict):
        return
    store = common.read_json(USAGE_PATH, {}) or {}
    claude = store.get("claude") or {}
    changed = False
    for kind in CLAUDE_WINDOWS:
        w = rate_limits.get(kind)
        if not isinstance(w, dict) or w.get("used_percentage") is None:
            continue
        try:
            new = {"used": float(w["used_percentage"]), "resetsAt": float(w.get("resets_at") or 0)}
        except (TypeError, ValueError):
            continue
        old = claude.get(kind)
        newer_window = old is None or new["resetsAt"] > old.get("resetsAt", 0) + 60
        same_window = old is not None and abs(new["resetsAt"] - old.get("resetsAt", 0)) <= 60
        if newer_window or (same_window and new["used"] > old.get("used", 0)):
            claude[kind] = {**new, "seenAt": common.now()}
            changed = True
    if changed:
        store["claude"] = claude
        common.write_json_atomic(USAGE_PATH, store)


def record_codex(found):
    """found：(事件時間, rate_limits)；比快取裡的新才寫。"""
    if not found:
        return
    ts, rate = found
    store = common.read_json(USAGE_PATH, {}) or {}
    old = store.get("codex") or {}
    if ts and ts > (old.get("ts") or 0):
        store["codex"] = {"ts": ts, "rate": rate}
        common.write_json_atomic(USAGE_PATH, store)


def _codex_window(w, now_ts):
    if not isinstance(w, dict) or w.get("used_percent") is None:
        return None
    resets = w.get("resets_at")
    used = float(w["used_percent"])
    return {"used": None if resets and resets < now_ts else used, "resetsAt": resets,
            "windowMinutes": w.get("window_minutes")}


def snapshot(now_ts):
    """目前的帳號用量。重置時間已過的視窗用量未知（下一次 API 回應才知道），used 回傳 None。"""
    store = common.read_json(USAGE_PATH, {}) or {}
    out = {"claude": {}, "codex": None}
    for kind in CLAUDE_WINDOWS:
        w = (store.get("claude") or {}).get(kind)
        if w:
            reset = w.get("resetsAt") or 0
            out["claude"][kind] = {"used": None if reset and reset < now_ts else w.get("used"), "resetsAt": reset,
                                   "seenAt": w.get("seenAt")}
    codex = store.get("codex")
    if codex and isinstance(codex.get("rate"), dict):
        rate = codex["rate"]
        out["codex"] = {"primary": _codex_window(rate.get("primary"), now_ts),
                        "secondary": _codex_window(rate.get("secondary"), now_ts),
                        "plan": rate.get("plan_type"), "ts": codex.get("ts")}
    return out


def _sample(snap):
    c = snap.get("claude") or {}
    x = snap.get("codex") or {}
    return {"c5": (c.get("five_hour") or {}).get("used"), "c7": (c.get("seven_day") or {}).get("used"),
            "x1": (x.get("primary") or {}).get("used"), "x2": (x.get("secondary") or {}).get("used")}


def append_history(snap, now_ts):
    sample = _sample(snap)
    if all(v is None for v in sample.values()):
        return
    _, lines = common.read_tail_lines(HISTORY_PATH, 4096)
    last = common.loads(lines[-1]) if lines else None
    if last:
        same = all(abs((last.get(k) or 0) - (v or 0)) < 0.5 for k, v in sample.items())
        if same and now_ts - (last.get("t") or 0) < SAMPLE_EVERY:
            return
    os.makedirs(common.DATA_DIR, exist_ok=True)
    try:
        with open(HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": int(now_ts), **sample}) + "\n")
        if os.path.getsize(HISTORY_PATH) > HISTORY_MAX_BYTES:
            keep = read_history(now_ts - HISTORY_KEEP)
            tmp = HISTORY_PATH + f".{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(json.dumps(r) + "\n" for r in keep)
            os.replace(tmp, HISTORY_PATH)
    except OSError:
        pass


def sparks(now_ts, codex_minutes=None):
    """把歷史樣本切成固定格數、每格取最大值，給 mod 畫走勢；在這裡先切好，mod 每 5 秒拿到的只有幾十個數字。
    Claude 5 小時：20 格（每格 15 分）；Claude 7 天與 Codex：28 格（每格 6 小時，Codex 視窗不是 7 天時依視窗長度切）。"""
    plans = {"c5": (5 * 3600, 20), "c7": (7 * 86400, 28), "x1": ((codex_minutes or 10080) * 60, 28)}
    since = now_ts - max(span for span, _ in plans.values())
    rows = read_history(since)
    out = {}
    for key, (span, cells) in plans.items():
        step = span / cells
        buckets = [None] * cells
        for r in rows:
            v = r.get(key)
            age = now_ts - (r.get("t") or 0)
            if v is None or age < 0 or age >= span:
                continue
            i = cells - 1 - int(age // step)
            buckets[i] = v if buckets[i] is None else max(buckets[i], v)
        out[key] = buckets
    return out


def read_history(since_ts):
    out = []
    try:
        with open(HISTORY_PATH, encoding="utf-8") as f:
            for line in f:
                o = common.loads(line)
                if o and (o.get("t") or 0) >= since_ts:
                    out.append(o)
    except OSError:
        pass
    return out
