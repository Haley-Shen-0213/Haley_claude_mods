// 路徑： hooks\helpers.ts
// 各面板共用的純函式：依顯示寬度排版（中文佔兩格）、時間與數字格式、進度條與配色，以及呼叫收集程式 collector\cockpit_cli.py。
// 這裡不宣告任何 $.state：引擎載入前會靜態掃描 update() 的對象，所以每個用到狀態的模組各自宣告自己的 atom。
import type { Color, EngineInterface, PluginOptions } from 'claude-code'

import type { CockpitLoad } from '../types'

export type Dollar = EngineInterface

export const EMPTY = { data: null, error: null, loadedAt: null }
const CLI_TIMEOUT_MS = 60000 // 第一次解析十幾 MB 的紀錄檔要一兩秒，留足餘裕

// ---- 文字排版：終端機是等寬字型，中文佔兩格，欄位要依顯示寬度補空白 ----

export function charWidth(code: number): number {
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

export function width(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 截斷（結尾加 …）並補空白到剛好 w 格。 */
export function fit(text: string, w: number): string {
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

export function right(text: string, w: number): string {
  const now = width(text)
  return now >= w ? text : ' '.repeat(w - now) + text
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}秒`
  if (s < 3600) return `${Math.floor(s / 60)}分${pad2(s % 60)}秒`
  if (s < 86400) return `${Math.floor(s / 3600)}時${pad2(Math.floor((s % 3600) / 60))}分`
  return `${Math.floor(s / 86400)}天${Math.floor((s % 86400) / 3600)}時`
}

export function ago(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  if (s < 86400) return `${Math.floor(s / 3600)} 時前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 時間由 Python 端給時區偏移：mod 的環境不保證知道本機時區。 */
export function clockText(epoch: number, tz: number): string {
  const d = new Date((epoch + tz) * 1000)
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

export function count(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}萬`
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const PARTS = '▏▎▍▌▋▊▉'

/** 以 1/8 格為單位的進度條，回傳［已用, 未用］兩段，方便分開上色。 */
export function bar(pct: number, w: number): [string, string] {
  const p = Math.max(0, Math.min(100, pct))
  const eighths = Math.round((p / 100) * w * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const filled = '█'.repeat(full) + (part ? (PARTS[part - 1] ?? '') : '')
  return [filled, '░'.repeat(Math.max(0, w - full - (part ? 1 : 0)))]
}

// 配色門檻（與狀態列相同）：低於 50% 綠、50～80% 黃、超過 80% 紅
export function level(pct: number): Color {
  return pct < 50 ? 'success' : pct <= 80 ? 'warning' : 'error'
}

const SPARK = '▁▂▃▄▅▆▇█'

export function spark(values: readonly (number | null)[]): string {
  return values.map(v => (v === null ? ' ' : (SPARK[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))] ?? ' '))).join('')
}

export function toolName(tool: string): string {
  return tool === 'codex' ? 'Codex' : 'Claude'
}

export function shortPath(path: string, root: string, home: string): string {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const r = norm(root).replace(/\\+$/, '')
  if (r && norm(path).startsWith(r + '\\')) return path.slice(r.length + 1)
  const h = norm(home).replace(/\\+$/, '')
  if (h && norm(path).startsWith(h + '\\')) return '~' + path.slice(h.length)
  return path
}

// ---- 資料：呼叫 collector\cockpit_cli.py ----

export type CliResult<T> = { data: T } | { error: string }

export function pythonCommand(options: PluginOptions): string {
  const v = options['python']
  return typeof v === 'string' && v.trim() ? v.trim() : 'python'
}

export function stallMinutes(options: PluginOptions): number {
  const v = options['stallMinutes']
  return typeof v === 'number' && v > 0 ? v : 10
}

export async function runCli<T>($: Dollar, options: PluginOptions, args: readonly string[]): Promise<CliResult<T>> {
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

const inFlight = new Set<string>()

/** 上一次還沒回來就回傳 null 跳過這一輪，避免慢的時候呼叫越疊越多。 */
export async function fetchOnce<T>(key: string, work: () => Promise<CliResult<T>>): Promise<CliResult<T> | null> {
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
export function merge<T>(r: CliResult<T>, at: number): (v: CockpitLoad<T>) => CockpitLoad<T> {
  return v => ('data' in r ? { data: r.data, error: null, loadedAt: at } : { ...v, error: r.error })
}

/** 每個 VS Code 視窗、每個狀態列項目共用的資料夾（交換檔都放這裡）。 */
export async function cockpitDir($: Dollar): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/haley-cockpit`
}
