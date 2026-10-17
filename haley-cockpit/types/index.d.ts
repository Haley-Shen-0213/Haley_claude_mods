// 路徑： types\index.d.ts
// haley-cockpit 的 $.state 契約：各面板讀的資料（collector\cockpit_cli.py 的 JSON 輸出形狀）與面板自己的狀態。

export type CockpitWindow = { used: number | null; resetsAt: number | null; windowMinutes?: number | null }

export type CockpitUsage = {
  claude: { five_hour?: CockpitWindow; seven_day?: CockpitWindow }
  codex: { primary: CockpitWindow | null; secondary: CockpitWindow | null; plan?: string | null; ts?: number | null } | null
}

export type CockpitPlan = { done: number; total: number; current: string | null; startedAt: number | null; eta: number | null }

export type CockpitSession = {
  tool: 'claude' | 'codex'
  id: string | null
  pid: number
  pids: number[]
  cwd: string | null
  project: string
  title: string
  state: string
  since?: number | null
  lastActivity: number | null
  pendingTools: string[]
  lastError: boolean
  startedAt: number | null
  plan?: CockpitPlan | null
  turnCount?: number
  turn?: { startedAt: number | null; seconds: number; calls?: number; outputTokens?: number; tools?: number }
  model?: string | null
  /** VS Code 擴充回報的終端機名稱（和分頁清單相同）；沒裝擴充或不在 VS Code 時沒有 */
  terminal?: string
  terminalIndex?: number | null
  window?: string
  /** context 使用比例：Claude 取自該 session 狀態列的回報，Codex 取自 rollout 的 token 事件 */
  ctx?: { pct: number | null; at: number | null; tokens?: number; size?: number } | null
}

/** 不在終端機裡的 session（例如 VS Code 的 Claude 面板在背景開的）：不列進總覽，只告知有幾個 */
export type CockpitOther = { tool: string; pid: number; entrypoint: string | null; state: string; project: string }

export type CockpitSparks = { c5: (number | null)[]; c7: (number | null)[]; x1: (number | null)[] }

export type CockpitBoard = {
  now: number
  tzOffset: number
  stallMinutes: number
  sessions: CockpitSession[]
  counts: { running: number; idle: number; stalled: number; unknown: number }
  others?: CockpitOther[]
  usage: CockpitUsage
  sparks?: CockpitSparks
}

export type CockpitEdit = { path: string; count: number; lastAt: number | null; sessions: number }
export type CockpitEdits = { now: number; tzOffset: number; files: CockpitEdit[]; total: number }

export type CockpitTurn = {
  index: number
  start: number | null
  seconds: number
  calls: number
  outputTokens: number
  inputTokens: number
  tools: number
  interrupted: boolean
  error: boolean
  queued: boolean
  running: boolean
}
export type CockpitTurns = { now: number; tzOffset: number; turns: CockpitTurn[]; error?: string }

export type CockpitWorktree = {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: string | null
  prunable: string | null
  isCurrent: boolean
}
export type CockpitWorktrees = { root: string; items: CockpitWorktree[] }

/** 一份面板資料：最後一次成功的結果、最後一次的錯誤（成功後清掉）、成功的時間（毫秒）。 */
export type CockpitLoad<T> = { data: T | null; error: string | null; loadedAt: number | null }

export type CockpitAgentTime = { startedAt: number; endedAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'haley-cockpit': {
      board: CockpitLoad<CockpitBoard>
      edits: CockpitLoad<CockpitEdits>
      editsAll: boolean
      turns: CockpitLoad<CockpitTurns>
      worktrees: CockpitLoad<CockpitWorktrees>
      agentTimes: Record<string, CockpitAgentTime>
      notice: string | null
    }
  }
}
