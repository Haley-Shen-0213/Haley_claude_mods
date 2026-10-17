// 路徑： hooks\agents.tsx
// /agent-board：本 session 的子代理（官方清單）＋工作流程（Workflow 工具）派出的代理。
// 官方的 $.agent.list() 不含工作流程的代理（Claude Code 畫面底部另外顯示「工作流程 8/16」），所以這裡另外讀磁碟上各代理的紀錄，
// 見 collector\cockpit\workflows.py；兩邊合起來才和畫面底部的顯示一致。
import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, Color, On, PluginOptions } from 'claude-code'

import type { CockpitAgentsData, CockpitAgentTime, CockpitLoad, CockpitWorkflowAgent, CockpitWorkflowRun } from '../types'
import { EMPTY, bar, count, fetchOnce, fit, merge, right, runCli, span, stallMinutes } from './helpers'
import type { Dollar } from './helpers'

// 子代理（官方清單）沒有時間欄位，所以在生成與回合結束時自己記
const agentTimes = atom({ plugin: 'haley-cockpit', key: 'agentTimes' } as const, {} as Record<string, CockpitAgentTime>)
const workflowsState = atom({ plugin: 'haley-cockpit', key: 'workflows' } as const, EMPTY as CockpitLoad<CockpitAgentsData>)
// 使用者按過標題列的 run：執行中的 run 預設展開、已完成的預設收合，按一下就反過來
const flippedRuns = atom({ plugin: 'haley-cockpit', key: 'flippedRuns' } as const, [] as string[])

const MAX_ROWS = 80

export async function refreshAgents($: Dollar, options: PluginOptions): Promise<void> {
  const args = ['agents', '--session', await $.session.id(), '--stall-minutes', String(stallMinutes(options))]
  const r = await fetchOnce('agents', () => runCli<CockpitAgentsData>($, options, args))
  if (r) await update($, workflowsState, merge(r, await $.clock.now()))
}

/** 子代理的回合結束時記下結束時間。engine 不允許同一事件無條件登記兩次，所以由 register.tsx 唯一的 turn.complete 掛鉤呼叫。 */
export async function noteAgentEnd($: Dollar, agentId: string): Promise<void> {
  const at = await $.clock.now()
  await update($, agentTimes, m => {
    const hit = m[agentId]
    return hit ? { ...m, [agentId]: { ...hit, endedAt: at } } : m
  })
}

const LIST_LABEL: Record<AgentStatus, [string, Color]> = {
  pending: ['… 排隊中', 'subtle'],
  running: ['● 執行中', 'success'],
  waiting: ['◐ 等待中', 'warning'],
  idle: ['○ 閒置', 'subtle'],
  completed: ['✓ 完成', 'subtle'],
  failed: ['✗ 失敗', 'error'],
  killed: ['■ 已停止', 'warning'],
}

const WF_ICON: Record<CockpitWorkflowAgent['state'], [string, Color]> = {
  done: ['✓', 'subtle'],
  running: ['●', 'success'],
  stalled: ['▲', 'error'],
  pending: ['…', 'subtle'],
}

/** 把一個 run 的代理依階段分組（階段依第一次出現的順序）。 */
function byPhase(agents: readonly CockpitWorkflowAgent[]): [string, CockpitWorkflowAgent[]][] {
  const groups = new Map<string, CockpitWorkflowAgent[]>()
  for (const a of agents) {
    const key = a.phase || '（未分階段）'
    const list = groups.get(key) ?? []
    list.push(a)
    groups.set(key, list)
  }
  return [...groups.entries()]
}

