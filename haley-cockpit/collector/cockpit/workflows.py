# 路徑： collector\cockpit\workflows.py
# 工作流程（Workflow 工具）派出的代理：官方的子代理清單不含它們（Claude Code 畫面底部另外顯示「工作流程 8/16」），
# 但每個代理都在 session 資料夾底下留了 agent-<編號>.meta.json（類型、描述、階段）與對話紀錄 agent-<編號>.jsonl。
# 這裡掃描並增量解析（快取每個檔案讀到的位置），回傳每個 run 的名稱、說明、進度與每個代理的階段、描述、狀態、時間、工具次數、輸出 token。
# 工作流程的名稱與說明在母 session 紀錄檔的 Workflow 工具結果裡，只在第一次找到後快取，之後不再翻那份大檔。
import glob
import os
import time

from . import common

CACHE_VERSION = 1
MAX_RUNS = 4
LAUNCH_RETRY = 60  # 秒：還找不到啟動結果（工作流程剛開始）時，隔這麼久再翻一次母紀錄檔


def session_dir(transcript_path):
    """<專案資料夾>/<session>.jsonl 對應的 session 資料夾 <專案資料夾>/<session>/。"""
    return os.path.splitext(transcript_path)[0]


def _new_agent():
    return {"offset": 0, "first": None, "last": None, "tools": 0, "out": 0, "req": None, "reqOut": 0,
            "lastTool": None, "finished": False}


def _feed_agent(a, o):
    ts = common.iso_to_epoch(o.get("timestamp"))
    if ts:
        a["first"] = a["first"] or ts
        if a["last"] is None or ts > a["last"]:
            a["last"] = ts
    kind = o.get("type")
    if kind not in ("user", "assistant"):
        return
    msg = o.get("message") or {}
    if kind == "assistant":
        # 同一個請求會拆成好幾列，輸出 token 取每個請求的最大值再加總，不重複累加
        rid = o.get("requestId") or msg.get("id")
        if rid != a["req"]:
            a["out"] += a["reqOut"]
            a["req"], a["reqOut"] = rid, 0
        a["reqOut"] = max(a["reqOut"], int((msg.get("usage") or {}).get("output_tokens") or 0))
        content = msg.get("content")
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    a["tools"] += 1
                    a["lastTool"] = b.get("name")
        a["finished"] = msg.get("stop_reason") in ("end_turn", "stop_sequence")
    else:
        # 完成的代理，最後一列是「結束回合的工具」的結果（toolEndsTurn）；後面若又有新的列，狀態就回到進行中
        a["finished"] = bool(o.get("toolEndsTurn"))


def _read_new(path, state):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size < state["offset"]:
                state.update(_new_agent())
            f.seek(state["offset"])
            data = f.read(max(0, size - state["offset"]))
    except OSError:
        return False
    end = data.rfind(b"\n")
    data = data[:end + 1] if end >= 0 else b""
    for raw in data.split(b"\n"):
        if raw.strip():
            o = common.loads(raw)
            if o:
                _feed_agent(state, o)
    state["offset"] += len(data)
    return bool(data)


