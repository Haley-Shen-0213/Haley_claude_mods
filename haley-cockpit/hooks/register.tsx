// 路徑： hooks\register.tsx
// haley-cockpit 駕駛艙：/session-board、/edit-heatmap、/agent-board、/turn-timeline、/worktree-map 五個面板，同一個 mod 共用讀取程式與設定。
// session 紀錄檔交給 collector\cockpit_cli.py 解析：mod 的環境一次只能讀 4 MiB，紀錄檔動輒十幾 MB；狀態列也用同一份 Python 程式，兩邊數字一致。
import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, Color, EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type {
  CockpitAgentTime,
  CockpitBoard,
  CockpitEdits,
  CockpitLoad,
  CockpitSession,
  CockpitTurns,
  CockpitWindow,
  CockpitWorktree,
  CockpitWorktrees,
} from '../types'

type Dollar = EngineInterface

const BOARD_MS = 5000 // session 總覽每 5 秒更新
const AGENT_MS = 2000
const SLOW_MS = 30000 // 編輯熱點、回合時間軸：解析是增量的，但沒必要更頻繁
const CLI_TIMEOUT_MS = 60000 // 第一次解析十幾 MB 的紀錄檔要一兩秒，留足餘裕
const ACK_TRIES = 8

const PANES = {
  board: { id: 'session-board', title: 'Session 總覽' },
  edits: { id: 'edit-heatmap', title: '編輯熱點' },
  agents: { id: 'agent-board', title: '子代理' },
  turns: { id: 'turn-timeline', title: '回合時間軸' },
  worktrees: { id: 'worktree-map', title: 'Worktree' },
} as const
type PaneKey = keyof typeof PANES

const EMPTY = { data: null, error: null, loadedAt: null }
const boardState = atom({ plugin: 'haley-cockpit', key: 'board' } as const, EMPTY as CockpitLoad<CockpitBoard>)
const editsState = atom({ plugin: 'haley-cockpit', key: 'edits' } as const, EMPTY as CockpitLoad<CockpitEdits>)
const editsAll = atom({ plugin: 'haley-cockpit', key: 'editsAll' } as const, false)
const turnsState = atom({ plugin: 'haley-cockpit', key: 'turns' } as const, EMPTY as CockpitLoad<CockpitTurns>)
const worktreeState = atom({ plugin: 'haley-cockpit', key: 'worktrees' } as const, EMPTY as CockpitLoad<CockpitWorktrees>)
const agentTimes = atom({ plugin: 'haley-cockpit', key: 'agentTimes' } as const, {} as Record<string, CockpitAgentTime>)
const noticeState = atom({ plugin: 'haley-cockpit', key: 'notice' } as const, null as string | null)

// 模組變數在熱重載時會清空（計時器也一併被引擎取消），所以 session.start 會依引擎記錄中仍開著的面板補回
const timers = new Map<PaneKey, Timer>()
const inFlight = new Set<string>()

// ---- 文字排版：終端機是等寬字型，中文佔兩格，欄位要依顯示寬度補空白 ----

