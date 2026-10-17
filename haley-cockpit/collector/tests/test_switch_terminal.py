# 路徑： collector\tests\test_switch_terminal.py
# switch_terminal.ps1 的決策測試：用假的分頁清單與脈絡檔乾跑（不碰真實視窗），驗證標題比對、排除法、順序推定與找不到時的回報。
# 只在 Windows 上跑（需要 Windows PowerShell 5.1）。用法：python -X utf8 -B -m unittest discover -s collector/tests -v
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "switch_terminal.ps1")
POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def tab(index, name, hwnd=1, pid=100, selected=False):
    return {"hwnd": hwnd, "pid": pid, "index": index, "name": name, "selected": selected}


def claimant(titles, started=0, pids=None):
    return {"titles": titles, "pids": pids or [], "startedAt": started}


@unittest.skipUnless(sys.platform == "win32" and os.path.exists(POWERSHELL), "需要 Windows PowerShell 5.1")
class SwitchTerminal(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="haley-switch-ps-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_ps(self, tabs, target, others=()):
        tabs_path = os.path.join(self.dir, "tabs.json")
        ctx_path = os.path.join(self.dir, "ctx.json")
        with open(tabs_path, "w", encoding="utf-8") as f:
            json.dump(tabs, f, ensure_ascii=False)
        with open(ctx_path, "w", encoding="utf-8") as f:
            json.dump({"target": target, "others": list(others)}, f, ensure_ascii=False)
        p = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-TabsFile", tabs_path,
                            "-ContextFile", ctx_path], capture_output=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr.decode("utf-8", "replace"))
        return json.loads(p.stdout.decode("utf-8"))

    def test_file_has_bom(self):
        """含 BOM：Windows PowerShell 5.1 才不會把檔案裡的中文讀壞。"""
        with open(SCRIPT, "rb") as f:
            self.assertEqual(f.read(3), b"\xef\xbb\xbf")

    def test_title_match_ignores_status_glyph_and_case(self):
        """分頁前面的狀態符號與大小寫不影響比對。"""
        tabs = [tab(0, "✳ 整理文件"), tab(1, "◐ Demo Exchange")]
        r = self.run_ps(tabs, claimant(["demo exchange"]))
        self.assertTrue(r["ok"])
        self.assertEqual((r["how"], r["index"], r["ambiguous"]), ("title", 1, False))

    def test_fresh_session_tab_is_claude_code(self):
        """還沒有對話的新 session，分頁固定叫 Claude Code。"""
        r = self.run_ps([tab(0, "✳ 整理文件"), tab(1, "✳ Claude Code")], claimant(["Claude Code"]))
        self.assertEqual((r["how"], r["index"]), ("title", 1))

    def test_elimination_when_tab_was_renamed_by_user(self):
        """分頁被使用者改過名（標題比不到）：其他 session 都對上後，剩下唯一的分頁就是它。"""
        tabs = [tab(0, "◑ 整理舊文件的過時內容"), tab(1, " 我的自訂分頁名稱")]
        r = self.run_ps(tabs, claimant(["執行卡與審查請求"]), [claimant(["整理舊文件的過時內容"])])
        self.assertTrue(r["ok"])
        self.assertEqual((r["how"], r["index"], r["ambiguous"]), ("elimination", 1, False))

    def test_no_match_reports_tab_names(self):
        """比不到、也排除不出唯一一個時，不亂選，回報找不到並附上分頁名稱供使用者對照。"""
        tabs = [tab(0, "分頁甲"), tab(1, "分頁乙"), tab(2, "分頁丙")]
        r = self.run_ps(tabs, claimant(["完全不同的標題"]), [claimant(["分頁甲"])])
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "no_match")
        self.assertEqual(len(r["tabs"]), 3)

    def test_order_guess_is_marked_uncertain(self):
        """兩個 session 都比不到、剛好兩個分頁：依啟動順序對應分頁順序，並標為不確定。"""
        tabs = [tab(0, "甲甲甲甲"), tab(1, "乙乙乙乙")]
        r = self.run_ps(tabs, claimant(["完全不同一"], started=200), [claimant(["完全不同二"], started=100)])
        self.assertTrue(r["ok"])
        self.assertEqual((r["how"], r["index"], r["ambiguous"]), ("order", 1, True))

    def test_duplicate_titles_are_ambiguous(self):
        """兩個分頁標題相同時選第一個，並標為不確定。"""
        r = self.run_ps([tab(0, "✳ Claude Code"), tab(1, "✳ Claude Code")], claimant(["Claude Code"]))
        self.assertEqual((r["how"], r["index"], r["ambiguous"]), ("title", 0, True))

    def test_other_session_keeps_its_unique_tab(self):
        """兩個 session 標題相同：其中一個已經唯一對上分頁時，另一個選剩下那個。"""
        tabs = [tab(0, "✳ 共同標題"), tab(1, "✳ 共同標題 補充")]
        r = self.run_ps(tabs, claimant(["共同標題"]), [claimant(["共同標題 補充"])])
        self.assertEqual((r["how"], r["index"]), ("title", 0))

    def test_no_wt_window(self):
        """沒有任何 Windows Terminal 分頁時，回報 no_wt_window。"""
        r = self.run_ps([], claimant(["任何標題"]))
        self.assertEqual(r["error"], "no_wt_window")


if __name__ == "__main__":
    unittest.main()
