// 路徑： hooks\register.tsx
// haley-cockpit 駕駛艙：/session-board、/edit-heatmap、/agent-board、/turn-timeline、/worktree-map、/file-tree 六個面板，
// /cockpit 一次開啟全部，/go 依編號或名稱切到某個 session；同一個 mod 共用讀取程式與設定。
// session 紀錄檔交給 collector\cockpit_cli.py 解析：mod 的環境一次只能讀 4 MiB，紀錄檔動輒十幾 MB；狀態列也用同一份 Python 程式，兩邊數字一致。
// 子代理與工作流程的面板在 agents.tsx，檔案樹在 filetree.tsx；共用的排版與呼叫收集程式的函式在 helpers.ts。
import { atom, read, update } from 'claude-code'
import type { Color, PluginOptions, Register, Timer } from 'claude-code'

import type {
  CockpitBoard,
  CockpitEdits,
  CockpitLoad,
  CockpitSession,
  CockpitTurns,
  CockpitWindow,
  CockpitWorktree,
  CockpitWorktrees,
} from '../types'
import { noteAgentEnd, refreshAgents, registerAgents } from './agents'
import { refreshTree, registerTree } from './filetree'
import {
  EMPTY, ago, bar, clockText, cockpitDir, count, fetchOnce, fit, level, merge, right, runCli, shortPath, span, spark, stallMinutes, toolName,
} from './helpers'
import type { Dollar } from './helpers'

const BOARD_MS = 5000 // session 總覽每 5 秒更新
const AGENT_MS = 3000
const TREE_MS = 10000
const SLOW_MS = 30000 // 編輯熱點、回合時間軸：解析是增量的，但沒必要更頻繁
const ACK_TRIES = 8

const PANES = {
  board: { id: 'session-board', title: 'Session 總覽' },
  agents: { id: 'agent-board', title: '代理與工作流程' },
  edits: { id: 'edit-heatmap', title: '編輯熱點' },
  turns: { id: 'turn-timeline', title: '回合時間軸' },
  worktrees: { id: 'worktree-map', title: 'Worktree' },
  tree: { id: 'file-tree', title: '專案檔案樹' },
} as const
type PaneKey = keyof typeof PANES

const boardState = atom({ plugin: 'haley-cockpit', key: 'board' } as const, EMPTY as CockpitLoad<CockpitBoard>)
const editsState = atom({ plugin: 'haley-cockpit', key: 'edits' } as const, EMPTY as CockpitLoad<CockpitEdits>)
const editsAll = atom({ plugin: 'haley-cockpit', key: 'editsAll' } as const, false)
const turnsState = atom({ plugin: 'haley-cockpit', key: 'turns' } as const, EMPTY as CockpitLoad<CockpitTurns>)
const worktreeState = atom({ plugin: 'haley-cockpit', key: 'worktrees' } as const, EMPTY as CockpitLoad<CockpitWorktrees>)
const noticeState = atom({ plugin: 'haley-cockpit', key: 'notice' } as const, null as string | null)

// 模組變數在熱重載時會清空（計時器也一併被引擎取消），所以 session.start 會依引擎記錄中仍開著的面板補回
const timers = new Map<PaneKey, Timer>()
const inFlightTree = new Set<string>()

// ---- 資料 ----

