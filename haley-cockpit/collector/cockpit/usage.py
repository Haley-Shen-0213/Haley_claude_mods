# 路徑： collector\cockpit\usage.py
# 帳號用量：Claude 的 5 小時／7 天由各 session 的狀態列寫進共用快取，Codex 取最新一次 rollout 額度回報；另存歷史樣本給 mod 畫走勢。
import json
import os
import re

from . import common

USAGE_PATH = os.path.join(common.DATA_DIR, "usage.json")
HISTORY_PATH = os.path.join(common.DATA_DIR, "usage_history.jsonl")
CLAUDE_WINDOWS = ("five_hour", "seven_day")
SAMPLE_EVERY = 120          # 秒：歷史樣本最密兩分鐘一筆
HISTORY_KEEP = 8 * 86400    # 秒：保留 8 天（7 天視窗再多一天）
HISTORY_MAX_BYTES = 2 * 1024 * 1024


OFFICIAL = "official"        # 官方 /usage：伺服器當下的數字，一律視為新回應
SOURCE_RE = re.compile(r"(sl|mod):[0-9A-Za-z-]{8,64}")


def record_claude(rate_limits, source=None):
    """狀態列收到的 rate_limits 是「該 session 最近一次 API 回應」的值；閒置 session 的值會過時，但狀態列仍會一直重畫、一直回報。
    合併規則（2026-11-16 Haley 裁定 D1A）：
    - 重置時間較新代表已進入新視窗，直接取代。
    - 有來源（sl:<session>＝狀態列、mod:<session>＝mod 面板、official＝官方 /usage）時，每個來源記住自己上次回報的值；
      值有變（或第一次回報）代表該來源剛收到伺服器的新回應，同一視窗內直接採用，比紀錄低也照用。
      Claude 用清除券後用量會變低、重置時間不變，靠這條才降得下來。
      值沒變的是閒置 session 的重畫，不採用，避免把舊的高數字拉回去。
    - 沒有來源（舊呼叫方式）時維持原規則：同一視窗內只增不減，取較大者。"""
    if not isinstance(rate_limits, dict):
        return
    if source is not None and source != OFFICIAL and not SOURCE_RE.fullmatch(str(source)):
        source = None
    store = common.read_json(USAGE_PATH, {}) or {}
    claude = store.get("claude") or {}
    sources = store.get("claudeSources") or {}
    now_ts = common.now()
    changed = False
    for kind in CLAUDE_WINDOWS:
        w = rate_limits.get(kind)
        if not isinstance(w, dict) or w.get("used_percentage") is None:
            continue
        try:
            new = {"used": float(w["used_percentage"]), "resetsAt": float(w.get("resets_at") or 0)}
        except (TypeError, ValueError):
            continue
        fresh = False
        if source == OFFICIAL:
            fresh = True
        elif source:
            last = (sources.get(source) or {}).get(kind)
            fresh = last != new
            if fresh:
                sources.setdefault(source, {})[kind] = new
                changed = True
        old = claude.get(kind)
        # 官方 /usage 的重置時間只精確到分鐘、狀態列給的是整點秒數，所以兩分鐘內都算同一個視窗
        newer_window = old is None or new["resetsAt"] > old.get("resetsAt", 0) + 120
        same_window = old is not None and abs(new["resetsAt"] - old.get("resetsAt", 0)) <= 120
        if source:
            take = newer_window or (same_window and fresh and new["used"] != old.get("used"))
        else:
            take = newer_window or (same_window and new["used"] > old.get("used", 0))
        if take:
            claude[kind] = {**new, "seenAt": now_ts}
            changed = True
    # 來源記錄裡的視窗都已過重置時間就刪掉：那個 session 之後再回報舊視窗，也會被「較舊視窗不採用」擋下
    for sid in list(sources):
        if all((v or {}).get("resetsAt", 0) < now_ts for v in sources[sid].values()):
            del sources[sid]
            changed = True
    if changed:
        store["claude"] = claude
        store["claudeSources"] = sources
        common.write_json_atomic(USAGE_PATH, store)


def record_session_ctx(data):
    """狀態列收到的本 session context 比例與花費，寫成 ctx\\<session_id>.json 給總覽與 VS Code 面板用。
    context 視窗大小只有 Claude Code 自己知道（依模型而異），所以由各 session 的狀態列回報，不在收集端推算。"""
    sid = str(data.get("session_id") or "")
    ctx = data.get("context_window") or {}
    pct = ctx.get("used_percentage")
    if not re.fullmatch(r"[0-9A-Za-z-]{8,64}", sid) or pct is None:
        return
    path = os.path.join(common.CTX_DIR, f"{sid}.json")
    new = {"pct": float(pct), "size": ctx.get("context_window_size"),
           "cost": (data.get("cost") or {}).get("total_cost_usd"), "model": (data.get("model") or {}).get("id")}
    old = common.read_json(path) or {}
    if any(old.get(k) != v for k, v in new.items()):
        common.write_json_atomic(path, {**new, "at": common.now()})


def record_usage_text(parsed, now_ts):
    """官方 /usage 的解析結果（見 usage_fetch.py）：模型專屬額度寫進 claudeUsage；
    5 小時與 7 天是伺服器現在的數字，比各 session 最近一次回應時的值新，一併併入原本的合併規則。"""
    store = common.read_json(USAGE_PATH, {}) or {}
    cu = store.get("claudeUsage") or {}
    cu.update({"seenAt": now_ts, "models": parsed.get("models") or {}})
    store["claudeUsage"] = cu
    common.write_json_atomic(USAGE_PATH, store)
    windows = {}
    for kind in CLAUDE_WINDOWS:
        w = parsed.get(kind)
        if w and w.get("resetsAt"):
            windows[kind] = {"used_percentage": w["used"], "resets_at": w["resetsAt"]}
    record_claude(windows, OFFICIAL)


def mark_usage_try(now_ts):
    """記下最近一次嘗試重抓的時間：抓失敗時也要等一個間隔才重試，不會每次狀態列更新都去敲一次。"""
    store = common.read_json(USAGE_PATH, {}) or {}
    cu = store.get("claudeUsage") or {}
    cu["tryAt"] = now_ts
    store["claudeUsage"] = cu
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


def codex_scan_due(now_ts, every):
    """距離上次翻 rollout 超過 every 秒才回 True，並記下這次的時間（多個狀態列同時跑時，最多一個去翻）。"""
    store = common.read_json(USAGE_PATH, {}) or {}
    if now_ts - (store.get("codexScanAt") or 0) < every:
        return False
    store["codexScanAt"] = now_ts
    common.write_json_atomic(USAGE_PATH, store)
    return True


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
    # 模型專屬的每週額度（例如 Fable），來自官方 /usage 的背景查詢；還沒查過就是空清單
    cu = store.get("claudeUsage") or {}
    out["claude"]["models"] = []
    for label, w in (cu.get("models") or {}).items():
        reset = w.get("resetsAt") or 0
        out["claude"]["models"].append({"label": label, "used": None if reset and reset < now_ts else w.get("used"),
                                        "resetsAt": reset, "seenAt": cu.get("seenAt")})
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
