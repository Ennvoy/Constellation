<#
    install.ps1 —— Asteria Constellation 一鍵部署（DESIGN.md §9／§10）。

    功能：
      1. 把 skills/constellation、skills/grill 各自 junction 到三邊 runtime 的個人 skills
         目錄（~/.claude/skills/<name>、~/.codex/skills/<name>、~/.agents/skills/<name>，
         最後一個是 Codex 官方現行使用者層 skills 路徑），三邊 runtime 讀同一份實體檔案，
         不重複部署；目標目錄不存在會自動先建。
      2. 把 gates/hooks.claude.json、gates/hooks.codex.json（先把 {{ROOT}} 換成本機絕對路徑）
         合併進 ~/.claude/settings.json 與 ~/.codex/hooks.json 的 hooks 設定，保留使用者原有的
         其他項目，只汰換 Constellation 自家掛的那幾條（冪等，重跑安全）。
      3. 使用者沒設過 ~/.claude/settings.json 的 worktree.baseRef 時寫成 "head"（P1；讓
         worker 開的 worktree 帶本機未推送的票與凍結名單），已設過任何值都不動；卸載時只
         移除自己寫入的那一筆。
      4. 產生本機簽章 secret（`~/.constellation/secret`，不存在才寫，跨專案共用同一把）——
         verify-runner 的驗證證據靠它簽章，close-gate／commit-gate 靠它驗簽（R1）。
      5. 印出對賬報告：三組 junction 的結果、兩邊 hooks 自家項數量、worktree.baseRef 動作、
         gates/*.mjs 逐支語法檢查。

    用法：
      ./install.ps1              安裝／重新對賬
      ./install.ps1 -Uninstall   拆自家 junction、移除兩邊 hooks 自家項、移除自己寫入的
                                  worktree.baseRef（使用者事後改過的值不動，見 P1）

    目標環境：Windows PowerShell 5.1。
#>

[CmdletBinding()]
param(
    [switch]$Uninstall
)

# ---------------------------------------------------------------------------
# UTF-8 自保護（PS 5.1 預設 cp950，繁中輸出/讀寫檔一律先扳正編碼）
# ---------------------------------------------------------------------------
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 母本根路徑
# ---------------------------------------------------------------------------
$Root = $PSScriptRoot.TrimEnd('\')

# ---------------------------------------------------------------------------
# 共用小工具
# ---------------------------------------------------------------------------
function Normalize-Path {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
    } catch {
        $full = $Path
    }
    return $full.TrimEnd('\').ToLowerInvariant()
}

function Get-JunctionInfo {
    # 回傳 $null＝路徑不存在；否則回 IsJunction / Target
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force
    $isJunction = $false
    $target = $null
    if ($item.PSIsContainer -and $item.LinkType -eq 'Junction') {
        $isJunction = $true
        if ($item.Target -and $item.Target.Count -gt 0) { $target = $item.Target[0] }
    }
    return [PSCustomObject]@{
        IsJunction = $isJunction
        Target = $target
    }
}

function Remove-JunctionSafe {
    # 用 cmd /c rmdir 拆 junction 本體，不遞迴刪目標內容（PowerShell Remove-Item -Recurse
    # 對 reparse point 曾有「跟著連結刪掉目標內容」的已知風險，這裡刻意繞開）。
    param([Parameter(Mandatory = $true)][string]$Path)
    $cmdLine = 'rmdir "' + $Path + '"'
    & cmd.exe /c $cmdLine | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "cmd /c rmdir 失敗（exit $LASTEXITCODE）：$Path"
    }
    if (Test-Path -LiteralPath $Path) {
        throw "rmdir 回報成功但路徑仍存在：$Path"
    }
}

# ---------------------------------------------------------------------------
# node 可用性（一次判斷，供 hooks 合併與 gates/*.mjs 語法檢查共用）
# ---------------------------------------------------------------------------
$script:NodeAvailable = [bool](Get-Command node -ErrorAction SilentlyContinue)

# ---------------------------------------------------------------------------
# hooks 合併／拆除實作見 gates/install-hooks.mjs（merge-hooks 子指令）：契約是
# gates/hooks.claude.json、gates/hooks.codex.json 都是 { "hooks": { <事件名>: [...] } }
# 形狀；分別合併進 ~/.claude/settings.json 與 ~/.codex/hooks.json 的同名 "hooks" 屬性。
# 自家項判斷雙條件擇一：指令形狀（node ...\gates\<六支已知腳本之一>.mjs）或本機 gates 目錄
# 路徑子字串；不看 _constellation 旗標（打在內層 hook 物件、entry 是外層 matcher 群組，
# 兩層對不上，從未真正發揮作用）。mode=uninstall 時忽略 fragment，只把 target 現有 hooks
# 裡的自家項全部拔掉——同一條路徑同時處理安裝、repo 搬家重裝、撤事件三種情境。
# ---------------------------------------------------------------------------
function Invoke-HooksMerge {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FragmentPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$RootPath,
        [switch]$UninstallMode
    )

    $report = [PSCustomObject]@{
        Label = $Label
        TargetPath = $TargetPath
        Status = ''
        OwnCount = 0
        RemovedCount = 0
        Detail = ''
    }

    if (-not $UninstallMode -and -not (Test-Path -LiteralPath $FragmentPath)) {
        $report.Status = '略過(找不到 fragment)'
        $report.Detail = $FragmentPath
        return $report
    }
    if (-not $script:NodeAvailable) {
        $report.Status = '中止(找不到 node)'
        return $report
    }
    if ($UninstallMode -and -not (Test-Path -LiteralPath $TargetPath)) {
        $report.Status = '略過(目標檔不存在)'
        return $report
    }

    try {
        $targetDir = Split-Path -Parent $TargetPath
        if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        if (Test-Path -LiteralPath $TargetPath) {
            Copy-Item -LiteralPath $TargetPath -Destination "$TargetPath.bak-constellation" -Force
        }

        $mode = if ($UninstallMode) { 'uninstall' } else { 'merge' }
        $fragmentArgPath = 'NONE'
        if (-not $UninstallMode) {
            $rawFragment = Get-Content -LiteralPath $FragmentPath -Raw -Encoding utf8
            $rootForJson = $RootPath.Replace('\', '\\')
            $resolvedFragment = $rawFragment.Replace('{{ROOT}}', $rootForJson)
            $fragmentArgPath = Join-Path $env:TEMP ("constellation-fragment-{0}-{1}.json" -f $Label, $PID)
            [System.IO.File]::WriteAllText($fragmentArgPath, $resolvedFragment, (New-Object System.Text.UTF8Encoding($false)))
        }

        $installHooksScript = Join-Path $Root 'gates\install-hooks.mjs'

        # 注意（Y3）：不可直接對 node 用 PowerShell 的 `2>&1` 合併重導——PS 5.1 在
        # $ErrorActionPreference='Stop' 下，只要 native command 寫過 stderr（哪怕 exit
        # code 是 0 的純 warning），這個重導語法本身就會拋出終止性 NativeCommandError，
        # 導致明明檔案已正確寫入卻整支腳本中斷、誤報失敗。改走 cmd.exe /c 讓合併動作在
        # cmd shell 內完成——PowerShell 收到的只是 cmd.exe 自己單純的 stdout 字串（不會
        # 被包成 ErrorRecord），可安全合併 stdout+stderr 供診斷、且完全依 $LASTEXITCODE
        # 判成敗（實測見 install 修復自測：exit 0 + stderr warning 不誤判失敗；exit 非 0
        # 仍完整保留錯誤堆疊供 Detail 顯示）。
        $mergeCmdLine = 'node "' + $installHooksScript + '" merge-hooks "' + $TargetPath + '" "' + $fragmentArgPath + '" ' + $mode + ' "' + $RootPath + '" 2>&1'
        $output = & cmd.exe /c $mergeCmdLine
        $exitCode = $LASTEXITCODE

        if ($fragmentArgPath -ne 'NONE') {
            Remove-Item -LiteralPath $fragmentArgPath -Force -ErrorAction SilentlyContinue
        }

        if ($exitCode -ne 0) {
            $report.Status = '失敗'
            $report.Detail = ($output -join ' | ')
        } else {
            $lastLine = $output | Select-Object -Last 1
            $parsed = $lastLine | ConvertFrom-Json
            $report.Status = '成功'
            $report.OwnCount = $parsed.ownCount
            $report.RemovedCount = $parsed.removedCount
        }
    } catch {
        $report.Status = '失敗'
        $report.Detail = $_.Exception.Message
    }

    return $report
}

# ---------------------------------------------------------------------------
# worktree.baseRef 使用者層設定（P1；DESIGN.md §7）：官方預設從遠端預設分支開
# worktree，worker 端看不到本輪未推送的票與凍結名單，凍結守衛因此在 worker 端放行。
# 使用者沒設過這個鍵才寫成 "head"；已設過任何值都不動，卸載時只憑自己寫入時打的
# 旗標移除那一筆。判斷邏輯見 gates/install-hooks.mjs（worktree-baseref 子指令），
# 只影響 Claude Code 使用者層設定——Codex 端不讀這項設定，不需要處理。
# 對抗複審 S4：這裡不自己備份——上面 hooks 合併那一段對同一個 $claudeSettingsPath 已經先備份過
# 一次（見下方主流程呼叫順序：Invoke-HooksMerge 先跑），那份才是使用者的原始檔；這裡若也備份
# 同一個檔名，會把「hooks 已合併後」的中間狀態蓋掉本來的原始備份，使用者真正的原始設定就救不回來了。
# ---------------------------------------------------------------------------
function Invoke-WorktreeBaseRef {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [switch]$UninstallMode
    )

    $report = [PSCustomObject]@{ TargetPath = $TargetPath; Status = ''; Action = ''; Detail = '' }

    if (-not $script:NodeAvailable) {
        $report.Status = '中止(找不到 node)'
        return $report
    }
    if ($UninstallMode -and -not (Test-Path -LiteralPath $TargetPath)) {
        $report.Status = '略過(目標檔不存在)'
        return $report
    }

    try {
        $targetDir = Split-Path -Parent $TargetPath
        if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }

        $mode = if ($UninstallMode) { 'uninstall' } else { 'merge' }
        $installHooksScript = Join-Path $Root 'gates\install-hooks.mjs'

        # 同 Y2/Y3：不可用 PowerShell 原生 2>&1 重導 node，改走 cmd.exe /c（理由同上）。
        $cmdLine = 'node "' + $installHooksScript + '" worktree-baseref "' + $TargetPath + '" ' + $mode + ' 2>&1'
        $output = & cmd.exe /c $cmdLine
        $exitCode = $LASTEXITCODE

        if ($exitCode -ne 0) {
            $report.Status = '失敗'
            $report.Detail = ($output -join ' | ')
        } else {
            $lastLine = $output | Select-Object -Last 1
            $parsed = $lastLine | ConvertFrom-Json
            $report.Status = '成功'
            $report.Action = $parsed.action
        }
    } catch {
        $report.Status = '失敗'
        $report.Detail = $_.Exception.Message
    }

    return $report
}

# ---------------------------------------------------------------------------
# 部署對象定義
# ---------------------------------------------------------------------------
$skillsToLink = @('constellation', 'grill')

# Skill junction 三組目標（Claude Code／Codex／Codex 官方現行使用者層 ~/.agents/skills，
# 三邊都讀同一份母本實體檔案）。.agents 這組只掛 skill junction，不涉 hooks 合併。
$skillsTargets = @(
    [PSCustomObject]@{
        Runtime = 'claude'
        SkillsBase = Join-Path $env:USERPROFILE '.claude\skills'
    },
    [PSCustomObject]@{
        Runtime = 'codex'
        SkillsBase = Join-Path $env:USERPROFILE '.codex\skills'
    },
    [PSCustomObject]@{
        Runtime = 'agents'
        SkillsBase = Join-Path $env:USERPROFILE '.agents\skills'
    }
)

# Hooks 合併只有 Claude Code／Codex 兩邊有對應設定檔（~/.agents 本身不掛 hooks）。
$hooksTargets = @(
    [PSCustomObject]@{
        Runtime = 'claude'
        HooksFragment = Join-Path $Root 'gates\hooks.claude.json'
        HooksTarget = Join-Path $env:USERPROFILE '.claude\settings.json'
    },
    [PSCustomObject]@{
        Runtime = 'codex'
        HooksFragment = Join-Path $Root 'gates\hooks.codex.json'
        HooksTarget = Join-Path $env:USERPROFILE '.codex\hooks.json'
    }
)

$junctionResults = New-Object System.Collections.Generic.List[object]
$hooksResults = New-Object System.Collections.Generic.List[object]
$mjsResults = New-Object System.Collections.Generic.List[object]

# ---------------------------------------------------------------------------
# Junction 部署 / 拆除
# ---------------------------------------------------------------------------
if ($Uninstall) {
    $rootSkillsNorm = Normalize-Path (Join-Path $Root 'skills')
    foreach ($skill in $skillsToLink) {
        foreach ($rt in $skillsTargets) {
            $linkPath = Join-Path $rt.SkillsBase $skill
            $r = [PSCustomObject]@{ Skill = $skill; Runtime = $rt.Runtime; LinkPath = $linkPath; Action = ''; Detail = '' }
            try {
                $info = Get-JunctionInfo -Path $linkPath
                if ($null -eq $info) {
                    $r.Action = '不存在(略過)'
                } elseif (-not $info.IsJunction) {
                    $r.Action = '略過(非 junction，未動)'
                    $r.Detail = $linkPath
                } elseif (-not ((Normalize-Path $info.Target).StartsWith($rootSkillsNorm))) {
                    $r.Action = '略過(target 不屬本 repo，未動)'
                    $r.Detail = $info.Target
                } else {
                    Remove-JunctionSafe -Path $linkPath
                    $r.Action = '已移除'
                    $r.Detail = $info.Target
                }
            } catch {
                $r.Action = '錯誤'
                $r.Detail = $_.Exception.Message
            }
            $junctionResults.Add($r)
        }
    }
} else {
    foreach ($skill in $skillsToLink) {
        $source = Join-Path $Root ("skills\{0}" -f $skill)
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            foreach ($rt in $skillsTargets) {
                $junctionResults.Add([PSCustomObject]@{ Skill = $skill; Runtime = $rt.Runtime; LinkPath = '(N/A)'; Action = '錯誤(來源不存在)'; Detail = $source })
            }
            continue
        }
        foreach ($rt in $skillsTargets) {
            $linkPath = Join-Path $rt.SkillsBase $skill
            $r = [PSCustomObject]@{ Skill = $skill; Runtime = $rt.Runtime; LinkPath = $linkPath; Action = ''; Detail = '' }
            try {
                if (-not (Test-Path -LiteralPath $rt.SkillsBase)) {
                    New-Item -ItemType Directory -Path $rt.SkillsBase -Force | Out-Null
                }
                $info = Get-JunctionInfo -Path $linkPath
                if ($null -eq $info) {
                    New-Item -ItemType Junction -Path $linkPath -Target $source | Out-Null
                    $r.Action = '已建立'
                    $r.Detail = $source
                } elseif ($info.IsJunction) {
                    if ((Normalize-Path $info.Target) -eq (Normalize-Path $source)) {
                        $r.Action = '已存在(略過)'
                        $r.Detail = $info.Target
                    } else {
                        Remove-JunctionSafe -Path $linkPath
                        New-Item -ItemType Junction -Path $linkPath -Target $source | Out-Null
                        $r.Action = '已重建(target 錯誤)'
                        $r.Detail = "舊: $($info.Target) -> 新: $source"
                    }
                } else {
                    $r.Action = '錯誤(已存在非 junction 項目，未覆蓋)'
                    $r.Detail = $linkPath
                }
            } catch {
                $r.Action = '錯誤'
                $r.Detail = $_.Exception.Message
            }
            $junctionResults.Add($r)
        }
    }
}

# ---------------------------------------------------------------------------
# hooks 合併 / 拆除
# ---------------------------------------------------------------------------
foreach ($rt in $hooksTargets) {
    if ($Uninstall) {
        $hooksResults.Add((Invoke-HooksMerge -Label $rt.Runtime -FragmentPath $rt.HooksFragment -TargetPath $rt.HooksTarget -RootPath $Root -UninstallMode))
    } else {
        $hooksResults.Add((Invoke-HooksMerge -Label $rt.Runtime -FragmentPath $rt.HooksFragment -TargetPath $rt.HooksTarget -RootPath $Root))
    }
}

# ---------------------------------------------------------------------------
# worktree.baseRef（只動 Claude Code 使用者層設定，沿用上面同一個 TargetPath）
# ---------------------------------------------------------------------------
$claudeSettingsPath = ($hooksTargets | Where-Object { $_.Runtime -eq 'claude' }).HooksTarget
if ($Uninstall) {
    $worktreeReport = Invoke-WorktreeBaseRef -TargetPath $claudeSettingsPath -UninstallMode
} else {
    $worktreeReport = Invoke-WorktreeBaseRef -TargetPath $claudeSettingsPath
}

# ---------------------------------------------------------------------------
# 本機簽章 secret（R1；DESIGN.md §5：驗證證據由 runner 以本機 secret 簽章、刷卡機
# 驗簽，手填時間戳無法通過）。存放於使用者家目錄，不進 git，跨專案共用同一把。
# 冪等：secret 檔已存在就不動，保證重跑安裝不會讓舊簽章失效。
# -Uninstall 刻意不刪除——刪掉會讓所有專案既有票的驗證證據簽章一次全部失效，
# 留著無害，故解除安裝時只回報現況、不動作。
# ---------------------------------------------------------------------------
$secretDir = Join-Path $env:USERPROFILE '.constellation'
$secretPath = Join-Path $secretDir 'secret'
$secretReport = [PSCustomObject]@{ Path = $secretPath; Status = ''; Detail = '' }

if ($Uninstall) {
    if (Test-Path -LiteralPath $secretPath) {
        $secretReport.Status = '保留(卸載不刪除，避免既有簽章全失效)'
    } else {
        $secretReport.Status = '不存在(未曾產生，無需動作)'
    }
} else {
    try {
        if (-not (Test-Path -LiteralPath $secretDir)) {
            New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
        }
        if (Test-Path -LiteralPath $secretPath) {
            $secretReport.Status = '已存在(未覆蓋，冪等)'
        } else {
            $secretBytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $rng.GetBytes($secretBytes)
            } finally {
                $rng.Dispose()
            }
            $secretHex = -join ($secretBytes | ForEach-Object { $_.ToString('x2') })
            # ASCII 編碼寫入：64 個 hex 字元皆為 7-bit ASCII，ASCIIEncoding 不帶 BOM，
            # 符合「純 ASCII、無 BOM」要求，同時避免任何編碼轉換造成的位元組漂移。
            [System.IO.File]::WriteAllText($secretPath, $secretHex, (New-Object System.Text.ASCIIEncoding))
            $secretReport.Status = '已產生(新)'
        }
    } catch {
        $secretReport.Status = '失敗'
        $secretReport.Detail = $_.Exception.Message
    }
}

# ---------------------------------------------------------------------------
# gates/*.mjs 語法檢查（安裝模式才跑，卸載不需要）
# ---------------------------------------------------------------------------
if (-not $Uninstall) {
    $gatesDir = Join-Path $Root 'gates'
    if (Test-Path -LiteralPath $gatesDir) {
        $mjsFiles = Get-ChildItem -LiteralPath $gatesDir -Filter '*.mjs' -File -ErrorAction SilentlyContinue
        foreach ($f in $mjsFiles) {
            if (-not $script:NodeAvailable) {
                $mjsResults.Add([PSCustomObject]@{ File = $f.Name; Ok = $false; Detail = '找不到 node，略過語法檢查' })
                continue
            }
            # 注意（Y2）：同 Y3——不可用 PowerShell 原生 `2>&1` 重導 node，$ErrorActionPreference
            # ='Stop' 下壞檔的語法錯誤（走 stderr）會讓這行本身拋出終止性例外，中斷整支
            # 腳本、後面的檔案連檢查都沒機會跑，對賬報告直接開天窗。改走 cmd.exe /c 合併
            # （同 Invoke-HooksMerge 手法）＋外層 try/catch 雙保險：單支壞檔只標 FAIL，
            # 迴圈繼續跑完剩下所有檔案、報告照印。
            try {
                $checkCmdLine = 'node --check "' + $f.FullName + '" 2>&1'
                $checkOutput = & cmd.exe /c $checkCmdLine
                $ok = ($LASTEXITCODE -eq 0)
                $mjsResults.Add([PSCustomObject]@{ File = $f.Name; Ok = $ok; Detail = ($checkOutput -join ' | ') })
            } catch {
                $mjsResults.Add([PSCustomObject]@{ File = $f.Name; Ok = $false; Detail = $_.Exception.Message })
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 對賬報告
# ---------------------------------------------------------------------------
$titleSuffix = if ($Uninstall) { '解除安裝' } else { '安裝／對賬' }

Write-Host ''
Write-Host '========================================================'
Write-Host ("  Asteria Constellation {0} 報告" -f $titleSuffix)
Write-Host '========================================================'
Write-Host ("母本根路徑：{0}" -f $Root)

Write-Host ''
Write-Host '-- Skill Junction --'
foreach ($r in $junctionResults) {
    Write-Host ("  [{0}/{1}] {2}" -f $r.Skill, $r.Runtime, $r.Action)
    if ($r.Detail) { Write-Host ("      {0}" -f $r.Detail) }
    Write-Host ("      連結：{0}" -f $r.LinkPath)
}

Write-Host ''
Write-Host '-- Hooks --'
foreach ($r in $hooksResults) {
    if ($Uninstall) {
        Write-Host ("  [{0}] {1} -> 狀態：{2}，移除自家項：{3}" -f $r.Label, $r.TargetPath, $r.Status, $r.RemovedCount)
    } else {
        Write-Host ("  [{0}] {1} -> 狀態：{2}，自家項數量：{3}" -f $r.Label, $r.TargetPath, $r.Status, $r.OwnCount)
    }
    if ($r.Detail) { Write-Host ("      {0}" -f $r.Detail) }
    if (-not $Uninstall -and $r.Label -eq 'codex') {
        Write-Host '      提醒：hooks 設定已寫入，但 Codex 要求在其 CLI 內執行 /hooks 審閱並信任後才會真正生效——請務必完成此步驟，否則 Codex 端閘門不會觸發。'
    }
}

Write-Host ''
Write-Host '-- worktree.baseRef --'
Write-Host ("  {0} -> 狀態：{1}，動作：{2}" -f $worktreeReport.TargetPath, $worktreeReport.Status, $worktreeReport.Action)
if ($worktreeReport.Detail) { Write-Host ("      {0}" -f $worktreeReport.Detail) }

Write-Host ''
Write-Host '-- 簽章 Secret --'
Write-Host ("  {0} -> 狀態：{1}" -f $secretReport.Path, $secretReport.Status)
if ($secretReport.Detail) { Write-Host ("      {0}" -f $secretReport.Detail) }

if (-not $Uninstall) {
    Write-Host ''
    Write-Host '-- gates/*.mjs 語法檢查 (node --check) --'
    if ($mjsResults.Count -eq 0) {
        Write-Host '  (gates/ 底下沒有 .mjs 檔案，或找不到 node)'
    }
    foreach ($m in $mjsResults) {
        $mark = if ($m.Ok) { 'PASS' } else { 'FAIL' }
        Write-Host ("  [{0}] {1}" -f $mark, $m.File)
        if (-not $m.Ok -and $m.Detail) { Write-Host ("      {0}" -f $m.Detail) }
    }
}

$errorCount = 0
foreach ($r in $junctionResults) { if ($r.Action -match '錯誤') { $errorCount++ } }
foreach ($r in $hooksResults) { if ($r.Status -match '失敗|中止') { $errorCount++ } }
foreach ($m in $mjsResults) { if (-not $m.Ok) { $errorCount++ } }
if ($secretReport.Status -match '失敗') { $errorCount++ }
if ($worktreeReport.Status -match '失敗|中止') { $errorCount++ }

Write-Host ''
if ($errorCount -eq 0) {
    Write-Host '狀態：全部正常，無需人工介入。'
} else {
    Write-Host ("狀態：有 {0} 項需要留意，請看上面對應區塊。" -f $errorCount)
}
Write-Host ''
