// 路徑： tests\register.test.ts
// haley-cockpit 行為測試（claude plugin test）：總覽面板畫出收集器資料、點一列寫出切換請求、worktree 解析、子代理檢視。
// 收集器（Python）與檔案系統都用掛鉤假造：測試環境沒有 fs、process，引擎底下沒人回答的呼叫會直接丟錯。
// $ 上的呼叫在掛鉤裡以 { value } 回答（OpEventResult）。
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW_S = 1792193000

const BOARD = {
  now: NOW_S,
  tzOffset: 28800,
  stallMinutes: 10,
  counts: { running: 1, idle: 1, stalled: 1, unknown: 0 },
  usage: {
    claude: { five_hour: { used: 34, resetsAt: NOW_S + 7200 }, seven_day: { used: 85, resetsAt: NOW_S + 86400 * 3 } },
    codex: { primary: { used: 12, resetsAt: NOW_S + 86400 * 5, windowMinutes: 10080 }, secondary: null, plan: 'pro', ts: NOW_S - 60 },
  },
  sparks: { c5: new Array(20).fill(null), c7: new Array(28).fill(null), x1: new Array(28).fill(null) },
  sessions: [
    {
      tool: 'claude', id: 'self-id', pid: 111, pids: [111, 222, 333], cwd: 'D:\\work\\alpha', project: 'alpha',
      title: '整理文件', state: 'running', since: NOW_S - 300, lastActivity: NOW_S - 5, pendingTools: ['Bash'],
      lastError: false, startedAt: NOW_S - 3600, plan: { done: 2, total: 5, current: '寫測試', startedAt: NOW_S - 600, eta: 900 },
      turnCount: 3, turn: { startedAt: NOW_S - 300, seconds: 300, calls: 4, outputTokens: 1200, tools: 6 },
    },
    {
      tool: 'codex', id: 'thread-1', pid: 444, pids: [444, 555, 666, 333], cwd: 'D:\\work\\beta', project: 'beta',
      title: '審查', state: 'stalled', since: NOW_S - 1200, lastActivity: NOW_S - 1200, pendingTools: [], lastError: true,
      startedAt: NOW_S - 7200, plan: null, turnCount: 7, turn: { startedAt: NOW_S - 1500, seconds: 1500 },
    },
    {
      tool: 'claude', id: 'other', pid: 777, pids: [777, 888, 333], cwd: 'D:\\work\\gamma', project: 'gamma', title: '',
      state: 'idle', since: NOW_S - 9000, lastActivity: NOW_S - 9000, pendingTools: [], lastError: false,
      startedAt: NOW_S - 99999, plan: null, turnCount: 1,
    },
  ],
}

const PORCELAIN = [
  'worktree D:/work/alpha', 'HEAD 1234567890abcdef', 'branch refs/heads/main', '',
  'worktree D:/work/alpha-review', 'HEAD abcdef1234567890', 'branch refs/heads/feature/x', 'locked 正在審查', '',
].join('\n')

type Calls = { argv: string[][]; writes: { path: string; text: string }[] }

function ran(exitCode: number, stdout: string, stderr = '') {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

/** 測試裡的 $ 是引擎自己的：指令要帶齊引擎呼叫時的欄位（來源、呈現方式）。 */
function cmd(command: string) {
  return { command, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
}

function paneProps(title: string) {
  return { title, isFocused: true, bodyColumns: 140, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
}

/** 每個測試都要的假環境：時鐘、環境變數、session 資訊、面板與指令登記、檔案寫入，以及收集器與 git 的輸出。 */
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
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    calls.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    calls.argv.push([...e.argv])
    if (e.argv.includes('board')) return ran(0, JSON.stringify(BOARD))
    if (e.argv[0] === 'git') return ran(0, PORCELAIN)
    return ran(1, '', 'unexpected call')
  })
}

test('總覽面板畫出收集器的資料，點一列寫出切換請求', async ($, on) => {
  const calls: Calls = { argv: [], writes: [] }
  world(on, calls)
  const out = await $.command.run(cmd('session-board'))
  expect(out.text ?? '').toContain('Session 總覽')
  const argv = calls.argv.find(a => a.includes('board'))
  expect(argv).toBeDefined()
  expect(argv ?? []).toContain('--claude-rate')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface, component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
    expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▲ 停滯/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\/5 ≈15分00秒/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Codex 7 天/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'session-board', props: paneProps('Session 總覽') })
  await ui.press({ key: 'row:codex:444' })
  const written = calls.writes.find(w => w.path.endsWith('switch-request.json'))
  expect(written).toBeDefined()
  expect(JSON.parse(written?.text ?? '{}').pids).toEqual([444, 555, 666, 333])
  expect(await ui.find({ type: 'Text', text: /切換中：beta/ })).toBeDefined()
})

test('worktree 面板解析 porcelain 並標出目前所在', async ($, on) => {
  const calls: Calls = { argv: [], writes: [] }
  world(on, calls)
  await $.command.run(cmd('worktree-map'))
  const ui = await $.ui.mount({ plugin: 'haley-cockpit', surface: 'terminal', component: 'Pane', requestId: 'worktree-map', props: paneProps('Worktree') })
  expect(await ui.find({ type: 'Text', text: /▶ D:\/work\/alpha / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /鎖定：正在審查/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /feature\/x/ })).toBeDefined()
})

test('子代理面板列出代理，點一列切換檢視', async ($, on) => {
  const calls: Calls = { argv: [], writes: [] }
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
