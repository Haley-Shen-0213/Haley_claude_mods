# Haley Cockpit（VS Code 擴充）

配合 Claude Code mod **haley-cockpit** 使用的 VS Code 擴充，擴充識別名稱是 `haley-shen-0213.haley-session-switch`。功能：

| 位置 | 內容 |
|---|---|
| 狀態列右側 | Claude 5 小時、7 天、模型專屬額度（例如 Fable）與 Codex 額度的迷你進度條和百分比，依用量變色（低於 50% 綠、50～80% 黃、超過 80% 紅）；滑鼠停留顯示重置時間；最後一項是 session 數與執行中、停滯數。點任一項開啟駕駛艙 |
| 右側欄「Claude 駕駛艙」 | 上方是帳號用量長條（含 Fable）；下方每個 session 一條進度條，列首是編號（和 mod 的 `/go` 編號、狀態列清單相同），名稱和終端機分頁清單相同、順序也相同。點一列（或用 Tab 移過去按 Enter）就切到那個終端機：在 VS Code 裡的切 VS Code 的終端機分頁，在 Windows Terminal 裡的選取對應分頁並把視窗帶到前景。目前所在的終端機有外框標示 |
| 背景 | 把本視窗各終端機的名稱回報給 haley-cockpit，終端機裡的 `/session-board` 因此顯示同樣的名稱；並處理 `/session-board` 與 `/go` 送來的切換請求 |

### 進度條代表什麼

- session 有待辦清單時（Claude 的 TodoWrite／TaskCreate、Codex 的計畫步驟）：完成比例，旁邊是「已完成／總數 · 約剩多久」。
- 沒有待辦清單但有工作流程（Workflow 工具）在跑：代理的完成比例，旁邊是「代理 完成數／總數 · 約剩多久」。
- 沒有待辦清單、執行中：綠色流動條，表示正在工作但無法估算進度。
- 停滯（執行中但超過門檻沒有新紀錄）：紅色長條。
- 閒置：空白長條。
- 每列另外顯示本回合已執行多久、最後動作距今、正在等哪個工具、context 使用比例。

## 運作方式

- 資料：每 5 秒（面板顯示時）或 30 秒（只有狀態列時）執行一次 haley-cockpit 的收集程式 `collector/cockpit_cli.py`，所有解析都在本機進行。
- 找收集程式的順序：設定 `haleyCockpit.collectorPath` → `~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS` → Claude Code 外掛快取中已安裝的 haley-cockpit。
- 終端機名稱：每 3 秒讀一次本視窗的終端機清單，有變動才寫進 `~/.claude/haley-cockpit/terminals/terminals-<程序編號>.json`；名稱前面 Claude 用來表示工作狀態的符號（例如 ✳）會去掉，名稱才不會一直跳動。
- 切換 VS Code 裡的 session：mod 的 `/session-board`、`/go` 把那個 session 的程序編號鏈寫進 `~/.claude/haley-cockpit/switch-request.json`；每個 VS Code 視窗都監看它，擁有對應終端機的視窗切換並回寫 `switch-ack.json`。面板裡點一列時，本視窗有就直接切，沒有就同樣寫切換請求。
- 切換 Windows Terminal 裡的 session：面板點一列時，擴充把目標與其他 session 的分頁名稱寫成脈絡檔（`switch-context-vscode-<程序編號>.json`），執行 haley-cockpit 附的 `collector/switch_terminal.ps1`（Windows PowerShell 5.1，以 UI Automation 選取分頁並提升視窗），結果顯示在狀態列訊息；失敗（找不到分頁、沒有 Windows Terminal 視窗）時跳出警告並說明原因。比對規則見上層 README〈判斷規則〉。

本擴充自己不連網，除了上面這些檔案也不讀寫其他檔案；執行紀錄在「輸出」面板的 `Haley Cockpit` 頻道（命令選擇區輸入「Haley Cockpit：顯示紀錄」）。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `haleyCockpit.statusBar` | `true` | 狀態列右側是否顯示用量與 session 數 |
| `haleyCockpit.refreshSeconds` | `5` | 駕駛艙面板顯示時的更新間隔（秒） |
| `haleyCockpit.collectorPath` | 空白 | `cockpit_cli.py` 的完整路徑；空白時自動尋找 |
| `haleyCockpit.python` | `python` | 執行收集程式用的 Python（3.10 以上） |

用量改在狀態列顯示後，終端機裡 Claude Code 狀態列的第一行可以拿掉：在 `statusLine.command` 最後加上 `--hide-usage`。

## 安裝

```
python pack.py            # 在系統暫存資料夾產生 haley-shen-0213.haley-session-switch-<版本>.vsix
code --install-extension <上一步印出的 .vsix 路徑>
```

安裝或升級後，在每個已開啟的 VS Code 視窗執行一次「Developer: Reload Window」（重新載入視窗）。終端機裡的程序不受影響，VS Code 預設會保留終端機工作階段。駕駛艙在右側的次要側邊欄：用 `Ctrl+Alt+B` 打開，或點狀態列右側的用量項目。

移除：`code --uninstall-extension haley-shen-0213.haley-session-switch`

## 限制

- 只能切換 VS Code 整合終端機與 Windows Terminal 裡的 session；舊式命令提示字元視窗、Claude 桌面 App、Codex 桌面 App 裡的 session 無法切換。不在 VS Code 裡的 session，名稱用 session 標題，不是終端機分頁名稱。
- Windows Terminal 的分頁若被你改過名稱，要靠排除法或啟動順序推定，推定時會在訊息裡註明；推定不出唯一一個時不會亂選。
- 終端機分頁清單底下那塊空白無法放東西（VS Code 沒有開放給擴充），所以用量放在狀態列右側，進度條放在右側欄。
- 有多個 VS Code 視窗時，目標視窗會切好分頁，但不保證被帶到最前面（Windows 限制背景程式搶前景）。
- 只處理請求發出後 15 秒內的切換請求。
- 次要側邊欄需要較新的 VS Code（測試於 1.138）。

## 測試

```
node test/lib-test.js
node test/run-test.js
```

用假的 `vscode` 模組、假的收集程式與假的 `powershell`（切換 Windows Terminal 用）測試，不需要安裝任何套件（`run-test.js` 需要 Python）。
