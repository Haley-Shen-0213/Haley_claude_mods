// 路徑： tests\register.test.ts
// haley-cockpit 行為測試（claude plugin test）：總覽面板（進度、Fable 用量、點一列切換）、/go、/cockpit、
// 代理面板的工作流程、專案檔案樹、worktree 解析、子代理檢視。
// 收集器（Python）、切換程式（PowerShell）與檔案系統都用掛鉤假造：測試環境沒有 fs、process，引擎底下沒人回答的呼叫會直接丟錯。
// $ 上的呼叫在掛鉤裡以 { value } 回答（OpEventResult）。
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW_S = 1792193000

const BOARD = {
  now: NOW_S,
  tzOffset: 28800,
  stallMinutes: 10,
  counts: { running: 2, idle: 1, stalled: 1, unknown: 0 },
  usage: {
    claude: {
      five_hour: { used: 34, resetsAt: NOW_S + 7200 },
      seven_day: { used: 85, resetsAt: NOW_S + 86400 * 3 },
      models: [{ label: 'Fable', used: 37, resetsAt: NOW_S + 86400 * 2, seenAt: NOW_S - 60 }],
    },
    codex: { primary: { used: 12, resetsAt: NOW_S + 86400 * 5, windowMinutes: 10080 }, secondary: null, plan: 'pro', ts: NOW_S - 60 },
  },
  sparks: { c5: new Array(20).fill(null), c7: new Array(28).fill(null), x1: new Array(28).fill(null) },
  sessions: [
    {
      no: 1, host: 'vscode', tabTitles: ['Alpha 中控台'],
      tool: 'claude', id: 'self-id', pid: 111, pids: [111, 222, 333], cwd: 'D:\\work\\alpha', project: 'alpha',
      title: '整理文件', state: 'running', since: NOW_S - 300, lastActivity: NOW_S - 5, pendingTools: ['Bash'],
      lastError: false, startedAt: NOW_S - 3600, plan: { done: 2, total: 5, current: '寫測試', startedAt: NOW_S - 600, eta: 900 },
      turnCount: 3, turn: { startedAt: NOW_S - 300, seconds: 300, calls: 4, outputTokens: 1200, tools: 6 },
      terminal: 'Alpha 中控台', terminalIndex: 1, window: 'workspace', ctx: { pct: 62, at: NOW_S - 30 },
    },
    {
      no: 2, host: 'vscode', tabTitles: ['審查'],
      tool: 'codex', id: 'thread-1', pid: 444, pids: [444, 555, 666, 333], cwd: 'D:\\work\\beta', project: 'beta',
      title: '審查', state: 'stalled', since: NOW_S - 1200, lastActivity: NOW_S - 1200, pendingTools: [], lastError: true,
      startedAt: NOW_S - 7200, plan: null, turnCount: 7, turn: { startedAt: NOW_S - 1500, seconds: 1500 },
    },
    {
      no: 3, host: 'wt', tabTitles: ['gamma'],
      tool: 'claude', id: 'other', pid: 777, pids: [777, 888, 333], cwd: 'D:\\work\\gamma', project: 'gamma', title: '',
      state: 'idle', since: NOW_S - 9000, lastActivity: NOW_S - 9000, pendingTools: [], lastError: false,
      startedAt: NOW_S - 99999, plan: null, turnCount: 1,
    },
    {
      no: 4, host: 'wt', tabTitles: ['收尾 任務'],
      tool: 'claude', id: 'delta-id', pid: 999, pids: [999, 1000, 333], cwd: 'D:\\work\\delta', project: 'delta',
      title: '收尾', state: 'running', since: NOW_S - 1600, lastActivity: NOW_S - 3, pendingTools: ['Task'], lastError: false,
      startedAt: NOW_S - 2000, plan: null, workflow: { name: 'audit', done: 8, total: 16, running: 8, stalled: 0, startedAt: NOW_S - 1600 },
      turnCount: 2, turn: { startedAt: NOW_S - 1600, seconds: 1600 },
    },
  ],
}

const PORCELAIN = [
  'worktree D:/work/alpha', 'HEAD 1234567890abcdef', 'branch refs/heads/main', '',
  'worktree D:/work/alpha-review', 'HEAD abcdef1234567890', 'branch refs/heads/feature/x', 'locked 正在審查', '',
].join('\n')

const NO_AGENTS = { now: NOW_S, tzOffset: 28800, runs: [] as unknown[] }

