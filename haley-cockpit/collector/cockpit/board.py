# 路徑： collector\cockpit\board.py
# 把 Claude 與 Codex 的 session 收集結果、帳號用量合成一份總覽；狀態列（輕量）與 mod 面板（完整）共用。
import glob
import os
import time

from . import claude_sessions, codex_sessions, common, usage, usage_fetch
from .winproc import Processes

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
    """Claude 的 context 比例。官方狀態列對閒置的 session 常回報 0%（實測：花費上百美元的 session 也是 0%），
    所以以紀錄檔最後一次請求的輸入 token 數為準，除以狀態列回報的視窗大小（只有 Claude Code 知道，依模型而異）；
    紀錄檔沒有數字時（例如剛壓縮完），只有執行中的 session 才採用狀態列的即時值，閒置的不顯示。"""
    for r in rows:
        tokens = r.pop("ctxTokens", None)
        if r.get("tool") != "claude" or not r.get("id"):
            continue
        doc = common.read_json(os.path.join(common.CTX_DIR, f"{r['id']}.json"))
        doc = doc if isinstance(doc, dict) else {}
        size = doc.get("size")
        if tokens and size:
            r["ctx"] = {"pct": round(min(100.0, 100.0 * tokens / size), 1), "at": r.get("lastActivity"),
                        "tokens": tokens, "size": size}
        elif doc.get("pct") is not None and r.get("state") in ("running", "stalled"):
            r["ctx"] = {"pct": doc.get("pct"), "at": doc.get("at")}


def tab_titles(r):
    """終端機分頁可能顯示的名稱，給切換程式比對。Claude：標題（還沒有任何對話時沒有標題，分頁固定叫 Claude Code）；
    Codex：thread 名稱，分頁上可能後面再接「 | 專案」。"""
    title = (r.get("title") or "").strip()
    if r.get("tool") == "codex":
        return [t for t in (title, f"{title} | {r.get('project') or ''}".strip(" |") if title else "") if t]
    if title and title != (r.get("slug") or ""):
        return [title]
    return ["Claude Code"]


def number_rows(rows):
    """編號依 session 啟動時間排（同時啟動時依程序編號），固定不變：/go 編號、狀態列清單、各面板用同一套號碼，
    不會因為狀態改變而跳號；有 session 結束時，排在它後面的編號才會往前補。就地排序並回傳同一個清單。"""
    rows.sort(key=lambda r: (r.get("startedAt") or 0, r["pid"]))
    for no, r in enumerate(rows, 1):
        r["no"] = no
        r["tabTitles"] = tab_titles(r)
    return rows


def split_non_terminal(rows):
    """登記檔的 entrypoint 不是 cli 的 session（例如 VS Code 的 Claude 面板在背景開的）不在任何終端機裡，
    點了也切不過去：不列進總覽、不算進 session 數，另外回傳給需要的介面。"""
    keep, others = [], []
    for r in rows:
        (others if r.get("entrypoint") not in (None, "cli") else keep).append(r)
    return keep, others


def collect(detail=False, stall_override=None, with_sparks=False, refresh_usage=False):
    now_ts = common.now()
    if refresh_usage:
        usage_fetch.maybe_spawn(now_ts)  # 模型專屬額度太舊時，在背景重抓；這一輪先用現有快取
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
    attach_terminals(rows, terminal_names(now_ts))
    attach_claude_ctx(rows)
    rows, others = split_non_terminal(rows)
    number_rows(rows)
    snap = usage.snapshot(now_ts)
    usage.append_history(snap, now_ts)
    counts = {"running": 0, "idle": 0, "stalled": 0, "unknown": 0}
    for r in rows:
        counts[r["state"] if r["state"] in counts else "unknown"] += 1
    out = {"now": now_ts, "tzOffset": tz_offset(), "stallMinutes": stall_min, "sessions": rows, "counts": counts,
           "others": [{k: r.get(k) for k in ("tool", "pid", "entrypoint", "state", "project")} for r in others],
           "usage": snap}
    if with_sparks:
        primary = ((snap.get("codex") or {}).get("primary") or {})
        out["sparks"] = usage.sparks(now_ts, primary.get("windowMinutes"))
    return out
