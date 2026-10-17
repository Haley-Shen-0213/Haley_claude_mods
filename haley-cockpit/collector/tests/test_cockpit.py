# 路徑： collector\tests\test_cockpit.py
# 收集程式核心計算的單元測試（標準函式庫 unittest，不需安裝套件）：context 比例、壓縮後歸零、非終端機 session 過濾、終端機名稱對應、用量合併、ISO 時間、
# 標題與編號、Fable 用量解析、狀態列排版、工作流程代理的狀態與增量解析。
# 用法：python -X utf8 -B -m unittest discover -s collector/tests -v（在 haley-cockpit 資料夾下執行）
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

# 在匯入收集程式之前，把它的資料資料夾導到暫存區，測試不碰真正的用量快取
_DATA = tempfile.mkdtemp(prefix="haley-cockpit-test-")
os.environ["HALEY_COCKPIT_DATA"] = _DATA
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest import mock  # noqa: E402

import statusline  # noqa: E402
from cockpit import board, claude_sessions, codex_sessions, common, usage, usage_fetch, winproc, workflows  # noqa: E402


def tearDownModule():
    shutil.rmtree(_DATA, ignore_errors=True)


def assistant(rid, inp=0, cache_create=0, cache_read=0, out=0, ts="2026-10-17T00:00:00Z"):
    return {"type": "assistant", "timestamp": ts, "requestId": rid,
            "message": {"usage": {"input_tokens": inp, "cache_creation_input_tokens": cache_create,
                                  "cache_read_input_tokens": cache_read, "output_tokens": out}, "content": []}}


