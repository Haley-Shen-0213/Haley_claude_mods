// 路徑： hooks\reads.tsx
// /read-map：本 session（含子代理）讀了哪些檔案。資料全部從紀錄檔重建，見 collector\cockpit\claude_sessions.py 的 read_view：
// 開場自動載入的規範檔、Read 工具讀的檔（分得出讀完沒）、Bash／PowerShell 從指令文字推測的讀檔、Grep／Glob 的次數。
import { atom, read, update } from 'claude-code'
import type { Color, On, PluginOptions } from 'claude-code'

import type { CockpitLoad, CockpitReadFile, CockpitReads } from '../types'
import { EMPTY, ago, fetchOnce, fit, merge, right, runCli, shortPath } from './helpers'
import type { Dollar } from './helpers'

const readsState = atom({ plugin: 'haley-cockpit', key: 'reads' } as const, EMPTY as CockpitLoad<CockpitReads>)

const LOADED_LABEL: Record<string, string> = { User: '使用者層', Project: '專案', Local: '本機', Managed: '組織', Mention: '@ 提及' }
const MAX_ROWS = 200

export async function refreshReads($: Dollar, options: PluginOptions): Promise<void> {
  const args = ['reads', '--session', await $.session.id()]
  const r = await fetchOnce('reads', () => runCli<CockpitReads>($, options, args))
  if (r) await update($, readsState, merge(r, await $.clock.now()))
}

function coverage(f: CockpitReadFile): [string, string, Color] {
  if (f.complete === null) return ['—', '', 'subtle']
  const lines = f.total === null ? '' : `${Math.min(f.lines, f.total)}/${f.total} 行`
  return f.complete ? ['完整', lines, 'success'] : ['部分', lines, 'warning']
}

export function registerReads(on: On, options: PluginOptions): void {
  on('ui.render', { component: 'Pane', requestId: 'read-map' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, readsState)
    const cols = Math.max(40, e.props.bodyColumns)
    const root = await $.session.root()
    const home = (await $.env.get('USERPROFILE')) ?? ''
    const d = load.data
    const toolbar = <Button key="refresh" hotkey="r" onPress={() => void refreshReads($, options)}>重新整理</Button>
    if (!d) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…'}</Text>
        </Box>
      )
    }
    const short = (p: string) => shortPath(p, root, home)
    const when = (at: number | null) => (at ? ago(d.now - at) : '')
    const lastW = 10
    const partial = d.files.filter(f => f.complete === false).length
    const loadedPathW = Math.max(10, cols - 11)
    const statW = 4 + 1 + 6 + 15 // 次數、狀態、行數
    const pathW = Math.max(10, cols - statW - lastW - 1)
    const shellPathW = Math.max(10, cols - 5 - lastW - 1)
    return (
      <Box flexDirection="column">
        {toolbar}
        {d.error ? <Text color="warning">{d.error}</Text> : null}
        <Text weight="bold">{`開場自動載入 ${d.loaded.length} 檔`}</Text>
        {d.loaded.map(l => (
          <Box key={`l:${l.path}`}>
            <Text dimColor>{fit(LOADED_LABEL[l.type] ?? l.type, 10) + ' '}</Text>
            <Text>{fit(short(l.path), loadedPathW)}</Text>
          </Box>
        ))}
        <Text weight="bold">{`\nRead 工具 ${d.files.length} 檔、${d.total} 次${partial ? `（${partial} 檔只讀部分）` : ''}`}</Text>
        {d.files.length === 0 ? <Text dimColor>還沒有讀取紀錄</Text> : null}
        {d.files.slice(0, MAX_ROWS).map(f => {
          const [label, lines, color] = coverage(f)
          return (
            <Box key={`f:${f.path}`}>
              <Text>{right(String(f.count), 4) + ' '}</Text>
              <Text color={color}>{fit(label, 6)}</Text>
              <Text dimColor>{fit(lines, 15)}</Text>
              <Text>{fit(short(f.path) + (f.main ? '' : '（子代理）'), pathW)}</Text>
              <Text dimColor>{' ' + right(when(f.lastAt), lastW)}</Text>
            </Box>
          )
        })}
        {d.files.length > MAX_ROWS ? <Text dimColor>{`… 另有 ${d.files.length - MAX_ROWS} 檔`}</Text> : null}
        {d.shell.length > 0 ? <Text weight="bold">{`\nBash／PowerShell 推測 ${d.shell.length} 檔`}</Text> : null}
        {d.shell.slice(0, MAX_ROWS).map(s => (
          <Box key={`s:${s.path}`}>
            <Text>{right(String(s.count), 4) + ' '}</Text>
            <Text>{fit(short(s.path), shellPathW)}</Text>
            <Text dimColor>{' ' + right(when(s.lastAt), lastW)}</Text>
          </Box>
        ))}
        <Text dimColor>{`\n含子代理 ${d.agents} 個。Grep ${d.searches['Grep'] ?? 0} 次、Glob ${d.searches['Glob'] ?? 0} 次只有搜尋條件，看不出讀到什麼，不列入。`}</Text>
        <Text dimColor>Bash／PowerShell 是從指令文字推測，腳本裡讀的檔看不到，也可能多列。</Text>
        {load.error ? <Text color="warning">{`最近一次更新失敗：${load.error}`}</Text> : null}
      </Box>
    )
  })
}
