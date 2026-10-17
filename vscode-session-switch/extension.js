// 路徑： extension.js
// Haley Cockpit 的 VS Code 端：狀態列右側顯示帳號用量（含 Fable）；右側欄「Claude 駕駛艙」面板每個 session 一條進度條，點一下切到它的終端機
// （在 VS Code 裡的切終端機分頁，在 Windows Terminal 裡的呼叫 switch_terminal.ps1 選分頁）；
// 把本視窗各終端機的名稱回報給收集器（總覽因此能顯示和分頁清單一樣的名稱）；處理 /session-board 與 /go 送來的切換請求。
'use strict'
const vscode = require('vscode')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const lib = require('./lib')

const DIR = lib.DATA_DIR
const REQUEST = path.join(DIR, 'switch-request.json')
const ACK = path.join(DIR, 'switch-ack.json')
const TERMINALS_DIR = path.join(DIR, 'terminals')
// 每個 VS Code 視窗各有一個擴充主機程序，用它的 pid 當檔名，多個視窗互不覆蓋
const TERMINALS_FILE = path.join(TERMINALS_DIR, `terminals-${process.pid}.json`)
const FRESH_MS = 15000 // 比這更舊的切換請求不理：視窗重新載入時不要把幾分鐘前的點擊又執行一次
const IDLE_REFRESH_MS = 30000 // 面板沒顯示時，只為狀態列更新
const NAME_POLL_MS = 3000 // 終端機標題會隨工作狀態改變，沒有事件可聽，只能輪詢
const KEEPALIVE_MS = 30000 // 名稱沒變也定期重寫，收集器靠檔案時間判斷視窗是否還開著

const COLORS = { ok: 'charts.green', warn: 'charts.yellow', bad: 'charts.red' }

let log = null
let provider = null
let latest = null
let loadedAt = null
let lastError = null
let refreshing = false
let timer = null
let lastRequestId = null
let pendingRequest = null
let lastTerminalsJson = ''
let lastTerminalsWrite = 0
const items = {}

function stamp() {
  return new Date().toLocaleTimeString()
}

function config() {
  return vscode.workspace.getConfiguration('haleyCockpit')
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  fs.renameSync(tmp, file)
}

async function pidOf(terminal) {
  try {
    return await terminal.processId
  } catch {
    return undefined
  }
}

async function terminalsSnapshot() {
  const list = []
  const terms = vscode.window.terminals
  for (let i = 0; i < terms.length; i++) {
    const pid = await pidOf(terms[i])
    if (pid) list.push({ pid, name: lib.cleanName(terms[i].name), index: i })
  }
  return list
}

async function activePid() {
  const t = vscode.window.activeTerminal
  return t ? (await pidOf(t)) ?? null : null
}

/** 把本視窗的終端機名稱寫給收集器；內容有變才寫，沒變也每 30 秒重寫一次，當作「視窗還開著」。 */
async function publishTerminals() {
  try {
    const list = await terminalsSnapshot()
    const json = JSON.stringify(list)
    const now = Date.now()
    if (json === lastTerminalsJson && now - lastTerminalsWrite < KEEPALIVE_MS) return
    lastTerminalsJson = json
    lastTerminalsWrite = now
    writeJsonAtomic(TERMINALS_FILE, { at: now / 1000, window: vscode.workspace.name || '', terminals: list })
  } catch (err) {
    log.appendLine(`${stamp()} 寫入終端機名稱失敗：${err.message || err}`)
  }
}

// ---- 讀資料：執行收集程式 cockpit_cli.py ----

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // windowsHide：擴充主機沒有主控台，不加的話每次執行 python 都會閃一個黑色視窗
    execFile(cmd, args, { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || '').trim().split(/\r?\n/).pop() || '執行失敗'))
      else resolve(stdout)
    })
  })
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const cli = lib.findCollector(config().get('collectorPath') || '')
    if (!cli) {
      lastError = '找不到收集程式 cockpit_cli.py：請在設定「haleyCockpit.collectorPath」填入完整路徑'
    } else {
      const out = await run(config().get('python') || 'python', ['-X', 'utf8', '-B', cli, 'board'])
      latest = JSON.parse(out)
      loadedAt = Date.now() / 1000
      lastError = null
    }
  } catch (err) {
    lastError = String(err.message || err)
  } finally {
    refreshing = false
  }
  await render()
}

function schedule() {
  clearTimeout(timer)
  const visible = provider && provider.view && provider.view.visible
  const ms = visible ? Math.max(2, Number(config().get('refreshSeconds')) || 5) * 1000 : IDLE_REFRESH_MS
  timer = setTimeout(() => {
    void refresh().then(schedule)
  }, ms)
}

function refreshNow() {
  clearTimeout(timer)
  void refresh().then(schedule)
}

// ---- 畫面：狀態列與駕駛艙面板 ----