const RUNS = {
  now: NOW_S,
  tzOffset: 28800,
  runs: [
    {
      runId: 'run-1', name: 'audit', summary: '稽核過期規範', taskId: 'wf-1', startedAt: NOW_S - 1600, endedAt: null,
      state: 'running', counts: { done: 1, running: 1, stalled: 0, pending: 1 }, total: 3, outputTokens: 12345,
      agents: [
        { id: 'w1', phase: '盤點', description: '讀取規範清單', type: 'general-purpose', state: 'done', startedAt: NOW_S - 1500, lastActivity: NOW_S - 1400, seconds: 100, tools: 5, lastTool: 'Read', outputTokens: 800 },
        { id: 'w2', phase: '盤點', description: '比對引用', type: 'general-purpose', state: 'running', startedAt: NOW_S - 800, lastActivity: NOW_S - 2, seconds: 800, tools: 9, lastTool: 'Grep', outputTokens: 4000 },
        { id: 'w3', phase: '彙整', description: '撰寫報告', type: 'general-purpose', state: 'pending', startedAt: null, lastActivity: null, seconds: 0, tools: 0, lastTool: null, outputTokens: 0 },
      ],
    },
    {
      runId: 'run-2', name: 'old-scan', summary: '', taskId: 'wf-0', startedAt: NOW_S - 9000, endedAt: NOW_S - 8000,
      state: 'done', counts: { done: 1, running: 0, stalled: 0, pending: 0 }, total: 1, outputTokens: 500,
      agents: [
        { id: 'w9', phase: '舊階段', description: '已結束的工作', type: 'Explore', state: 'done', startedAt: NOW_S - 9000, lastActivity: NOW_S - 8000, seconds: 1000, tools: 3, lastTool: 'Read', outputTokens: 500 },
      ],
    },
  ],
}

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

type Calls = {
  argv: string[][]
  writes: { path: string; text: string }[]
  opened: string[]
  closed: string[]
  copied: string[]
  /** 假的切換程式（powershell）印出的內容 */
  ps: string
  /** 假的 `agents` 子命令輸出 */
  agents: unknown
  /** 假的資料夾內容，鍵是資料夾路徑 */
  listing: Record<string, Entry[]>
}

function newCalls(): Calls {
  return { argv: [], writes: [], opened: [], closed: [], copied: [], ps: '', agents: NO_AGENTS, listing: {} }
}

function ran(exitCode: number, stdout: string, stderr = '') {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

/** 測試裡的 $ 是引擎自己的：指令要帶齊引擎呼叫時的欄位（來源、呈現方式）。 */
function cmd(command: string, args = '') {
  return { command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
}

function paneProps(title: string) {
  return { title, isFocused: true, bodyColumns: 140, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
}

const file = (name: string, size = 0): Entry => ({ name, kind: 'file', size, mtimeMs: 0, isLink: false })
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

/** 每個測試都要的假環境：時鐘、環境變數、session 資訊、面板與指令登記、檔案讀寫，以及收集器、git、切換程式的輸出。 */
function world(on: On, calls: Calls): void {
  mock.clock(on, { now: NOW_S * 1000 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('session.id', () => ({ value: 'self-id' }))
  on('session.cwd', () => ({ value: 'D:\\work\\alpha' }))
  on('session.root', () => ({ value: 'D:\\work\\alpha' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-17T03:00:00.000Z' }],
    },
  }))
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    calls.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    calls.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    calls.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ value: calls.listing[e.path] ?? [] }))
  on('process.run', ($, e) => {
    calls.argv.push([...e.argv])
    if (e.argv.includes('board')) return ran(0, JSON.stringify(BOARD))
    if (e.argv.includes('agents')) return ran(0, JSON.stringify(calls.agents))
    if (e.argv.includes('edits')) return ran(0, JSON.stringify({ now: NOW_S, tzOffset: 28800, files: [], total: 0 }))
    if (e.argv.includes('turns')) return ran(0, JSON.stringify({ now: NOW_S, tzOffset: 28800, turns: [] }))
    if (e.argv[0] === 'git') return ran(0, PORCELAIN)
    if (e.argv[0] === 'powershell') return ran(0, calls.ps)
    return ran(1, '', 'unexpected call')
  })
}

test('總覽面板畫出收集器的資料，點 VS Code 裡的一列寫出切換請求', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  const out = await $.command.run(cmd('session-board'))
  expect(out.text ?? '').toContain('Session 總覽')
  const argv = calls.argv.find(a => a.includes('board'))
  expect(argv).toBeDefined()
  expect(argv ?? []).toContain('--claude-rate')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface, component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
    expect(await ui.find({ type: 'Text', text: /Alpha 中控台/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▲ 停滯/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /██▍░░░ 2\/5 ≈15分00秒/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Codex 7 天/ })).toBeDefined()
    await ui.unmount()
  }
  // 窄版把工具縮成前綴：CL＝Claude、CX＝Codex（兩者不能都顯示成 C）；沒有終端機名稱時名稱用標題
  const narrow = await $.ui.mount({
    plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'session-board',
    props: { ...paneProps('Session 總覽'), bodyColumns: 100 },
  })
  expect(await narrow.find({ type: 'Text', text: /CL Alpha 中控台/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /CX 審查/ })).toBeDefined()
  await narrow.unmount()
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
  await ui.press({ key: 'row:codex:444' })
  const written = calls.writes.find(w => w.path.endsWith('switch-request.json'))
  expect(written).toBeDefined()
  expect(JSON.parse(written?.text ?? '{}').pids).toEqual([444, 555, 666, 333])
  expect(await ui.find({ type: 'Text', text: /切換中：審查|切換到「審查」/ })).toBeDefined()
  // VS Code 裡的 session 不該跑 Windows Terminal 的切換程式
  expect(calls.argv.some(a => a[0] === 'powershell')).toBe(false)
})

