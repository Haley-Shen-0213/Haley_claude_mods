// 路徑： hooks\update.ts
// 自動更新（v1.2.0，Haley 2026-11-16 裁定 D3、D4A、D5A）：
// - 更新模式在 /config 的「更新模式」：不問不做／可選／全自動，預設不問不做。
// - 從市集安裝、第一次載入時問一次要不要開啟；不選或關掉視窗就維持不問不做。
// - 從資料夾載入（手動部署、開發機）不檢查更新。
// - 每次載入都改寫狀態列啟動程式（~\.claude\haley-cockpit\statusline_launcher.py），指向目前的版本。
import type { PluginOptions } from 'claude-code'

import type { CockpitStartup, CockpitUpdateApply, CockpitVersion } from '../types'
import { ago, clockText, liveOptions, runCli } from './helpers'
import type { Dollar } from './helpers'

export const UPDATE_MODES = ['不問不做', '可選', '全自動'] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

export function updateMode(options: PluginOptions): UpdateMode {
  const v = options['updateMode']
  return (UPDATE_MODES as readonly string[]).includes(v as string) ? (v as UpdateMode) : '不問不做'
}

const FIRST_ASK: Record<string, UpdateMode> = {
  '不開啟（不問不做）': '不問不做',
  '有新版時先問我（可選）': '可選',
  '有新版直接更新（全自動）': '全自動',
}

function log($: Dollar, text: string): void {
  $.ui.log(`haley-cockpit：${text}`, { to: 'debug' })
}

async function firstAsk($: Dollar): Promise<UpdateMode> {
  let mode: UpdateMode = '不問不做'
  try {
    const picked = await $.ui.ask('haley-cockpit 可以在有新版本時自動更新，要開啟嗎？之後可在 /config 的「更新模式」修改。', {
      header: '自動更新',
      options: Object.keys(FIRST_ASK),
    })
    mode = FIRST_ASK[picked] ?? '不問不做'
  } catch {
    // 關掉視窗或 -p 執行（沒有人可以問）：維持不問不做
  }
  if (mode !== '不問不做') {
    try {
      await $.config.set({ key: 'haley-cockpit.updateMode', value: mode })
    } catch (err) {
      log($, `寫入更新模式失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return mode
}

async function applyUpdate($: Dollar, options: PluginOptions, s: CockpitStartup, root: string): Promise<void> {
  const r = await runCli<CockpitUpdateApply>($, options, ['update-apply', '--marketplace', s.marketplace ?? ''], root)
  if (!('data' in r) || !r.data.ok) {
    $.ui.toast(`haley-cockpit 更新失敗：${'data' in r ? r.data.message : r.error}`, { timeoutMs: 10000 })
    return
  }
  $.ui.toast(`haley-cockpit 已更新到 ${s.latest}；執行 /reload-plugins 或重開 session 後生效。`, { timeoutMs: 10000 })
}

/** /cockpit-version（v1.3.1）：版本查詢。check：馬上向市集查一次（只限市集安裝，不受一小時限制）。 */
export async function versionText($: Dollar, options: PluginOptions, root: string, check: boolean): Promise<string> {
  const r = await runCli<CockpitVersion>($, options, ['version', '--root', root, ...(check ? ['--check'] : [])], root)
  if (!('data' in r)) return `版本查詢失敗：${r.error}`
  const v = r.data
  const mode = updateMode(await liveOptions($, options))
  const lines = [`haley-cockpit ${v.installed ?? '（讀不到版本）'}`]
  if (v.kind !== 'marketplace') {
    lines.push('安裝方式：從資料夾載入（手動部署），不檢查更新；要更新請更新該資料夾的內容。')
    return lines.join('\n')
  }
  lines.push(`安裝方式：市集 ${v.marketplace}`, `更新模式：${mode}`)
  if (v.error) lines.push(`查詢市集失敗：${v.error}`)
  if (v.latest && v.checkedAt) {
    const when = `${clockText(v.checkedAt, v.tzOffset)}，${ago(v.now - v.checkedAt)}`
    lines.push(`市集最新版：${v.latest}（${v.checkedNow ? '剛剛查詢' : `上次查詢 ${when}`}）`)
    lines.push(v.available
      ? `有新版本。${mode === '不問不做' ? '更新模式是不問不做，' : ''}可執行 claude plugin update haley-cockpit@${v.marketplace}，或開新 session 依更新模式處理。`
      : '已是最新版。')
  } else if (!v.error) {
    lines.push('還沒向市集查過；輸入 /cockpit-version check 馬上查。')
  }
  if (!check) lines.push('（輸入 /cockpit-version check 會馬上向市集查一次，不受一小時一次的限制。）')
  return lines.join('\n')
}

/** session.start 時在背景執行，不擋開場。root：外掛根目錄（$.plugin.root）。 */
export async function startupUpdate($: Dollar, options: PluginOptions, root: string): Promise<void> {
  let mode = updateMode(options)
  const run = (check: boolean) =>
    runCli<CockpitStartup>($, options, ['startup', '--root', root, ...(check ? ['--check'] : [])], root)
  let r = await run(mode !== '不問不做')
  if (!('data' in r)) return log($, `啟動檢查失敗：${r.error}`)
  if (r.data.error) log($, r.data.error)
  if (r.data.kind !== 'marketplace') return // 從資料夾載入：不檢查更新（D5A）
  if (!r.data.asked) {
    // 先記下已問過：同時開好幾個 session 也只問一次
    await runCli($, options, ['update-asked'], root)
    mode = await firstAsk($)
    if (mode === '不問不做') return
    r = await run(true)
    if (!('data' in r)) return log($, `查詢新版失敗：${r.error}`)
  }
  const s = r.data
  if (mode === '不問不做' || !s.available) return
  if (mode === '全自動') return applyUpdate($, options, s, root)
  try {
    const picked = await $.ui.ask(`haley-cockpit 有新版本 ${s.latest}（目前 ${s.installed}），要更新嗎？`, {
      header: '更新',
      options: ['更新', '這次先不要'],
    })
    if (picked === '更新') await applyUpdate($, options, s, root)
  } catch {
    // 關掉視窗：這次不更新，下次開啟再問
  }
}
