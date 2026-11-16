// 路徑： hooks\skills.tsx
// /skill-board 技能清單（v1.3.0）：列出使用者層（~\.claude\skills）與入口資料夾層（<入口資料夾>\.claude\skills）的 skill，
// 點一列展開或收合它的描述。預設只讀這兩個位置的 SKILL.md 開頭欄位；Codex 的 ~\.agents\skills 是選配（Haley 2026-11-16 裁定 D7），
// 讀取在 collector\cockpit\skills.py。
import { atom, read, update } from 'claude-code'
import type { On, PluginOptions } from 'claude-code'

import type { CockpitLoad, CockpitSkill, CockpitSkills } from '../types'
import { EMPTY, fetchOnce, fit, liveOptions, merge, runCli, shortPath, width } from './helpers'
import type { Dollar } from './helpers'

const skillsState = atom({ plugin: 'haley-cockpit', key: 'skills' } as const, EMPTY as CockpitLoad<CockpitSkills>)
const skillOpen = atom({ plugin: 'haley-cockpit', key: 'skillOpen' } as const, [] as string[])

const SOURCE_LABEL: Record<CockpitSkill['source'], string> = { user: '使用者層', entry: '入口資料夾', codex: 'Codex（選配）' }

export async function refreshSkills($: Dollar, options: PluginOptions): Promise<void> {
  const codex = (await liveOptions($, options))['skillsCodex'] === true
  const args = ['skills', '--root', await $.session.root(), ...(codex ? ['--codex'] : [])]
  const r = await fetchOnce('skills', () => runCli<CockpitSkills>($, options, args))
  if (r) await update($, skillsState, merge(r, await $.clock.now()))
}

/** 描述依面板寬度切成多行（中文算兩格），不讓一行超出面板。 */
function wrap(text: string, cols: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    if (width(line + ch) > cols) {
      out.push(line)
      line = ''
    }
    line += ch
  }
  if (line) out.push(line)
  return out
}

export function registerSkills(on: On, options: PluginOptions): void {
  on('ui.render', { component: 'Pane', requestId: 'skill-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const load = await read($, skillsState)
    const open = await read($, skillOpen)
    const cols = Math.max(40, e.props.bodyColumns)
    const home = (await $.env.get('USERPROFILE')) ?? ''
    const root = await $.session.root()
    const d = load.data
    const toolbar = <Button key="refresh" hotkey="r" onPress={() => void refreshSkills($, options)}>重新整理</Button>
    if (!d) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{load.error ? `讀取失敗：${load.error}` : '讀取中…'}</Text>
        </Box>
      )
    }
    const groups: [CockpitSkill['source'], string | null][] = [['user', d.userDir], ['entry', d.entryDir], ['codex', d.codexDir]]
    const descW = Math.max(20, cols - 4)
    return (
      <Box flexDirection="column">
        {toolbar}
        {groups.map(([source, dir]) => {
          const rows = d.skills.filter(s => s.source === source)
          if (source !== 'user' && !dir) return null
          return (
            <Box key={`g:${source}`} flexDirection="column">
              <Text weight="bold">{`\n${SOURCE_LABEL[source]} ${rows.length} 個`}</Text>
              <Text dimColor>{fit(shortPath(dir ?? '', root, home), cols)}</Text>
              {rows.length === 0 ? <Text dimColor>（沒有 skill）</Text> : null}
              {rows.map(s => {
                const key = `${s.source}:${s.folder}`
                const isOpen = open.includes(key)
                return (
                  <Box key={`s:${key}`} flexDirection="column">
                    <Button key={`skill:${key}`} plain onPress={() => void update($, skillOpen, v => (v.includes(key) ? v.filter(x => x !== key) : [...v, key]))}>
                      <Text>{fit(`${isOpen ? '▼' : '▶'} ${s.name}`, cols)}</Text>
                    </Button>
                    {isOpen
                      ? (s.error ? [s.error] : s.description ? wrap(s.description, descW) : ['（沒有描述）']).map((line, i) => (
                          <Text key={`d:${key}:${i}`} dimColor={!s.description || !!s.error}>{`    ${line}`}</Text>
                        ))
                      : null}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        <Text dimColor>{'\n點一列展開或收合描述。只讀上列位置的 SKILL.md 開頭欄位，不讀其他位置；Codex 的 skills 要在設定打開「技能清單：也列 Codex 的 skills」。'}</Text>
        {load.error ? <Text color="warning">{`最近一次更新失敗：${load.error}`}</Text> : null}
      </Box>
    )
  })
}