test('總覽面板：沒有待辦清單時進度條改用工作流程的完成代理數，用量區多一列 Fable', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  await $.command.run(cmd('session-board'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
  expect(await ui.find({ type: 'Text', text: /███░░░ 代理 8\/16 ≈26分40秒/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fable 7 天/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /37%/ })).toBeDefined()
  await ui.unmount()
})

test('點 Windows Terminal 裡的一列：把脈絡寫成檔交給切換程式，並顯示結果', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  calls.ps = '雜訊一行\n' + JSON.stringify({ ok: true, how: 'title', tab: 'delta ', foreground: true })
  await $.command.run(cmd('session-board'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
  await ui.press({ key: 'row:claude:999' })
  const ps = calls.argv.find(a => a[0] === 'powershell')
  expect(ps).toBeDefined()
  expect(ps ?? []).toContain('-ContextFile')
  expect((ps ?? []).some(a => a.endsWith('switch_terminal.ps1'))).toBe(true)
  const ctx = calls.writes.find(w => w.path.endsWith('switch-context.json'))
  expect(ctx).toBeDefined()
  const parsed = JSON.parse(ctx?.text ?? '{}')
  expect(parsed.target).toEqual({ titles: ['收尾 任務'], pids: [999, 1000, 333], startedAt: NOW_S - 2000 })
  // 同在 Windows Terminal 的其他 session 帶進去，切換程式才能用排除法對應被使用者改過名的分頁；VS Code 裡的不帶
  expect(parsed.others).toEqual([{ titles: ['gamma'], pids: [777, 888, 333], startedAt: NOW_S - 99999 }])
  expect(calls.writes.some(w => w.path.endsWith('switch-request.json'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /已切換到分頁「delta」/ })).toBeDefined()
})

test('/go：不帶參數列出編號，依編號或名稱切換，並處理各種失敗', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  const list = await $.command.run(cmd('go'))
  expect(list.text ?? '').toContain('1. ● Alpha 中控台（Claude，alpha）')
  expect(list.text ?? '').toContain('2. ▲ 審查（Codex，beta）')
  expect(list.text ?? '').toContain('4. ● 收尾（Claude，delta）')

  expect((await $.command.run(cmd('go', '1'))).text).toBe('這就是目前的 session')
  expect((await $.command.run(cmd('go', '9'))).text ?? '').toContain('沒有編號 9')
  expect((await $.command.run(cmd('go', 'a'))).text ?? '').toContain('符合多個')
  expect((await $.command.run(cmd('go', 'zzz'))).text ?? '').toContain('找不到符合「zzz」')

  // VS Code 裡的：寫切換請求，不跑切換程式
  const vs = await $.command.run(cmd('go', '2'))
  expect(vs.text).toBe('已請 VS Code 切換到「審查」')
  expect(calls.writes.some(w => w.path.endsWith('switch-request.json'))).toBe(true)
  expect(calls.argv.some(a => a[0] === 'powershell')).toBe(false)

  // Windows Terminal 裡的：依名稱找到，交給切換程式
  calls.ps = JSON.stringify({ ok: true, how: 'elimination', tab: '自訂名稱 ', foreground: false })
  const wt = await $.command.run(cmd('go', 'delta'))
  expect(wt.text ?? '').toContain('已切換到分頁「自訂名稱」')
  expect(wt.text ?? '').toContain('依排除法推定')
  expect(wt.text ?? '').toContain('視窗沒能自動帶到最前面')

  calls.ps = JSON.stringify({ ok: false, error: 'no_wt_window' })
  expect((await $.command.run(cmd('go', '3'))).text ?? '').toContain('找不到 Windows Terminal 視窗')

  calls.ps = JSON.stringify({ ok: false, error: 'no_match', tabs: ['甲 ', '乙'] })
  const miss = (await $.command.run(cmd('go', '3'))).text ?? ''
  expect(miss).toContain('找不到對應的分頁')
  expect(miss).toContain('「甲」、「乙」')

  calls.ps = '這不是 JSON'
  expect((await $.command.run(cmd('go', '3'))).text ?? '').toContain('切換失敗')
})

test('/cockpit 一次開啟全部面板，close 全部關閉', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  const out = await $.command.run(cmd('cockpit'))
  expect(out.text ?? '').toContain('已開啟 6 個面板')
  expect([...calls.opened].sort()).toEqual(['agent-board', 'edit-heatmap', 'file-tree', 'session-board', 'turn-timeline', 'worktree-map'])
  const closed = await $.command.run(cmd('cockpit', 'close'))
  expect(closed.text ?? '').toContain('已關閉全部')
  expect([...calls.closed].sort()).toEqual(['agent-board', 'edit-heatmap', 'file-tree', 'session-board', 'turn-timeline', 'worktree-map'])
})

