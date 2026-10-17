# Haley Claude Mods

自製的 Claude Code mods 與配套工具（非官方）。目前收錄：

| 資料夾 | 是什麼 |
|---|---|
| [`haley-cockpit/`](haley-cockpit/) | Claude Code mod「駕駛艙」：本機所有 Claude／Codex session 的總覽與帳號用量、編輯熱點、子代理、回合時間軸、git worktree，另附一支狀態列程式 |
| [`vscode-session-switch/`](vscode-session-switch/) | 配套的 VS Code 擴充：狀態列右側顯示用量；右側欄「Claude 駕駛艙」每個 session 一條進度條，名稱和終端機分頁相同，點一下切到該終端機 |

> ⚠️ **使用前請先讀完下方〈免責聲明〉。** 這是個人工具，不是官方產品。

## 免責聲明

1. **非官方**：本專案是個人自製的工具，與 Anthropic、OpenAI、Microsoft 沒有任何關係，也未經它們審核、認可或背書。Claude、Claude Code、Codex、ChatGPT、Visual Studio Code 等名稱與商標屬於各自的所有者。
2. **API 可能變動**：Claude Code 的 mod（函式掛鉤外掛）API 目前是搶先體驗（early access），官方註明各版本之間可能變動而不另行通知。本專案只在這個環境測試過：Windows 11、Claude Code 2.1.301／2.1.302、Codex CLI 0.163、VS Code 1.138、Python 3.13。其他版本或平台可能部分或完全無法運作。
3. **依現狀提供，不負擔保責任**：本專案依「現狀」提供，不附任何明示或默示的保證，包括但不限於適售性、特定用途適用性與不侵權。因使用或無法使用本專案而產生的任何直接或間接損失，例如資料遺失、帳號用量或費用消耗、工作中斷、設定檔損壞，作者概不負責；使用風險由使用者自行承擔。[MIT 授權條款](LICENSE)中的免責條款同樣適用，以英文原文為準。
4. **會讀取你的 session 紀錄**：為了顯示進度，本工具會在你的電腦上讀取 Claude Code 與 Codex 的 session 紀錄檔（`~/.claude/projects/`、`~/.codex/sessions/` 等），這些檔案可能含有你的程式碼、提示與 AI 回覆。所有解析都在本機進行：本工具不連網、不上傳，也不修改那些紀錄檔。但面板會在畫面上顯示 session 標題與待辦項目的文字，在共用螢幕、錄影或受管理的電腦上使用前，請自行評估風險。完整清單見〈會讀寫哪些檔案〉。
5. **數字是推算的**：用量百分比、重置倒數、預估剩餘時間與停滯判斷，都是依本機紀錄，以及各 session 最近一次收到的回應推算，可能落後，也可能與官方顯示不同。請以官方介面（例如 Claude Code 的 `/usage`）為準，不要依這些數字做計費或排程決策。
6. **不保證維護**：本專案可能隨時停止更新，也可能不經通知修改或移除功能。

## haley-cockpit（Claude Code mod）

### 功能

| 指令 | 面板內容 |
|---|---|
| `/session-board` | 頂端是 Claude 5 小時／7 天與 Codex 額度的彩色進度條、重置倒數與近期走勢。下方是本機每個 Claude 與 Codex session 一列：狀態（執行中／閒置／停滯）、名稱、任務標題、迷你進度條與預估剩餘時間、context 使用比例、本回合已執行多久、最後動作距今。每 5 秒更新。點一列（或在面板內按 1～9）切到該 session 的 VS Code 終端機。裝了 `vscode-session-switch` 時，名稱會和 VS Code 終端機分頁清單相同；沒裝時用專案資料夾名。 |
| `/edit-heatmap` | 本 session 各檔案被 Edit／Write 成功修改的次數排行。從 session 紀錄檔重建，mod 重新載入也不會歸零；可切換成「所有存活的 session」。 |
| `/agent-board` | 本 session 的子代理：類型、任務、狀態、已執行時間。點一列就在主畫面檢視那個子代理的對話。 |
| `/turn-timeline` | 本 session 每個回合的開始時間、耗時長條、輸出 token、API 呼叫數、工具次數，以及是否中斷或以錯誤結束。 |
| `/worktree-map` | 目前 repo 的 git worktree：路徑、分支、HEAD、鎖定或可清除狀態，並標出本 session 所在的那一個。 |

狀態列（選用，`haley-cockpit/collector/statusline.py`）：

```
Claude 5h █████▍░░░░ 54% ↻2時12分  7d ████▎░░░░░ 43% ↻4天22時 │ Codex 7d ███▌░░░░░░ 35% ↻5天6時
ctx ███▍░░░░░░ 34% · $3.42 │ session 7：執行中 1 · 閒置 6 · 停滯 0
```

用量顏色：低於 50% 綠、50～80% 黃、超過 80% 紅（面板相同）。在指令最後加上 `--hide-usage` 只顯示第 2 行，適合已經用 VS Code 擴充在狀態列右側看用量的人。

### 判斷規則

