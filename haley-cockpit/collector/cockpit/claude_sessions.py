# 路徑： collector\cockpit\claude_sessions.py
# Claude Code session 收集：讀 ~\.claude\sessions\<pid>.json 存活登記表並核對程序還在；最後動作讀紀錄檔尾，回合、待辦進度與編輯熱點用增量解析並快取。
# 回傳的是數值與 session 自己的標題、待辦項目文字，不回傳 prompt、回覆或工具輸出內容。
import glob
import os
import re

from . import common

SESSIONS_DIR = os.path.join(common.CLAUDE_DIR, "sessions")
PROJECTS_DIR = os.path.join(common.CLAUDE_DIR, "projects")
CACHE_VERSION = 1
# 斜線指令與本機指令的輸出也以 user 列寫入，但不是使用者開的新回合
LOCAL_PREFIX = ("<command-name>", "<local-command-stdout>", "<local-command-caveat>",
                "<command-message>", "<local-command-stderr>")
INTERRUPTED = "[Request interrupted"
# 編輯熱點只算成功的寫檔類工具；值是輸入裡放檔案路徑的欄位
EDIT_TOOLS = {"Edit": "file_path", "Write": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}
# 這幾類列很大又用不到（整份請求內容、檔案備份），先用字串比對跳過，不做 JSON 解析
_HEAVY = (b'"type":"api-request-blob"', b'"type":"file-history-snapshot"', b'"type":"file-history-delta"',
          b'"type":"api-request-shape"')
MAX_TURNS = 400


def _heavy(raw):
    head = raw[:400]
    return any(h in head for h in _HEAVY)


def registered():
    """存活登記表的每一筆；程序已結束但檔案還沒清掉的也在內，要再經 is_alive 篩。"""
    out = []
    for path in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        s = common.read_json(path)
        if isinstance(s, dict) and s.get("sessionId") and s.get("pid"):
            out.append(s)
    return out


def is_alive(s, procs):
    """pid 還在、是 claude.exe，且啟動時間與登記的 procStart 相同（差 2 秒內），才算同一個 session；否則是 pid 被重用。"""
    pid = int(s["pid"])
    exe = procs.exe(pid)
    if not exe or exe.lower() != "claude.exe":
        return False
    start = s.get("procStart")
    if start:
        ft = procs.created_filetime(pid)
        try:
            if ft is not None and abs(ft - int(start)) > 2 * 10 ** 7:
                return False
        except ValueError:
            pass
    return True


def transcript_path(s):
    sid = s["sessionId"]
    # Claude Code 把工作目錄的非英數字元都換成「-」當資料夾名；session 中途 /cd 過就對不上，所以再全域找一次
    guess = os.path.join(PROJECTS_DIR, re.sub(r"[^A-Za-z0-9]", "-", s.get("cwd") or ""), sid + ".jsonl")
    if os.path.exists(guess):
        return guess
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", sid + ".jsonl"))
    return hits[0] if hits else None


def _content(o):
    return (o.get("message") or {}).get("content")


def _text_blocks(content):
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return []


def is_turn_start(o):
    if o.get("type") != "user" or o.get("isMeta") or o.get("isSidechain") or o.get("isCompactSummary") \
            or o.get("isVisibleInTranscriptOnly"):
        return False
    c = _content(o)
    if isinstance(c, str):
        t = c.lstrip()
        return not t.startswith(LOCAL_PREFIX) and not t.startswith(INTERRUPTED)
    if isinstance(c, list):
        seen = False
        for b in c:
            if not isinstance(b, dict):
                continue
            kind = b.get("type")
            if kind == "tool_result":
                return False
            if kind == "text":
                t = str(b.get("text", "")).lstrip()
                if t.startswith(LOCAL_PREFIX) or t.startswith(INTERRUPTED):
                    return False
                seen = True
            elif kind in ("image", "document"):
                seen = True
        return seen
    return False