function charWidth(code: number): number {
  if (code < 0x1100) return 1
  const wide =
    (code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return wide ? 2 : 1
}

function width(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 截斷（結尾加 …）並補空白到剛好 w 格。 */
function fit(text: string, w: number): string {
  if (w <= 0) return ''
  const now = width(text)
  if (now <= w) return text + ' '.repeat(w - now)
  let out = ''
  let used = 0
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (used + cw > w - 1) break
    out += ch
    used += cw
  }
  return out + '…' + ' '.repeat(Math.max(0, w - used - 1))
}

function right(text: string, w: number): string {
  const now = width(text)
  return now >= w ? text : ' '.repeat(w - now) + text
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}秒`
  if (s < 3600) return `${Math.floor(s / 60)}分${pad2(s % 60)}秒`
  if (s < 86400) return `${Math.floor(s / 3600)}時${pad2(Math.floor((s % 3600) / 60))}分`
  return `${Math.floor(s / 86400)}天${Math.floor((s % 86400) / 3600)}時`
}

function ago(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  if (s < 86400) return `${Math.floor(s / 3600)} 時前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 時間由 Python 端給時區偏移：mod 的環境不保證知道本機時區。 */
function clockText(epoch: number, tz: number): string {
  const d = new Date((epoch + tz) * 1000)
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

function count(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}萬`
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const PARTS = '▏▎▍▌▋▊▉'

/** 以 1/8 格為單位的進度條，回傳［已用, 未用］兩段，方便分開上色。 */
function bar(pct: number, w: number): [string, string] {
  const p = Math.max(0, Math.min(100, pct))
  const eighths = Math.round((p / 100) * w * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const filled = '█'.repeat(full) + (part ? (PARTS[part - 1] ?? '') : '')
  return [filled, '░'.repeat(Math.max(0, w - full - (part ? 1 : 0)))]
}

// 配色門檻（與狀態列相同）：低於 50% 綠、50～80% 黃、超過 80% 紅
function level(pct: number): Color {
  return pct < 50 ? 'success' : pct <= 80 ? 'warning' : 'error'
}

const SPARK = '▁▂▃▄▅▆▇█'

function spark(values: readonly (number | null)[]): string {
  return values.map(v => (v === null ? ' ' : (SPARK[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))] ?? ' '))).join('')
}

function toolName(tool: string): string {
  return tool === 'codex' ? 'Codex' : 'Claude'
}

function shortPath(path: string, root: string, home: string): string {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const r = norm(root).replace(/\\+$/, '')
  if (r && norm(path).startsWith(r + '\\')) return path.slice(r.length + 1)
  const h = norm(home).replace(/\\+$/, '')
  if (h && norm(path).startsWith(h + '\\')) return '~' + path.slice(h.length)
  return path
}

// ---- 資料：呼叫 collector\cockpit_cli.py ----

function pythonCommand(options: PluginOptions): string {
  const v = options['python']
  return typeof v === 'string' && v.trim() ? v.trim() : 'python'
}

async function runCli<T>($: Dollar, options: PluginOptions, args: readonly string[]): Promise<{ data: T } | { error: string }> {
  try {
    // -B：不寫 __pycache__；外掛資料夾可能在版控裡，也可能被引擎監看熱重載
    const r = await $.process.run([pythonCommand(options), '-X', 'utf8', '-B', `${$.plugin.root}/collector/cockpit_cli.py`, ...args], {
      timeoutMs: CLI_TIMEOUT_MS,
    })
    if (r.exitCode !== 0) {
      const last = r.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ''
      return { error: `cockpit_cli.py 結束碼 ${r.exitCode}：${last}` }
    }
    return { data: JSON.parse(r.stdout) as T }
  } catch (err) {
    return { error: `無法執行 python：${err instanceof Error ? err.message : String(err)}` }
  }
}

type CliResult<T> = { data: T } | { error: string }

/** 上一次還沒回來就回傳 null 跳過這一輪，避免慢的時候呼叫越疊越多。 */
async function fetchOnce<T>(key: string, work: () => Promise<CliResult<T>>): Promise<CliResult<T> | null> {
  if (inFlight.has(key)) return null
  inFlight.add(key)
  try {
    return await work()
  } finally {
    inFlight.delete(key)
  }
}

/** 成功就換上新資料並清掉錯誤；失敗保留上一次的資料，只記錯誤。
 * 呼叫端各自寫 update($, <atom 常數>, …)：引擎載入前會靜態掃描 update 的對象，參數傳進來的 atom 掃不到。 */
function merge<T>(r: CliResult<T>, at: number): (v: CockpitLoad<T>) => CockpitLoad<T> {
  return v => ('data' in r ? { data: r.data, error: null, loadedAt: at } : { ...v, error: r.error })
}

function stallMinutes(options: PluginOptions): number {
  const v = options['stallMinutes']
  return typeof v === 'number' && v > 0 ? v : 10
}

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
  if (inFlight.has('worktrees')) return
  inFlight.add('worktrees')
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
    inFlight.delete('worktrees')
  }
}

// ---- 點一列切換終端機：交給同 repo 的 VS Code 擴充 haley-session-switch ----

async function cockpitDir($: Dollar): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/haley-cockpit`
}

async function requestSwitch($: Dollar, s: CockpitSession): Promise<void> {
  const dir = await cockpitDir($)
  const at = await $.clock.now()
  const id = `${at.toString(36)}-${s.pid}`
  // 交換檔：每個 VS Code 視窗的擴充都監看它，擁有這串 pid 中某個終端機程序的視窗負責切換並回寫 switch-ack.json
  await $.fs.write(`${dir}/switch-request.json`, JSON.stringify({ id, at, pids: s.pids, tool: s.tool, project: s.project }))
  await update($, noticeState, () => `切換中：${s.project}（${toolName(s.tool)}）…`)
  waitAck($, dir, id, 0)
}

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
  if (key === 'agents') return schedule($, key, AGENT_MS, () => $.ui.invalidate('ui.render'))
  return refreshWorktrees($)
}

