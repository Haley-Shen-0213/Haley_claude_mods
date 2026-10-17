# 路徑： collector\cockpit_cli.py
# 駕駛艙資料的命令列出口，給 haley-cockpit mod 呼叫：board／edits／turns 三種查詢，結果以一行 JSON 印到 stdout。
# mod 在自己的環境裡不能讀超過 4 MiB 的檔案，session 紀錄檔動輒十幾 MB，所以解析交給這支程式。
import argparse
import json
import sys

from cockpit import board, claude_sessions, common, usage, usage_fetch, workflows
from cockpit.winproc import Processes


def _session_paths(ids, all_live):
    out = []
    if all_live:
        procs = Processes()
        for s in claude_sessions.registered():
            if claude_sessions.is_alive(s, procs):
                path = claude_sessions.transcript_path(s)
                if path:
                    out.append((s["sessionId"], s.get("cwd"), path, s.get("status") == "busy"))
        return out
    for sid in ids or []:
        s = claude_sessions.find(sid)
        if not s:
            continue
        path = s.get("_path") or claude_sessions.transcript_path(s)
        if path:
            out.append((sid, s.get("cwd"), path, s.get("status") == "busy"))
    return out


def cmd_edits(args):
    merged = {}
    for sid, cwd, path, _ in _session_paths(args.session, args.all):
        st = claude_sessions.analyze(path, sid)
        for row in claude_sessions.edit_rows(st):
            hit = merged.setdefault(row["path"], {"path": row["path"], "count": 0, "lastAt": None, "sessions": 0})
            hit["count"] += row["count"]
            hit["sessions"] += 1
            if row["lastAt"] and (hit["lastAt"] is None or row["lastAt"] > hit["lastAt"]):
                hit["lastAt"] = row["lastAt"]
    rows = sorted(merged.values(), key=lambda r: (-r["count"], -(r["lastAt"] or 0)))
    return {"now": common.now(), "tzOffset": board.tz_offset(), "files": rows, "total": sum(r["count"] for r in rows)}


def cmd_turns(args):
    found = _session_paths(args.session, False)
    if not found:
        return {"now": common.now(), "turns": [], "error": "找不到這個 session 的紀錄檔"}
    sid, _, path, busy = found[0]
    st = claude_sessions.analyze(path, sid)
    return {"now": common.now(), "tzOffset": board.tz_offset(), "turns": claude_sessions.turn_rows(st, busy, common.now())}


def cmd_agents(args):
    """這個 session 的工作流程（Workflow 工具）與它們派出的代理：官方的子代理清單不含這些。"""
    found = _session_paths(args.session, False)
    if not found:
        return {"now": common.now(), "tzOffset": board.tz_offset(), "runs": [], "error": "找不到這個 session 的紀錄檔"}
    stall_s = common.stall_minutes(args.stall_minutes) * 60
    now_ts = common.now()
    return {"now": now_ts, "tzOffset": board.tz_offset(), "runs": workflows.collect_session(found[0][2], now_ts, stall_s)}


def main():
    ap = argparse.ArgumentParser(description="haley-cockpit 資料收集")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("agents", help="工作流程與它們派出的代理")
    a.add_argument("--session", action="append", required=True)
    a.add_argument("--stall-minutes")
    b = sub.add_parser("board", help="所有 session 總覽與帳號用量")
    b.add_argument("--stall-minutes")
    b.add_argument("--claude-rate", help="mod 從 $.session.usage() 取得的 Claude 用量（狀態列 stdin 的 rate_limits 格式）")
    e = sub.add_parser("edits", help="編輯熱點")
    e.add_argument("--session", action="append")
    e.add_argument("--all", action="store_true", help="所有存活的 Claude session")
    t = sub.add_parser("turns", help="回合時間軸")
    t.add_argument("--session", action="append", required=True)
    sub.add_parser("usage-refresh", help="背景重抓各模型的額度（執行官方 /usage 並解析；一般由總覽自動觸發）")
    args = ap.parse_args()
    if args.cmd == "usage-refresh":
        usage_fetch.run_refresh()
        return
    if args.cmd == "board":
        if args.claude_rate:
            try:
                usage.record_claude(json.loads(args.claude_rate))
            except ValueError:
                pass
        result = board.collect(detail=True, stall_override=args.stall_minutes, with_sparks=True, refresh_usage=True)
    elif args.cmd == "edits":
        result = cmd_edits(args)
    elif args.cmd == "agents":
        result = cmd_agents(args)
    else:
        result = cmd_turns(args)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
