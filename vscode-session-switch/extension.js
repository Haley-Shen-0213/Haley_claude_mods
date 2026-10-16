// 路徑： extension.js
// haley-session-switch：監看 ~/.claude/haley-cockpit/switch-request.json（haley-cockpit 的 /session-board 點一列時寫入），
// 在本視窗的終端機裡找出程序編號落在請求 pids 中的那一個並切過去；找到的視窗才回寫 switch-ack.json，其他視窗不動。
'use strict'
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

// HALEY_COCKPIT_DATA 只給測試用，與收集器同一個約定
const DIR = process.env.HALEY_COCKPIT_DATA || path.join(os.homedir(), '.claude', 'haley-cockpit')
const REQUEST = path.join(DIR, 'switch-request.json')
const ACK = path.join(DIR, 'switch-ack.json')
// 比這更舊的請求不理：VS Code 重新載入或剛開啟時，不要把幾分鐘前的點擊又執行一次
const FRESH_MS = 15000

let log = null
let lastId = null
let pending = null

function stamp() {
  return new Date().toLocaleTimeString()
}

function activate(context) {
  log = vscode.window.createOutputChannel('Haley Session Switch')
  fs.mkdirSync(DIR, { recursive: true })
  // 監看資料夾而不是檔案：檔案可能還不存在，mod 每次也是整份覆寫（覆寫會換掉檔案，監看檔案本身會失效）
  const watcher = fs.watch(DIR, (event, filename) => {
    if (filename && filename !== 'switch-request.json') return
    // 一次寫入常觸發兩三個事件，合併成一次處理
    clearTimeout(pending)
    pending = setTimeout(() => void handle(), 50)
  })
  context.subscriptions.push({ dispose: () => watcher.close() })
  context.subscriptions.push(vscode.commands.registerCommand('haleySessionSwitch.showLog', () => log.show()))
  log.appendLine(`${stamp()} 啟用，監看 ${REQUEST}`)
}

async function handle() {
  let req
  try {
    req = JSON.parse(fs.readFileSync(REQUEST, 'utf8'))
  } catch {
    return
  }
  if (!req || !req.id || req.id === lastId || !Array.isArray(req.pids)) return
  if (Date.now() - Number(req.at || 0) > FRESH_MS) return
  lastId = req.id
  // pids 是 session 程序與它的祖先鏈（claude.exe ← powershell.exe ← …）；終端機的 processId 是 shell 的 pid，會落在鏈上
  const wanted = new Set(req.pids.map(Number))
  for (const term of vscode.window.terminals) {
    let pid
    try {
      pid = await term.processId
    } catch {
      pid = undefined
    }
    if (pid && wanted.has(pid)) {
      term.show(false)
      writeAck({ id: req.id, ok: true, terminal: term.name, pid, at: Date.now() })
      log.appendLine(`${stamp()} 切換到「${term.name}」（pid ${pid}，${req.project || ''}）`)
      return
    }
  }
  log.appendLine(`${stamp()} 本視窗沒有程序編號 ${[...wanted].join('、')} 的終端機（${req.project || ''}）`)
}

function writeAck(obj) {
  const tmp = `${ACK}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  fs.renameSync(tmp, ACK)
}

function deactivate() {}

module.exports = { activate, deactivate }