def find_launch(parent_path, run_id):
    """在母 session 紀錄檔找這個 run 的啟動結果：名稱（workflowName）、說明（summary）、工作編號（taskId）。"""
    try:
        with open(parent_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if run_id not in line or "workflowName" not in line:
                    continue
                o = common.loads(line.encode("utf-8"))
                r = o.get("toolUseResult") if o else None
                if isinstance(r, dict) and r.get("runId") == run_id:
                    return {"name": r.get("workflowName"), "summary": r.get("summary"), "taskId": r.get("taskId")}
    except OSError:
        pass
    return None


def scan_run(run_dir, parent_path, now_ts, stall_s):
    run_id = os.path.basename(run_dir)
    cache_path = os.path.join(common.CACHE_DIR, f"wf-{run_id}.json")
    cache = common.read_json(cache_path)
    if not isinstance(cache, dict) or cache.get("v") != CACHE_VERSION:
        cache = {"v": CACHE_VERSION, "launch": None, "launchTry": 0, "agents": {}}
    dirty = False
    if cache["launch"] is None and parent_path and now_ts - cache.get("launchTry", 0) > LAUNCH_RETRY:
        cache["launch"] = find_launch(parent_path, run_id)
        cache["launchTry"] = now_ts
        dirty = True
    agents = []
    for meta_path in sorted(glob.glob(os.path.join(run_dir, "agent-*.meta.json"))):
        aid = os.path.basename(meta_path)[len("agent-"):-len(".meta.json")]
        meta = common.read_json(meta_path) or {}
        st = cache["agents"].setdefault(aid, _new_agent())
        jl = os.path.join(run_dir, f"agent-{aid}.jsonl")
        mtime = None
        if os.path.exists(jl):
            dirty = _read_new(jl, st) or dirty
            try:
                mtime = os.path.getmtime(jl)
            except OSError:
                mtime = None
        last = max([t for t in (st["last"], mtime) if t] or [0]) or None
        if st["finished"]:
            state = "done"
        elif not st["first"]:
            state = "pending"
        elif last and now_ts - last > stall_s:
            state = "stalled"
        else:
            state = "running"
        end = st["last"] if state == "done" else now_ts
        agents.append({"id": aid, "phase": meta.get("workflowPhase") or "", "description": meta.get("description") or aid[:8],
                       "type": meta.get("agentType") or "", "state": state, "startedAt": st["first"], "lastActivity": last,
                       "seconds": max(0.0, (end or now_ts) - st["first"]) if st["first"] else 0.0, "tools": st["tools"],
                       "lastTool": st["lastTool"], "outputTokens": st["out"] + st["reqOut"]})
    if dirty:
        common.write_json_atomic(cache_path, cache)
    # 依開始時間排：階段先後自然排好；還沒開始的排最後
    agents.sort(key=lambda a: (a["startedAt"] is None, a["startedAt"] or 0, a["description"]))
    counts = {k: sum(1 for a in agents if a["state"] == k) for k in ("done", "running", "stalled", "pending")}
    started = [a["startedAt"] for a in agents if a["startedAt"]]
    all_done = bool(agents) and counts["done"] == len(agents)
    launch = cache.get("launch") or {}
    ends = [a["lastActivity"] for a in agents if a["lastActivity"]]
    return {"runId": run_id, "name": launch.get("name") or run_id, "summary": launch.get("summary") or "", "taskId": launch.get("taskId"),
            "startedAt": min(started) if started else None, "endedAt": max(ends) if all_done and ends else None,
            "state": "done" if all_done else ("running" if counts["running"] or counts["pending"] else "stalled"),
            "counts": counts, "total": len(agents), "outputTokens": sum(a["outputTokens"] for a in agents), "agents": agents}


def collect_session(transcript_path, now_ts, stall_s, limit=MAX_RUNS):
    """這個 session 最近的幾個工作流程 run（新的在前）；沒有工作流程就回傳空清單。"""
    if not transcript_path:
        return []
    base = os.path.join(session_dir(transcript_path), "subagents", "workflows")
    dirs = [d for d in glob.glob(os.path.join(base, "*")) if os.path.isdir(d)]
    if not dirs:
        return []

    def newest(d):
        try:
            return max((os.path.getmtime(f) for f in glob.glob(os.path.join(d, "*"))), default=0)
        except OSError:
            return 0

    dirs.sort(key=newest, reverse=True)
    return [scan_run(d, transcript_path, now_ts, stall_s) for d in dirs[:limit]]


def row_summary(runs):
    """給總覽每一列的進度條用：最新一個還沒跑完的 run 的名稱與完成數；沒有就回傳 None。"""
    for r in runs:
        if r["state"] != "done" and r["total"]:
            return {"name": r["name"], "done": r["counts"]["done"], "total": r["total"], "running": r["counts"]["running"],
                    "stalled": r["counts"]["stalled"], "startedAt": r["startedAt"]}
    return None
