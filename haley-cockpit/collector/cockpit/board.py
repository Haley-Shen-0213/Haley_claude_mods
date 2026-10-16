# 路徑： collector\cockpit\board.py
# 把 Claude 與 Codex 的 session 收集結果、帳號用量合成一份總覽；狀態列（輕量）與 mod 面板（完整）共用。
import time

from . import claude_sessions, codex_sessions, common, usage
from .winproc import Processes


def tz_offset():
    """本機時區相對 UTC 的秒數；mod 的執行環境不一定知道本機時區，時間由這裡換算好再交給它。"""
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone)

STATE_ORDER = {"stalled": 0, "running": 1, "unknown": 2, "idle": 3}


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