/** 本 session 最近一次 API 回應的 Claude 用量，換成狀態列 stdin 的格式交給收集器合併；沒裝狀態列時面板也有數字。 */
async function claudeRate($: Dollar): Promise<string | null> {
  try {
    const { rateLimits } = await $.session.usage()
    const out: Record<string, { used_percentage: number; resets_at: number }> = {}
    for (const r of rateLimits) {
      const at = r.resetsAt ? Date.parse(r.resetsAt) / 1000 : 0
      if ((r.kind === 'five_hour' || r.kind === 'seven_day') && Number.isFinite(at)) {
        out[r.kind] = { used_percentage: r.percentUsed, resets_at: at }
      }
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null
  } catch {
    return null
  }
}

async function refreshBoard($: Dollar, options: PluginOptions): Promise<void> {
  const args = ['board', '--stall-minutes', String(stallMinutes(options))]
  const rate = await claudeRate($)
  if (rate) args.push('--claude-rate', rate)
  const r = await fetchOnce('board', () => runCli<CockpitBoard>($, options, args))
  if (r) await update($, boardState, merge(r, await $.clock.now()))
}

async function refreshEdits($: Dollar, options: PluginOptions): Promise<void> {
  const all = await read($, editsAll)
  const args = all ? ['edits', '--all'] : ['edits', '--session', await $.session.id()]
  const r = await fetchOnce('edits', () => runCli<CockpitEdits>($, options, args))
  if (r) await update($, editsState, merge(r, await $.clock.now()))
}

async function refreshTurns($: Dollar, options: PluginOptions): Promise<void> {
  const args = ['turns', '--session', await $.session.id()]
  const r = await fetchOnce('turns', () => runCli<CockpitTurns>($, options, args))
  if (r) await update($, turnsState, merge(r, await $.clock.now()))
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function parseWorktrees(text: string, cwd: string): CockpitWorktree[] {
  const items: CockpitWorktree[] = []
  let cur: CockpitWorktree | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: null, prunable: null, isCurrent: false }
      items.push(cur)
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5, 12)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (cur && line === 'detached') cur.detached = true
    else if (cur && line === 'bare') cur.bare = true
    else if (cur && line.startsWith('locked')) cur.locked = line.slice(6).trim() || '已鎖定'
    else if (cur && line.startsWith('prunable')) cur.prunable = line.slice(8).trim() || '可清除'
  }
  // 目前所在：工作目錄落在哪個 worktree 底下，取最長的那個（主 worktree 也包含底下的連結 worktree 路徑）
  const here = normPath(cwd)
  let best: CockpitWorktree | null = null
  for (const w of items) {
    const p = normPath(w.path)
    if ((here === p || here.startsWith(p + '/')) && (!best || p.length > normPath(best.path).length)) best = w
  }
  if (best) best.isCurrent = true
  return items
}

async function refreshWorktrees($: Dollar): Promise<void> {
  if (inFlightTree.has('worktrees')) return
  inFlightTree.add('worktrees')
  try {
    const cwd = await $.session.cwd()
    let result: { data: CockpitWorktrees } | { error: string }
    try {
      const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd, timeoutMs: 20000 })
      result = r.exitCode === 0
        ? { data: { root: cwd, items: parseWorktrees(r.stdout, cwd) } }
        : { error: r.stderr.trim() || `git 結束碼 ${r.exitCode}` }
    } catch (err) {
      result = { error: `無法執行 git：${err instanceof Error ? err.message : String(err)}` }
    }
    const at = await $.clock.now()
    await update($, worktreeState, v => ('data' in result ? { data: result.data, error: null, loadedAt: at } : { ...v, error: result.error }))
  } finally {
    inFlightTree.delete('worktrees')
  }
}

// ---- 切換到某個 session ----
// 在 VS Code 終端機裡的交給 VS Code 擴充（寫切換請求）；在 Windows Terminal 或其他終端機的，用 UI Automation 選分頁（collector\switch_terminal.ps1）。

type SwitchAck = { id?: string; ok?: boolean; terminal?: string; reason?: string }

async function readAck($: Dollar, dir: string): Promise<SwitchAck | null> {
  try {
    return JSON.parse(await $.fs.read(`${dir}/switch-ack.json`)) as SwitchAck
  } catch {
    return null
  }
}

function waitAck($: Dollar, dir: string, id: string, tries: number): void {
  $.clock.after(400, () => {
    void (async () => {
      const ack = await readAck($, dir)
      if (ack && ack.id === id) {
        const text = ack.ok ? `已切換到終端機「${ack.terminal ?? ''}」` : `切換失敗：${ack.reason ?? '原因不明'}`
        await update($, noticeState, () => text)
      } else if (tries + 1 < ACK_TRIES) {
        waitAck($, dir, id, tries + 1)
      } else {
        await update($, noticeState, () => '沒有 VS Code 視窗回應：請確認 haley-session-switch 擴充已安裝，並在每個 VS Code 視窗執行過「重新載入視窗」')
      }
    })()
  })
}

async function sendVsCodeRequest($: Dollar, s: CockpitSession): Promise<void> {
  const dir = await cockpitDir($)
  const at = await $.clock.now()
  const id = `${at.toString(36)}-${s.pid}`
  // 交換檔：每個 VS Code 視窗的擴充都監看它，擁有這串 pid 中某個終端機程序的視窗負責切換並回寫 switch-ack.json
  await $.fs.write(`${dir}/switch-request.json`, JSON.stringify({ id, at, pids: s.pids, tool: s.tool, project: s.project }))
  waitAck($, dir, id, 0)
}

