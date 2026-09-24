// gates/test/commit-gate.test.mjs — P4 回歸表：commit 守門別再把 sed -n、tail -n 這類與 --no-verify
// 無關的 -n 短旗標當成「想跳過檢查」。commitGateCheck 是純函式（檔案頂部有 import.meta.url 守衛，
// 被 import 時不會自動掛 stdin），直接 import 呼叫。
//
// 38 條「現場誤擋指令」逐字取自對 3,440 份 transcript 的唯讀掃描結果（tool_result 以 hook error
// 開頭、訊息含 --no-verify/-n 字樣的真擋下），對應 report.md ### P4「現場 5 筆真實擋下」統計裡的
// 完整 38 筆（不是取樣）——使用者名稱、私人專案路徑已改成中性佔位字（C:/Users/u/proj-*），指令的
// 形狀（sed -n、heredoc、-F、PowerShell 多行等決定判定結果的部分）維持原樣。逐條已用現行
// commit-gate 重播過：38 筆全數命中「命令帶了 --no-verify/-n」擋下訊息，且逐一核對後真的帶
// --no-verify/-n 的 0 筆——這 38 筆改後全部應該放行。真繞過寫法（--no-verify、-n、-anm、
// core.hooksPath）維持擋下，見下方「必須仍擋下」區塊。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitGateCheck } from '../commit-gate.mjs';

let repo;

before(() => {
  // 一個空的 Constellation 專案（有 .git＋.constellation，沒有任何 staged 檔）——只用來讓
  // resolveRepoRoot／existsSync(.constellation) 判定成立，三道檔案閘門（secrets／垃圾／done 票稽核）
  // 在空 staging 下天然 fail-open，不干擾本檔要測的「-n 旗標範圍」判定。
  repo = mkdtempSync(join(tmpdir(), 'cg-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  mkdirSync(join(repo, '.constellation'), { recursive: true });
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

const bash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: repo });
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: repo });

function assertPassed(input, label) {
  const r = commitGateCheck(input);
  assert.equal(r.block, false, `${label}：應放行，實際 ${JSON.stringify(r).slice(0, 200)}`);
}
function assertBlockedNoVerify(input, label) {
  const r = commitGateCheck(input);
  assert.equal(r.block, true, `${label}：應擋下`);
  assert.match(r.message, /--no-verify\/-n|core\.hooksPath/, `${label}：擋下理由應是 --no-verify/-n 或 hooksPath，實際：${r.message}`);
}
function assertBlocked(input, label) {
  const r = commitGateCheck(input);
  assert.equal(r.block, true, `${label}：應擋下，實際 ${JSON.stringify(r).slice(0, 200)}`);
}

