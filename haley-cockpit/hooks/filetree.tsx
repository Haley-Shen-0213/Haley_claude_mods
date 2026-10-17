// 路徑： hooks\filetree.tsx
// /file-tree：專案檔案樹。顯示目前專案的資料夾與檔案結構；點資料夾展開或收合，點檔名複製它的路徑，
// 每列右側的「複製」複製該列（資料夾或檔案）的路徑；路徑可在「絕對」與「相對於根目錄」之間切換。
import { atom, read, update } from 'claude-code'
import type { Color, On } from 'claude-code'

import type { CockpitTreeEntry } from '../types'
import { fit, right } from './helpers'
import type { Dollar } from './helpers'

const treeRoot = atom({ plugin: 'haley-cockpit', key: 'treeRoot' } as const, null as string | null)
const treeOpen = atom({ plugin: 'haley-cockpit', key: 'treeOpen' } as const, [] as string[])
const treeDirs = atom({ plugin: 'haley-cockpit', key: 'treeDirs' } as const, {} as Record<string, CockpitTreeEntry[]>)
const treeAbs = atom({ plugin: 'haley-cockpit', key: 'treeAbs' } as const, true)
const treeHidden = atom({ plugin: 'haley-cockpit', key: 'treeHidden' } as const, false)
const treeNotice = atom({ plugin: 'haley-cockpit', key: 'treeNotice' } as const, null as string | null)
const treeError = atom({ plugin: 'haley-cockpit', key: 'treeError' } as const, null as string | null)

// 預設略過的資料夾：很大、很少需要複製路徑；按「顯示全部」可以看到
const SKIPPED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vs'])
const MAX_PER_DIR = 400
const MAX_ROWS = 700

function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + '\\' + name
}

function parentOf(path: string): string {
  const cut = path.replace(/[\\/]+$/, '')
  const i = Math.max(cut.lastIndexOf('\\'), cut.lastIndexOf('/'))
  // 磁碟機根目錄（D:）再往上沒有東西
  return i <= 2 && /^[A-Za-z]:/.test(cut) ? cut.slice(0, 2) + '\\' : i > 0 ? cut.slice(0, i) : cut
}

