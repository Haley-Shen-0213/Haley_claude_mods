# 路徑： collector\cockpit\codex_sessions.py
# Codex session 收集：找出終端機裡的 codex.exe，以「程序啟動時間 ≈ rollout 檔名時間」對應主執行緒的 rollout，
# 讀事件判斷執行中或閒置（任務開始／完成）、token 與額度、計畫步驟；標題取自 ~\.codex\session_index.jsonl。
import glob
import json
import os
import re
import time

from . import common

SESSIONS_DIR = os.path.join(common.CODEX_DIR, "sessions")
INDEX_PATH = os.path.join(common.CODEX_DIR, "session_index.jsonl")
CACHE_VERSION = 2  # 2：快取多存 context 比例，舊快取重新解析一次
# 實測（2026-10-16）：codex.exe 啟動與主執行緒 rollout 檔名時間相差 1 秒內；審查子代理的 rollout 晚 1 秒建立，要靠 session_meta 排除
MATCH_WINDOW = 15
SHELLS = {"powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "wsl.exe", "nu.exe"}
_NAME = re.compile(r"^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f-]{36})\.jsonl$")
_TURN_EVENTS = {"task_started", "task_complete", "turn_aborted"}


def cli_processes(procs):
    """終端機裡的 Codex CLI：codex.exe 且祖先鏈上有 shell；ChatGPT 桌面 App 底下的 codex.exe 與父程序已結束的孤兒程序不算。"""
    out = []
    for pid in procs.find("codex.exe"):
        chain = procs.chain(pid)
        exes = [(procs.exe(p) or "").lower() for p in chain[1:]]
        if "chatgpt.exe" in exes or not SHELLS.intersection(exes):
            continue
        out.append((pid, chain))
    return out


def _name_time(path):
    m = _NAME.match(os.path.basename(path))
    if not m:
        return None, None
    y, mo, d, h, mi, s, tid = m.groups()
    # 檔名是本機時間
    return time.mktime((int(y), int(mo), int(d), int(h), int(mi), int(s), 0, 0, -1)), tid


def _first_line(path, cap=4 * 1024 * 1024):
    try:
        with open(path, "rb") as f:
            data = f.read(64 * 1024)
            while b"\n" not in data and len(data) < cap:
                more = f.read(256 * 1024)
                if not more:
                    break
                data += more
    except OSError:
        return None
    return common.loads(data.split(b"\n", 1)[0])


def _meta(path):
    o = _first_line(path)
    if not o or o.get("type") != "session_meta":
        return None
    p = o.get("payload") or {}
    src = p.get("source")
    return {"id": p.get("id"), "sessionId": p.get("session_id"), "threadSource": p.get("thread_source"),
            "source": src if isinstance(src, str) else "subagent", "cwd": p.get("cwd"),
            "startedAt": common.iso_to_epoch(p.get("timestamp")), "cliVersion": p.get("cli_version"),
            "parent": p.get("parent_thread_id")}


def _is_main(meta):
    return bool(meta) and (meta.get("threadSource") == "user" or (not meta.get("parent") and meta.get("source") != "subagent"))


def rollout_for(created_epoch):
    """依程序啟動時間到當天（與前後一天，跨午夜用）的資料夾找主執行緒 rollout。"""
    best = None
    for delta in (0, -86400, 86400):
        t = time.localtime(created_epoch + delta)
        folder = os.path.join(SESSIONS_DIR, f"{t.tm_year:04d}", f"{t.tm_mon:02d}", f"{t.tm_mday:02d}")
        for path in glob.glob(os.path.join(folder, "rollout-*.jsonl")):
            ft, _ = _name_time(path)
            if ft is None or abs(ft - created_epoch) > MATCH_WINDOW:
                continue
            meta = _meta(path)
            if _is_main(meta) and (best is None or abs(ft - created_epoch) < best[0]):
                best = (abs(ft - created_epoch), path, meta)
    return (best[1], best[2]) if best else (None, None)


def thread_names():
    names = {}
    _, lines = common.read_tail_lines(INDEX_PATH, 2 * 1024 * 1024)
    for raw in lines:
        o = common.loads(raw)
        if o and o.get("id"):
            names[o["id"]] = o.get("thread_name") or ""
    return names


def _new_state(path):
    return {"v": CACHE_VERSION, "path": path, "offset": 0, "lastTs": None, "running": False, "turnStart": None,
            "turns": 0, "aborted": False, "plan": None, "planStart": None, "rate": None, "rateTs": None,
            "tokens": None, "lastErr": False, "model": None, "ctx": None, "ctxTs": None}


def _ctx_pct(info):
    """context 比例＝最近一次請求的 token 數 ÷ 模型的 context 視窗（token_count 事件的 info 兩個欄位）。"""
    last = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}
    window = info.get("model_context_window")
    total = last.get("total_tokens")
    if not window or total is None:
        return None
    return round(min(100.0, 100.0 * float(total) / float(window)), 1)