function item(id, priority, name) {
  if (!items[id]) {
    // 靠右對齊時，優先順序越低越靠右；排在一起，依序是 5h、7d、模型專屬額度（Fable 等）、Codex、session
    const it = vscode.window.createStatusBarItem(`haleyCockpit.${id}`, vscode.StatusBarAlignment.Right, priority)
    it.name = name
    it.command = 'haleyCockpit.open'
    items[id] = it
  }
  return items[id]
}

function updateStatusBar() {
  const show = config().get('statusBar') !== false
  const now = Date.now() / 1000
  const usage = latest ? latest.usage : null
  const tip = new vscode.MarkdownString(lastError && !latest ? `讀取失敗：${lastError}` : lib.usageTooltip(usage, now, loadedAt))
  const list = usage ? lib.usageItems(usage, now) : []
  const order = { c5: -101, c7: -102, m0: -103, m1: -104, x1: -105 }
  for (const id of Object.keys(order)) {
    const it = item(id, order[id], `Haley Cockpit：${id === 'x1' ? 'Codex' : 'Claude'} 用量`)
    const u = list.find(x => x.id === id)
    if (!show || !u) {
      it.hide()
      continue
    }
    it.text = id === 'c5' ? `$(pulse) ${u.text}` : u.text
    it.color = new vscode.ThemeColor(COLORS[u.level])
    it.tooltip = tip
    it.show()
  }
  const s = item('sessions', -106, 'Haley Cockpit：session 狀態')
  if (!show || !latest) {
    if (show && lastError) {
      s.text = '$(warning) 駕駛艙讀取失敗'
      s.tooltip = lastError
      s.color = new vscode.ThemeColor(COLORS.bad)
      s.show()
    } else {
      s.hide()
    }
    return
  }
  const c = latest.counts || {}
  const total = (latest.sessions || []).length
  s.text = `$(terminal) ${total} 個 session · 執行中 ${c.running || 0}${c.stalled ? ` · 停滯 ${c.stalled}` : ''}`
  s.color = c.stalled ? new vscode.ThemeColor(COLORS.bad) : undefined
  s.tooltip = '點一下開啟駕駛艙，看每個 session 的進度並切換終端機'
  s.show()
}

async function render() {
  updateStatusBar()
  if (!provider || !provider.view || !provider.view.visible) return
  let html
  if (latest) {
    const warn = lastError ? `<p class="warn">最近一次更新失敗：${lib.escapeHtml(lastError)}</p>` : ''
    html = warn + lib.renderBoard(latest, await terminalsSnapshot(), await activePid())
  } else {
    html = `<p class="muted">${lib.escapeHtml(lastError || '讀取中…')}</p>`
  }
  void provider.view.webview.postMessage({ type: 'render', html })
}

// ---- 切換終端機 ----

async function showByPids(pids) {
  const wanted = new Set((pids || []).map(Number))
  for (const term of vscode.window.terminals) {
    const pid = await pidOf(term)
    if (pid && wanted.has(pid)) {
      term.show(false)
      return term
    }
  }
  return null
}

/** 開在 Windows Terminal 的 session：把脈絡寫成檔交給 switch_terminal.ps1（UI Automation 選分頁並把視窗帶到前景），結果顯示在狀態列訊息。 */
async function switchViaTerminal(row) {
  const cli = lib.findCollector(config().get('collectorPath') || '')
  if (!cli) {
    void vscode.window.showWarningMessage('找不到收集程式，無法切換到 Windows Terminal：請在設定「haleyCockpit.collectorPath」填入完整路徑')
    return
  }
  const script = path.join(path.dirname(cli), 'switch_terminal.ps1')
  // 每個 VS Code 視窗各用自己的脈絡檔，同時點擊不會互相覆蓋
  const ctxFile = path.join(DIR, `switch-context-vscode-${process.pid}.json`)
  try {
    writeJsonAtomic(ctxFile, lib.buildSwitchContext(row, (latest && latest.sessions) || []))
    const out = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ContextFile', ctxFile])
    const result = JSON.parse(out.trim().split(/\r?\n/).pop() || '{}')
    const text = lib.describeTerminal(result)
    log.appendLine(`${stamp()} Windows Terminal：${text}`)
    if (result.ok) vscode.window.setStatusBarMessage(text, 5000)
    else void vscode.window.showWarningMessage(text)
  } catch (err) {
    log.appendLine(`${stamp()} Windows Terminal 切換失敗：${err.message || err}`)
    void vscode.window.showWarningMessage(`切換到 Windows Terminal 失敗：${err.message || err}`)
  }
}

