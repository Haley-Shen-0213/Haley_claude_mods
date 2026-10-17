// 路徑： lib.js
// 不依賴 vscode 模組的邏輯：找收集程式、整理終端機名稱、session 與終端機配對、狀態列文字、駕駛艙面板的 HTML；抽出來才能用 node 直接測試。
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
// HALEY_COCKPIT_DATA 只給測試用，與收集器同一個約定
const DATA_DIR = process.env.HALEY_COCKPIT_DATA || path.join(HOME, '.claude', 'haley-cockpit')

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

function span(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}秒`
  if (s < 3600) return `${Math.floor(s / 60)}分${pad2(s % 60)}秒`
  if (s < 86400) return `${Math.floor(s / 3600)}時${pad2(Math.floor((s % 3600) / 60))}分`
  return `${Math.floor(s / 86400)}天${Math.floor((s % 86400) / 3600)}時`
}

function ago(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  if (s < 86400) return `${Math.floor(s / 3600)} 時前`
  return `${Math.floor(s / 86400)} 天前`
}

function clock(epochSeconds) {
  const d = new Date(epochSeconds * 1000)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 配色門檻與 mod、終端機狀態列相同：低於 50% 綠、50～80% 黃、超過 80% 紅
function level(pct) {
  return pct < 50 ? 'ok' : pct <= 80 ? 'warn' : 'bad'
}

function miniBar(pct, cells = 5) {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

/** Claude Code 會把工作狀態畫在終端機標題最前面（✳、◐ 這類會一直變的符號），比對與顯示時去掉，名稱才穩定。 */
function cleanName(name) {
  return String(name || '').replace(/^[^\p{L}\p{N}[(（【「]+/u, '').trim()
}

/** session 的程序鏈（自己 ← shell ← …）上只要有一個 pid 是這個視窗某個終端機的 shell，就是那個終端機。 */
function matchTerminal(row, terminals) {
  const pids = new Set(row.pids || [])
  return terminals.find(t => pids.has(t.pid)) || null
}

/** 依本視窗終端機分頁的順序排，和分頁清單由上到下一致；不在本視窗的 session 排最後。 */
function orderRows(rows, terminals) {
  const pos = row => {
    const t = matchTerminal(row, terminals)
    return t ? t.index : 1e6
  }
  return [...rows].sort((a, b) => pos(a) - pos(b))
}

function windowLabel(minutes) {
  if (minutes === 300) return '5 小時'
  if (minutes === 10080) return '7 天'
  return minutes ? `${Math.round(minutes / 60)} 小時` : '視窗'
}

/** 狀態列的三個用量項目（各自依用量變色）；沒有資料的視窗不出現。 */
function usageItems(usage, now) {
  const items = []
  const add = (id, label, w) => {
    if (!w) return
    if (w.used === null || w.used === undefined) {
      items.push({ id, text: `${label} 已重置`, level: 'ok', used: null, resetsAt: w.resetsAt, title: label })
      return
    }
    items.push({ id, text: `${label} ${miniBar(w.used)} ${Math.round(w.used)}%`, level: level(w.used), used: w.used, resetsAt: w.resetsAt, title: label })
  }
  const claude = (usage && usage.claude) || {}
  add('c5', 'Claude 5h', claude.five_hour)
  add('c7', '7d', claude.seven_day)
  // 模型專屬的每週額度（例如 Fable，取自官方 /usage）：狀態列位置有限，最多顯示兩個
  ;(claude.models || []).slice(0, 2).forEach((m, i) => add(`m${i}`, `${m.label} 7d`, m))
  const codex = usage && usage.codex
  if (codex && codex.primary) add('x1', `Codex ${codex.primary.windowMinutes === 10080 ? '7d' : codex.primary.windowMinutes === 300 ? '5h' : ''}`.trim(), codex.primary)
  for (const it of items) {
    it.reset = it.resetsAt && it.resetsAt > now ? `${clock(it.resetsAt)}（${span(it.resetsAt - now)}後）重置` : ''
  }
  return items
}

/** 狀態列滑鼠停留時的說明（Markdown 表格）。 */
function usageTooltip(usage, now, loadedAt) {
  const rows = []
  const claude = (usage && usage.claude) || {}
  const line = (label, w) => {
    if (!w) return
    const used = w.used === null || w.used === undefined ? '已重置' : `${Math.round(w.used)}%`
    const reset = w.resetsAt && w.resetsAt > now ? `${clock(w.resetsAt)}（${span(w.resetsAt - now)}後）` : '—'
    rows.push(`| ${label} | ${used} | ${reset} |`)
  }
  line('Claude 5 小時', claude.five_hour)
  line('Claude 7 天', claude.seven_day)
  for (const m of claude.models || []) line(`${m.label} 7 天`, m)
  const codex = usage && usage.codex
  if (codex && codex.primary) line(`Codex ${windowLabel(codex.primary.windowMinutes)}`, codex.primary)
  if (codex && codex.secondary) line(`Codex ${windowLabel(codex.secondary.windowMinutes)}`, codex.secondary)
  const head = '**帳號用量**\n\n| 視窗 | 已用 | 重置 |\n|---|---|---|\n'
  const foot = `\n\n各 session 最近一次收到回應時的數字，可能落後官方 /usage。${loadedAt ? `資料時間 ${clock(loadedAt)}。` : ''}點一下開啟駕駛艙。`
  return rows.length ? head + rows.join('\n') + foot : '還沒有用量資料：任一個 Claude session 收到回應後才會出現。'
}

const STATE = {
  running: { label: '執行中', cls: 'running' },
  stalled: { label: '停滯', cls: 'stalled' },
  idle: { label: '閒置', cls: 'idle' },
  unknown: { label: '未對應', cls: 'unknown' },
}

function rowKey(row) {
  return `${row.tool}:${row.pid}`
}

/** session 開在 Windows Terminal 或其他主控台（不是 VS Code 整合終端機）：切換要靠 switch_terminal.ps1 選分頁。 */
function isTerminalHost(row) {
  return row.host === 'wt' || row.host === 'console'
}

/** 交給 switch_terminal.ps1 的脈絡：目標 session 的分頁名稱候選，以及同在 Windows Terminal 的其他 session（排除法用：
 * 分頁被使用者改過名時，其他 session 都對上了，剩下的唯一分頁就是目標）。 */
function buildSwitchContext(row, rows) {
  const info = r => ({ titles: r.tabTitles && r.tabTitles.length ? r.tabTitles : [r.title || ''], pids: r.pids || [], startedAt: r.startedAt || 0 })
  return { target: info(row), others: rows.filter(r => r !== row && r.pid !== row.pid && isTerminalHost(r)).map(info) }
}

/** switch_terminal.ps1 印出的最後一行 JSON 換成給人看的中文（和 mod 的 /go 同一套說法）。 */
function describeTerminal(r) {
  if (r.ok) {
    const how = r.how === 'elimination' ? '（分頁被改過名，依排除法推定）' : r.how === 'order' ? '（依啟動順序推定，可能不準）' : r.ambiguous ? '（有多個同名分頁，選了第一個）' : ''
    const fg = r.foreground === false ? '；視窗沒能自動帶到最前面，請手動切到 Windows Terminal' : ''
    return `已切換到分頁「${String(r.tab || '').trim()}」${how}${fg}`
  }
  if (r.error === 'no_wt_window') return '找不到 Windows Terminal 視窗：這個 session 可能開在別種終端機（例如舊式的命令提示字元視窗），目前無法切換'
  if (r.error === 'no_match') {
    const names = (r.tabs || []).map(t => `「${String(t).trim()}」`).join('、')
    return `找不到對應的分頁。目前的分頁：${names}。分頁名稱若被你改過，清空名稱就會恢復成自動標題`
  }
  return `切換失敗：${r.message || r.error || '原因不明'}`
}

/** 每個 session 一條主進度條：有待辦清單時是完成比例；沒有清單但有工作流程（Workflow 工具）在跑時是代理的完成比例；
 * 都沒有時，執行中畫成流動條、停滯畫成紅色、閒置留空。 */
function progressOf(row, now) {
  const plan = row.plan
  if (plan && plan.total > 0) {
    const pct = (plan.done / plan.total) * 100
    const eta = plan.eta !== null && plan.eta !== undefined ? ` · 約 ${span(plan.eta)}` : plan.done >= plan.total ? ' · 完成' : ''
    return { kind: 'plan', pct, text: `${plan.done}/${plan.total}${eta}` }
  }
  const wf = row.workflow
  if (wf && wf.total > 0) {
    const remaining = now && wf.startedAt && wf.done > 0 && wf.done < wf.total ? ((now - wf.startedAt) / wf.done) * (wf.total - wf.done) : null
    const eta = remaining !== null ? ` · 約 ${span(remaining)}` : wf.done >= wf.total ? ' · 完成' : ''
    return { kind: 'plan', pct: (wf.done / wf.total) * 100, text: `代理 ${wf.done}/${wf.total}${eta}` }
  }
  if (row.state === 'running') return { kind: 'busy', pct: 100, text: '執行中（無待辦清單）' }
  if (row.state === 'stalled') return { kind: 'stalled', pct: 100, text: '停滯' }
  return { kind: 'empty', pct: 0, text: row.state === 'unknown' ? '找不到對應的紀錄檔' : '閒置' }
}

function renderBoard(data, terminals, activePid) {
  const now = data.now
  const parts = []
  const gauge = (label, w) => {
    if (!w) return
    if (w.used === null || w.used === undefined) {
      parts.push(`<div class="gauge"><div class="g-label">${escapeHtml(label)}</div><div class="g-sub">已重置，等下一次回應更新</div></div>`)
      return
    }
    const reset = w.resetsAt && w.resetsAt > now ? `${span(w.resetsAt - now)}後重置（${clock(w.resetsAt)}）` : ''
    parts.push(
      `<div class="gauge lvl-${level(w.used)}"><div class="g-head"><span class="g-label">${escapeHtml(label)}</span>` +
        `<span class="g-val">${Math.round(w.used)}%</span></div><div class="bar"><i data-pct="${Number(w.used)}"></i></div>` +
        `<div class="g-sub">${escapeHtml(reset)}</div></div>`,
    )
  }
  const usage = data.usage || {}
  const claude = usage.claude || {}
  parts.push(`<section><h2>帳號用量</h2>`)
  gauge('Claude 5 小時', claude.five_hour)
  gauge('Claude 7 天', claude.seven_day)
  for (const m of claude.models || []) gauge(`${m.label} 7 天`, m)
  if (usage.codex) {
    gauge(`Codex ${windowLabel(usage.codex.primary && usage.codex.primary.windowMinutes)}`, usage.codex.primary)
    if (usage.codex.secondary) gauge(`Codex ${windowLabel(usage.codex.secondary.windowMinutes)}`, usage.codex.secondary)
  }
  if (!claude.five_hour && !claude.seven_day) parts.push('<p class="muted">Claude 用量要等任一個 session 收到回應後才有數字</p>')
  parts.push('</section>')

  const rows = orderRows(data.sessions || [], terminals)
  const c = data.counts || {}
  parts.push(
    `<section><h2>Session ${rows.length} 個 <span class="chip running">執行中 ${c.running || 0}</span>` +
      `<span class="chip idle">閒置 ${c.idle || 0}</span><span class="chip ${c.stalled ? 'stalled' : 'idle'}">停滯 ${c.stalled || 0}</span>` +
      `<button class="link" data-action="refresh" title="立即重新整理">↻</button></h2>`,
  )
  for (const row of rows) {
    const term = matchTerminal(row, terminals)
    const name = term ? term.name : row.terminal || row.title || row.project || `${row.tool} ${row.pid}`
    const st = STATE[row.state] || { label: row.state, cls: 'unknown' }
    const prog = progressOf(row, now)
    const isActive = activePid !== null && activePid !== undefined && (row.pids || []).includes(activePid)
    const meta = []
    if ((row.state === 'running' || row.state === 'stalled') && row.turn && row.turn.seconds !== undefined) meta.push(`本回合 ${span(row.turn.seconds)}`)
    if (row.lastActivity) {
      const waiting = row.pendingTools && row.pendingTools.length && (row.state === 'running' || row.state === 'stalled') ? `（等 ${row.pendingTools[0]}）` : ''
      meta.push(`最後動作 ${ago(now - row.lastActivity)}${waiting}`)
    }
    if (row.ctx && row.ctx.pct !== null && row.ctx.pct !== undefined) {
      meta.push(`<span class="lvl-${level(row.ctx.pct)}">ctx ${Math.round(row.ctx.pct)}%</span>`)
    }
    if (row.lastError) meta.push('<span class="lvl-bad">上回合錯誤</span>')
    const task = [row.title && row.title !== name ? row.title : '', row.plan && row.plan.current ? row.plan.current : ''].filter(Boolean).join(' · ')
    const where = term ? '' : isTerminalHost(row) ? '（在 Windows Terminal，點一下切過去）' : row.window ? `（在另一個 VS Code 視窗：${row.window}）` : '（不在這個視窗）'
    const tip = [`${name}`, `${row.tool === 'codex' ? 'Codex' : 'Claude'} · ${row.project || ''}`, row.cwd || '', row.model ? `模型 ${row.model}` : '', `程序 ${row.pid}`]
      .filter(Boolean)
      .join('\n')
    parts.push(
      `<div class="row st-${st.cls}${isActive ? ' active' : ''}" data-key="${escapeHtml(rowKey(row))}" tabindex="0" title="${escapeHtml(tip)}">` +
        `<div class="r-head"><span class="dot"></span>${row.no ? `<span class="r-no">${escapeHtml(row.no)}</span>` : ''}<span class="r-name">${escapeHtml(name)}</span>` +
        `<span class="r-tool">${row.tool === 'codex' ? 'Codex' : 'Claude'}</span></div>` +
        `<div class="bar p-${prog.kind}"><i data-pct="${prog.pct}"></i></div>` +
        `<div class="r-meta"><span class="r-state">${escapeHtml(st.label)}</span><span>${escapeHtml(prog.text)}</span>` +
        meta.map(m => (m.startsWith('<span') ? m : `<span>${escapeHtml(m)}</span>`)).join('') +
        `</div>` +
        (task || where ? `<div class="r-task">${escapeHtml(task)}${escapeHtml(where)}</div>` : '') +
        `</div>`,
    )
  }
  if (rows.length === 0) parts.push('<p class="muted">沒有存活的 session</p>')
  parts.push(`</section><p class="muted foot">點一列切到該終端機。停滯門檻 ${escapeHtml(data.stallMinutes)} 分。${escapeHtml(clock(now))} 更新</p>`)
  return parts.join('')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p
}

/** 找 cockpit_cli.py：設定值優先；其次 ~/.claude/settings.json 的 CLAUDE_CODE_PLUGIN_DIRS；再其次從市集安裝的外掛快取裡找。 */
function findCollector(configured, home = HOME) {
  if (configured) return fs.existsSync(configured) ? configured : null
  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {}
  const raw = String(((settings.env || {}).CLAUDE_CODE_PLUGIN_DIRS) || process.env.CLAUDE_CODE_PLUGIN_DIRS || '')
  for (const dir of raw.split(path.delimiter).map(s => s.trim()).filter(Boolean)) {
    const cli = path.join(expandHome(dir), 'collector', 'cockpit_cli.py')
    if (fs.existsSync(cli)) return cli
  }
  const cache = path.join(home, '.claude', 'plugins', 'cache')
  const walk = (dir, depth) => {
    if (depth > 4) return null
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      const cli = path.join(full, 'collector', 'cockpit_cli.py')
      if (full.includes('haley-cockpit') && fs.existsSync(cli)) return cli
      const hit = walk(full, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(cache, 0)
}

module.exports = {
  DATA_DIR,
  ago,
  buildSwitchContext,
  cleanName,
  clock,
  describeTerminal,
  escapeHtml,
  findCollector,
  isTerminalHost,
  level,
  matchTerminal,
  miniBar,
  orderRows,
  progressOf,
  renderBoard,
  rowKey,
  span,
  usageItems,
  usageTooltip,
}