def _set_plan(st, plan, ts):
    items = [{"c": str(i.get("step", "")), "s": str(i.get("status", ""))} for i in (plan or []) if isinstance(i, dict)]
    if not (st["plan"] and any(i["s"] != "completed" for i in st["plan"])):
        st["planStart"] = ts
    st["plan"] = items or None


def _feed(st, o):
    ts = common.iso_to_epoch(o.get("timestamp"))
    if ts and (st["lastTs"] is None or ts > st["lastTs"]):
        st["lastTs"] = ts
    kind = o.get("type")
    p = o.get("payload") if isinstance(o.get("payload"), dict) else {}
    if kind == "turn_context":
        st["model"] = p.get("model") or st["model"]
    elif kind == "event_msg":
        pt = p.get("type")
        if pt == "task_started":
            st["running"], st["turnStart"], st["aborted"], st["lastErr"] = True, ts, False, False
            st["turns"] += 1
        elif pt in ("task_complete", "turn_aborted"):
            st["running"] = False
            st["aborted"] = pt == "turn_aborted"
        elif pt == "token_count":
            if isinstance(p.get("rate_limits"), dict):
                st["rate"], st["rateTs"] = p["rate_limits"], ts
            info = p.get("info") if isinstance(p.get("info"), dict) else {}
            if isinstance(info.get("total_token_usage"), dict):
                st["tokens"] = info["total_token_usage"]
            pct = _ctx_pct(info)
            if pct is not None:
                st["ctx"], st["ctxTs"] = pct, ts
        elif pt in ("error", "stream_error"):
            st["lastErr"] = True
        elif pt == "plan_update":
            _set_plan(st, p.get("plan"), ts)
    elif kind == "response_item" and p.get("type") == "function_call" and p.get("name") == "update_plan":
        try:
            args = json.loads(p.get("arguments") or "{}")
        except ValueError:
            args = {}
        _set_plan(st, args.get("plan"), ts)


def analyze(path):
    tid = _name_time(path)[1] or os.path.basename(path)
    cache_path = os.path.join(common.CACHE_DIR, f"codex-{tid}.json")
    st = common.read_json(cache_path)
    if not isinstance(st, dict) or st.get("v") != CACHE_VERSION or st.get("path") != path:
        st = _new_state(path)
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size < st["offset"]:
                st = _new_state(path)
            f.seek(st["offset"])
            data = f.read(max(0, size - st["offset"]))
    except OSError:
        return st
    end = data.rfind(b"\n")
    data = data[:end + 1] if end >= 0 else b""
    if data:
        for raw in data.split(b"\n"):
            if raw.strip():
                o = common.loads(raw)
                if o:
                    _feed(st, o)
        st["offset"] += len(data)
        common.write_json_atomic(cache_path, st)
    return st


