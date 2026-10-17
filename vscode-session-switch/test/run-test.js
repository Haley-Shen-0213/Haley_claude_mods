// 路徑： test\run-test.js
// 用假的 vscode 模組測 extension.js（不需安裝任何套件）：啟用後狀態列顯示用量（含 Fable）、面板列出每個 session 且名稱同終端機分頁、
// 面板點一列切到相符的終端機（開在 Windows Terminal 的改叫切換程式，powershell 用假的）、
// 處理 /session-board 的切換請求（相符才回寫 ack、太舊的不理）、終端機名稱寫給收集器。用法：node test/run-test.js
'use strict'
const Module = require('module')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haley-switch-'))
process.env.HALEY_COCKPIT_DATA = tmp
delete process.env.CLAUDE_CODE_PLUGIN_DIRS
const NOW = Math.floor(Date.now() / 1000)
const BOARD = {
  now: NOW,
  stallMinutes: 10,
  counts: { running: 1, idle: 2, stalled: 0, unknown: 0 },
  usage: {
    claude: {
      five_hour: { used: 7, resetsAt: NOW + 3600 },
      seven_day: { used: 85, resetsAt: NOW + 86400 },
      models: [{ label: 'Fable', used: 37, resetsAt: NOW + 86400 * 2, seenAt: NOW - 60 }],
    },
    codex: { primary: { used: 35, resetsAt: NOW + 86400, windowMinutes: 10080 }, secondary: null },
  },
  sessions: [
    { no: 1, host: 'vscode', tool: 'claude', pid: 11, pids: [11, 100], state: 'running', title: '中控', project: 'alpha', pendingTools: [], lastActivity: NOW - 3 },
    { no: 2, host: 'vscode', tool: 'codex', pid: 22, pids: [22, 200], state: 'idle', title: '審查', project: 'beta', pendingTools: [], lastActivity: NOW - 600 },
    { no: 3, host: 'wt', tabTitles: ['Gamma 分頁'], tool: 'claude', pid: 33, pids: [33, 34], state: 'idle', title: 'Gamma 分頁', project: 'gamma', pendingTools: [], lastActivity: NOW - 900, startedAt: NOW - 5000 },
  ],
}
// 假的收集程式：只把固定的總覽印出來
const cli = path.join(tmp, 'fake_cli.py')
fs.writeFileSync(cli, `import sys\nsys.stdout.reconfigure(encoding="utf-8")\nsys.stdout.write(${JSON.stringify(JSON.stringify(BOARD))})\n`, 'utf8')

const shown = []
const posted = []
const messages = []
const psCalls = []
const statusItems = {}
let provider = null
const terminal = (name, pid) => ({ name, processId: Promise.resolve(pid), show: () => shown.push(name) })
const settings = { collectorPath: cli, python: 'python', refreshSeconds: 5, statusBar: true }
const disposable = { dispose() {} }
const fake = {
  window: {
    terminals: [terminal('✳ Alpha 中控台', 100), terminal('Beta 審查', 200)],
    activeTerminal: null,
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    createStatusBarItem: id => (statusItems[id] = { id, text: '', visible: false, show() { this.visible = true }, hide() { this.visible = false }, dispose() {} }),
    registerWebviewViewProvider: (id, p) => {
      provider = p
      return disposable
    },
    onDidOpenTerminal: () => disposable,
    onDidCloseTerminal: () => disposable,
    onDidChangeActiveTerminal: () => disposable,
    setStatusBarMessage: text => {
      messages.push(text)
      return disposable
    },
    showWarningMessage: async text => {
      messages.push(text)
    },
  },
  workspace: { name: '測試視窗', getConfiguration: () => ({ get: key => settings[key] }), onDidChangeConfiguration: () => disposable },
  commands: { registerCommand: () => disposable, executeCommand: async () => undefined },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id
    }
  },
  MarkdownString: class {
    constructor(value) {
      this.value = value
    }
  },
  Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
}
// 切換程式（powershell）換成假的：記下參數與脈絡檔內容，回一行像真的一樣的 JSON；其他程式（python）照常執行
const realCp = require('child_process')
const fakeCp = {
  ...realCp,
  execFile: (cmd, args, opts, cb) => {
    if (cmd !== 'powershell') return realCp.execFile(cmd, args, opts, cb)
    const ctx = JSON.parse(fs.readFileSync(args[args.indexOf('-ContextFile') + 1], 'utf8'))
    psCalls.push({ args, ctx })
    cb(null, '雜訊一行\n' + JSON.stringify({ ok: true, how: 'title', tab: 'Gamma 分頁 ', foreground: true }), '')
    return undefined
  },
}
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fake
  if (request === 'child_process') return fakeCp
  return load.call(this, request, ...rest)
}

