# 路徑： collector\tests\test_cockpit.py
# 收集程式核心計算的單元測試（標準函式庫 unittest，不需安裝套件）：context 比例、壓縮後歸零、非終端機 session 過濾、終端機名稱對應、用量合併、ISO 時間。
# 用法：python -X utf8 -B -m unittest discover -s collector/tests -v（在 haley-cockpit 資料夾下執行）
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

from cockpit import board, claude_sessions, codex_sessions, common, usage  # noqa: E402


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


class IsoTime(unittest.TestCase):
    def test_seven_digit_fraction_and_timezone(self):
        """Codex 的時間有 7 位小數，且要能換算時區。"""
        self.assertAlmostEqual(common.iso_to_epoch("2026-10-16T14:15:21.4441385Z"), 1792160121.4441385, places=3)
        self.assertEqual(common.iso_to_epoch("2026-10-16T22:15:21+08:00"), common.iso_to_epoch("2026-10-16T14:15:21Z"))
        self.assertIsNone(common.iso_to_epoch("不是時間"))


if __name__ == "__main__":
    unittest.main()