function relativeTo(path: string, root: string): string {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  if (norm(path) === norm(root)) return '.'
  const r = norm(root)
  return norm(path).startsWith(r + '\\') ? path.slice(root.replace(/[\\/]+$/, '').length + 1) : path
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function listDir($: Dollar, dir: string): Promise<{ entries: CockpitTreeEntry[]; error: string | null }> {
  try {
    const raw = await $.fs.list(dir)
    const entries: CockpitTreeEntry[] = raw.map(x => ({ name: x.name, kind: x.kind, size: x.size }))
    // 資料夾在前、檔案在後，各自依名稱排（不分大小寫；不用 localeCompare，mod 的環境不一定有中文語系資料）
    entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    return { entries, error: null }
  } catch (err) {
    return { entries: [], error: `${dir}：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 讀根目錄與所有展開中的資料夾（平行），整份換進快取；單一資料夾讀不到只記錯誤，不影響其他。 */
export async function refreshTree($: Dollar): Promise<void> {
  const root = (await read($, treeRoot)) ?? (await $.session.root())
  const open = await read($, treeOpen)
  const dirs = [root, ...open.filter(d => d !== root)]
  const results = await Promise.all(dirs.map(async d => [d, await listDir($, d)] as const))
  const map: Record<string, CockpitTreeEntry[]> = {}
  const errors: string[] = []
  for (const [d, r] of results) {
    map[d] = r.entries
    if (r.error) errors.push(r.error)
  }
  await update($, treeRoot, v => v ?? root)
  await update($, treeDirs, () => map)
  await update($, treeError, () => (errors.length ? errors.slice(0, 2).join('；') : null))
}

export function registerTree(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'file-tree' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const root = await read($, treeRoot)
    const open = await read($, treeOpen)
    const dirs = await read($, treeDirs)
    const abs = await read($, treeAbs)
    const showAll = await read($, treeHidden)
    const notice = await read($, treeNotice)
    const error = await read($, treeError)
    const cols = Math.max(40, e.props.bodyColumns)

    const copy = async (press: { surface: Parameters<typeof $.ui.copy>[0]['surface'] }, path: string) => {
      const useAbs = await read($, treeAbs)
      const base = await read($, treeRoot)
      const text = useAbs || !base ? path : relativeTo(path, base)
      const r = await $.ui.copy({ text, surface: press.surface })
      await update($, treeNotice, () => (r.isCopied ? `已複製：${text}` : `複製失敗（${r.reason}）：${text}`))
    }
    const toggle = async (path: string) => {
      const isOpen = (await read($, treeOpen)).includes(path)
      await update($, treeOpen, v => (v.includes(path) ? v.filter(x => x !== path) : [...v, path]))
      if (!isOpen) await refreshTree($)
    }
    const goto = async (path: string) => {
      await update($, treeRoot, () => path)
      await update($, treeOpen, () => [])
      await refreshTree($)
    }
    // 六個按鈕加起來超過九十欄，不換行會被截掉最後一個（驗收截圖看到過）
    const toolbar = (
      <Box gap={1} flexWrap="wrap">
        <Button key="refresh" hotkey="r" onPress={() => void refreshTree($)}>重新整理</Button>
        <Button key="fmt" hotkey="s" onPress={() => void update($, treeAbs, v => !v)}>{abs ? '路徑：絕對' : '路徑：相對'}</Button>
        <Button key="all" hotkey="h" onPress={() => void update($, treeHidden, v => !v)}>{showAll ? '顯示：全部' : '顯示：略過 .git 等'}</Button>
        {root ? <Button key="up" hotkey="u" onPress={() => void goto(parentOf(root))}>上一層</Button> : null}
        <Button key="home" hotkey="0" onPress={() => void $.session.root().then(goto)}>回專案根目錄</Button>
        {root ? <Button key="root-copy" hotkey="c" onPress={p => void copy(p, root)}>複製根目錄</Button> : null}
      </Box>
    )
    if (!root || !dirs[root]) {
      return (
        <Box flexDirection="column">
          {toolbar}
          <Text dimColor>{error ? `讀取失敗：${error}` : '讀取中…'}</Text>
        </Box>
      )
    }

    type Row = { path: string; name: string; entry: CockpitTreeEntry; depth: number }
    const rows: Row[] = []
    let truncated = 0
    const walk = (dir: string, depth: number) => {
      const list = (dirs[dir] ?? []).filter(x => showAll || !(x.kind === 'dir' && SKIPPED.has(x.name)))
      for (const entry of list.slice(0, MAX_PER_DIR)) {
        if (rows.length >= MAX_ROWS) {
          truncated++
          continue
        }
        const path = joinPath(dir, entry.name)
        rows.push({ path, name: entry.name, entry, depth })
        if (entry.kind === 'dir' && open.includes(path)) walk(path, depth + 1)
      }
      if (list.length > MAX_PER_DIR) truncated += list.length - MAX_PER_DIR
    }
    walk(root, 0)

    const nameW = Math.max(16, cols - 9 - 7)
    return (
      <Box flexDirection="column">
        {toolbar}
        <Text dimColor>{root}</Text>
        <Text dimColor>{`點資料夾展開；點檔名複製${abs ? '絕對' : '相對'}路徑；右側「複製」複製那一列`}</Text>
        {notice ? <Text color="suggestion">{notice}</Text> : null}
        {error ? <Text color="warning">{`部分資料夾讀不到：${error}`}</Text> : null}
        {rows.map(r => {
          const isDir = r.entry.kind === 'dir'
          const isOpen = isDir && open.includes(r.path)
          const label = '  '.repeat(r.depth) + (isDir ? (isOpen ? '▾ ' : '▸ ') : '  ') + r.name + (isDir ? '\\' : '')
          const color: Color = isDir ? 'suggestion' : 'text'
          return (
            <Box key={`row:${r.path}`}>
              <Button key={`n:${r.path}`} plain onPress={p => void (isDir ? toggle(r.path) : copy(p, r.path))}>
                <Text color={color}>{fit(label, nameW)}</Text>
              </Button>
              <Text dimColor>{right(isDir ? '' : fmtSize(r.entry.size), 9)}</Text>
              <Button key={`c:${r.path}`} plain onPress={p => void copy(p, r.path)}>
                <Text dimColor>{' 複製'}</Text>
              </Button>
            </Box>
          )
        })}
        {truncated > 0 ? <Text dimColor>{`… 另有 ${truncated} 項沒有列出（展開的資料夾太多或單一資料夾項目過多）`}</Text> : null}
      </Box>
    )
  })
}