const ext = require('../extension.js')
const context = { subscriptions: [], extensionUri: { fsPath: path.join(__dirname, '..') } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const request = obj => fs.writeFileSync(path.join(tmp, 'switch-request.json'), JSON.stringify(obj))

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(100)
  }
  throw new Error('等待逾時')
}

;(async () => {
  let failed = false
  try {
    ext.activate(context)
    await waitFor(() => statusItems['haleyCockpit.c5'] && statusItems['haleyCockpit.c5'].visible)
    assert.ok(statusItems['haleyCockpit.c5'].text.includes('Claude 5h'), '狀態列有 Claude 5h')
    assert.strictEqual(statusItems['haleyCockpit.c5'].color.id, 'charts.green')
    assert.strictEqual(statusItems['haleyCockpit.c7'].color.id, 'charts.red')
    assert.strictEqual(statusItems['haleyCockpit.x1'].text, 'Codex 7d ▰▰▱▱▱ 35%')
    assert.strictEqual(statusItems['haleyCockpit.m0'].text, 'Fable 7d ▰▰▱▱▱ 37%')
    assert.strictEqual(statusItems['haleyCockpit.m0'].color.id, 'charts.green')
    assert.ok(statusItems['haleyCockpit.sessions'].text.includes('3 個 session'))

    const view = {
      visible: true,
      webview: {
        options: null,
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: u => u.fsPath,
        postMessage: m => {
          posted.push(m)
          return Promise.resolve(true)
        },
        onDidReceiveMessage: fn => {
          view.onMessage = fn
          return disposable
        },
      },
      onDidChangeVisibility: () => disposable,
      onDidDispose: () => disposable,
    }
    provider.resolveWebviewView(view)
    assert.ok(view.webview.html.includes("script-src 'nonce-"), '面板有內容安全政策')
    await waitFor(() => posted.some(m => m.type === 'render' && m.html.includes('Alpha 中控台')))
    const html = posted[posted.length - 1].html
    assert.ok(html.includes('Beta 審查'), '名稱與終端機分頁相同')
    assert.ok(html.indexOf('Alpha 中控台') < html.indexOf('Beta 審查'), '依分頁順序排列')

    view.onMessage({ type: 'switch', key: 'codex:22' })
    await waitFor(() => shown.includes('Beta 審查'))
    assert.strictEqual(psCalls.length, 0, 'VS Code 裡的 session 不該跑 Windows Terminal 的切換程式')

    // 開在 Windows Terminal 的 session：交給切換程式，脈絡檔帶分頁名稱，結果顯示在狀態列訊息，不動 VS Code 的終端機
    const shownBefore = shown.length
    view.onMessage({ type: 'switch', key: 'claude:33' })
    await waitFor(() => psCalls.length === 1 && messages.some(m => m.includes('已切換到分頁「Gamma 分頁」')))
    assert.ok(psCalls[0].args.includes('-ContextFile'))
    assert.ok(psCalls[0].args.some(a => a.endsWith('switch_terminal.ps1')))
    assert.deepStrictEqual(psCalls[0].ctx, { target: { titles: ['Gamma 分頁'], pids: [33, 34], startedAt: NOW - 5000 }, others: [] })
    assert.strictEqual(shown.length, shownBefore)
    assert.ok(!fs.existsSync(path.join(tmp, 'switch-request.json')), 'Windows Terminal 的切換不走 VS Code 的切換請求')

    request({ id: 't1', at: Date.now(), pids: [999, 100], project: 'alpha' })
    await waitFor(() => shown.includes('✳ Alpha 中控台'))
    const ack = JSON.parse(fs.readFileSync(path.join(tmp, 'switch-ack.json'), 'utf8'))
    assert.strictEqual(ack.id, 't1')
    assert.strictEqual(ack.ok, true)

    request({ id: 't2', at: Date.now() - 60000, pids: [200] })
    await sleep(400)
    assert.strictEqual(shown.filter(n => n === 'Beta 審查').length, 1, '太舊的請求不理')

    const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'terminals', `terminals-${process.pid}.json`), 'utf8'))
    assert.deepStrictEqual(doc.terminals.map(t => [t.pid, t.name]), [[100, 'Alpha 中控台'], [200, 'Beta 審查']])
    assert.strictEqual(doc.window, '測試視窗')
    console.log('通過：狀態列（含 Fable）、面板、面板點擊切換（VS Code 與 Windows Terminal）、切換請求、終端機名稱回報')
  } catch (err) {
    failed = true
    console.error('失敗：', err.message)
  } finally {
    for (const d of context.subscriptions) d.dispose()
    ext.deactivate()
    fs.rmSync(tmp, { recursive: true, force: true })
    process.exit(failed ? 1 : 0)
  }
})()
