# 路徑： collector\switch_terminal.ps1
# 把 Windows Terminal 裡某個 session 的分頁選起來，並把視窗帶到前景：用 UI Automation 讀各視窗的分頁名稱，
# 依「session 標題」與「排除法」決定是哪個分頁，選取（SelectionItemPattern）後再提升視窗。VS Code 的終端機不走這支，由 VS Code 擴充處理。
# 本檔必須存成「含 BOM 的 UTF-8」：Windows PowerShell 5.1 讀不到 BOM 時會把中文當成舊式編碼而讀壞（測試會檢查）。
#
# 為什麼要排除法：分頁名稱可能是使用者自己改的（Windows Terminal 的「重新命名分頁」會蓋掉程式設定的標題），
# 這時標題比對不到；但只要其他 session 都對上了分頁，剩下的 session 若只剩一個分頁可選，就是它。
#
# 參數：
#   -ContextFile  JSON 檔（UTF-8）：{ "target": {titles:[], pids:[], startedAt}, "others": [{titles, pids, startedAt}, ...] }
#                 target 是要切過去的 session，others 是其他同樣不在 VS Code 裡的 session；titles 是分頁名稱候選
#                 （AI 標題、自訂名稱、Codex 的 thread 名稱；還沒有標題的新 session 分頁固定叫 Claude Code）；
#                 pids 是 session 的程序鏈，鏈上有 WindowsTerminal.exe 時，只在那個程序的視窗裡找
#   -ListOnly     只列出視窗與分頁，不選取、不提升（診斷用）
#   -NoActivate   選取分頁但不提升視窗
#   -TabsFile     測試用：分頁清單的 JSON 檔（陣列，欄位 hwnd、pid、index、name、selected），不碰 UI Automation，只輸出會選哪一個
# 輸出：一行 JSON，欄位 ok、how（title／elimination／order）、ambiguous、window、index、tab、foreground、
#       error（no_wt_window／no_match／no_context／exception）。order 是最後手段（依啟動順序對應分頁順序），結果標為不確定。
param(
    [string]$ContextFile = '',
    [switch]$ListOnly,
    [switch]$NoActivate,
    [string]$TabsFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 6)
}

# 去掉分頁名稱前面的狀態符號（Claude Code 會在標題前放一個一直變化的符號），並轉小寫，比對才穩定
function Normalize([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return '' }
    return ($s -replace '^[^\p{L}\p{N}\[\(]+', '').Trim().ToLowerInvariant()
}

function Get-LiveTabs {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $ae = [System.Windows.Automation.AutomationElement]
    $byClass = New-Object System.Windows.Automation.PropertyCondition($ae::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
    $tabCond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $list = @()
    foreach ($w in $ae::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byClass)) {
        $i = 0
        foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
            $sel = $false
            $pat = $null
            if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $sel = [bool]$pat.Current.IsSelected }
            $list += [pscustomobject]@{ hwnd = [int64]$w.Current.NativeWindowHandle; pid = [int]$w.Current.ProcessId; index = $i; name = [string]$t.Current.Name; selected = $sel; el = $t }
            $i++
        }
    }
    return $list
}

# 名稱完全相同 3 分、互相包含（兩邊都至少 4 個字）2 分
function Score-Tab([string]$tabName, $cands) {
    $n = Normalize $tabName
    $score = 0
    foreach ($c in $cands) {
        if ($n -eq $c) { $score = [Math]::Max($score, 3) }
        elseif ($c.Length -ge 4 -and $n.Length -ge 4 -and ($n.Contains($c) -or $c.Contains($n))) { $score = [Math]::Max($score, 2) }
    }
    return $score
}

function Tab-Key($t) { return ('{0}/{1}' -f $t.hwnd, $t.index) }

# session 程序鏈上有 Windows Terminal 時，只在它的視窗裡找；找不到那個視窗的分頁再退回全部
function Scope-Of($claimant, $tabs) {
    $wtPids = @()
    foreach ($p in @($claimant.pids)) {
        $proc = Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'WindowsTerminal') { $wtPids += [int]$p }
    }
    if ($wtPids.Count -gt 0) {
        $narrow = @($tabs | Where-Object { $wtPids -contains $_.pid })
        if ($narrow.Count -gt 0) { return $narrow }
    }
    return @($tabs)
}

$win32Source = @"
using System;
using System.Runtime.InteropServices;
public static class HaleyWin32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

