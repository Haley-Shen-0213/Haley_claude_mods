// 路徑： test\lib-test.js
// lib.js 的單元測試（不需安裝任何套件）：名稱清理、session 與終端機配對與排序、進度條種類、狀態列文字、面板 HTML 跳脫、找收集程式。用法：node test/lib-test.js
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const lib = require('../lib')

// 執行環境若已設定這個變數（例如在 Claude Code 裡跑測試），找收集程式的測試會讀到真的路徑
delete process.env.CLAUDE_CODE_PLUGIN_DIRS

const NOW = 1792193000
const terminals = [
  { pid: 300, name: 'Beta 交易所', index: 0 },
  { pid: 100, name: 'Alpha 中控台', index: 1 },
]
const rows = [
  { tool: 'claude', pid: 11, pids: [11, 100, 9], state: 'running', title: '中控', project: 'alpha', plan: { done: 2, total: 5, eta: 900, current: '寫測試' }, pendingTools: ['Bash'], lastActivity: NOW - 5, turn: { seconds: 300 }, ctx: { pct: 62 } },
  { tool: 'codex', pid: 22, pids: [22, 23, 300, 9], state: 'idle', title: '<script>alert(1)</script>', project: 'beta', pendingTools: [], lastActivity: NOW - 7200 },
  { tool: 'claude', pid: 33, pids: [33, 34], state: 'stalled', title: '', project: 'ytdp', pendingTools: [], lastActivity: NOW - 1200, window: '另一個視窗', terminal: '外部名稱' },
]

let passed = 0
function check(name, fn) {
  fn()
  passed++
}

check('去掉 Claude 標題前的狀態符號', () => {
  assert.strictEqual(lib.cleanName('✳ 整理文件'), '整理文件')
  assert.strictEqual(lib.cleanName('◐ 了解 Codex 的設定'), '了解 Codex 的設定')
  assert.strictEqual(lib.cleanName('Beta 交易所'), 'Beta 交易所')
})

check('依程序鏈配對終端機、依分頁順序排列', () => {
  assert.strictEqual(lib.matchTerminal(rows[0], terminals).name, 'Alpha 中控台')
  assert.strictEqual(lib.matchTerminal(rows[2], terminals), null)
  assert.deepStrictEqual(lib.orderRows(rows, terminals).map(r => r.pid), [22, 11, 33])
})

check('進度條種類', () => {
  assert.strictEqual(lib.progressOf(rows[0]).kind, 'plan')
  assert.strictEqual(lib.progressOf(rows[0]).pct, 40)
  assert.strictEqual(lib.progressOf({ state: 'running' }).kind, 'busy')
  assert.strictEqual(lib.progressOf({ state: 'stalled' }).kind, 'stalled')
  assert.strictEqual(lib.progressOf({ state: 'idle' }).kind, 'empty')
})

check('狀態列用量文字與配色', () => {
  const usage = {
    claude: { five_hour: { used: 7, resetsAt: NOW + 3600 }, seven_day: { used: 85, resetsAt: NOW + 86400 } },
    codex: { primary: { used: 55, resetsAt: NOW + 86400 * 5, windowMinutes: 10080 } },
  }
  const items = lib.usageItems(usage, NOW)
  assert.deepStrictEqual(items.map(i => [i.id, i.level]), [['c5', 'ok'], ['c7', 'bad'], ['x1', 'warn']])
  assert.strictEqual(items[0].text, 'Claude 5h ▱▱▱▱▱ 7%')
  assert.strictEqual(items[2].text, 'Codex 7d ▰▰▰▱▱ 55%')
  assert.ok(lib.usageTooltip(usage, NOW, NOW).includes('| Claude 5 小時 | 7% |'))
})

check('面板 HTML：名稱取自終端機、內容跳脫、標出目前的終端機', () => {
  const html = lib.renderBoard({ now: NOW, stallMinutes: 10, counts: { running: 1, idle: 1, stalled: 1 }, usage: {}, sessions: rows }, terminals, 100)
  assert.ok(html.includes('Alpha 中控台'))
  assert.ok(html.includes('Beta 交易所'))
  assert.ok(html.includes('外部名稱'))
  assert.ok(!html.includes('<script>'), '標題要跳脫')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('class="row st-running active"'))
  assert.ok(html.includes('data-key="claude:11"'))
  assert.ok(html.includes('2/5 · 約 15分00秒'))
  assert.ok(html.includes('（等 Bash）'))
  assert.ok(html.includes('（在另一個 VS Code 視窗：另一個視窗）'))
})

check('找收集程式：設定值、settings.json 的 CLAUDE_CODE_PLUGIN_DIRS', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haley-lib-'))
  try {
    const plugin = path.join(home, 'mods', 'haley-cockpit')
    fs.mkdirSync(path.join(plugin, 'collector'), { recursive: true })
    const cli = path.join(plugin, 'collector', 'cockpit_cli.py')
    fs.writeFileSync(cli, '')
    fs.mkdirSync(path.join(home, '.claude'))
    assert.strictEqual(lib.findCollector('', home), null)
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: plugin } }))
    assert.strictEqual(lib.findCollector('', home), cli)
    assert.strictEqual(lib.findCollector(cli, home), cli)
    assert.strictEqual(lib.findCollector(path.join(home, 'nope.py'), home), null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

console.log(`通過：${passed} 項`)