class ContextTokens(unittest.TestCase):
    def test_last_request_input_is_context(self):
        """最後一次請求的輸入加快取，就是當下 context 的大小。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, assistant("r1", inp=2, cache_create=500, cache_read=340868, out=6))
        self.assertEqual(st["ctxTokens"], 341370)
        claude_sessions._feed(st, assistant("r2", inp=3, cache_read=400000))
        self.assertEqual(st["ctxTokens"], 400003)

    def test_split_request_rows_take_max(self):
        """同一個請求拆成多列時取最大值，不重複累加。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, assistant("r1", inp=2, cache_read=1000))
        claude_sessions._feed(st, assistant("r1", inp=2, cache_read=1000, out=50))
        self.assertEqual(st["ctxTokens"], 1002)

    def test_error_row_does_not_overwrite(self):
        """API 錯誤訊息列的用量是 0，不能蓋掉上一次的數字。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, assistant("r1", inp=10, cache_read=90))
        claude_sessions._feed(st, {**assistant("r2"), "isApiErrorMessage": True})
        self.assertEqual(st["ctxTokens"], 100)

    def test_compaction_resets_until_next_request(self):
        """壓縮之後、下一次請求之前不知道 context 多大：先歸零，不沿用壓縮前的數字。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, assistant("r1", cache_read=500000))
        claude_sessions._feed(st, {"type": "system", "subtype": "compact_boundary", "timestamp": "2026-10-17T00:01:00Z"})
        self.assertIsNone(st["ctxTokens"])
        claude_sessions._feed(st, {"type": "user", "isCompactSummary": True, "timestamp": "2026-10-17T00:01:01Z",
                                   "message": {"content": "摘要"}})
        self.assertIsNone(st["ctxTokens"])
        claude_sessions._feed(st, assistant("r2", cache_read=30000))
        self.assertEqual(st["ctxTokens"], 30000)

    def test_subagent_requests_are_ignored(self):
        """子代理（sidechain）的請求不是主對話的 context。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, assistant("r1", cache_read=1000))
        claude_sessions._feed(st, {**assistant("r2", cache_read=999999), "isSidechain": True})
        self.assertEqual(st["ctxTokens"], 1000)


class ContextPercent(unittest.TestCase):
    def setUp(self):
        os.makedirs(common.CTX_DIR, exist_ok=True)

    def _ctx_file(self, sid, **doc):
        common.write_json_atomic(os.path.join(common.CTX_DIR, f"{sid}.json"), doc)

    def test_tokens_over_reported_window(self):
        """以紀錄檔的 token 數，除以狀態列回報的視窗大小。"""
        self._ctx_file("aaaaaaaa-1", pct=0.0, size=1000000)
        rows = [{"tool": "claude", "id": "aaaaaaaa-1", "state": "idle", "ctxTokens": 250000, "lastActivity": 1.0}]
        board.attach_claude_ctx(rows)
        self.assertEqual(rows[0]["ctx"]["pct"], 25.0)
        self.assertNotIn("ctxTokens", rows[0])

    def test_idle_without_tokens_hides_statusline_zero(self):
        """閒置、紀錄檔又沒有數字（剛壓縮完）時，不顯示狀態列回報的 0%。"""
        self._ctx_file("aaaaaaaa-2", pct=0.0, size=1000000)
        rows = [{"tool": "claude", "id": "aaaaaaaa-2", "state": "idle", "ctxTokens": None}]
        board.attach_claude_ctx(rows)
        self.assertNotIn("ctx", rows[0])

    def test_running_without_tokens_uses_live_value(self):
        """執行中又沒有紀錄數字時，採用狀態列的即時值。"""
        self._ctx_file("aaaaaaaa-3", pct=40.0, size=1000000)
        rows = [{"tool": "claude", "id": "aaaaaaaa-3", "state": "running", "ctxTokens": None}]
        board.attach_claude_ctx(rows)
        self.assertEqual(rows[0]["ctx"]["pct"], 40.0)

    def test_unknown_window_is_not_guessed(self):
        """沒有視窗大小就不猜（猜錯會差 5 倍）。"""
        rows = [{"tool": "claude", "id": "aaaaaaaa-4", "state": "idle", "ctxTokens": 250000}]
        board.attach_claude_ctx(rows)
        self.assertNotIn("ctx", rows[0])

    def test_codex_percent_from_token_event(self):
        """Codex 的比例由 token 事件的最近一次請求與視窗大小算出。"""
        info = {"last_token_usage": {"total_tokens": 218444}, "model_context_window": 258400}
        self.assertEqual(codex_sessions._ctx_pct(info), 84.5)
        self.assertIsNone(codex_sessions._ctx_pct({}))


class Sessions(unittest.TestCase):
    def test_non_terminal_sessions_are_split_out(self):
        """登記檔 entrypoint 不是 cli 的 session（例如 VS Code 的 Claude 面板）不列入總覽。"""
        rows = [{"pid": 1, "entrypoint": "cli"}, {"pid": 2, "entrypoint": None}, {"pid": 3, "entrypoint": "claude-vscode"},
                {"pid": 4, "entrypoint": "sdk-ts"}]
        keep, others = board.split_non_terminal(rows)
        self.assertEqual([r["pid"] for r in keep], [1, 2])
        self.assertEqual([r["pid"] for r in others], [3, 4])

    def test_terminal_name_by_process_chain(self):
        """程序鏈上有某個終端機的 shell，就用那個終端機的名稱。"""
        rows = [{"pids": [11, 100, 9]}, {"pids": [22, 23, 200]}, {"pids": [33, 34]}]
        board.attach_terminals(rows, {100: ("甲", 0, "視窗"), 200: ("乙", 1, "視窗")})
        self.assertEqual([r.get("terminal") for r in rows], ["甲", "乙", None])
        self.assertEqual(rows[1]["terminalIndex"], 1)

    def test_stale_terminal_file_means_window_closed(self):
        """名稱檔超過 120 秒沒更新，視為那個視窗已關閉。"""
        os.makedirs(common.TERMINALS_DIR, exist_ok=True)
        now = time.time()
        common.write_json_atomic(os.path.join(common.TERMINALS_DIR, "terminals-1.json"),
                                 {"at": now - 10, "window": "w", "terminals": [{"pid": 5, "name": "新", "index": 0}]})
        common.write_json_atomic(os.path.join(common.TERMINALS_DIR, "terminals-2.json"),
                                 {"at": now - 500, "window": "w", "terminals": [{"pid": 6, "name": "舊", "index": 0}]})
        names = board.terminal_names(now)
        self.assertIn(5, names)
        self.assertNotIn(6, names)


class UsageMerge(unittest.TestCase):
    def setUp(self):
        if os.path.exists(usage.USAGE_PATH):
            os.remove(usage.USAGE_PATH)

    def _used(self):
        return usage.snapshot(time.time())["claude"]["five_hour"]["used"]

    def test_same_window_monotonic_new_window_replaces(self):
        """同一個計量視窗內只增不減；進入新視窗就取代。"""
        reset = time.time() + 3600
        usage.record_claude({"five_hour": {"used_percentage": 10, "resets_at": reset}})
        usage.record_claude({"five_hour": {"used_percentage": 5, "resets_at": reset}})
        self.assertEqual(self._used(), 10)
        usage.record_claude({"five_hour": {"used_percentage": 12, "resets_at": reset}})
        self.assertEqual(self._used(), 12)
        usage.record_claude({"five_hour": {"used_percentage": 1, "resets_at": reset + 18000}})
        self.assertEqual(self._used(), 1)

    def test_expired_window_is_unknown(self):
        """重置時間已過的視窗，用量未知（要等下一次 API 回應）。"""
        usage.record_claude({"five_hour": {"used_percentage": 50, "resets_at": time.time() - 10}})
        self.assertIsNone(self._used())


class Titles(unittest.TestCase):
    def test_derived_name_is_not_a_title(self):
        """登記檔的 name 若是自動代號（derived），標題用 Claude 產生的 ai-title。"""
        s = {"name": "myproject-8e", "nameSource": "derived"}
        self.assertEqual(claude_sessions.display_title(s, "整理文件"), "整理文件")

    def test_derived_name_is_the_last_resort(self):
        """還沒有 ai-title（剛開、沒有對話）時，退回登記檔的名稱。"""
        s = {"name": "myproject-8e", "nameSource": "derived"}
        self.assertEqual(claude_sessions.display_title(s, None), "myproject-8e")

    def test_custom_name_wins(self):
        """使用者用 /rename 取的名字（nameSource 不是 derived）優先於 ai-title。"""
        s = {"name": "我的專案", "nameSource": "user"}
        self.assertEqual(claude_sessions.display_title(s, "整理文件"), "我的專案")

    def test_tail_takes_last_ai_title(self):
        """檔尾有好幾個 ai-title 時取最後一個（標題會隨對話更新）。"""
        path = os.path.join(_DATA, "t.jsonl")
        rows = [{"type": "ai-title", "aiTitle": "舊標題"},
                {"type": "assistant", "timestamp": "2026-10-17T00:00:00Z", "message": {"content": []}},
                {"type": "ai-title", "aiTitle": "新標題"}]
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
        self.assertEqual(claude_sessions.tail_state(path)["aiTitle"], "新標題")

    def test_incremental_state_keeps_ai_title(self):
        """增量解析也記住最新的 ai-title，檔尾剛好沒有標題列時有備用。"""
        st = claude_sessions._new_state("x")
        claude_sessions._feed(st, {"type": "ai-title", "aiTitle": "A"})
        claude_sessions._feed(st, {"type": "ai-title", "aiTitle": "B"})
        self.assertEqual(st["aiTitle"], "B")


class Host(unittest.TestCase):
    def _procs(self, table):
        p = winproc.Processes.__new__(winproc.Processes)
        p.table = table
        p._created = {}
        return p

    def test_host_kinds(self):
        """依程序鏈判斷 session 在哪種終端機裡。"""
        procs = self._procs({1: (2, "claude.exe"), 2: (3, "powershell.exe"), 3: (4, "Code.exe"),
                             11: (12, "claude.exe"), 12: (13, "OpenConsole.exe"), 13: (0, "WindowsTerminal.exe"),
                             21: (22, "claude.exe"), 22: (23, "cmd.exe"), 23: (0, "explorer.exe")})
        self.assertEqual(procs.host([1, 2, 3]), "vscode")
        self.assertEqual(procs.host([11, 12, 13]), "wt")
        self.assertEqual(procs.host([21, 22, 23]), "console")


USAGE_SAMPLE = """You are currently using your subscription to power your Claude Code usage