type TerminalResult = {
  ok: boolean
  how?: string
  ambiguous?: boolean
  tab?: string
  foreground?: boolean | null
  error?: string
  message?: string
  tabs?: string[]
}

function describeTerminal(r: TerminalResult): string {
  if (r.ok) {
    const how =
      r.how === 'elimination' ? '（分頁被改過名，依排除法推定）' :
      r.how === 'order' ? '（依啟動順序推定，可能不準）' :
      r.ambiguous ? '（有多個同名分頁，選了第一個）' : ''
    const fg = r.foreground === false ? '；視窗沒能自動帶到最前面，請手動切到 Windows Terminal' : ''
    return `已切換到分頁「${(r.tab ?? '').trim()}」${how}${fg}`
  }
  if (r.error === 'no_wt_window') return '找不到 Windows Terminal 視窗：這個 session 可能開在別種終端機（例如舊式的命令提示字元視窗），目前無法切換'
  if (r.error === 'no_match') {
    const names = (r.tabs ?? []).map(t => `「${t.trim()}」`).join('、')
    return `找不到對應的分頁。目前的分頁：${names}。分頁名稱若被你改過，清空名稱就會恢復成自動標題`
  }
  return `切換失敗：${r.message ?? r.error ?? '原因不明'}`
}

async function switchViaTerminal($: Dollar, s: CockpitSession, all: readonly CockpitSession[]): Promise<string> {
  const dir = await cockpitDir($)
  // 排除法只該把確定開在 Windows Terminal／主控台的其他 session 算進去；VS Code 裡的或位置不明的會讓推定錯位
  const others = all.filter(o => o.pid !== s.pid && (o.host === 'wt' || o.host === 'console'))
  const ctx = {
    target: { titles: s.tabTitles ?? [s.title], pids: s.pids, startedAt: s.startedAt ?? 0 },
    others: others.map(o => ({ titles: o.tabTitles ?? [o.title], pids: o.pids, startedAt: o.startedAt ?? 0 })),
  }
  // 脈絡寫成檔案交給切換程式：標題含中文與各種符號，走命令列會被引號與編碼弄壞
  const ctxPath = `${dir}/switch-context.json`
  await $.fs.write(ctxPath, JSON.stringify(ctx))
  try {
    const r = await $.process.run(
      ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${$.plugin.root}/collector/switch_terminal.ps1`, '-ContextFile', ctxPath],
      { timeoutMs: 30000 },
    )
    const line = r.stdout.trim().split(/\r?\n/).pop() ?? ''
    return describeTerminal(JSON.parse(line) as TerminalResult)
  } catch (err) {
    return `切換失敗：${err instanceof Error ? err.message : String(err)}`
  }
}

async function switchToSession($: Dollar, target: CockpitSession, all: readonly CockpitSession[]): Promise<string> {
  const self = await $.session.id()
  if (target.tool === 'claude' && target.id === self) return '這就是目前的 session'
  const name = target.terminal || target.title || target.project
  // 只有確定不在 VS Code 的（Windows Terminal 或其他主控台）才走分頁切換；沒標示的一律交給 VS Code 擴充
  if (target.host === 'wt' || target.host === 'console') return switchViaTerminal($, target, all)
  await sendVsCodeRequest($, target)
  return `已請 VS Code 切換到「${name}」`
}

// ---- 面板與計時器 ----

function keyOf(id: string): PaneKey | null {
  for (const key of Object.keys(PANES) as PaneKey[]) if (PANES[key].id === id) return key
  return null
}

/** 掛上週期計時器並立刻跑第一次；回傳第一次的 promise，開面板時等它，面板一出現就有內容。 */
function schedule($: Dollar, key: PaneKey, ms: number, fn: () => Promise<void> | void): Promise<void> {
  timers.get(key)?.cancel()
  timers.set(key, $.clock.every(ms, () => void fn()))
  return Promise.resolve(fn())
}

function startFor($: Dollar, key: PaneKey, options: PluginOptions): Promise<void> {
  if (key === 'board') return schedule($, key, BOARD_MS, () => refreshBoard($, options))
  if (key === 'edits') return schedule($, key, SLOW_MS, () => refreshEdits($, options))
  if (key === 'turns') return schedule($, key, SLOW_MS, () => refreshTurns($, options))
  // 子代理清單的「已執行時間」每次重畫才會走動，所以資料沒變也要定期重畫
  if (key === 'agents') return schedule($, key, AGENT_MS, async () => { await refreshAgents($, options); $.ui.invalidate('ui.render') })
  if (key === 'tree') return schedule($, key, TREE_MS, () => refreshTree($))
  return refreshWorktrees($)
}

async function openPane($: Dollar, key: PaneKey, options: PluginOptions): Promise<{ placed: boolean; text: string }> {
  const pane = PANES[key]
  const opened = await $.ui.open({ id: pane.id, title: pane.title })
  await startFor($, key, options)
  return opened.isPlaced
    ? { placed: true, text: `已開啟「${pane.title}」面板。` }
    : { placed: false, text: `「${pane.title}」面板已開啟，等待版面空間：${opened.reason}` }
}

// ---- 畫面 ----

const STATE_LABEL: Record<string, [string, Color]> = {
  running: ['● 執行中', 'success'],
  stalled: ['▲ 停滯', 'error'],
  idle: ['○ 閒置', 'subtle'],
  unknown: ['? 未對應', 'warning'],
}

function windowLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return '5 小時'
  if (minutes === 10080) return '7 天'
  return minutes ? `${Math.round(minutes / 60)} 小時` : '視窗'
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // 逐個登記並各自攔錯：萬一某個名稱和內建指令撞名而被拒絕，不能連累其他指令與整個 session.start
    const commands: { name: string; description: string; argumentHint?: string }[] = [
      { name: 'cockpit', description: '一次開啟全部駕駛艙面板（Session 總覽、代理、編輯熱點、回合時間軸、Worktree、專案檔案樹）；加 close 全部關閉', argumentHint: '[close]' },
      { name: 'go', description: '依編號或名稱切到某個 session 的終端機；不帶參數時列出編號', argumentHint: '[編號或名稱]' },
      { name: 'session-board', description: '所有 Claude／Codex session 的狀態、進度與帳號用量（每 5 秒更新；點一列切到該終端機）' },
      { name: 'agent-board', description: '本 session 的子代理與工作流程派出的代理：階段、描述、狀態、已執行時間' },
      { name: 'edit-heatmap', description: '本 session 各檔案被 Edit／Write 成功修改的次數（從紀錄檔重建）' },
      { name: 'turn-timeline', description: '本 session 每回合的耗時、輸出 token、API 呼叫與工具次數' },
      { name: 'worktree-map', description: '目前 repo 的 git worktree：路徑、分支、鎖定狀態' },
      { name: 'file-tree', description: '專案檔案樹：展開資料夾、點一下複製路徑（絕對或相對）' },
    ]
    for (const c of commands) {
      try {
        await $.command.register({ ...c, immediate: true })
      } catch (err) {
        $.ui.log(`haley-cockpit：登記 /${c.name} 失敗：${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      }
    }
    for (const pane of await $.ui.panes()) {
      const key = keyOf(pane.id)
      if (key) void startFor($, key, options)
    }
    return next(e)
  })

  const single: [string, PaneKey][] = [
    ['session-board', 'board'], ['agent-board', 'agents'], ['edit-heatmap', 'edits'],
    ['turn-timeline', 'turns'], ['worktree-map', 'worktrees'], ['file-tree', 'tree'],
  ]
  for (const [command, key] of single) {
    on('command.run', { command }, async $ => ({ text: (await openPane($, key, options)).text }))
  }

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const keys = Object.keys(PANES) as PaneKey[]
    if (/^(close|關閉)$/i.test(e.args.trim())) {
      for (const key of keys) {
        await $.ui.close({ id: PANES[key].id })
        timers.get(key)?.cancel()
        timers.delete(key)
      }
      return { text: '已關閉全部駕駛艙面板。' }
    }
    const results = await Promise.all(keys.map(key => openPane($, key, options)))
    const waiting = results.filter(r => !r.placed).length
    return {
      text:
        `已開啟 ${keys.length} 個面板：${keys.map(k => PANES[k].title).join('、')}。` +
        (waiting ? `\n其中 ${waiting} 個還在等版面空間（終端機太窄，放寬視窗後會自動出現）。` : '') +
        '\n面板上方的分頁可以切換；/cockpit close 一次關閉全部。',
    }
  })

  on('command.run', { command: 'go' }, async ($, e) => {
    const r = await runCli<CockpitBoard>($, options, ['board', '--stall-minutes', String(stallMinutes(options))])
    if (!('data' in r)) return { text: `讀取 session 清單失敗：${r.error}` }
    const rows = r.data.sessions
    const dot: Record<string, string> = { running: '●', stalled: '▲', idle: '○' }
    const label = (s: CockpitSession) => `${s.no}. ${dot[s.state] ?? '?'} ${s.terminal || s.title || s.project}（${toolName(s.tool)}，${s.project}）`
    const listing = rows.map(label).join('\n')
    const arg = e.args.trim()
    if (!arg) return { text: `用法：/go 編號或名稱（編號與狀態列、面板相同）\n${listing}` }
    let target: CockpitSession | undefined
    if (/^\d+$/.test(arg)) {
      target = rows.find(s => s.no === Number(arg))
      if (!target) return { text: `沒有編號 ${arg}。\n${listing}` }
    } else {
      const q = arg.toLowerCase()
      const hits = rows.filter(s => [s.terminal, s.title, s.project].some(t => (t ?? '').toLowerCase().includes(q)))
      if (hits.length === 0) return { text: `找不到符合「${arg}」的 session。\n${listing}` }
      if (hits.length > 1) return { text: `「${arg}」符合多個，請改用編號：\n${hits.map(label).join('\n')}` }
      target = hits[0]
    }
    return { text: await switchToSession($, target as CockpitSession, rows) }
  })

  // 只是觀察關閉、停掉自己的計時器；就算這裡出錯也一律放行關閉
  on('ui.close', ($, e, next) => {
    const key = keyOf(e.id)
    if (key) {
      timers.get(key)?.cancel()
      timers.delete(key)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await noteAgentEnd($, e.agentId)
    } else {
      // 主對話的回合結束時，開著的時間軸與熱點順手更新，不必等 30 秒
      if (timers.has('turns')) void refreshTurns($, options)
      if (timers.has('edits')) void refreshEdits($, options)
    }
    return next(e)
  })

  registerAgents(on, options)
  registerTree(on)

  // ---- /session-board ----
  on('ui.render', { component: 'Pane', requestId: 'session-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, boardState)
    const notice = await read($, noticeState)
    const self = await $.session.id()
    const cols = Math.max(40, e.props.bodyColumns)
    const b = load.data
    if (!b) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…（第一次解析 session 紀錄檔約需一兩秒）'}</Text>
        </Box>
      )
    }
    const now = b.now
    const barW = cols >= 120 ? 24 : cols >= 90 ? 16 : 10
    const usageRow = (key: string, label: string, w: CockpitWindow | null | undefined, sparkVals?: readonly (number | null)[], sparkNote?: string) => {
      if (!w) return null
      if (w.used === null) {
        return (
          <Box key={key}>
            <Text>{fit(label, 14)}</Text>
            <Text dimColor>已重置，等下一次回應更新</Text>
          </Box>
        )
      }
      const [filled, empty] = bar(w.used, barW)
      const reset = w.resetsAt && w.resetsAt > now ? `${span(w.resetsAt - now)}後重置` : ''
      return (
        <Box key={key}>
          <Text>{fit(label, 14)}</Text>
          <Text color={level(w.used)}>{filled}</Text>
          <Text dimColor>{empty}</Text>
          <Text color={level(w.used)}>{right(`${w.used.toFixed(0)}%`, 5)}</Text>
          <Text dimColor>{'  ' + fit(reset, 14)}</Text>
          {sparkVals && cols >= 100 ? <Text color="suggestion">{' ' + spark(sparkVals)}</Text> : null}
          {sparkVals && cols >= 100 && sparkNote ? <Text dimColor>{' ' + sparkNote}</Text> : null}
        </Box>
      )
    }
    const claude = b.usage.claude
    const codex = b.usage.codex
    const sp = b.sparks
    // 欄寬：狀態、工具、名稱、進度、ctx、本回合、最後動作固定，任務吃剩下的；太窄時先拿掉工具、ctx 與本回合
    const hot = 3 // plain Button 前面的「1: 」
    const narrow = cols < 110
    const W = { state: 9, tool: narrow ? 0 : 7, name: narrow ? 16 : 20, progress: 26, ctx: narrow ? 0 : 6, turn: narrow ? 0 : 10, last: 14 }
    const fixed = W.state + W.tool + W.name + W.progress + W.ctx + W.turn + W.last + hot + 1
    const taskW = Math.max(10, cols - fixed)
    const header = (
      <Text dimColor>
        {' '.repeat(hot) + fit('狀態', W.state) + fit('工具', W.tool) + fit('名稱', W.name) + fit('任務', taskW) +
          fit('進度／預估剩餘', W.progress) + fit('ctx', W.ctx) + fit('本回合', W.turn) + fit('最後動作', W.last)}
      </Text>
    )
    const rows = b.sessions.map((s, i) => {
      const [label, color] = STATE_LABEL[s.state] ?? [s.state, 'warning']
      const mark = s.tool === 'claude' && s.id === self ? '▶' : ' '
      // 名稱：VS Code 擴充回報的終端機名稱（和分頁清單一樣）；不在 VS Code 時用 session 標題；都沒有才用專案資料夾名
      const name = s.terminal || s.title || s.project
      // 任務：標題與名稱不同時才再寫一次標題，後面接目前的待辦項目；兩者都沒有就寫專案資料夾名
      const task = [s.title && s.title !== name ? s.title : '', s.plan?.current ?? ''].filter(Boolean).join(' · ') || s.project
      // 窄版把工具縮成前綴（沿用使用者的命名習慣：CL＝Claude、CX＝Codex）
      const tag = s.tool === 'codex' ? 'CX' : 'CL'
      // 每列一條迷你進度條：有待辦清單時是完成比例；沒有清單但有工作流程在跑時，是代理的完成比例；都沒有時，執行中畫成網點、其他留空
      const wf = s.workflow
      const wfPct = wf && wf.total > 0 ? (wf.done / wf.total) * 100 : null
      const wfEta = wf && wf.startedAt && wf.done > 0 && wf.done < wf.total ? ((now - wf.startedAt) / wf.done) * (wf.total - wf.done) : null
      const mini = s.plan && s.plan.total > 0
        ? bar((s.plan.done / s.plan.total) * 100, 6).join('')
        : wfPct !== null ? bar(wfPct, 6).join('')
        : s.state === 'running' || s.state === 'stalled' ? '▒▒▒▒▒▒' : '░░░░░░'
      const progress = mini + ' ' + (s.plan
        ? `${s.plan.done}/${s.plan.total}` + (s.plan.eta !== null ? ` ≈${span(s.plan.eta)}` : s.plan.done >= s.plan.total ? ' 完成' : '')
        : wf ? `代理 ${wf.done}/${wf.total}` + (wfEta !== null ? ` ≈${span(wfEta)}` : '')
        : '無計畫')
      const ctx = s.ctx && s.ctx.pct !== null ? `${Math.round(s.ctx.pct)}%` : ''
      const turn = (s.state === 'running' || s.state === 'stalled') && s.turn ? span(s.turn.seconds) : ''
      const lastAgo = s.lastActivity ? ago(now - s.lastActivity) : '—'
      const last = s.pendingTools.length > 0 && (s.state === 'running' || s.state === 'stalled')
        ? `${s.pendingTools[0]} ${lastAgo.replace(' 前', '')}`
        : lastAgo
      const extra = s.lastError ? '!' : ' '
      const doSwitch = () => void (async () => {
        await update($, noticeState, () => `切換中：${name}…`)
        const text = await switchToSession($, s, b.sessions)
        await update($, noticeState, () => text)
      })()
      return (
        <Button key={`row:${s.tool}:${s.pid}`} plain {...(s.no <= 9 ? { hotkey: String(s.no) } : {})} onPress={doSwitch}>
          <Text color={color}>{fit(mark + label, W.state)}</Text>
          <Text dimColor>{fit(W.tool ? toolName(s.tool) : '', W.tool)}</Text>
          <Text>{fit((W.tool ? '' : tag + ' ') + name, W.name - 1) + ' '}</Text>
          <Text>{fit(task, taskW - 1) + ' '}</Text>
          <Text color={s.plan || wf ? 'text' : s.state === 'running' ? 'success' : 'subtle'}>{fit(progress, W.progress)}</Text>
          <Text color={s.ctx && s.ctx.pct !== null ? level(s.ctx.pct) : 'subtle'}>{fit(ctx, W.ctx)}</Text>
          <Text dimColor>{fit(turn, W.turn)}</Text>
          <Text color={s.lastError ? 'warning' : 'subtle'}>{fit(extra + last, W.last)}</Text>
        </Button>
      )
    })
    const c = b.counts
    return (
      <Box flexDirection="column">
        <Text weight="bold">帳號用量</Text>
        {usageRow('u-c5', 'Claude 5 小時', claude.five_hour, sp?.c5, '近 5 小時')}
        {usageRow('u-c7', 'Claude 7 天', claude.seven_day, sp?.c7, '近 7 天')}
        {(claude.models ?? []).map(m => usageRow(`u-m-${m.label}`, `${m.label} 7 天`, { used: m.used, resetsAt: m.resetsAt }))}
        {codex ? usageRow('u-x1', `Codex ${windowLabel(codex.primary?.windowMinutes)}`, codex.primary, sp?.x1, '') : null}
        {codex?.secondary ? usageRow('u-x2', `Codex ${windowLabel(codex.secondary.windowMinutes)}`, codex.secondary) : null}
        {!claude.five_hour && !claude.seven_day ? <Text dimColor>Claude 用量要等任一個 session 收到 API 回應後才有數字</Text> : null}
        <Text> </Text>
        <Box>
          <Text weight="bold">{`Session ${b.sessions.length} 個　`}</Text>
          <Text color="success">{`執行中 ${c.running}`}</Text>
          <Text dimColor>{` · 閒置 ${c.idle} · `}</Text>
          <Text color={c.stalled ? 'error' : 'subtle'}>{`停滯 ${c.stalled}`}</Text>
          {c.unknown ? <Text color="warning">{` · 未對應 ${c.unknown}`}</Text> : null}
          <Text dimColor>{`　停滯門檻 ${b.stallMinutes} 分　${clockText(now, b.tzOffset)} 更新`}</Text>
        </Box>
        {header}
        {rows}
        {b.sessions.length === 0 ? <Text dimColor>沒有存活的 session</Text> : null}
        <Text> </Text>
        <Text dimColor>點一列（或按面板內的 1～9、或輸入 /go 編號）切到該 session 的終端機。▶ 是本視窗；! 表示上一回合以錯誤結束。</Text>
        {load.error ? <Text color="warning">{`最近一次更新失敗：${load.error}`}</Text> : null}
        {notice ? <Text color="suggestion">{notice}</Text> : null}
      </Box>
    )
  })

  // ---- /edit-heatmap ----
  on('ui.render', { component: 'Pane', requestId: 'edit-heatmap' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, editsState)
    const all = await read($, editsAll)
    const cols = Math.max(40, e.props.bodyColumns)
    const root = await $.session.root()
    const home = (await $.env.get('USERPROFILE')) ?? ''
    const d = load.data
    const toolbar = (
      <Box gap={1}>
        <Button key="scope" hotkey="s" onPress={() => void update($, editsAll, v => !v).then(() => refreshEdits($, options))}>
          {all ? '範圍：所有存活的 session' : '範圍：本 session'}
        </Button>
        <Button key="refresh" hotkey="r" onPress={() => void refreshEdits($, options)}>重新整理</Button>
      </Box>
    )
    if (!d) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…'}</Text>
        </Box>
      )
    }
    const max = d.files[0]?.count ?? 1
    const barW = cols >= 100 ? 20 : 10
    const lastW = 10
    const pathW = Math.max(10, cols - 5 - barW - 2 - lastW - 1)
    const room = Math.max(5, (e.props.scroll.bodyRows ?? 30) - 4)
    return (
      <Box flexDirection="column">
        {toolbar}
        <Text dimColor>{`${all ? '所有存活的 Claude session' : '本 session'}：共 ${d.total} 次、${d.files.length} 個檔案（只算成功的 Edit／Write／NotebookEdit）`}</Text>
        {d.files.length === 0 ? <Text dimColor>還沒有編輯紀錄</Text> : null}
        {d.files.slice(0, Math.max(room, 40)).map(f => {
          const ratio = (f.count / max) * 100
          const [filled, empty] = bar(ratio, barW)
          const heat: Color = ratio >= 66 ? 'error' : ratio >= 33 ? 'warning' : 'success'
          return (
            <Box key={`f:${f.path}`}>
              <Text color={heat}>{right(String(f.count), 4) + ' '}</Text>
              <Text color={heat}>{filled}</Text>
              <Text dimColor>{empty + '  '}</Text>
              <Text>{fit(shortPath(f.path, root, home), pathW)}</Text>
              <Text dimColor>{' ' + right(f.lastAt ? ago(d.now - f.lastAt) : '', lastW)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // ---- /turn-timeline ----
  on('ui.render', { component: 'Pane', requestId: 'turn-timeline' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, turnsState)
    const cols = Math.max(40, e.props.bodyColumns)
    const d = load.data
    const toolbar = <Button key="refresh" hotkey="r" onPress={() => void refreshTurns($, options)}>重新整理</Button>
    if (!d) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…'}</Text>
        </Box>
      )
    }
    const turns = d.turns
    const max = Math.max(1, ...turns.map(t => t.seconds))
    const totalS = turns.reduce((n, t) => n + t.seconds, 0)
    const totalOut = turns.reduce((n, t) => n + t.outputTokens, 0)
    const fixedW = 4 + 7 + 12 + 9 + 6 + 6 + 8
    const barW = Math.max(6, Math.min(40, cols - fixedW - 2))
    const room = Math.max(5, (e.props.scroll.bodyRows ?? 30) - 4)
    return (
      <Box flexDirection="column">
        {toolbar}
        <Text dimColor>{`本 session：${turns.length} 回合，合計 ${span(totalS)}、輸出 ${count(totalOut)} token`}</Text>
        <Text dimColor>{right('#', 3) + ' ' + fit('開始', 7) + fit('耗時', barW + 1) + right('時間', 12) + right('輸出', 9) + right('呼叫', 6) + right('工具', 6) + '  狀態'}</Text>
        {turns.slice(-Math.max(room, 30)).map(t => {
          const [filled] = bar((t.seconds / max) * 100, barW)
          const color: Color = t.running ? 'success' : t.error ? 'error' : t.interrupted ? 'warning' : 'suggestion'
          const flags = [t.running ? '執行中' : '', t.interrupted ? '中斷' : '', t.error ? '錯誤' : '', t.queued ? '中途加入' : ''].filter(Boolean).join('、')
          return (
            <Box key={`t:${t.index}`}>
              <Text dimColor>{right(String(t.index), 3) + ' '}</Text>
              <Text>{fit(t.start ? clockText(t.start, d.tzOffset) : '', 7)}</Text>
              <Text color={color}>{fit(filled, barW + 1)}</Text>
              <Text>{right(span(t.seconds), 12)}</Text>
              <Text>{right(count(t.outputTokens), 9)}</Text>
              <Text dimColor>{right(String(t.calls), 6) + right(String(t.tools), 6)}</Text>
              <Text color={color}>{'  ' + flags}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // ---- /worktree-map ----
  on('ui.render', { component: 'Pane', requestId: 'worktree-map' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, worktreeState)
    const cols = Math.max(40, e.props.bodyColumns)
    const d = load.data
    const toolbar = <Button key="refresh" hotkey="r" onPress={() => void refreshWorktrees($)}>重新整理</Button>
    if (!d) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…'}</Text>
        </Box>
      )
    }
    const branchW = 30
    const headW = 9
    const pathW = Math.max(12, cols - 2 - branchW - headW - 14)
    return (
      <Box flexDirection="column">
        {toolbar}
        <Text dimColor>{`${d.items[0]?.path ?? d.root}：${d.items.length} 個 worktree　▶ 是本 session 所在`}</Text>
        {d.items.map(w => {
          const flags = [w.bare ? '裸庫' : '', w.locked ? `鎖定：${w.locked}` : '', w.prunable ? `可清除：${w.prunable}` : ''].filter(Boolean).join('、')
          return (
            <Box key={`w:${w.path}`}>
              <Text color={w.isCurrent ? 'success' : 'text'}>{(w.isCurrent ? '▶ ' : '  ') + fit(w.path, pathW)}</Text>
              <Text color={w.detached ? 'warning' : 'suggestion'}>{' ' + fit(w.detached ? '（分離 HEAD）' : (w.branch ?? ''), branchW)}</Text>
              <Text dimColor>{fit(w.head ?? '', headW)}</Text>
              <Text color={w.locked || w.prunable ? 'warning' : 'subtle'}>{flags}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