def tail_state(path):
    """只讀檔尾：最後動作時間、尚未拿到結果的工具、最後一則回應是不是 API 錯誤。狀態列每次都要跑，所以不做全檔解析。"""
    size, lines = common.read_tail_lines(path, 256 * 1024)
    if size > 0 and not lines:
        size, lines = common.read_tail_lines(path, 2 * 1024 * 1024)
    last_ts = None
    pending = {}
    last_err = False
    for raw in lines:
        if _heavy(raw):
            continue
        o = common.loads(raw)
        if not o or o.get("isSidechain"):
            continue
        ts = common.iso_to_epoch(o.get("timestamp"))
        if ts and (last_ts is None or ts > last_ts):
            last_ts = ts
        kind = o.get("type")
        if kind == "assistant":
            last_err = bool(o.get("isApiErrorMessage"))
            for b in _content(o) or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    pending[b.get("id")] = b.get("name")
        elif kind == "user":
            c = _content(o)
            if is_turn_start(o):
                pending.clear()
            elif isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        pending.pop(b.get("tool_use_id"), None)
    return {"lastTs": last_ts, "pendingTools": sorted({n for n in pending.values() if n}), "lastError": last_err}


# ---- 全檔增量解析（給 mod 的面板用） ----

def _new_state(path):
    return {"v": CACHE_VERSION, "path": path, "offset": 0, "turns": [], "req": None, "pending": {},
            "edits": {}, "todos": None, "tasks": {}, "taskCreates": {}, "planStart": None, "planKind": None,
            "lastTs": None, "lastErr": False}


def _close_request(st):
    """同一個 API 回應會拆成好幾列（每個內容區塊一列），各列帶同一個 requestId；換到下一個 requestId 時才把上一個計入回合。"""
    req = st["req"]
    if req and st["turns"]:
        turn = st["turns"][-1]
        turn["calls"] += 1
        turn["out"] += req["out"]
        turn["inp"] += req["inp"]
    st["req"] = None


def _open_items(items):
    return bool(items) and any(i.get("s") != "completed" for i in items)


def _set_todos(st, todos, ts):
    items = [{"c": str(t.get("content", "")), "s": str(t.get("status", "")), "a": str(t.get("activeForm", ""))}
             for t in (todos or []) if isinstance(t, dict)]
    # 先前沒有清單或已全部完成，這次寫入就是一份新計畫：從這裡起算已耗時
    if not _open_items(st["todos"]):
        st["planStart"] = ts
    st["todos"] = items or None
    st["planKind"] = "todo"


