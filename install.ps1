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
      3. 印出對賬報告：三組 junction 的結果、兩邊 hooks 自家項數量、gates/*.mjs 逐支語法檢查、
         Codex hooks feature 開啟狀態。

    用法：
      ./install.ps1              安裝／重新對賬
      ./install.ps1 -Uninstall   拆自家 junction、移除兩邊 hooks 自家項

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
$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
    if ($MyInvocation.MyCommand.Path) {
        $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        Write-Warning '無法自動判斷母本根路徑（$PSScriptRoot 為空），改用目前工作目錄。'
        $Root = (Get-Location).Path
    }
}
$Root = $Root.TrimEnd('\')

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
        IsContainer = $item.PSIsContainer
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
# hooks 合併用的 node 腳本（執行期寫成暫存 .cjs 檔案，跑完即刪）。
# 契約：gates/hooks.claude.json、gates/hooks.codex.json 都是 { "hooks": { <事件名>: [...] } }
# 形狀；分別合併進 ~/.claude/settings.json 與 ~/.codex/hooks.json 的同名 "hooks" 屬性。
# 自家項判斷：遞迴走訪條目內每個字串葉節點，看是否含本機 gates 目錄路徑（正反斜線都認）。
# mode=uninstall 時忽略 fragment，改成把 target 現有 hooks 內含自家標記的條目全部拔掉。
# ---------------------------------------------------------------------------
$script:MergeNodeScript = @'
"use strict";
var fs = require("fs");

function stripBOM(text) {
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    return text.slice(1);
  }
  return text;
}

function readJson(filePath, fallback) {
  if (!filePath || filePath === "NONE" || !fs.existsSync(filePath)) {
    return fallback;
  }
  var raw = fs.readFileSync(filePath, "utf8");
  var trimmed = stripBOM(raw).trim();
  if (trimmed === "") {
    return fallback;
  }
  return JSON.parse(trimmed);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

var targetPath = process.argv[2];
var fragmentPath = process.argv[3];
var mode = process.argv[4];
var rootPath = process.argv[5];

var marker1 = rootPath + "\\gates";
var marker2 = rootPath.split("\\").join("/") + "/gates";

// 直接走訪原始值的字串葉節點比對（不經 JSON.stringify），因為 JSON.stringify 會把
// 反斜線跳脫成雙反斜線，拿單反斜線的路徑 marker 去比對會永遠比不中。
function containsMarker(value) {
  if (typeof value === "string") {
    return value.indexOf(marker1) !== -1 || value.indexOf(marker2) !== -1;
  }
  if (Array.isArray(value)) {
    for (var vi = 0; vi < value.length; vi++) {
      if (containsMarker(value[vi])) { return true; }
    }
    return false;
  }
  if (value !== null && typeof value === "object") {
    var vKeys = Object.keys(value);
    for (var vk = 0; vk < vKeys.length; vk++) {
      if (containsMarker(value[vKeys[vk]])) { return true; }
    }
    return false;
  }
  return false;
}

function isOwnEntry(entry) {
  // 優先認 hook entry 自帶的 "_constellation": true 標記（BY7b：新版 fragment 直接
  // 在條目物件上打旗標，判斷穩定不受路徑搬家影響）；沒有標記的舊裝（搬家前裝的）
  // 才退回路徑子字串比對，確保舊裝也能被 uninstall／merge 正確辨識並汰換。
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry._constellation === true) {
    return true;
  }
  return containsMarker(entry);
}

var target = readJson(targetPath, {});
if (!isPlainObject(target)) {
  target = {};
}
if (!isPlainObject(target.hooks)) {
  target.hooks = {};
}
var hooksRoot = target.hooks;

var ownCount = 0;
var removedCount = 0;

if (mode === "uninstall") {
  var existingKeys = Object.keys(hooksRoot);
  for (var i = 0; i < existingKeys.length; i++) {
    var eventKeyU = existingKeys[i];
    var arrU = Array.isArray(hooksRoot[eventKeyU]) ? hooksRoot[eventKeyU] : [];
    var keptU = [];
    for (var j = 0; j < arrU.length; j++) {
      if (isOwnEntry(arrU[j])) {
        removedCount++;
      } else {
        keptU.push(arrU[j]);
      }
    }
    if (keptU.length === 0) {
      delete hooksRoot[eventKeyU];
    } else {
      hooksRoot[eventKeyU] = keptU;
    }
  }
} else {
  var fragmentRaw = readJson(fragmentPath, {});
  var fragmentHooks = isPlainObject(fragmentRaw) && isPlainObject(fragmentRaw.hooks) ? fragmentRaw.hooks : fragmentRaw;
  if (!isPlainObject(fragmentHooks)) {
    fragmentHooks = {};
  }
  var fragKeys = Object.keys(fragmentHooks);
  for (var k = 0; k < fragKeys.length; k++) {
    var eventKey = fragKeys[k];
    var fragArr = Array.isArray(fragmentHooks[eventKey]) ? fragmentHooks[eventKey] : [];
    var existingArr = Array.isArray(hooksRoot[eventKey]) ? hooksRoot[eventKey] : [];
    var kept = [];
    for (var m = 0; m < existingArr.length; m++) {
      if (!isOwnEntry(existingArr[m])) {
        kept.push(existingArr[m]);
      }
    }
    hooksRoot[eventKey] = kept.concat(fragArr);
    ownCount += fragArr.length;
  }
}

fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ ownCount: ownCount, removedCount: removedCount }));
'@

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

        $mergeScriptPath = Join-Path $env:TEMP ("constellation-merge-{0}-{1}.cjs" -f $Label, $PID)
        [System.IO.File]::WriteAllText($mergeScriptPath, $script:MergeNodeScript, (New-Object System.Text.UTF8Encoding($false)))

        # 注意（Y3）：不可直接對 node 用 PowerShell 的 `2>&1` 合併重導——PS 5.1 在
        # $ErrorActionPreference='Stop' 下，只要 native command 寫過 stderr（哪怕 exit
        # code 是 0 的純 warning），這個重導語法本身就會拋出終止性 NativeCommandError，
        # 導致明明檔案已正確寫入卻整支腳本中斷、誤報失敗。改走 cmd.exe /c 讓合併動作在
        # cmd shell 內完成——PowerShell 收到的只是 cmd.exe 自己單純的 stdout 字串（不會
        # 被包成 ErrorRecord），可安全合併 stdout+stderr 供診斷、且完全依 $LASTEXITCODE
        # 判成敗（實測見 install 修復自測：exit 0 + stderr warning 不誤判失敗；exit 非 0
        # 仍完整保留錯誤堆疊供 Detail 顯示）。
        $mergeCmdLine = 'node "' + $mergeScriptPath + '" "' + $TargetPath + '" "' + $fragmentArgPath + '" ' + $mode + ' "' + $RootPath + '" 2>&1'
        $output = & cmd.exe /c $mergeCmdLine
        $exitCode = $LASTEXITCODE

        Remove-Item -LiteralPath $mergeScriptPath -Force -ErrorAction SilentlyContinue
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
# Codex hooks feature 狀態確認（BY7a；非致命——抓不到 codex 指令或執行失敗都只降級
# 為提示，不影響本次安裝／對賬結果）。除了抓到那一行原文，另外解析行內 enabled 值
# （true/false）：false 印警告要求去 config.toml 開啟；解析不到就印「無法確認」。
# ---------------------------------------------------------------------------
$codexFeatureFound = $false
$codexFeatureLine = ''
$codexFeatureNote = ''
$codexFeatureEnabled = $null   # $null=無法解析, $true=已開啟, $false=未開啟
try {
    $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codexCmd) {
        $codexFeatureNote = '找不到 codex 指令'
    } else {
        $codexCmdLine = 'codex features list 2>&1'
        $codexOutput = & cmd.exe /c $codexCmdLine
        $codexExitCode = $LASTEXITCODE
        if ($codexExitCode -ne 0 -or -not $codexOutput) {
            $codexFeatureNote = ("執行失敗或無輸出(exit {0})" -f $codexExitCode)
        } else {
            $hooksLine = $codexOutput | Where-Object { $_ -match 'hooks' } | Select-Object -First 1
            if ($hooksLine) {
                $codexFeatureFound = $true
                $codexFeatureLine = $hooksLine.Trim()
                if ($codexFeatureLine -match '(?i)\btrue\b') {
                    $codexFeatureEnabled = $true
                } elseif ($codexFeatureLine -match '(?i)\bfalse\b') {
                    $codexFeatureEnabled = $false
                } else {
                    $codexFeatureNote = '無法從輸出解析 enabled 值(true/false)'
                }
            } else {
                $codexFeatureNote = '輸出中找不到 hooks 相關字樣'
            }
        }
    }
} catch {
    $codexFeatureNote = $_.Exception.Message
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

Write-Host ''
Write-Host '-- Codex Hooks Feature 狀態 (codex features list) --'
if ($codexFeatureFound) {
    Write-Host ("  {0}" -f $codexFeatureLine)
    if ($codexFeatureEnabled -eq $false) {
        Write-Host '  警告：Codex hooks 功能未開啟，請在 config.toml [features] 開啟。'
    } elseif ($null -eq $codexFeatureEnabled) {
        Write-Host '  無法確認。'
    }
} else {
    Write-Host ("  無法確認 Codex hooks feature 狀態，請自行確認。({0})" -f $codexFeatureNote)
}

$errorCount = 0
foreach ($r in $junctionResults) { if ($r.Action -match '錯誤') { $errorCount++ } }
foreach ($r in $hooksResults) { if ($r.Status -match '失敗|中止') { $errorCount++ } }
foreach ($m in $mjsResults) { if (-not $m.Ok) { $errorCount++ } }
if ($secretReport.Status -match '失敗') { $errorCount++ }

Write-Host ''
if ($errorCount -eq 0) {
    Write-Host '狀態：全部正常，無需人工介入。'
} else {
    Write-Host ("狀態：有 {0} 項需要留意，請看上面對應區塊。" -f $errorCount)
}
Write-Host ''