Current session: 11% used · resets Oct 17, 10:59am (Asia/Taipei)
Current week (all models): 45% used · resets Oct 22, 5:59am (Asia/Taipei)
Current week (Fable): 36% used · resets Oct 22, 6am (Asia/Taipei)

What's contributing to your limits usage?
"""


class ModelUsage(unittest.TestCase):
    def setUp(self):
        for p in (usage.USAGE_PATH, usage_fetch.LOCK_PATH):
            if os.path.exists(p):
                os.remove(p)

    def test_parse_official_usage_text(self):
        """session＝5 小時、week (all models)＝7 天、week (某模型)＝該模型自己的每週額度。"""
        now = time.mktime((2026, 10, 17, 9, 0, 0, 0, 0, -1))
        p = usage_fetch.parse_usage_text(USAGE_SAMPLE, now)
        self.assertEqual(p["five_hour"]["used"], 11.0)
        self.assertEqual(p["seven_day"]["used"], 45.0)
        self.assertEqual(p["models"]["Fable"]["used"], 36.0)
        self.assertEqual(time.strftime("%m-%d %H:%M", time.localtime(p["five_hour"]["resetsAt"])), "10-17 10:59")
        self.assertEqual(time.strftime("%m-%d %H:%M", time.localtime(p["models"]["Fable"]["resetsAt"])), "10-22 06:00")

    def test_other_models_and_missing_reset(self):
        """之後出現別的模型專屬額度、或沒有重置時間時，照樣解析。"""
        p = usage_fetch.parse_usage_text("Current week (Opus): 12.5% used\nCurrent week (Fable): 3% used", time.time())
        self.assertEqual(p["models"]["Opus"]["used"], 12.5)
        self.assertIsNone(p["models"]["Opus"]["resetsAt"])
        self.assertEqual(p["models"]["Fable"]["used"], 3.0)
        self.assertEqual(usage_fetch.parse_usage_text("沒有可解析的內容", time.time()), {"five_hour": None, "seven_day": None, "models": {}})

    def test_reset_rolls_into_next_year(self):
        """年底查到明年一月的重置時間，要算成明年。"""
        now = time.mktime((2026, 12, 30, 9, 0, 0, 0, 0, -1))
        epoch = usage_fetch.parse_reset("Jan 3, 6am", now)
        self.assertEqual(time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch)), "2027-01-03 06:00")

    def test_refresh_interval_and_failed_try(self):
        """快取新就不重抓；超過 5 分鐘才重抓；嘗試失敗（只有 tryAt）也要等一個間隔。"""
        now = 1_000_000.0
        self.assertTrue(usage_fetch.due(now))
        common.write_json_atomic(usage.USAGE_PATH, {"claudeUsage": {"seenAt": now - 60}})
        self.assertFalse(usage_fetch.due(now))
        common.write_json_atomic(usage.USAGE_PATH, {"claudeUsage": {"seenAt": now - 900, "tryAt": now - 100}})
        self.assertFalse(usage_fetch.due(now))
        common.write_json_atomic(usage.USAGE_PATH, {"claudeUsage": {"seenAt": now - 900, "tryAt": now - 400}})
        self.assertTrue(usage_fetch.due(now))

    def test_spawn_only_when_due_and_not_locked(self):
        """到期才在背景啟動；鎖檔還新（另一個程序正在抓）就不再啟動。"""
        now = common.now()
        with mock.patch.object(usage_fetch.subprocess, "Popen") as popen:
            common.write_json_atomic(usage.USAGE_PATH, {"claudeUsage": {"seenAt": now - 10}})
            self.assertFalse(usage_fetch.maybe_spawn(now))
            os.remove(usage.USAGE_PATH)
            self.assertTrue(usage_fetch.maybe_spawn(now))
            self.assertEqual(popen.call_count, 1)
            self.assertIn("usage-refresh", popen.call_args.args[0])
            with open(usage_fetch.LOCK_PATH, "w", encoding="utf-8") as f:
                f.write("x")
            self.assertFalse(usage_fetch.maybe_spawn(now))
            self.assertEqual(popen.call_count, 1)

    def test_record_and_snapshot(self):
        """寫入後快照要有模型額度；重置時間已過的視窗用量未知。"""
        now = time.time()
        usage.record_usage_text({"five_hour": None, "seven_day": {"used": 45.0, "resetsAt": now + 86400},
                                 "models": {"Fable": {"used": 36.0, "resetsAt": now + 86400}, "Old": {"used": 9.0, "resetsAt": now - 10}}}, now)
        snap = usage.snapshot(now)
        models = {m["label"]: m for m in snap["claude"]["models"]}
        self.assertEqual(models["Fable"]["used"], 36.0)
        self.assertIsNone(models["Old"]["used"])
        self.assertEqual(snap["claude"]["seven_day"]["used"], 45.0)


class Numbering(unittest.TestCase):
    def test_stable_order_by_start_time(self):
        """編號依啟動時間排，與狀態無關；同時啟動時依程序編號。"""
        rows = [{"pid": 3, "startedAt": 300, "tool": "claude", "title": "丙", "slug": "", "state": "running"},
                {"pid": 1, "startedAt": 100, "tool": "codex", "title": "甲", "project": "p", "state": "idle"},
                {"pid": 2, "startedAt": 100, "tool": "claude", "title": "乙", "slug": "", "state": "idle"}]
        board.number_rows(rows)
        self.assertEqual([(r["no"], r["pid"]) for r in rows], [(1, 1), (2, 2), (3, 3)])

    def test_tab_title_candidates(self):
        """切換程式比對用的分頁名稱：有標題用標題；新 session 沒有標題時分頁固定叫 Claude Code；Codex 可能接「 | 專案」。"""
        self.assertEqual(board.tab_titles({"tool": "claude", "title": "整理文件", "slug": "p-8e"}), ["整理文件"])
        self.assertEqual(board.tab_titles({"tool": "claude", "title": "p-8e", "slug": "p-8e"}), ["Claude Code"])
        self.assertEqual(board.tab_titles({"tool": "codex", "title": "審查", "project": "alpha"}), ["審查", "審查 | alpha"])


class StatusLine(unittest.TestCase):
    ROWS = [{"no": i + 1, "id": f"s{i}", "state": st, "terminal": name}
            for i, (st, name) in enumerate([("running", "整理文件與設定的長名稱"), ("idle", "甲專案 交易所"), ("idle", "乙專案 流量監控"),
                                            ("stalled", "新 session"), ("idle", "系統診斷"), ("idle", "中控台"), ("idle", "Codex 審查"), ("idle", "Codex 規範")])]

    def test_list_numbers_names_and_current(self):
        """每格「編號:狀態點 名稱」，本 session 加粗，寬度放得下時 8 個都列出。"""
        text = statusline.line_list(self.ROWS, "s1", 200)
        plain = statusline._ANSI.sub("", text)
        self.assertTrue(plain.startswith("1:● "))
        self.assertIn("4:▲ ", plain)
        self.assertIn("8:○ ", plain)
        self.assertLessEqual(statusline.visible_width(text), 200)
        self.assertIn(statusline.BOLD, text)

    def test_list_collapses_when_narrow(self):
        """太窄時只列放得下的前幾個，其餘收成 +N，而且不超過寬度。"""
        text = statusline.line_list(self.ROWS, "s0", 60)
        self.assertLessEqual(statusline.visible_width(text), 60)
        self.assertRegex(statusline._ANSI.sub("", text), r"\+\d+$")

    def test_usage_line_fits_any_width(self):
        """帳號用量行（含 Fable）依寬度挑放得下的版本。"""
        now = 1_000_000.0
        snap = {"claude": {"five_hour": {"used": 11.0, "resetsAt": now + 7000}, "seven_day": {"used": 45.0, "resetsAt": now + 400000},
                           "models": [{"label": "Fable", "used": 36.0, "resetsAt": now + 400000}]},
                "codex": {"primary": {"used": 35.0, "resetsAt": now + 500000, "windowMinutes": 10080}, "secondary": None}}
        for cols in (220, 160, 130, 100):
            text = statusline.line_usage(snap, now, cols)
            self.assertLessEqual(statusline.visible_width(text), cols, cols)
            self.assertIn("Fable 7d", text)
        self.assertIn("後重置", statusline.line_usage(snap, now, 220))


def _jl(path, rows, mode="a"):
    with open(path, mode, encoding="utf-8", newline="\n") as f:
        for o in rows:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def wf_assistant(ts, rid, out, tool=None, stop="tool_use"):
    content = [{"type": "tool_use", "name": tool}] if tool else [{"type": "text", "text": "好"}]
    return {"type": "assistant", "timestamp": _iso(ts), "requestId": rid,
            "message": {"id": rid, "stop_reason": stop, "usage": {"output_tokens": out}, "content": content}}


def wf_user(ts, ends=False):
    o = {"type": "user", "timestamp": _iso(ts), "message": {"content": "x"}}
    if ends:
        o["toolEndsTurn"] = True
    return o


class Workflows(unittest.TestCase):
    NOW = 1_800_000_000.0

    def setUp(self):
        os.makedirs(common.CACHE_DIR, exist_ok=True)
        self.root = tempfile.mkdtemp(prefix="wf-")
        self.parent = os.path.join(self.root, "sess-1.jsonl")
        self.run_id = "wf-test-" + self._testMethodName
        self.base = os.path.join(self.root, "sess-1", "subagents", "workflows")
        self.run_dir = os.path.join(self.base, self.run_id)
        os.makedirs(self.run_dir)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        for rid in (self.run_id, "wf-old"):
            try:
                os.remove(os.path.join(common.CACHE_DIR, f"wf-{rid}.json"))
            except OSError:
                pass

    def _agent(self, aid, desc, phase, rows=None, mtime=None, run_dir=None):
        d = run_dir or self.run_dir
        meta = os.path.join(d, f"agent-{aid}.meta.json")
        with open(meta, "w", encoding="utf-8") as f:
            json.dump({"agentType": "general-purpose", "description": desc, "workflowPhase": phase}, f, ensure_ascii=False)
        if rows is not None:
            _jl(os.path.join(d, f"agent-{aid}.jsonl"), rows, "w")
        if mtime is not None:
            # run 之間的新舊看檔案修改時間，測試要自己控制，不能讓它跟著真實時間走
            for name in os.listdir(d):
                os.utime(os.path.join(d, name), (mtime, mtime))

    def _scan(self, now=None, stall=600):
        return workflows.scan_run(self.run_dir, self.parent, now or self.NOW, stall)

    def test_agent_states(self):
        """結束回合的工具結果＝完成；最近有動靜＝執行中；太久沒動靜＝停滯；還沒開始寫紀錄＝待開始；依開始時間排、未開始的在最後。"""
        n = self.NOW
        self._agent("d", "做完的", "盤點", [wf_user(n - 500), wf_assistant(n - 480, "r1", 40, "Read"), wf_user(n - 470, ends=True)])
        self._agent("r", "進行中的", "盤點", [wf_user(n - 100), wf_assistant(n - 20, "r2", 30, "Grep")])
        self._agent("s", "卡住的", "彙整", [wf_user(n - 4000), wf_assistant(n - 3900, "r3", 5, "Bash")])
        self._agent("p", "還沒開始的", "彙整")
        for name, age in (("agent-d.jsonl", 470), ("agent-r.jsonl", 20), ("agent-s.jsonl", 3900)):
            os.utime(os.path.join(self.run_dir, name), (n - age, n - age))
        run = self._scan()
        by = {a["id"]: a for a in run["agents"]}
        self.assertEqual({k: v["state"] for k, v in by.items()}, {"d": "done", "r": "running", "s": "stalled", "p": "pending"})
        self.assertEqual(run["counts"], {"done": 1, "running": 1, "stalled": 1, "pending": 1})
        self.assertEqual((run["total"], run["state"]), (4, "running"))
        self.assertEqual([a["id"] for a in run["agents"]], ["s", "d", "r", "p"])
        self.assertAlmostEqual(by["d"]["seconds"], 30, delta=1)
        self.assertAlmostEqual(by["r"]["seconds"], 100, delta=1)
        self.assertEqual((by["d"]["tools"], by["d"]["lastTool"], by["d"]["outputTokens"]), (1, "Read", 40))
        self.assertEqual(by["r"]["phase"], "盤點")
        self.assertEqual(by["p"]["seconds"], 0)

    def test_all_done_run_has_end_time_and_no_row_summary(self):
        """全部完成的 run 狀態是 done、有結束時間；總覽每列的進度只看還沒跑完的 run。"""
        n = self.NOW
        self._agent("a", "甲", "盤點", [wf_user(n - 300), wf_user(n - 200, ends=True)], mtime=n - 200)
        run = self._scan()
        self.assertEqual(run["state"], "done")
        self.assertAlmostEqual(run["endedAt"], n - 200, delta=1)
        self.assertIsNone(workflows.row_summary([run]))

    def test_launch_name_and_summary_come_from_parent_transcript(self):
        """名稱與說明在母 session 紀錄檔的 Workflow 工具結果裡。"""
        n = self.NOW
        _jl(self.parent, [{"type": "user", "message": {"content": "x"}},
                          {"type": "user", "toolUseResult": {"runId": self.run_id, "workflowName": "audit-demo", "summary": "稽核示範", "taskId": "wf-9"}}], "w")
        self._agent("a", "甲", "盤點", [wf_user(n - 10), wf_assistant(n - 5, "r1", 1)], mtime=n - 5)
        run = self._scan()
        self.assertEqual((run["name"], run["summary"], run["taskId"]), ("audit-demo", "稽核示範", "wf-9"))

    def test_launch_is_retried_after_a_minute(self):
        """工作流程剛開始時母紀錄檔還沒有啟動結果：先用 run 編號當名稱，隔一分鐘以上再翻一次。"""
        n = self.NOW
        _jl(self.parent, [{"type": "user", "message": {"content": "x"}}], "w")
        self._agent("a", "甲", "盤點", [wf_user(n - 10), wf_assistant(n - 5, "r1", 1)], mtime=n - 5)
        self.assertEqual(self._scan(n)["name"], self.run_id)
        _jl(self.parent, [{"type": "user", "toolUseResult": {"runId": self.run_id, "workflowName": "late-name", "summary": "", "taskId": "t"}}])
        self.assertEqual(self._scan(n + 10)["name"], self.run_id)
        self.assertEqual(self._scan(n + 61)["name"], "late-name")

    def test_output_tokens_deduplicated_and_parsing_incremental(self):
        """同一個請求拆成多列只算一次；紀錄檔追加後只讀新增的部分；寫到一半的列補完整才算。"""
        n = self.NOW
        self._agent("a", "甲", "盤點", [wf_user(n - 60), wf_assistant(n - 50, "r1", 5, "Read"), wf_assistant(n - 49, "r1", 12)], mtime=n - 49)
        first = self._scan(n)["agents"][0]
        self.assertEqual((first["outputTokens"], first["tools"]), (12, 1))
        p = os.path.join(self.run_dir, "agent-a.jsonl")
        _jl(p, [wf_assistant(n - 30, "r2", 7, "Grep")])
        second = self._scan(n)["agents"][0]
        self.assertEqual((second["outputTokens"], second["tools"], second["lastTool"]), (19, 2, "Grep"))
        full = json.dumps(wf_assistant(n - 10, "r3", 100, "Edit"), ensure_ascii=False)
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(full[:30])
        self.assertEqual(self._scan(n)["agents"][0]["outputTokens"], 19)
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(full[30:] + "\n")
        third = self._scan(n)["agents"][0]
        self.assertEqual((third["outputTokens"], third["tools"], third["lastTool"]), (119, 3, "Edit"))

    def test_collect_session_newest_first_and_row_summary(self):
        """一個 session 的多個 run 新的在前；總覽進度取最新一個還沒跑完的；沒有工作流程資料夾回傳空清單。"""
        n = self.NOW
        old_dir = os.path.join(self.base, "wf-old")
        os.makedirs(old_dir)
        self._agent("x", "舊的", "盤點", [wf_user(n - 9000), wf_user(n - 8000, ends=True)], mtime=n - 8000, run_dir=old_dir)
        self._agent("a", "新的", "盤點", [wf_user(n - 100), wf_assistant(n - 20, "r1", 3, "Read")], mtime=n - 20)
        runs = workflows.collect_session(self.parent, n, 600)
        self.assertEqual([r["runId"] for r in runs], [self.run_id, "wf-old"])
        s = workflows.row_summary(runs)
        self.assertEqual((s["name"], s["done"], s["total"], s["running"]), (self.run_id, 0, 1, 1))
        self.assertIsNone(workflows.row_summary(runs[1:]))
        self.assertEqual(len(workflows.collect_session(self.parent, n, 600, limit=1)), 1)
        self.assertEqual(workflows.collect_session(os.path.join(self.root, "none.jsonl"), n, 600), [])
        self.assertEqual(workflows.collect_session(None, n, 600), [])


class IsoTime(unittest.TestCase):
    def test_seven_digit_fraction_and_timezone(self):
        """Codex 的時間有 7 位小數，且要能換算時區。"""
        self.assertAlmostEqual(common.iso_to_epoch("2026-10-16T14:15:21.4441385Z"), 1792160121.4441385, places=3)
        self.assertEqual(common.iso_to_epoch("2026-10-16T22:15:21+08:00"), common.iso_to_epoch("2026-10-16T14:15:21Z"))
        self.assertIsNone(common.iso_to_epoch("不是時間"))


if __name__ == "__main__":
    unittest.main()