def _feed(st, o):
    if o.get("isSidechain"):
        return
    kind = o.get("type")
    ts = common.iso_to_epoch(o.get("timestamp"))
    if ts and (st["lastTs"] is None or ts > st["lastTs"]):
        st["lastTs"] = ts
    turn = st["turns"][-1] if st["turns"] else None
    if kind == "user":
        if is_turn_start(o):
            _close_request(st)
            # 上一回合沒拿到結果的工具（被中斷）不會再有結果，新回合開始時清掉，免得快取越積越大
            st["pending"] = {}
            st["taskCreates"] = {}
            st["turns"].append({"start": ts, "end": ts, "dur": None, "calls": 0, "out": 0, "inp": 0, "tools": 0,
                                "intr": False, "err": False, "queued": o.get("promptSource") == "queued"})
            if len(st["turns"]) > MAX_TURNS:
                st["turns"] = st["turns"][-MAX_TURNS:]
            return
        c = _content(o)
        if any(INTERRUPTED in t for t in _text_blocks(c)) and turn:
            turn["intr"] = True
        if isinstance(c, list):
            for b in c:
                if not isinstance(b, dict) or b.get("type") != "tool_result":
                    continue
                tid = b.get("tool_use_id")
                hit = st["pending"].pop(tid, None)
                if not hit or b.get("is_error"):
                    st["taskCreates"].pop(tid, None)
                    continue
                name, fpath = hit[0], hit[1]
                if name in EDIT_TOOLS and fpath:
                    count, _ = st["edits"].get(fpath, (0, None))
                    st["edits"][fpath] = [count + 1, ts]
                if name == "TaskCreate":
                    spec = st["taskCreates"].pop(tid, None)
                    task = ((o.get("toolUseResult") or {}).get("task") or {}) if isinstance(o.get("toolUseResult"), dict) else {}
                    if spec and task.get("id"):
                        if not _open_items(list(st["tasks"].values())):
                            st["planStart"] = ts
                        st["tasks"][str(task["id"])] = {"c": spec["c"], "s": "pending", "a": spec["a"]}
                        st["planKind"] = "task"
        if turn and ts:
            turn["end"] = ts
    elif kind == "assistant":
        msg = o.get("message") or {}
        is_err = bool(o.get("isApiErrorMessage"))
        st["lastErr"] = is_err
        if is_err and turn:
            turn["err"] = True
        rid = o.get("requestId") or msg.get("id")
        if rid and (st["req"] is None or st["req"]["id"] != rid):
            _close_request(st)
            st["req"] = {"id": rid, "out": 0, "inp": 0}
        usage = msg.get("usage") or {}
        if st["req"] and usage:
            inp = int(usage.get("input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0) \
                + int(usage.get("cache_read_input_tokens") or 0)
            st["req"]["out"] = max(st["req"]["out"], int(usage.get("output_tokens") or 0))
            st["req"]["inp"] = max(st["req"]["inp"], inp)
        for b in msg.get("content") or []:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name") or ""
            args = b.get("input") if isinstance(b.get("input"), dict) else {}
            if turn:
                turn["tools"] += 1
            fpath = args.get(EDIT_TOOLS[name]) if name in EDIT_TOOLS else None
            st["pending"][b.get("id")] = [name, fpath if isinstance(fpath, str) else None]
            if name == "TodoWrite":
                _set_todos(st, args.get("todos"), ts)
            elif name == "TaskCreate":
                st["taskCreates"][b.get("id")] = {"c": str(args.get("subject", "")), "a": str(args.get("activeForm", ""))}
            elif name == "TaskUpdate":
                task = st["tasks"].get(str(args.get("taskId")))
                if task is not None:
                    if args.get("status") == "deleted":
                        st["tasks"].pop(str(args.get("taskId")), None)
                    else:
                        if args.get("status"):
                            task["s"] = str(args["status"])
                        if args.get("subject"):
                            task["c"] = str(args["subject"])
                        if args.get("activeForm"):
                            task["a"] = str(args["activeForm"])
                    st["planKind"] = "task"
        if turn and ts:
            turn["end"] = ts
    elif kind == "system":
        if o.get("subtype") == "turn_duration" and turn:
            turn["dur"] = o.get("durationMs")
            if ts:
                turn["end"] = ts


def analyze(path, sid):
    """增量解析：快取記住讀到的位元組位置，每次只讀新增的完整行。檔案變短（被重寫）就從頭來。"""
    cache_path = os.path.join(common.CACHE_DIR, f"claude-{sid}.json")
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
            if raw.strip() and not _heavy(raw):
                o = common.loads(raw)
                if o:
                    _feed(st, o)
        st["offset"] += len(data)
        common.write_json_atomic(cache_path, st)
    return st


def plan_view(st, now_ts):
    """預估剩餘 ≈ 已耗時 ÷ 已完成 × 未完成；已耗時從這份計畫第一次寫入起算。沒有清單回傳 None（面板顯示「無計畫」）。"""
    if st.get("planKind") == "task":
        items = list(st["tasks"].values())
    else:
        items = st.get("todos") or []
    if not items:
        return None
    done = sum(1 for i in items if i.get("s") == "completed")
    total = len(items)
    current = next((i.get("a") or i.get("c") for i in items if i.get("s") == "in_progress"), None)
    eta = None
    start = st.get("planStart")
    if start and 0 < done < total:
        eta = max(0.0, (now_ts - start) / done * (total - done))
    return {"done": done, "total": total, "current": current, "startedAt": start, "eta": eta}


def turn_rows(st, running, now_ts):
    rows = []
    turns = st.get("turns") or []
    for i, t in enumerate(turns):
        calls, out, inp = t["calls"], t["out"], t["inp"]
        last = i == len(turns) - 1
        if last and st.get("req"):
            calls += 1
            out += st["req"]["out"]
            inp += st["req"]["inp"]
        is_running = last and running
        if t.get("dur") is not None and not is_running:
            secs = t["dur"] / 1000
        elif is_running and t.get("start"):
            secs = now_ts - t["start"]
        else:
            secs = (t.get("end") or 0) - (t.get("start") or 0)
        rows.append({"index": i + 1, "start": t.get("start"), "seconds": max(0.0, secs), "calls": calls,
                     "outputTokens": out, "inputTokens": inp, "tools": t["tools"], "interrupted": t["intr"],
                     "error": t["err"], "queued": t.get("queued", False), "running": is_running})
    return rows


def edit_rows(st):
    rows = [{"path": p, "count": v[0], "lastAt": v[1]} for p, v in (st.get("edits") or {}).items()]
    rows.sort(key=lambda r: (-r["count"], -(r["lastAt"] or 0)))
    return rows


def collect(procs, now_ts, stall_s, detail=False):
    """每個存活的 Claude session 一列。state：running（執行中）／stalled（執行中但超過門檻沒有新紀錄）／idle（閒置）。"""
    rows = []
    for s in registered():
        if not is_alive(s, procs):
            continue
        sid = s["sessionId"]
        path = transcript_path(s)
        tail = tail_state(path) if path else {"lastTs": None, "pendingTools": [], "lastError": False}
        since = (s.get("statusUpdatedAt") or s.get("updatedAt") or 0) / 1000 or None
        # 狀態切換時間也算一次動作：找不到紀錄檔，或紀錄檔還沒寫入新回合時，至少有它
        stamps = [t for t in (tail["lastTs"], since) if t]
        last = max(stamps) if stamps else None
        raw = s.get("status")
        if raw == "busy":
            state = "stalled" if last and now_ts - last > stall_s else "running"
        elif raw in (None, "idle"):
            state = "idle"
        else:
            state = str(raw)
        pid = int(s["pid"])
        row = {"tool": "claude", "id": sid, "pid": pid, "pids": procs.chain(pid), "cwd": s.get("cwd"),
               "project": common.project_name(s.get("cwd")), "title": s.get("name") or "", "state": state,
               "rawStatus": raw, "since": since, "lastActivity": last, "pendingTools": tail["pendingTools"],
               "lastError": tail["lastError"], "startedAt": (s.get("startedAt") or 0) / 1000 or None,
               "version": s.get("version"), "transcript": path}
        if detail and path:
            st = analyze(path, sid)
            row["plan"] = plan_view(st, now_ts)
            turns = st.get("turns") or []
            row["turnCount"] = len(turns)
            if turns:
                cur = turn_rows({**st, "turns": turns[-1:]}, state in ("running", "stalled"), now_ts)[0]
                row["turn"] = {"startedAt": cur["start"], "calls": cur["calls"], "outputTokens": cur["outputTokens"],
                               "tools": cur["tools"], "seconds": cur["seconds"]}
        rows.append(row)
    return rows


def find(sid):
    """依 session id 找登記表那一筆（給 edits／turns 查詢用）；找不到時直接全域找紀錄檔。"""
    for s in registered():
        if s["sessionId"] == sid:
            return s
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", sid + ".jsonl"))
    return {"sessionId": sid, "cwd": None, "_path": hits[0]} if hits else None
