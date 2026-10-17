// 路徑： types\index.d.ts
// haley-cockpit 的 $.state 契約：各面板讀的資料（collector\cockpit_cli.py 的 JSON 輸出形狀）與面板自己的狀態。

export type CockpitWindow = { used: number | null; resetsAt: number | null; windowMinutes?: number | null }

/** 模型專屬的每週額度（例如 Fable），來自官方 /usage 的背景查詢 */
export type CockpitModelLimit = { label: string; used: number | null; resetsAt: number | null; seenAt: number | null }

export type CockpitUsage = {
  claude: { five_hour?: CockpitWindow; seven_day?: CockpitWindow; models?: CockpitModelLimit[] }
  codex: { primary: CockpitWindow | null; secondary: CockpitWindow | null; plan?: string | null; ts?: number | null } | null
}

export type CockpitPlan = { done: number; total: number; current: string | null; startedAt: number | null; eta: number | null }

/** 沒有待辦清單的 session 有工作流程（Workflow 工具）在跑時，總覽的進度條改用代理的完成數 */
export type CockpitWorkflowSummary = { name: string; done: number; total: number; running: number; stalled: number; startedAt: number | null }

export type CockpitSession = {
  tool: 'claude' | 'codex'
  id: string | null
  /** 固定的編號（依 session 啟動時間排）：/go 編號、狀態列清單、各面板用同一套 */
  no: number
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
  workflow?: CockpitWorkflowSummary | null
  turnCount?: number
  turn?: { startedAt: number | null; seconds: number; calls?: number; outputTokens?: number; tools?: number }
  model?: string | null
  /** session 在哪種終端機裡：vscode＝VS Code 整合終端機；wt＝鏈上看得到 Windows Terminal；console＝其他（例如從開始功能表開的 cmd） */
  host?: 'vscode' | 'wt' | 'console'
  /** 終端機分頁可能顯示的名稱，給切換程式比對 */
  tabTitles?: string[]
  /** 登記檔裡自動產生的代號（例如 myproject-8e），不是標題；標題在 title */
  slug?: string
  /** VS Code 擴充回報的終端機名稱（和分頁清單相同）；沒裝擴充或不在 VS Code 時沒有 */
  terminal?: string
  terminalIndex?: number | null
  window?: string
  /** context 使用比例：Claude 取自該 session 紀錄檔最後一次請求，Codex 取自 rollout 的 token 事件 */
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

/** 工作流程派出的一個代理（資料來自它在 session 資料夾底下的 meta 與對話紀錄） */
export type CockpitWorkflowAgent = {
  id: string
  phase: string
  description: string
  type: string
  state: 'done' | 'running' | 'stalled' | 'pending'
  startedAt: number | null
  lastActivity: number | null
  seconds: number
  tools: number
  lastTool: string | null
  outputTokens: number
}
export type CockpitWorkflowRun = {
  runId: string
  name: string
  summary: string
  taskId: string | null
  startedAt: number | null
  endedAt: number | null
  state: 'done' | 'running' | 'stalled'
  counts: { done: number; running: number; stalled: number; pending: number }
  total: number
  outputTokens: number
  agents: CockpitWorkflowAgent[]
}
export type CockpitAgentsData = { now: number; tzOffset: number; runs: CockpitWorkflowRun[]; error?: string }

/** 一份面板資料：最後一次成功的結果、最後一次的錯誤（成功後清掉）、成功的時間（毫秒）。 */
export type CockpitLoad<T> = { data: T | null; error: string | null; loadedAt: number | null }

export type CockpitAgentTime = { startedAt: number; endedAt: number | null }

/** 檔案樹的一個項目 */
export type CockpitTreeEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number }

declare module 'claude-code' {
  interface PluginState {
    'haley-cockpit': {
      board: CockpitLoad<CockpitBoard>
      edits: CockpitLoad<CockpitEdits>
      editsAll: boolean
      turns: CockpitLoad<CockpitTurns>
      worktrees: CockpitLoad<CockpitWorktrees>
      agentTimes: Record<string, CockpitAgentTime>
      workflows: CockpitLoad<CockpitAgentsData>
      flippedRuns: string[]
      notice: string | null
      treeRoot: string | null
      treeOpen: string[]
      treeDirs: Record<string, CockpitTreeEntry[]>
      treeAbs: boolean
      treeHidden: boolean
      treeNotice: string | null
      treeError: string | null
    }
  }
}