- **執行中**：Claude 是 `~/.claude/sessions/<pid>.json` 的狀態為 busy；Codex 是最後一個任務事件為 `task_started`。
- **停滯**：執行中，但超過門檻（預設 10 分鐘，可在 `/config` 調整）沒有任何新紀錄。執行很久的指令（例如長時間的測試）也會被標成停滯，面板會同時顯示正在等哪個工具。
- **閒置**：正在等使用者輸入。
- **預估剩餘時間**：只在 session 有待辦清單時估算（Claude 的 TodoWrite／TaskCreate、Codex 的計畫步驟）：剩餘 ≈ 已耗時 ÷ 已完成 × 未完成。沒有清單時顯示「無計畫」。
- **Codex 的對應方式**：Codex 的紀錄檔不記錄程序編號，所以用「codex.exe 啟動時間與 rollout 檔名時間相差 15 秒內」來對應。用 `codex resume` 接續的舊 session 可能對應不到，會顯示「未對應」。
- **Claude 用量**：每個 session 只知道自己最近一次 API 回應時的數字。本工具把各 session 看到的值合併（同一個計量視窗取最大值），所以只要任何一個 session 收到新回應，所有面板與狀態列都會更新。
- **context 比例**：以 session 紀錄檔裡最後一次請求的輸入 token（含快取）除以視窗大小，算法與官方狀態列相同；視窗大小（例如 100 萬）由各 session 的狀態列回報。不直接採用官方狀態列給閒置 session 的值，因為剛壓縮（`/compact`）完、下一次請求之前，它會把「未知」顯示成 0%（實測：花費上百美元的 session 也是 0%）。這種剛壓縮完的 session，本工具的 context 欄位留白，直到下一次請求。Codex 用 rollout 裡 token 事件的最近一次請求與視窗大小計算。
- **不在終端機裡的 session**：登記檔的 `entrypoint` 不是 `cli` 的 Claude session（例如 VS Code 的 Claude 面板在背景開的）不在任何終端機裡，點了也切不過去，所以不列進總覽，也不算進 session 數。

### 需求

- Windows 10／11（偵測程序用的是 Windows API；在其他系統目前讀不到任何 session）
- Claude Code 2.1.287 以上（mod API；測試於 2.1.301、2.1.302）
- Python 3.10 以上（只用標準函式庫，不需安裝套件）
- 選用：Codex CLI（顯示 Codex 的 session 與額度）、VS Code（點一列切換終端機）

### 安裝

**方法一：從本 repo 安裝。** 在 Claude Code 的提示列輸入：

```
/plugin install haley-cockpit --marketplace Haley-Shen-0213/Haley_claude_mods
```

或在終端機執行：

```
claude plugin install haley-cockpit --marketplace Haley-Shen-0213/Haley_claude_mods
```

**方法二：clone 後從資料夾載入**（方便自行修改，存檔就會熱重載）。在 `~/.claude/settings.json` 加入下面這段，之後新開的 session 都會載入：

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:/path/to/Haley_claude_mods/haley-cockpit" }
}
```

**設定**（`/config` 裡 haley-cockpit 的欄位）：

- `stallMinutes`：停滯門檻（分鐘），預設 10；狀態列也讀這個值。
- `python`：執行收集程式用的 Python，預設 `python`；不在 PATH 上時填完整路徑。

**狀態列（選用）**：在 `~/.claude/settings.json` 加入下面這段，路徑換成你的位置並使用正斜線（Windows 上 Claude Code 會經 Git Bash 執行這個指令）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "python -X utf8 -B C:/path/to/Haley_claude_mods/haley-cockpit/collector/statusline.py",
    "refreshInterval": 30
  }
}
```

用方法一安裝的副本放在 Claude Code 的外掛快取資料夾，路徑會隨版本改變；要用狀態列的話，建議另外 clone 一份來指向。

**VS Code 擴充（選用）**：見 [`vscode-session-switch/README.md`](vscode-session-switch/README.md)。

### 會讀寫哪些檔案

只讀：

- `~/.claude/sessions/*.json`：Claude Code 的存活 session 登記表（狀態、名稱、工作目錄、程序編號）
- `~/.claude/projects/*/<session>.jsonl`：Claude session 紀錄檔；只擷取回合時間、待辦項目、工具名稱與編輯的檔案路徑、token 數，不擷取提示與回覆內文
- `~/.claude/settings.json`：只讀 `pluginConfigs` 裡本外掛的設定值
- `~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/session_index.jsonl`：Codex 的紀錄與標題
- Windows 的程序清單：程序編號、父程序、執行檔名、啟動時間

會寫入（全部在 `~/.claude/haley-cockpit/`）：

- `usage.json`、`usage_history.jsonl`：用量快取與走勢樣本（保留 8 天）
- `ctx/<session>.json`：各 Claude session 的狀態列回報的 context 比例與花費（每個 session 一個小檔，可隨時刪除）
- `terminals/terminals-<程序編號>.json`：VS Code 擴充回報的終端機名稱（每個 VS Code 視窗一份，關閉視窗時刪除）
- `cache/`：紀錄檔的增量解析結果（數字、待辦文字、檔案路徑）
- `switch-request.json`、`switch-ack.json`：和 VS Code 擴充交換的切換請求與回覆
- `statusline-error.log`：狀態列出錯時的錯誤訊息

除此之外不連網，也不修改任何 session 紀錄檔、設定檔或專案檔案。

### 移除

1. 方法一：`/plugin uninstall haley-cockpit`；方法二：從 `settings.json` 刪掉 `CLAUDE_CODE_PLUGIN_DIRS`。
2. 有設定狀態列的話，從 `settings.json` 刪掉 `statusLine`。
3. 刪除 `~/.claude/haley-cockpit/` 資料夾。

## 開發與測試

```
claude plugin validate haley-cockpit
claude plugin test haley-cockpit
python -X utf8 -B -m unittest discover -s haley-cockpit/collector/tests -v
node vscode-session-switch/test/lib-test.js
node vscode-session-switch/test/run-test.js
```

測試資料一律用虛構名稱；測試不會碰真正的用量快取（資料夾導到暫存區，結束時刪除）。

每個原始碼檔第一行的「路徑」相對於該元件自己的資料夾（`haley-cockpit/` 或 `vscode-session-switch/`）。

## 授權

[MIT](LICENSE)：可以自由使用、修改、再散布，包括商業用途，條件是保留著作權與授權聲明；本專案不提供任何保證。條文以英文原文為準。