# 提升視窗：先用 SwitchToThisWindow；沒成功再送一次 Alt 按鍵事件（讓系統視為有使用者輸入，繞過前景鎖）後呼叫 SetForegroundWindow
function Raise-Window([int64]$hwnd) {
    Add-Type -TypeDefinition $win32Source
    $h = [IntPtr]$hwnd
    if ([HaleyWin32]::IsIconic($h)) { [void][HaleyWin32]::ShowWindow($h, 9) }
    [HaleyWin32]::SwitchToThisWindow($h, $true)
    Start-Sleep -Milliseconds 120
    if ([HaleyWin32]::GetForegroundWindow() -ne $h) {
        [HaleyWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [HaleyWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [void][HaleyWin32]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 120
    }
    return ([HaleyWin32]::GetForegroundWindow() -eq $h)
}

# 決定 target 是哪個分頁：先依標題（同分取多個＝ambiguous），比不到就用排除法，最後才依啟動順序推定
function Decide($ctx, $tabs) {
    $claimants = @($ctx.target) + @($ctx.others | Where-Object { $_ })
    foreach ($c in $claimants) {
        $cands = @(@($c.titles) | ForEach-Object { Normalize $_ } | Where-Object { $_.Length -gt 0 } | Select-Object -Unique)
        $scope = @(Scope-Of $c $tabs)
        $best = 0
        $hits = @()
        foreach ($t in $scope) {
            $s = Score-Tab $t.name $cands
            if ($s -gt $best) { $best = $s; $hits = @($t) }
            elseif ($s -gt 0 -and $s -eq $best) { $hits += $t }
        }
        $c | Add-Member -NotePropertyName scope -NotePropertyValue $scope -Force
        $c | Add-Member -NotePropertyName hits -NotePropertyValue @($hits) -Force
    }
    $target = $claimants[0]
    $others = @($claimants | Select-Object -Skip 1)
    # 其他 session 唯一對上的分頁，不能再算給 target
    $claimedByOthers = @{}
    foreach ($o in $others) { if ($o.hits.Count -eq 1) { $claimedByOthers[(Tab-Key $o.hits[0])] = $true } }

    if ($target.hits.Count -ge 1) {
        $free = @($target.hits | Where-Object { -not $claimedByOthers.ContainsKey((Tab-Key $_)) })
        $pick = if ($free.Count -ge 1) { $free[0] } else { $target.hits[0] }
        return @{ tab = $pick; how = 'title'; ambiguous = ($target.hits.Count -gt 1) }
    }
    # 排除法：把所有 session 唯一對上的分頁都扣掉，target 範圍內若只剩一個，就是它
    $claimed = @{}
    foreach ($c in $claimants) { if ($c.hits.Count -eq 1) { $claimed[(Tab-Key $c.hits[0])] = $true } }
    $pool = @($target.scope | Where-Object { -not $claimed.ContainsKey((Tab-Key $_)) })
    $unmatchedOthers = @($others | Where-Object { $_.hits.Count -eq 0 })
    if ($pool.Count -eq 1 -and $unmatchedOthers.Count -eq 0) {
        return @{ tab = $pool[0]; how = 'elimination'; ambiguous = $false }
    }
    # 最後手段：沒對上的 session 數量剛好等於剩下的分頁數，依啟動順序對應分頁順序（使用者調動過分頁順序時會錯，所以標為不確定）
    if ($pool.Count -ge 2 -and $pool.Count -eq ($unmatchedOthers.Count + 1)) {
        $sessions = @(@($target) + $unmatchedOthers | Sort-Object { [double]$_.startedAt })
        $rank = [Array]::IndexOf($sessions, $target)
        $ordered = @($pool | Sort-Object hwnd, index)
        return @{ tab = $ordered[$rank]; how = 'order'; ambiguous = $true }
    }
    return $null
}

try {
    if ($TabsFile) {
        # Windows PowerShell 5.1：ConvertFrom-Json 讀到 JSON 陣列時整個陣列算一個物件，要經過 ForEach-Object 才會攤開；空陣列則會留下 $null
        $tabs = @(Get-Content -Raw -Encoding UTF8 -LiteralPath $TabsFile | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_ })
        $dry = $true
    } else {
        $tabs = @(Get-LiveTabs)
        $dry = $false
    }

    if ($ListOnly) {
        $rows = @($tabs | ForEach-Object { [pscustomobject]@{ window = ('0x{0:X}' -f $_.hwnd); pid = $_.pid; index = $_.index; name = $_.name; selected = $_.selected } })
        Out-Json @{ ok = $true; tabs = $rows }
        exit 0
    }
    if (-not $ContextFile) {
        Out-Json @{ ok = $false; error = 'no_context' }
        exit 0
    }
    if ($tabs.Count -eq 0) {
        Out-Json @{ ok = $false; error = 'no_wt_window' }
        exit 0
    }
    $ctx = Get-Content -Raw -Encoding UTF8 -LiteralPath $ContextFile | ConvertFrom-Json
    $pick = Decide $ctx $tabs
    if (-not $pick) {
        Out-Json @{ ok = $false; error = 'no_match'; tabs = @($tabs | ForEach-Object { $_.name }) }
        exit 0
    }
    $tab = $pick.tab
    $result = @{ ok = $true; how = $pick.how; ambiguous = [bool]$pick.ambiguous; window = ('0x{0:X}' -f $tab.hwnd); index = $tab.index; tab = $tab.name; foreground = $null }
    if (-not $dry) {
        $tab.el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        if (-not $NoActivate) { $result.foreground = Raise-Window $tab.hwnd }
    }
    Out-Json $result
} catch {
    Out-Json @{ ok = $false; error = 'exception'; message = $_.Exception.Message }
    exit 0
}