test('worktree 面板解析 porcelain 並標出目前所在', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  await $.command.run(cmd('worktree-map'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'worktree-map', props: paneProps('Worktree') })
  expect(await ui.find({ type: 'Text', text: /▶ D:\/work\/alpha / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /鎖定：正在審查/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /feature\/x/ })).toBeDefined()
})

test('子代理面板列出代理，點一列切換檢視', async ($, on) => {
  const calls = newCalls()
  world(on, calls)
  const viewed: unknown[] = []
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '搜尋設定', type: 'Explore', status: 'running' as const },
      { id: 'a2', description: '寫報告', type: 'general-purpose', status: 'completed' as const },
    ],
  }))
  on('ui.view', ($, e) => {
    viewed.push({ ...e })
    return { value: {} }
  })
  await $.command.run(cmd('agent-board'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'agent-board', props: paneProps('子代理') })
  expect(await ui.find({ type: 'Text', text: /搜尋設定/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /執行中 1/ })).toBeDefined()
  await ui.press({ key: 'a:a1' })
  expect(viewed).toEqual([{ agentId: 'a1' }])
})

test('代理面板：工作流程依階段列出代理，執行中的預設展開、已完成的預設收合，點標題列反轉', async ($, on) => {
  const calls = newCalls()
  calls.agents = RUNS
  world(on, calls)
  on('agent.list', () => ({ value: [] }))
  await $.command.run(cmd('agent-board'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'agent-board', props: paneProps('代理與工作流程') })
  expect(await ui.find({ type: 'Text', text: /工作流程 audit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/3 完成/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /盤點（1\/2）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /彙整（0\/1）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /比對引用/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /工作流程 2 個（執行中 1）/ })).toBeDefined()
  // 已完成的 run 預設收合：只看得到標題列
  expect(await ui.find({ type: 'Text', text: /工作流程 old-scan/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已結束的工作/ })).toBeUndefined()
  await ui.press({ key: 'run:run-2' })
  expect(await ui.find({ type: 'Text', text: /已結束的工作/ })).toBeDefined()
  // 執行中的 run 按一下收合
  await ui.press({ key: 'run:run-1' })
  expect(await ui.find({ type: 'Text', text: /比對引用/ })).toBeUndefined()
})

test('檔案樹：預設略過 .git，點資料夾展開，點檔名複製絕對或相對路徑', async ($, on) => {
  const calls = newCalls()
  calls.listing = {
    'D:\\work\\alpha': [file('README.md', 2048), dir('src'), dir('.git')],
    'D:\\work\\alpha\\src': [file('main.py', 10)],
  }
  world(on, calls)
  await $.command.run(cmd('file-tree'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'file-tree', props: paneProps('專案檔案樹') })
  expect(await ui.find({ type: 'Text', text: /src\\/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\.0 KB/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\.git/ })).toBeUndefined()
  // 點檔名：複製絕對路徑
  await ui.press({ key: 'n:D:\\work\\alpha\\README.md' })
  expect(calls.copied).toEqual(['D:\\work\\alpha\\README.md'])
  expect(await ui.find({ type: 'Text', text: /已複製：D:\\work\\alpha\\README\.md/ })).toBeDefined()
  // 點資料夾：展開，不複製
  await ui.press({ key: 'n:D:\\work\\alpha\\src' })
  expect(calls.copied).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /main\.py/ })).toBeDefined()
  // 切成相對路徑，再用每列右側的「複製」
  await ui.press({ key: 'fmt' })
  await ui.press({ key: 'c:D:\\work\\alpha\\src\\main.py' })
  expect(calls.copied.at(-1)).toBe('src\\main.py')
  // 顯示全部：.git 出現
  await ui.press({ key: 'all' })
  expect(await ui.find({ type: 'Text', text: /\.git/ })).toBeDefined()
})
