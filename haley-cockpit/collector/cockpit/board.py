# 路徑： collector\cockpit\board.py
# 把 Claude 與 Codex 的 session 收集結果、帳號用量合成一份總覽；狀態列（輕量）與 mod 面板（完整）共用。
import glob
import os
import time

from . import claude_sessions, codex_sessions, common, usage
from .winproc import Processes

STATE_ORDER = {"stalled": 0, "running": 1, "unknown": 2, "idle": 3}
TERMINALS_FRESH = 120  # 秒：VS Code 擴充每 30 秒重寫一次，超過這個時間的檔案視為視窗已關閉


def tz_offset():
    """本機時區相對 UTC 的秒數；mod 的執行環境不一定知道本機時區，時間由這裡換算好再交給它。"""
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone)


def terminal_names(now_ts):
    """VS Code 擴充寫的 terminals-<pid>.json（每個視窗一份）：shell pid → (終端機名稱, 在分頁清單的位置, 視窗名稱)。"""
    names = {}
    for path in glob.glob(os.path.join(common.TERMINALS_DIR, "terminals-*.json")):
        doc = common.read_json(path)
        if not isinstance(doc, dict) or now_ts - float(doc.get("at") or 0) > TERMINALS_FRESH:
            continue
        for t in doc.get("terminals") or []:
            if isinstance(t, dict) and t.get("pid"):
                names[int(t["pid"])] = (str(t.get("name") or ""), t.get("index"), doc.get("window") or "")
    return names


def attach_terminals(rows, names):
    """session 的程序鏈（自己 ← shell ← …）上只要有一個 pid 是某個終端機的 shell，就用那個終端機的名稱。"""
    for r in rows:
        for pid in r.get("pids") or []:
            hit = names.get(pid)
            if hit:
                r["terminal"], r["terminalIndex"], r["window"] = hit
                break


def attach_claude_ctx(rows):
    for r in rows:
        if r.get("tool") == "claude" and r.get("id"):
            doc = common.read_json(os.path.join(common.CTX_DIR, f"{r['id']}.json"))
            if isinstance(doc, dict) and doc.get("pct") is not None:
                r["ctx"] = {"pct": doc.get("pct"), "at": doc.get("at")}


def collect(detail=False, stall_override=None, with_sparks=False):
    now_ts = common.now()
    stall_min = common.stall_minutes(stall_override)
    stall_s = stall_min * 60
    procs = Processes()
    rows = claude_sessions.collect(procs, now_ts, stall_s, detail=detail)
    codex_rows, rates = codex_sessions.collect(procs, now_ts, stall_s, detail=detail)
    rows.extend(codex_rows)
    if rates:
        usage.record_codex(max(rates, key=lambda r: r[0]))
    elif not (common.read_json(usage.USAGE_PATH, {}) or {}).get("codex"):
        # 沒有存活的 Codex，快取也還沒有額度時才去翻最新的 rollout（比較慢，只做一次）
        usage.record_codex(codex_sessions.newest_rate())
    rows.sort(key=lambda r: (STATE_ORDER.get(r["state"], 2), r["tool"], r.get("project") or ""))
    attach_terminals(rows, terminal_names(now_ts))
    attach_claude_ctx(rows)
    snap = usage.snapshot(now_ts)
    usage.append_history(snap, now_ts)
    counts = {"running": 0, "idle": 0, "stalled": 0, "unknown": 0}
    for r in rows:
        counts[r["state"] if r["state"] in counts else "unknown"] += 1
    out = {"now": now_ts, "tzOffset": tz_offset(), "stallMinutes": stall_min, "sessions": rows, "counts": counts,
           "usage": snap}
    if with_sparks:
        primary = ((snap.get("codex") or {}).get("primary") or {})
        out["sparks"] = usage.sparks(now_ts, primary.get("windowMinutes"))
    return out