def tail_state(path):
    """只讀檔尾判斷是否在任務中（狀態列用）。檔尾找不到任務事件時（一個很長的任務），以最後事件時間判斷。"""
    _, lines = common.read_tail_lines(path, 256 * 1024)
    last_ts = None
    running = None
    rate = rate_ts = None
    for raw in lines:
        o = common.loads(raw)
        if not o:
            continue
        ts = common.iso_to_epoch(o.get("timestamp"))
        if ts and (last_ts is None or ts > last_ts):
            last_ts = ts
        p = o.get("payload") if isinstance(o.get("payload"), dict) else {}
        if o.get("type") == "event_msg":
            if p.get("type") in _TURN_EVENTS:
                running = p.get("type") == "task_started"
            elif p.get("type") == "token_count" and isinstance(p.get("rate_limits"), dict):
                rate, rate_ts = p["rate_limits"], ts
    return {"lastTs": last_ts, "running": running, "rate": rate, "rateTs": rate_ts}


def _plan_view(st, now_ts):
    items = st.get("plan") or []
    if not items:
        return None
    done = sum(1 for i in items if i.get("s") == "completed")
    total = len(items)
    current = next((i.get("c") for i in items if i.get("s") == "in_progress"), None)
    eta = None
    if st.get("planStart") and 0 < done < total:
        eta = max(0.0, (now_ts - st["planStart"]) / done * (total - done))
    return {"done": done, "total": total, "current": current, "startedAt": st.get("planStart"), "eta": eta}


def collect(procs, now_ts, stall_s, detail=False):
    rows = []
    rates = []
    names = thread_names() if detail else {}
    for pid, chain in cli_processes(procs):
        created = procs.created_epoch(pid)
        path, meta = rollout_for(created) if created else (None, None)
        row = {"tool": "codex", "pid": pid, "pids": chain, "host": procs.host(chain), "startedAt": created,
               "state": "unknown",
               "id": None, "cwd": None, "project": "", "title": "", "lastActivity": None, "pendingTools": [],
               "lastError": False, "transcript": path}
        if path:
            row["id"] = meta.get("id")
            row["cwd"] = meta.get("cwd")
            row["project"] = common.project_name(meta.get("cwd"))
            if detail:
                st = analyze(path)
                running, last = st["running"], st["lastTs"]
                row["title"] = names.get(meta.get("id"), "")
                row["plan"] = _plan_view(st, now_ts)
                row["turnCount"] = st["turns"]
                row["model"] = st["model"]
                row["lastError"] = st["lastErr"] or st["aborted"]
                if running and st["turnStart"]:
                    row["turn"] = {"startedAt": st["turnStart"], "seconds": now_ts - st["turnStart"]}
                if st.get("ctx") is not None:
                    row["ctx"] = {"pct": st["ctx"], "at": st.get("ctxTs")}
                if st["rate"]:
                    rates.append((st["rateTs"] or 0, st["rate"]))
            else:
                tail = tail_state(path)
                last = tail["lastTs"]
                running = tail["running"]
                if running is None:
                    running = bool(last and now_ts - last < stall_s)
                if tail["rate"]:
                    rates.append((tail["rateTs"] or 0, tail["rate"]))
            row["lastActivity"] = last
            if running:
                row["state"] = "stalled" if last and now_ts - last > stall_s else "running"
            else:
                row["state"] = "idle"
            row["since"] = (st["turnStart"] if detail and running else last)
        rows.append(row)
    return rows, rates


def newest_rate():
    """沒有存活的 Codex session 時，從最新的幾個 rollout 檔尾找最後一次額度回報（Codex 只在收到回應時回報）。"""
    days = sorted(glob.glob(os.path.join(SESSIONS_DIR, "*", "*", "*")))[-3:]
    files = []
    for d in days:
        files.extend(glob.glob(os.path.join(d, "rollout-*.jsonl")))
    files.sort(key=lambda p: os.path.basename(p), reverse=True)
    best = None
    for path in files[:6]:
        t = tail_state(path)
        if t["rate"] and (best is None or (t["rateTs"] or 0) > best[0]):
            best = (t["rateTs"] or 0, t["rate"])
    return best