async function openPane($: Dollar, key: PaneKey, options: PluginOptions): Promise<string> {
  const pane = PANES[key]
  const opened = await $.ui.open({ id: pane.id, title: pane.title })
  await startFor($, key, options)
  return opened.isPlaced ? `已開啟「${pane.title}」面板。` : `「${pane.title}」面板已開啟，等待版面空間：${opened.reason}`
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
    await $.command.register({ name: 'session-board', description: '所有 Claude／Codex session 的狀態、進度與帳號用量（每 5 秒更新；點一列切到該終端機）', immediate: true })
    await $.command.register({ name: 'edit-heatmap', description: '本 session 各檔案被 Edit／Write 成功修改的次數（從紀錄檔重建）', immediate: true })
    await $.command.register({ name: 'agent-board', description: '本 session 的子代理：類型、任務、狀態、已執行時間；點一列檢視它的對話', immediate: true })
    await $.command.register({ name: 'turn-timeline', description: '本 session 每回合的耗時、輸出 token、API 呼叫與工具次數', immediate: true })
    await $.command.register({ name: 'worktree-map', description: '目前 repo 的 git worktree：路徑、分支、鎖定狀態', immediate: true })
    for (const pane of await $.ui.panes()) {
      const key = keyOf(pane.id)
      if (key) void startFor($, key, options)
    }
    return next(e)
  })

  on('command.run', { command: 'session-board' }, async $ => ({ text: await openPane($, 'board', options) }))
  on('command.run', { command: 'edit-heatmap' }, async $ => ({ text: await openPane($, 'edits', options) }))
  on('command.run', { command: 'agent-board' }, async $ => ({ text: await openPane($, 'agents', options) }))
  on('command.run', { command: 'turn-timeline' }, async $ => ({ text: await openPane($, 'turns', options) }))
  on('command.run', { command: 'worktree-map' }, async $ => ({ text: await openPane($, 'worktrees', options) }))

  // 只是觀察關閉、停掉自己的計時器；就算這裡出錯也一律放行關閉
  on('ui.close', ($, e, next) => {
    const key = keyOf(e.id)
    if (key) {
      timers.get(key)?.cancel()
      timers.delete(key)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 子代理的開始與結束時間：$.agent.list() 沒有時間欄位，所以在生成與回合結束時自己記
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const at = await $.clock.now()
      await update($, agentTimes, m => {
        const keep = Object.entries(m).slice(-199)
        return { ...Object.fromEntries(keep), [id]: { startedAt: at, endedAt: null } }
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const at = await $.clock.now()
      await update($, agentTimes, m => {
        const hit = m[id]
        return hit ? { ...m, [id]: { ...hit, endedAt: at } } : m
      })
    } else {
      // 主對話的回合結束時，開著的時間軸與熱點順手更新，不必等 30 秒
      if (timers.has('turns')) void refreshTurns($, options)
      if (timers.has('edits')) void refreshEdits($, options)
    }
    return next(e)
  })

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
    const W = { state: 9, tool: narrow ? 0 : 7, name: narrow ? 16 : 20, progress: 22, ctx: narrow ? 0 : 6, turn: narrow ? 0 : 10, last: 14 }
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
      // 名稱用 VS Code 擴充回報的終端機名稱（和分頁清單一樣）；沒有時用專案資料夾名
      const name = s.terminal || s.project
      const task = (s.title || (s.tool === 'codex' ? '（Codex 未命名）' : '（未命名）')) + (s.plan?.current ? ` · ${s.plan.current}` : '')
      // 每列一條迷你進度條：有待辦清單時是完成比例；沒有清單時，執行中畫成網點、其他留空
      const mini = s.plan && s.plan.total > 0
        ? bar((s.plan.done / s.plan.total) * 100, 6).join('')
        : s.state === 'running' || s.state === 'stalled' ? '▒▒▒▒▒▒' : '░░░░░░'
      const progress = mini + ' ' + (s.plan
        ? `${s.plan.done}/${s.plan.total}` + (s.plan.eta !== null ? ` ≈${span(s.plan.eta)}` : s.plan.done >= s.plan.total ? ' 完成' : '')
        : '無計畫')
      const ctx = s.ctx && s.ctx.pct !== null ? `${Math.round(s.ctx.pct)}%` : ''
      const turn = (s.state === 'running' || s.state === 'stalled') && s.turn ? span(s.turn.seconds) : ''
      const lastAgo = s.lastActivity ? ago(now - s.lastActivity) : '—'
      const last = s.pendingTools.length > 0 && (s.state === 'running' || s.state === 'stalled')
        ? `${s.pendingTools[0]} ${lastAgo.replace(' 前', '')}`
        : lastAgo
      const extra = s.lastError ? '!' : ' '
      return (
        <Button key={`row:${s.tool}:${s.pid}`} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => void requestSwitch($, s)}>
          <Text color={color}>{fit(mark + label, W.state)}</Text>
          <Text dimColor>{fit(W.tool ? toolName(s.tool) : '', W.tool)}</Text>
          <Text>{fit((W.tool ? '' : toolName(s.tool)[0] + ' ') + name, W.name)}</Text>
          <Text>{fit(task, taskW)}</Text>
          <Text color={s.plan ? 'text' : s.state === 'running' ? 'success' : 'subtle'}>{fit(progress, W.progress)}</Text>
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
        <Text dimColor>點一列（或按面板內的 1～9）切到該 session 的 VS Code 終端機。▶ 是本視窗；! 表示上一回合以錯誤結束。</Text>
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

  // ---- /agent-board ----
  on('ui.render', { component: 'Pane', requestId: 'agent-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const agents: AgentInfo[] = await $.agent.list()
    const times = await read($, agentTimes)
    const nowMs = await $.clock.now()
    const cols = Math.max(40, e.props.bodyColumns)
    const viewing = e.props.view.agentId
    const LABEL: Record<AgentStatus, [string, Color]> = {
      pending: ['… 排隊中', 'subtle'],
      running: ['● 執行中', 'success'],
      waiting: ['◐ 等待中', 'warning'],
      idle: ['○ 閒置', 'subtle'],
      completed: ['✓ 完成', 'subtle'],
      failed: ['✗ 失敗', 'error'],
      killed: ['■ 已停止', 'warning'],
    }
    const running = agents.filter(a => a.status === 'running').length
    const typeW = 20
    const timeW = 12
    const descW = Math.max(10, cols - 3 - 10 - typeW - timeW - 1)
    return (
      <Box flexDirection="column">
        <Text weight="bold">{`本 session 的子代理：${agents.length} 個（執行中 ${running}）`}</Text>
        {viewing ? <Button key="back" hotkey="0" onPress={() => void $.ui.view({})}>回到主對話</Button> : null}
        {agents.length === 0 ? <Text dimColor>目前沒有子代理（工作流程的代理不在這份清單裡）</Text> : null}
        {agents.map((a, i) => {
          const [label, color] = LABEL[a.status] ?? [a.status, 'warning']
          const t = times[a.id]
          const elapsed = t ? span(((t.endedAt ?? (a.status === 'running' || a.status === 'waiting' ? nowMs : t.startedAt)) - t.startedAt) / 1000) : '—'
          const mark = viewing === a.id ? '▶' : ' '
          return (
            <Button key={`a:${a.id}`} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => void $.ui.view({ agentId: a.id })}>
              <Text color={color}>{fit(mark + label, 10)}</Text>
              <Text dimColor>{fit(a.type, typeW)}</Text>
              <Text>{fit(a.name ? `${a.name}：${a.description}` : a.description, descW)}</Text>
              <Text dimColor>{right(elapsed, timeW)}</Text>
            </Button>
          )
        })}
        <Text dimColor>點一列（或按 1～9）在主畫面檢視該子代理的對話；已執行時間從本 mod 載入後開始記錄。</Text>
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
