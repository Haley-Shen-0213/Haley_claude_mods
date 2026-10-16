# Haley Session Switch（VS Code 擴充）

配合 Claude Code mod **haley-cockpit** 使用：在 `/session-board` 面板點一列（或在面板內按 1～9），VS Code 就切到該 Claude／Codex session 所在的終端機分頁。

## 運作方式

1. mod 把那個 session 的程序編號鏈（例如 `claude.exe ← powershell.exe ← …`）寫進 `~/.claude/haley-cockpit/switch-request.json`。
2. 每個 VS Code 視窗裡的本擴充都監看這個檔案，逐一比對自己的終端機 `processId`（shell 的程序編號）。
3. 比對到的視窗呼叫 `terminal.show()` 切過去，並寫回 `switch-ack.json`；mod 讀到後在面板顯示「已切換」。

本擴充不連網、不讀其他檔案，只讀寫上面兩個檔案；執行紀錄在「輸出」面板的 `Haley Session Switch` 頻道（命令選擇區輸入「Haley Session Switch：顯示切換紀錄」）。

## 安裝

```
python pack.py            # 在系統暫存資料夾產生 haley-shen-0213.haley-session-switch-<版本>.vsix
code --install-extension <上一步印出的 .vsix 路徑>
```

安裝後，在每個已開啟的 VS Code 視窗執行一次「Developer: Reload Window」（重新載入視窗）才會啟用；終端機裡的程序不受影響（VS Code 預設保留終端機工作階段）。

移除：`code --uninstall-extension haley-shen-0213.haley-session-switch`

## 限制

- 只認得 VS Code 整合終端機裡的 session；Windows Terminal、Claude 桌面 App、Codex 桌面 App 裡的 session 無法切換。
- 有多個 VS Code 視窗時，目標視窗會切好分頁，但不保證被帶到最前面（Windows 限制背景程式搶前景）。
- 只比對請求發出後 15 秒內的點擊。

## 測試

```
node test/run-test.js
```

用假的 `vscode` 模組測試比對與回寫邏輯，不需要安裝任何套件。