export function registerAgents(on: On, options: PluginOptions): void {
  // 子代理的開始與結束時間：工作流程的代理由磁碟紀錄提供，不記在這裡（免得塞滿）
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId && !e.workflow) {
      const id = r.agentId
      const at = await $.clock.now()
      await update($, agentTimes, m => {
        const keep = Object.entries(m).slice(-199)
        return { ...Object.fromEntries(keep), [id]: { startedAt: at, endedAt: null } }
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'agent-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const agents: AgentInfo[] = await $.agent.list()
    const times = await read($, agentTimes)
    const wf = await read($, workflowsState)
    const flipped = await read($, flippedRuns)
    const nowMs = await $.clock.now()
    const cols = Math.max(40, e.props.bodyColumns)
    const viewing = e.props.view.agentId
    const runs = wf.data?.runs ?? []
    const running = agents.filter(a => a.status === 'running').length
    const runningRuns = runs.filter(r => r.state !== 'done').length
    const barW = Math.max(10, Math.min(40, cols - 36))

    const runBlocks = runs.map((run: CockpitWorkflowRun) => {
      const isOpen = (run.state !== 'done') !== flipped.includes(run.runId)
      const c = run.counts
      const pct = run.total ? (c.done / run.total) * 100 : 0
      const color: Color = run.state === 'done' ? 'subtle' : run.state === 'stalled' ? 'error' : 'success'
      const [filled, empty] = bar(pct, barW)
      const elapsed = run.startedAt ? span(((run.endedAt ?? wf.data?.now ?? 0) - run.startedAt)) : ''
      const phases = isOpen ? byPhase(run.agents) : []
      let shown = 0
      return (
        <Box key={`run-box:${run.runId}`} flexDirection="column">
          <Button key={`run:${run.runId}`} plain onPress={() => void update($, flippedRuns, v => (v.includes(run.runId) ? v.filter(x => x !== run.runId) : [...v, run.runId]))}>
            <Text color={color} weight="bold">{`${isOpen ? '▾' : '▸'} 工作流程 ${run.name}`}</Text>
            <Text color={color}>{`　${c.done}/${run.total} 完成　執行中 ${c.running}${c.stalled ? `　停滯 ${c.stalled}` : ''}${c.pending ? `　待開始 ${c.pending}` : ''}`}</Text>
            <Text dimColor>{`　${elapsed ? `已執行 ${elapsed}　` : ''}輸出 ${count(run.outputTokens)} token`}</Text>
          </Button>
          <Box>
            <Text color={color}>{'  ' + filled}</Text>
            <Text dimColor>{empty}</Text>
            <Text color={color}>{` ${Math.round(pct)}%`}</Text>
          </Box>
          {run.summary ? <Text dimColor>{'  ' + fit(run.summary, cols - 3).trimEnd()}</Text> : null}
          {phases.map(([phase, list]) => {
            const done = list.filter(a => a.state === 'done').length
            const rows = list.filter(() => shown++ < MAX_ROWS)
            const descW = Math.max(10, cols - 4 - 9 - 8 - 12 - 2)
            return (
              <Box key={`ph:${run.runId}:${phase}`} flexDirection="column">
                <Text dimColor>{`  ${phase}（${done}/${list.length}）`}</Text>
                {rows.map(a => {
                  const [icon, iconColor] = WF_ICON[a.state]
                  return (
                    <Box key={`wa:${a.id}`}>
                      <Text color={iconColor}>{`    ${icon} `}</Text>
                      <Text dimColor={a.state === 'done'}>{fit(a.description, descW)}</Text>
                      <Text dimColor>{right(a.state === 'pending' ? '' : span(a.seconds), 9)}</Text>
                      <Text dimColor>{right(`工具 ${a.tools}`, 8)}</Text>
                      <Text dimColor>{'  ' + fit(a.state === 'running' || a.state === 'stalled' ? (a.lastTool ?? '') : '', 12)}</Text>
                    </Box>
                  )
                })}
                {rows.length < list.length ? <Text dimColor>{`    … 另有 ${list.length - rows.length} 個`}</Text> : null}
              </Box>
            )
          })}
        </Box>
      )
    })

    const typeW = 20
    const timeW = 12
    const descW = Math.max(10, cols - 3 - 10 - typeW - timeW - 1)
    return (
      <Box flexDirection="column">
        <Text weight="bold">{`本 session 的代理：子代理 ${agents.length} 個（執行中 ${running}）· 工作流程 ${runs.length} 個（執行中 ${runningRuns}）`}</Text>
        <Box gap={1}>
          <Button key="refresh" hotkey="r" onPress={() => void refreshAgents($, options)}>重新整理</Button>
          {viewing ? <Button key="back" hotkey="0" onPress={() => void $.ui.view({})}>回到主對話</Button> : null}
        </Box>
        {wf.error ? <Text color="warning">{`工作流程資料更新失敗：${wf.error}`}</Text> : null}
        {runBlocks}
        {agents.length > 0 ? <Text weight="bold">{'\n子代理'}</Text> : null}
        {agents.map((a, i) => {
          const [label, color] = LIST_LABEL[a.status] ?? [a.status, 'warning']
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
        {agents.length === 0 && runs.length === 0 ? <Text dimColor>目前沒有子代理，也沒有工作流程</Text> : null}
        <Text dimColor>子代理：點一列（或按 1～9）在主畫面檢視它的對話。工作流程：點標題列展開或收合；資料來自各代理的對話紀錄，約每 3 秒更新。</Text>
      </Box>
    )
  })
}