// ── 38 條現場誤擋指令（逐字，未改寫）：改後全部應該放行 ──
const FIELD_38 = [
  `cd /c/Users/u/Desktop/proj-a && sed -n '60,72p' specs/architecture.md; echo "--- exists? ---"; ls system/project-aliases.json 2>&1 | head -2; ls system/promotion-queue.json 2>&1 | head -2; ls system/.state/promotion-queue.json 2>&1 | head -2; echo "--- git last commit of specs/architecture.md ---"; git log -1 --format='%ad %h' -- specs/architecture.md`,
  `git status --porcelain | grep -v "^?? .constellation/decisions/" | head -30; grep -n -i "worktree\\|commit" /c/Users/u/.claude/skills/constellation/references/phase-build.md | head -30`,
  `cd "C:/Users/u/Documents/proj-b"; git add .constellation/tickets/T-510-unify-version-conflict-error-code.md .constellation/tickets/T-511-parent-unavailable-modal-regression.md && git commit -q -F - <<'EOF'\ndocs(tickets): 開兩張整合缺陷補票 T-510、T-511\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\nEOF\necho "已 commit"`,
  `$roots = @("$env:USERPROFILE\\Desktop") | Where-Object { Test-Path $_ }; foreach ($r in $roots) { Get-ChildItem -Path $r -Recurse -File -ErrorAction SilentlyContinue -Include *.txt,*.md,*.json | Where-Object { $_.Name -match 'git|逐字|旁白|字幕|腳本|稿|transcript|開場|commit|branch|worktree|merge' } | Select-Object @{n='Path';e={$_.FullName}}, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 60 | Format-Table -AutoSize | Out-String -Width 260 }`,
  `cd /c/Users/u/Desktop && echo "--- top-level:" && ls && find . -type f \\( -iname '*.txt' -o -iname '*.md' \\) 2>/dev/null | grep -v -E 'node_modules|/\\.git/' | grep -i -E 'git|commit|branch|worktree|merge' | head -60`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-418-training-data-foundation.md && sed -n '1,3p' .constellation/tickets/T-418-training-data-foundation.md && git add supabase/migrations/0122.sql .constellation/tickets/T-418-training-data-foundation.md && git -c core.safecrlf=false commit -q -F "msg.txt" 2>&1 | grep -v "^warning:" ; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-418-training-data-foundation.md && sed -n '2p' .constellation/tickets/T-418-training-data-foundation.md && git add supabase/migrations/0122.sql 2>&1 | grep -v "^warning:"; git commit -q -F "msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-421-training-hard-delete-cron.md && git add .constellation/tickets/T-421-training-hard-delete-cron.md 2>&1 | grep -v "^warning:"; git commit -q -F "msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && SC="/tmp/sc" && cat > "$SC/commit-msg.txt" <<'EOF'\nfeat(weekly+line): 138 LINE 週報不列停滯\nEOF\ngit add lib/line/report-message.ts && git commit -q -F "$SC/commit-msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b/.constellation" && echo "=== 找出貨審查報告 ===" && find . -maxdepth 2 -name "*review*" | grep -v "^./archive" && cd "C:/Users/u/Documents/proj-b" && git status --short .constellation | head -20 && git rev-list --count origin/main..main 2>/dev/null || echo "（無 origin/main）"`,
  `$r = "C:\\Users\\u\\Documents\\proj-b"; git -C $r add -A; git -C $r commit -q -m "chore: 批2 三件小事" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" 2>$null; git -C $r log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && S="/tmp/s" && printf '%s\\n' "docs(constellation): 續期取樣點寫入規格" > "$S/c-notes2.txt" && git add .constellation/decisions && git commit -q -F "$S/c-notes2.txt" && git log --oneline -1 && for f in .constellation/tickets/T-5*.md; do printf "%s  " "$(basename $f .md | cut -c1-5)"; sed -n '2p' "$f"; done`,
  `cd "C:/Users/u/Documents/proj-c" && sed -n '90,96p' .constellation/decisions/244-export-completed-trips-net-value.md && git add .constellation/decisions/244-export-completed-trips-net-value.md && git commit -q -F - <<'EOF' && git push -q origin main && echo "已推送" && git log --oneline -1\ndocs(constellation): 決議 244 的懸置事項定案\nEOF`,
  `cd "C:/Users/u/Documents/proj-c"; S="/tmp/s"; echo "=== 第二批 t015 有跑嗎 ==="; f=$(ls -t "$S"/dbtest-batch2-*.log | head -1); grep -aE "^\\s+(ok|x|-) .*t015" "$f" | cut -c1-110; sed -n 462p .constellation/MAP.md; git add .constellation/MAP.md && git commit -q -F "$S/msg-map-jsonb.txt" && git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-c" && echo "=== T-106 相關符號位置 ==="; grep -rn "loadUnmatchedTaskNos\\|batchDays" app/api/import/_lib/trip-detail-route.ts | head -30; git log --oneline --since=2026-09-10 --until=2026-09-12 --name-only | head -60`,
  `cd "C:\\Users\\u\\Documents\\proj-c" && git log --all --oneline -p -- lib/activity/recompute/daily.ts | grep -n "requeueActiveBackfills\\|GRACE_DAYS\\|^commit\\|^Date:" | grep -B2 "GRACE_DAYS" | head -80`,
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%node%'\\" | Where-Object { \\$_.CommandLine -match 'proj-c' } | Select-Object ProcessId | Format-Table -AutoSize | Out-String" | grep -E "^\\s*[0-9]+" | head -3; git add tests/segment/t081.spec.ts && git commit -q -m "$(cat <<'EOF'\ntest(t081)+docs: 上車縣市改快照\nEOF\n)" && git push origin main 2>&1 | tail -1`,
  `git add tests/ops/prod-profile-open.measure.spec.ts && git commit -q -F - <<'EOF'\ntest(ops): 隊員 Profile 重現探針兩支\nEOF\ngit push origin main 2>&1 | tail -1; powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId | Out-String" | grep -cE "^\\s*[0-9]+"`,
  `cd "C:/Users/u/Desktop/proj-a" && grep -n "git add\\|git commit\\|execSync\\|spawnSync" scripts/lib/txn.mjs | head -20`,
  `cd "C:\\Users\\u\\Documents\\proj-c" && git log -p --follow -- lib/import/db.ts | grep -n "^\\-.*max:\\|^\\+.*max:\\|^commit\\|^Date:" | head -80`,
  `git log --oneline --since="2026-08-05" --until="2026-08-10" --all\necho "---playwright.config.ts history---"\ngit log --follow --oneline -- playwright.config.ts\ngit log -p --all -S "6543" -- . | grep -n "^commit\\|6543" | head -60`,
  `cd C:/Users/u/Documents/proj-c && S="/tmp/s" && git add "app/(dashboard)/activity/activity.css" .constellation/design-frozen.json && git commit -q -F "$S/commit-336.txt" && git log --oneline -1 && echo "== push" && git push origin main 2>&1 | tail -3`,
  `cd C:/Users/u/Documents/proj-c && git add tests/e2e/req-e2e-007-activity-create.e2e.spec.ts && git commit -q -F "/tmp/s/commit-e2e007.txt" && git log --oneline -1 && git status --short | head -3; (netstat -ano | grep -E ":3000 " | grep LISTEN | head -1 || echo "3000 free")`,
  `cd "C:/Users/u/Documents/proj-c-worktrees/Function" && git add .constellation/CONTEXT.md && git commit -q -m "docs(context): 修回被 shell 命令替換吃掉的兩個程式欄位\n\n上一個 commit 用 bash 雙引號包 node -e 字串，內含反引號被當成命令替換執行，\nCONTEXT.md「原話待補／原因待補」兩條的欄位名變成空括號。改用 Edit 精確補回。" && git log --oneline -1 && grep -n "原話待補\\*\\*＝\\|原因待補\\*\\*＝" .constellation/CONTEXT.md | cut -c1-110`,
  `cd "C:/Users/u/Documents/proj-c-worktrees/Function" && node "/tmp/freeze-tool.mjs" unfreeze "0903 輪 build 批次 2 接真資料" "app/(dashboard)/settings/ReasonDictTab.tsx" && git add .constellation/design-frozen.json && git commit -q -F - <<'EOF'\nchore(constellation): 批次 2 開工前解凍 7 支定稿檔（決議 286）\nEOF\ngit log --oneline -1; grep -n -i "port\\|usage\\|用法" "/tmp/serve.mjs" | head -25`,
  `M="/tmp/m"; cat > "$M/reference-commit-hook-dash-n-false-positive.md" <<'EOF'\n---\nname: reference-commit-hook-dash-n-false-positive\n---\nConstellation 的 PreToolUse hook 掃整條 Bash 命令字串：只要同時出現 \`git commit\` 與 \` -n\`，就判定為 \`--no-verify\` 短式而擋下——\`grep -n\`、\`sed -n\`、commit message 內文的「-n」都會誤中。\nEOF\ncat >> "$M/MEMORY.md" <<'EOF'\n- [commit 守門誤判 -n](reference-commit-hook-dash-n-false-positive.md)\nEOF\ntail -3 "$M/MEMORY.md"`,
  `cd "C:/Users/u/Documents/proj-d" && sed -i '44s|舊字串|新字串|' HANDOFF.md && grep -n "1212" HANDOFF.md | cut -c1-120 && git add HANDOFF.md && git commit -q -F - << 'EOF'\ndocs: 交接紀錄測試數字訂正為最終全量 1212\nEOF\ngit log --oneline -5 && git status --short`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'; $b=[System.IO.File]::ReadAllBytes('.constellation\\tickets\\T-009-ui-live-data-wiring.md')[0..2]; "ticket BOM: $($b -join ',')"; git add app/Ui.ps1 .constellation/tickets/T-009-ui-live-data-wiring.md; git commit -m @'\nfeat(T-009): 改列失敗真的寫回日誌\n\n全量 1382 passed / 1 failed / 1383 支，\n唯一紅燈是 Win.Tests AC9 剪貼簿既知偶發，單獨重跑該 Describe 17 / 0 全綠。\n'@; git log --oneline -4; git status --short`,
  `cd "C:/Users/u/Documents/proj-d" && git commit -F - -- app/lib/SendRunner.ps1 <<'EOF'\nfix(T-008): 補「清空後讀回仍非空」與「未定關閉段」兩處離線測試\n\nSendRunner 239 -> 248（0 failed）、SendEngine 440 -> 443（0 failed）。\nEOF`,
  `$ErrorActionPreference='Stop'; foreach ($f in @('.constellation/CONTEXT.md')) { $tmp="$env:TEMP\\chk.diff"; git --no-pager diff -U0 --no-color -- $f | Out-File $tmp -Encoding utf8; $addLines = @(Get-Content $tmp | Where-Object { $_.Length -gt 1 -and $_[0] -eq '+' -and $_ -notmatch '^\\+\\+\\+' }); $withDate = @($addLines | Where-Object { $_ -match '2026-09-20' }); "$f : 新增行=$($addLines.Count) 含2026-09-20=$($withDate.Count)" }`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\n$subject = (git log -1 --pretty=%s).Trim()\nif ($head -like '6c41444*' -and $subject -match 'fix\\(T-008\\): 背景執行緒') {\n  $msgPath = '/tmp/commit-msg.txt'\n  $t = [System.IO.File]::ReadAllText($msgPath, (New-Object System.Text.UTF8Encoding($true)))\n  [System.IO.File]::WriteAllText($msgPath, $t, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $msgPath\n  git log --oneline -1\n} else { "HEAD 已被其他執行者變更，跳過 amend" }`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = git rev-parse HEAD\nif ($head.Trim().StartsWith('9a26a11')) {\n  $msg = git log -1 --pretty=%B\n  $clean = ($msg -join "\`n").TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-zone1-nobom.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $f --only 2>&1 | Select-String -NotMatch 'warning: in the working copy'\n  git log -1 --pretty='%H%n%s'\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\nif ($head.StartsWith('9a26a11')) {\n  $msg = (git log -1 --pretty=%B) -join "\`n"\n  $clean = $msg.TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-zone1-nobom.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $f -- app/lib/Config.ps1\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}\ngit log -1 --pretty='%H%n%s'`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\nif ($head.StartsWith('9a26a11')) {\n  $msg = (git log -1 --pretty=%B) -join "\`r\`n"\n  $clean = $msg.TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-clean.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend --file $f -- app/lib/Config.ps1\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}\ngit log -1 --pretty='%H%n%s'`,
  `cd "C:/Users/u/Documents/proj-d" && for i in 1 2 3 4 5; do git add -- .constellation/decisions/088-clipboard-reliability-scope-ruling.md && git commit -q -m "docs: decisions/088 補記" -- .constellation/decisions/088-clipboard-reliability-scope-ruling.md && break || sleep 4; done; grep -n "剪貼簿" docs/交付說明.md | head -6`,
  `cd "C:/Users/u/Documents/proj-d"; perl -i -pe 's/^status: in-progress$/status: done/ if $. < 10' .constellation/tickets/T-014-csv-distribution.md; sed -n '1,6p' .constellation/tickets/T-014-csv-distribution.md; git add .constellation/tickets/T-014-csv-distribution.md; git commit -q -F - << 'EOF'\nfeat(T-014): 關票——分發用名單檔改為 CSV\nEOF\ngit log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-d/.constellation/decisions"; cat > 099-skip-network-off-test.md <<'EOF'\n# 099 不做斷網送出測試\nEOF\ncd ../..; git add .constellation/decisions/099-skip-network-off-test.md; git commit -q -m "docs: decisions/099 不做斷網送出測試"; git log --oneline -1; grep -n "^| 3[89]\\|^| 4[0-9]" .constellation/decisions/013*.md | cut -c1-400`,
  `cd C:/Users/u/Documents/proj-e && git show 218e935:backend/src/services/scoring.ts > "/tmp/scoring_old.ts"; grep -n "buildCombinedAnalysisPrompt\\|description" "/tmp/scoring_old.ts" | head -50; grep -rn "analyzeAudioComplete" backend/src --include=*.ts | grep -v "^backend/src/services/scoring.ts" | head; git log --format='%h %ad %s' --date=iso -8 -- backend/src/services/scoring.ts`,
];

describe('commit-gate：P4——38 條現場誤擋指令改後全數放行', () => {
  FIELD_38.forEach((cmd, i) => {
    test(`案例 #${i + 1}`, () => assertPassed(bash(cmd), `#${i + 1}`));
  });
});

describe('commit-gate：真繞過寫法必須仍擋下', () => {
  test('--no-verify 長式要擋', () => assertBlockedNoVerify(bash('git commit --no-verify -m "x"'), '--no-verify'));
  test('-n 短式要擋', () => assertBlockedNoVerify(bash('git commit -n -m "x"'), '-n'));
  test('-anm 組合旗標（含 n）要擋', () => assertBlockedNoVerify(bash('git commit -anm "x"'), '-anm'));
  test('-c core.hooksPath=... 全域旗標要擋', () =>
    assertBlockedNoVerify(bash('git -c core.hooksPath=/dev/null commit -m "x"'), '-c core.hooksPath'));
  test('git config core.hooksPath 改向後 commit 要擋', () =>
    assertBlockedNoVerify(bash('git config core.hooksPath /tmp/none && git commit -m "x"'), 'config core.hooksPath'));
  test('PowerShell -NoVerify 混寫也要擋（真旗標）', () =>
    assertBlockedNoVerify(ps('git commit --no-verify -m "x"'), 'ps --no-verify'));
});

// 對抗審查 must-fix：切段本來用「不管引號的字串 split」找 &&/;/||/|/換行，heredoc／here-string／
// 訊息裡的分隔符會把 commit 段從中間切開，讓寫在訊息之後的 --no-verify/-n 落到下一段（不算 commit
// 段）而漏擋。改法：切段一律逐字元掃描，跳過雙引號／單引號／PowerShell here-string 整段內容。
describe('commit-gate：對抗審查 must-fix——訊息含分隔符（heredoc／分號／&&／管線／換行／here-string）後接 --no-verify/-n 仍要擋', () => {
  test('heredoc 訊息（bash -m "$(cat <<\'EOF\' … EOF)"）後接 --no-verify 要擋', () =>
    assertBlocked(bash(`git commit -m "$(cat <<'EOF'\nfeat: x\n\nbody\nEOF\n)" --no-verify`), 'heredoc msg + --no-verify'));
  test('同一寫法改成結尾 -n 也要擋', () =>
    assertBlocked(bash(`git commit -m "$(cat <<'EOF'\nfeat: x\n\nbody\nEOF\n)" -n`), 'heredoc msg + -n'));
  test('訊息含分號（雙引號內）後接 --no-verify 要擋', () =>
    assertBlocked(bash('git commit -m "fix a; b" --no-verify'), 'semicolon in quoted msg'));
  test('訊息含 &&（雙引號內）後接 --no-verify 要擋', () =>
    assertBlocked(bash('git commit -m "fix a && b" --no-verify'), '&& in quoted msg'));
  test('訊息含管線符號（雙引號內）後接 -n 要擋', () =>
    assertBlocked(bash('git commit -m "a | b" -n'), 'pipe in quoted msg'));
  test('多行單引號訊息後接 --no-verify 要擋', () =>
    assertBlocked(bash("git commit -m 'line1\nline2' --no-verify"), 'multiline single-quote msg'));
  test('PowerShell here-string 訊息後接 --no-verify 要擋', () =>
    assertBlocked(ps("git commit -m @'\nmsg\n'@ --no-verify"), 'PS here-string msg'));
});

// 對抗審查 should-fix：commit 包在殼裡（bash -c／cmd /c／powershell -Command／括號子殼／命令替換／
// -C 值是 $(...)）時 isCommitSegment 認不出真正的 commit 子命令，長式 --no-verify 仍要靠整條指令的
// 保底擋下（短式 -n 藏在殼裡不強求，見 commit-gate.mjs 的 GIT_COMMIT_LOOSE_RE 註解）。
describe('commit-gate：對抗審查 should-fix——commit 包在殼裡，長式 --no-verify 仍要擋', () => {
  test('bash -c 包裹要擋', () => assertBlocked(bash('bash -c "git commit --no-verify -m x"'), 'bash -c wrapped'));
  test('cmd /c 包裹要擋', () => assertBlocked(bash('cmd /c "git commit --no-verify -m x"'), 'cmd /c wrapped'));
  test('powershell -Command 包裹要擋', () =>
    assertBlocked(bash('powershell -Command "git commit --no-verify -m x"'), 'powershell -Command wrapped'));
  test('括號子殼包裹要擋', () => assertBlocked(bash('(git commit --no-verify -m x)'), 'paren subshell wrapped'));
  test('命令替換包裹要擋', () => assertBlocked(bash('echo $(git commit --no-verify -m x)'), 'command substitution wrapped'));
  test('-C 值是 $(...) 要擋', () =>
    assertBlocked(bash('git -C $(dirname $f) commit --no-verify -m x'), '-C $(...) value wrapped'));
});

describe('commit-gate：邊界案例（放行）', () => {
  test('commit message 內文含 --no-verify/-n 字樣不誤擋', () =>
    assertPassed(bash('git commit -m "fix: add --no-verify doc and -n flag"'), 'message content immunity'));
  test('git add -A && git commit 常見組合放行', () =>
    assertPassed(bash('git add -A && git commit -m "feat: x"'), 'add && commit'));
  test('commit 後接 push（不帶 force）放行', () =>
    assertPassed(bash('git commit -m "x" && git push origin main'), 'commit && push'));
  test('-F 訊息檔案旗標放行（訊息檔內容 commit-gate 不讀）', () =>
    assertPassed(bash('git commit -F msg.txt'), '-F msgfile'));
  test('非 commit 的唯讀 git 指令放行', () => assertPassed(bash('git log -n 5'), 'git log -n'));
  test('非 git 指令直接放行（tool 判定）', () => assertPassed(bash('sed -n 1,5p a.md'), 'non-git'));
});