/** 面板裡點一列：開在 Windows Terminal 的交給切換程式；本視窗有終端機就直接切；都沒有就寫切換請求，交給擁有那個終端機的其他視窗。 */
async function switchTo(key) {
  const row = ((latest && latest.sessions) || []).find(r => lib.rowKey(r) === key)
  if (!row) return
  if (lib.isTerminalHost(row)) {
    await switchViaTerminal(row)
    return
  }
  const term = await showByPids(row.pids)
  if (term) {
    log.appendLine(`${stamp()} 面板切換到「${term.name}」`)
    void render()
    return
  }
  const at = Date.now()
  writeJsonAtomic(REQUEST, { id: `${at.toString(36)}-${row.pid}`, at, pids: row.pids, tool: row.tool, project: row.project })
  vscode.window.setStatusBarMessage('這個 session 不在本視窗，已請其他 VS Code 視窗切換', 4000)
}

async function handleRequest() {
  let req
  try {
    req = JSON.parse(fs.readFileSync(REQUEST, 'utf8'))
  } catch {
    return
  }
  if (!req || !req.id || req.id === lastRequestId || !Array.isArray(req.pids)) return
  if (Date.now() - Number(req.at || 0) > FRESH_MS) return
  lastRequestId = req.id
  // pids 是 session 程序與它的祖先鏈（claude.exe ← powershell.exe ← …）；終端機的 processId 是 shell 的 pid，會落在鏈上
  const term = await showByPids(req.pids)
  if (term) {
    writeJsonAtomic(ACK, { id: req.id, ok: true, terminal: term.name, pid: await pidOf(term), at: Date.now() })
    log.appendLine(`${stamp()} 切換到「${term.name}」（${req.project || ''}）`)
    return
  }
  // 沒找到就不回寫：可能在別的視窗，讓擁有它的視窗回答
  log.appendLine(`${stamp()} 本視窗沒有程序編號 ${req.pids.join('、')} 的終端機（${req.project || ''}）`)
}

class BoardProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri
    this.view = null
  }

  resolveWebviewView(view) {
    this.view = view
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    const nonce = crypto.randomBytes(16).toString('hex')
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'board.css'))
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'board.js'))
    // 只允許自己的樣式檔與帶 nonce 的腳本；進度條寬度由腳本設定，不用行內 style
    view.webview.html =
      '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">' +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>` +
      `<body><div id="root"><p class="muted">讀取中…</p></div><script nonce="${nonce}" src="${js}"></script></body></html>`
    view.webview.onDidReceiveMessage(msg => {
      if (msg && msg.type === 'switch') void switchTo(String(msg.key))
      else if (msg && msg.type === 'refresh') refreshNow()
      else if (msg && msg.type === 'ready') void render()
    })
    view.onDidChangeVisibility(() => (view.visible ? refreshNow() : schedule()))
    view.onDidDispose(() => {
      this.view = null
      schedule()
    })
    refreshNow()
  }
}

function activate(context) {
  log = vscode.window.createOutputChannel('Haley Cockpit')
  fs.mkdirSync(TERMINALS_DIR, { recursive: true })

  // 監看資料夾而不是檔案：檔案可能還不存在，mod 每次也是整份覆寫（覆寫會換掉檔案，監看檔案本身會失效）
  const watcher = fs.watch(DIR, (event, filename) => {
    if (filename && filename !== 'switch-request.json') return
    // 一次寫入常觸發兩三個事件，合併成一次處理
    clearTimeout(pendingRequest)
    pendingRequest = setTimeout(() => void handleRequest(), 50)
  })
  context.subscriptions.push({ dispose: () => watcher.close() })

  provider = new BoardProvider(context.extensionUri)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('haleyCockpit.board', provider))
  context.subscriptions.push(
    vscode.commands.registerCommand('haleyCockpit.open', () => vscode.commands.executeCommand('haleyCockpit.board.focus')),
    vscode.commands.registerCommand('haleyCockpit.refresh', () => refreshNow()),
    vscode.commands.registerCommand('haleySessionSwitch.showLog', () => log.show()),
  )

  const onTerminalsChanged = () => {
    void publishTerminals()
    void render()
  }
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(onTerminalsChanged),
    vscode.window.onDidCloseTerminal(onTerminalsChanged),
    vscode.window.onDidChangeActiveTerminal(() => void render()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('haleyCockpit')) refreshNow()
    }),
  )
  const namePoll = setInterval(() => void publishTerminals(), NAME_POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(namePoll) })
  context.subscriptions.push({ dispose: () => clearTimeout(timer) })
  context.subscriptions.push({ dispose: () => Object.values(items).forEach(it => it.dispose()) })

  void publishTerminals()
  refreshNow()
  log.appendLine(`${stamp()} 啟用：監看 ${REQUEST}，終端機名稱寫到 ${TERMINALS_FILE}`)
}

function deactivate() {
  try {
    fs.rmSync(TERMINALS_FILE, { force: true })
  } catch {
    // 關閉時刪不掉也沒關係：收集器會依檔案時間判斷視窗已關閉
  }
}

module.exports = { activate, deactivate }
