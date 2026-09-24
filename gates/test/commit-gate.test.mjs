// gates/test/commit-gate.test.mjs — P4 回歸表：commit 守門別再把 sed -n、tail -n 這類與 --no-verify
// 無關的 -n 短旗標當成「想跳過檢查」。commitGateCheck 是純函式（檔案頂部有 import.meta.url 守衛，
// 被 import 時不會自動掛 stdin），直接 import 呼叫。
//
// 38 條「現場誤擋指令」取自對 3,440 份 transcript 的唯讀掃描結果（tool_result 以 hook error
// 開頭、訊息含 --no-verify/-n 字樣的真擋下），對應 report.md ### P4「現場 5 筆真實擋下」統計裡的
// 完整 38 筆（不是取樣）——形狀取自現場，內容已合成：使用者名稱、私人專案路徑、票號、內部路徑、
// commit hash、業務訊息內文與共同作者行都已換成中性佔位字，但決定判定結果的形狀（sed -n、heredoc、
// -F、PowerShell 多行、here-string、管線與分號的位置）維持原樣。逐條已用現行 commit-gate 重播過：
// 38 筆全數命中「命令帶了 --no-verify/-n」擋下訊息，且逐一核對後真的帶 --no-verify/-n 的 0 筆——
// 這 38 筆改後全部應該放行。真繞過寫法（--no-verify、-n、-anm、core.hooksPath）維持擋下，見下方
// 「必須仍擋下」區塊。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitGateCheck } from '../commit-gate.mjs';

let repo;

before(() => {
  // 第四輪對抗複審 should-fix：本檔多處夾具會 `git add .env`——開發者的全域 excludesFile 只要列了
  // .env（全域 gitignore 範本的常見內容），git add 就會失敗、before() 拋錯，整組測試被取消。比照
  // precommit-install.test.mjs／session-start.test.mjs 的既有隔離手法，指到一個空的暫存全域設定檔，
  // 讓本檔的 git 操作不受開發者機器上的全域設定影響。
  const emptyGlobalConfig = join(mkdtempSync(join(tmpdir(), 'cg-gitcfg-')), 'gitconfig');
  writeFileSync(emptyGlobalConfig, '', 'utf8');
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

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

// ── 38 條現場誤擋指令（形狀取自現場，內容已合成）：改後全部應該放行 ──
const FIELD_38 = [
  `cd /c/Users/u/Desktop/proj-a && sed -n '60,72p' specs/architecture.md; echo "--- exists? ---"; ls system/project-aliases.json 2>&1 | head -2; ls system/promotion-queue.json 2>&1 | head -2; ls system/.state/promotion-queue.json 2>&1 | head -2; echo "--- git last commit of specs/architecture.md ---"; git log -1 --format='%ad %h' -- specs/architecture.md`,
  `git status --porcelain | grep -v "^?? .constellation/decisions/" | head -30; grep -n -i "worktree\\|commit" /c/Users/u/.claude/skills/constellation/references/phase-build.md | head -30`,
  `cd "C:/Users/u/Documents/proj-b"; git add .constellation/tickets/T-201-sync-conflict-code.md .constellation/tickets/T-202-parent-modal-regression.md && git commit -q -F - <<'EOF'\ndocs(tickets): 開兩張整合缺陷補票 T-201、T-202\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\nEOF\necho "已 commit"`,
  `$roots = @("$env:USERPROFILE\\Desktop") | Where-Object { Test-Path $_ }; foreach ($r in $roots) { Get-ChildItem -Path $r -Recurse -File -ErrorAction SilentlyContinue -Include *.txt,*.md,*.json | Where-Object { $_.Name -match 'git|逐字|旁白|字幕|腳本|稿|transcript|開場|commit|branch|worktree|merge' } | Select-Object @{n='Path';e={$_.FullName}}, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 60 | Format-Table -AutoSize | Out-String -Width 260 }`,
  `cd /c/Users/u/Desktop && echo "--- top-level:" && ls && find . -type f \\( -iname '*.txt' -o -iname '*.md' \\) 2>/dev/null | grep -v -E 'node_modules|/\\.git/' | grep -i -E 'git|commit|branch|worktree|merge' | head -60`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-301-batch-data-foundation.md && sed -n '1,3p' .constellation/tickets/T-301-batch-data-foundation.md && git add db/migrations/0042.sql .constellation/tickets/T-301-batch-data-foundation.md && git -c core.safecrlf=false commit -q -F "msg.txt" 2>&1 | grep -v "^warning:" ; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-301-batch-data-foundation.md && sed -n '2p' .constellation/tickets/T-301-batch-data-foundation.md && git add db/migrations/0042.sql 2>&1 | grep -v "^warning:"; git commit -q -F "msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && sed -i '2s/^status: .*/status: done/' .constellation/tickets/T-304-hard-delete-cron.md && git add .constellation/tickets/T-304-hard-delete-cron.md 2>&1 | grep -v "^warning:"; git commit -q -F "msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && SC="/tmp/sc" && cat > "$SC/commit-msg.txt" <<'EOF'\nfeat(weekly+line): 週報不列停滯項目\nEOF\ngit add lib/notify/report-message.ts && git commit -q -F "$SC/commit-msg.txt" 2>&1 | grep -v "^warning:"; git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b/.constellation" && echo "=== 找出貨審查報告 ===" && find . -maxdepth 2 -name "*review*" | grep -v "^./archive" && cd "C:/Users/u/Documents/proj-b" && git status --short .constellation | head -20 && git rev-list --count origin/main..main 2>/dev/null || echo "（無 origin/main）"`,
  `$r = "C:\\Users\\u\\Documents\\proj-b"; git -C $r add -A; git -C $r commit -q -m "chore: 批2 三件小事" -m "Co-Authored-By: Claude Test 5 <noreply@example.com>" 2>$null; git -C $r log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-b" && S="/tmp/s" && printf '%s\\n' "docs(constellation): 續期取樣點寫入規格" > "$S/c-notes2.txt" && git add .constellation/decisions && git commit -q -F "$S/c-notes2.txt" && git log --oneline -1 && for f in .constellation/tickets/T-5*.md; do printf "%s  " "$(basename $f .md | cut -c1-5)"; sed -n '2p' "$f"; done`,
  `cd "C:/Users/u/Documents/proj-c" && sed -n '90,96p' .constellation/decisions/244-export-completed-trips-net-value.md && git add .constellation/decisions/244-export-completed-trips-net-value.md && git commit -q -F - <<'EOF' && git push -q origin main && echo "已推送" && git log --oneline -1\ndocs(constellation): 決議 244 的懸置事項定案\nEOF`,
  `cd "C:/Users/u/Documents/proj-c"; S="/tmp/s"; echo "=== 第二批 t015 有跑嗎 ==="; f=$(ls -t "$S"/dbtest-batch2-*.log | head -1); grep -aE "^\\s+(ok|x|-) .*t015" "$f" | cut -c1-110; sed -n 462p .constellation/MAP.md; git add .constellation/MAP.md && git commit -q -F "$S/msg-map-jsonb.txt" && git log --oneline -1`,
  `cd "C:/Users/u/Documents/proj-c" && echo "=== T-106 相關符號位置 ==="; grep -rn "loadUnmatchedTaskNos\\|batchDays" app/api/import/_lib/trip-detail-route.ts | head -30; git log --oneline --since=2026-09-10 --until=2026-09-12 --name-only | head -60`,
  `cd "C:\\Users\\u\\Documents\\proj-c" && git log --all --oneline -p -- lib/metrics/recompute/daily.ts | grep -n "requeueActiveBackfills\\|GRACE_DAYS\\|^commit\\|^Date:" | grep -B2 "GRACE_DAYS" | head -80`,
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%node%'\\" | Where-Object { \\$_.CommandLine -match 'proj-c' } | Select-Object ProcessId | Format-Table -AutoSize | Out-String" | grep -E "^\\s*[0-9]+" | head -3; git add tests/segment/t081.spec.ts && git commit -q -m "$(cat <<'EOF'\ntest(t081)+docs: 上車縣市改快照\nEOF\n)" && git push origin main 2>&1 | tail -1`,
  `git add tests/ops/prod-profile-open.measure.spec.ts && git commit -q -F - <<'EOF'\ntest(ops): 隊員 Profile 重現探針兩支\nEOF\ngit push origin main 2>&1 | tail -1; powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId | Out-String" | grep -cE "^\\s*[0-9]+"`,
  `cd "C:/Users/u/Desktop/proj-a" && grep -n "git add\\|git commit\\|execSync\\|spawnSync" scripts/lib/txn.mjs | head -20`,
  `cd "C:\\Users\\u\\Documents\\proj-c" && git log -p --follow -- lib/import/store.ts | grep -n "^\\-.*max:\\|^\\+.*max:\\|^commit\\|^Date:" | head -80`,
  `git log --oneline --since="2026-08-05" --until="2026-08-10" --all\necho "---playwright.config.ts history---"\ngit log --follow --oneline -- playwright.config.ts\ngit log -p --all -S "6543" -- . | grep -n "^commit\\|6543" | head -60`,
  `cd C:/Users/u/Documents/proj-c && S="/tmp/s" && git add "app/(dashboard)/activity/activity.css" .constellation/design-frozen.json && git commit -q -F "$S/commit-336.txt" && git log --oneline -1 && echo "== push" && git push origin main 2>&1 | tail -3`,
  `cd C:/Users/u/Documents/proj-c && git add tests/e2e/req-e2e-007-activity-create.e2e.spec.ts && git commit -q -F "/tmp/s/commit-e2e007.txt" && git log --oneline -1 && git status --short | head -3; (netstat -ano | grep -E ":3000 " | grep LISTEN | head -1 || echo "3000 free")`,
  `cd "C:/Users/u/Documents/proj-c-worktrees/Function" && git add .constellation/CONTEXT.md && git commit -q -m "docs(context): 修回被 shell 命令替換吃掉的兩個程式欄位\n\n上一個 commit 用 bash 雙引號包 node -e 字串，內含反引號被當成命令替換執行，\nCONTEXT.md「原話待補／原因待補」兩條的欄位名變成空括號。改用 Edit 精確補回。" && git log --oneline -1 && grep -n "原話待補\\*\\*＝\\|原因待補\\*\\*＝" .constellation/CONTEXT.md | cut -c1-110`,
  `cd "C:/Users/u/Documents/proj-c-worktrees/Function" && node "/tmp/freeze-tool.mjs" unfreeze "0903 輪 build 批次 2 接真資料" "app/(dashboard)/settings/ReasonDictTab.tsx" && git add .constellation/design-frozen.json && git commit -q -F - <<'EOF'\nchore(constellation): 批次 2 開工前解凍 7 支定稿檔（決議 286）\nEOF\ngit log --oneline -1; grep -n -i "port\\|usage\\|用法" "/tmp/serve.mjs" | head -25`,
  `M="/tmp/m"; cat > "$M/reference-commit-hook-dash-n-false-positive.md" <<'EOF'\n---\nname: reference-commit-hook-dash-n-false-positive\n---\nConstellation 的 PreToolUse hook 掃整條 Bash 命令字串：只要同時出現 \`git commit\` 與 \` -n\`，就判定為 \`--no-verify\` 短式而擋下——\`grep -n\`、\`sed -n\`、commit message 內文的「-n」都會誤中。\nEOF\ncat >> "$M/MEMORY.md" <<'EOF'\n- [commit 守門誤判 -n](reference-commit-hook-dash-n-false-positive.md)\nEOF\ntail -3 "$M/MEMORY.md"`,
  `cd "C:/Users/u/Documents/proj-d" && sed -i '44s|舊字串|新字串|' HANDOFF.md && grep -n "1212" HANDOFF.md | cut -c1-120 && git add HANDOFF.md && git commit -q -F - << 'EOF'\ndocs: 交接紀錄測試數字訂正為最終全量 1212\nEOF\ngit log --oneline -5 && git status --short`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'; $b=[System.IO.File]::ReadAllBytes('.constellation\\tickets\\T-105-ui-live-data-wiring.md')[0..2]; "ticket BOM: $($b -join ',')"; git add app/Ui.ps1 .constellation/tickets/T-105-ui-live-data-wiring.md; git commit -m @'\nfeat(T-105): 改列失敗真的寫回日誌\n\n全量 1382 passed / 1 failed / 1383 支，\n唯一紅燈是 Win.Tests AC9 剪貼簿既知偶發，單獨重跑該 Describe 17 / 0 全綠。\n'@; git log --oneline -4; git status --short`,
  `cd "C:/Users/u/Documents/proj-d" && git commit -F - -- app/lib/SendRunner.ps1 <<'EOF'\nfix(T-008): 補「清空後讀回仍非空」與「未定關閉段」兩處離線測試\n\nSendRunner 239 -> 248（0 failed）、SendEngine 440 -> 443（0 failed）。\nEOF`,
  `$ErrorActionPreference='Stop'; foreach ($f in @('.constellation/CONTEXT.md')) { $tmp="$env:TEMP\\chk.diff"; git --no-pager diff -U0 --no-color -- $f | Out-File $tmp -Encoding utf8; $addLines = @(Get-Content $tmp | Where-Object { $_.Length -gt 1 -and $_[0] -eq '+' -and $_ -notmatch '^\\+\\+\\+' }); $withDate = @($addLines | Where-Object { $_ -match '2026-09-20' }); "$f : 新增行=$($addLines.Count) 含2026-09-20=$($withDate.Count)" }`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\n$subject = (git log -1 --pretty=%s).Trim()\nif ($head -like 'a1b2c3d*' -and $subject -match 'fix\\(T-008\\): 背景執行緒') {\n  $msgPath = '/tmp/commit-msg.txt'\n  $t = [System.IO.File]::ReadAllText($msgPath, (New-Object System.Text.UTF8Encoding($true)))\n  [System.IO.File]::WriteAllText($msgPath, $t, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $msgPath\n  git log --oneline -1\n} else { "HEAD 已被其他執行者變更，跳過 amend" }`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = git rev-parse HEAD\nif ($head.Trim().StartsWith('f4e5d6c')) {\n  $msg = git log -1 --pretty=%B\n  $clean = ($msg -join "\`n").TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-zone1-nobom.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $f --only 2>&1 | Select-String -NotMatch 'warning: in the working copy'\n  git log -1 --pretty='%H%n%s'\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\nif ($head.StartsWith('f4e5d6c')) {\n  $msg = (git log -1 --pretty=%B) -join "\`n"\n  $clean = $msg.TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-zone1-nobom.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend -F $f -- app/lib/Settings.ps1\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}\ngit log -1 --pretty='%H%n%s'`,
  `cd 'C:\\Users\\u\\Documents\\proj-d'\n$head = (git rev-parse HEAD).Trim()\nif ($head.StartsWith('f4e5d6c')) {\n  $msg = (git log -1 --pretty=%B) -join "\`r\`n"\n  $clean = $msg.TrimStart([char]0xFEFF)\n  $f = Join-Path $env:TEMP 'commit-msg-clean.txt'\n  [System.IO.File]::WriteAllText($f, $clean, (New-Object System.Text.UTF8Encoding($false)))\n  git commit --amend --file $f -- app/lib/Settings.ps1\n} else {\n  "HEAD 已前進到 $head，不 amend"\n}\ngit log -1 --pretty='%H%n%s'`,
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

// 第二輪對抗複審 must-fix：續行寫法（bash `\`+換行、PowerShell 反引號+換行）不能把 --no-verify/-n
// 切到認不出來的下一段（C1／C2／C3）。
describe('第二輪 must-fix——續行寫法不能漏擋', () => {
  test('C1：bash \\+換行接 --no-verify 要擋', () =>
    assertBlockedNoVerify(bash('git commit -m "msg" \\\n  --no-verify'), 'C1'));
  test('C2：同一寫法改成結尾 -n 要擋', () =>
    assertBlockedNoVerify(bash('git commit -m "msg" \\\n  -n'), 'C2'));
  test('C3：PowerShell 反引號+換行接 --no-verify 要擋', () =>
    assertBlockedNoVerify(ps('git commit -m "msg" `\n  --no-verify'), 'C3'));
});

// 第二輪對抗複審 must-fix：包在殼裡／子殼／命令替換的 commit（isCommitSegment 認不出來）不能讓三道
// 檔案閘門跟著 fail-open——staged 的 secrets 要能被擋下，不管 commit 包得多深。獨立開一個帶 staged
// .env 的 repo，避免污染其他測試假設的「空 staging」前提。
describe('第二輪 must-fix——包殼裡的 commit 也要跑三道檔案閘門（staged .env）', () => {
  let secretRepo;
  before(() => {
    secretRepo = mkdtempSync(join(tmpdir(), 'cg-secret-'));
    execFileSync('git', ['init', '-q'], { cwd: secretRepo });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: secretRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: secretRepo });
    mkdirSync(join(secretRepo, '.constellation'), { recursive: true });
    writeFileSync(join(secretRepo, '.env'), 'SECRET=1\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: secretRepo });
  });
  after(() => rmSync(secretRepo, { recursive: true, force: true }));
  const sbash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: secretRepo });
  const sps = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: secretRepo });

  test('(git commit -m x) 要擋（staged .env）', () =>
    assertBlocked(sbash('(git commit -m x)'), 'paren commit, staged .env'));
  test('git -C $(git rev-parse --show-toplevel) commit -m x 要擋（staged .env）', () =>
    assertBlocked(sbash('git -C $(git rev-parse --show-toplevel) commit -m x'), '-C $(...) commit, staged .env'));
  test('bash -c "git commit -m x" 要擋（staged .env）', () =>
    assertBlocked(sbash('bash -c "git commit -m x"'), 'bash -c commit, staged .env'));
  test('echo $(git commit -m x) 要擋（staged .env）', () =>
    assertBlocked(sbash('echo $(git commit -m x)'), 'command substitution commit, staged .env'));
  test('PowerShell：git -C (Split-Path $PWD) commit -m x 要擋（staged .env）', () =>
    assertBlocked(sps('git -C (Split-Path $PWD) commit -m x'), 'ps -C (Split-Path) commit, staged .env'));
});

// 第二輪對抗複審 must-fix：短式 -n 包在殼裡也要精準擋下（空 staging，只測旗標判斷本身）。
describe('第二輪 must-fix——短式 -n 包在殼裡也要精準擋下', () => {
  test('bash -c "git commit -n -m x" 要擋', () => assertBlockedNoVerify(bash('bash -c "git commit -n -m x"'), 'bash -c -n'));
  test("sh -c 'git commit -an -m x' 要擋", () => assertBlockedNoVerify(bash("sh -c 'git commit -an -m x'"), 'sh -c -an'));
  test('(git commit -n -m x) 要擋', () => assertBlockedNoVerify(bash('(git commit -n -m x)'), 'paren -n'));
  test('echo x && (git commit -n -m x) 要擋', () =>
    assertBlockedNoVerify(bash('echo x && (git commit -n -m x)'), 'chain paren -n'));
  test('$(git commit -n -m x) 要擋', () => assertBlockedNoVerify(bash('$(git commit -n -m x)'), 'command substitution -n'));
  test('git -C $(git rev-parse --show-toplevel) commit -n -m x 要擋', () =>
    assertBlockedNoVerify(bash('git -C $(git rev-parse --show-toplevel) commit -n -m x'), '-C $(...) -n'));
  test('反引號命令替換：git -C `git rev-parse --show-toplevel` commit -n -m x 要擋', () =>
    assertBlockedNoVerify(bash('git -C `git rev-parse --show-toplevel` commit -n -m x'), 'backtick -C -n'));
  test('PowerShell：cmd /c "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('cmd /c "git commit -n -m x"'), 'cmd /c -n'));
  test('PowerShell：powershell -Command "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('powershell -Command "git commit -n -m x"'), 'powershell -Command -n'));
});

// 第二輪對抗複審 must-fix：引號模型與真實 shell 對不上時，commit 段被切斷或併段，旗標漏看
// （C9／C12／C14／C15／C23／C24，逐字取自複審報告）。
describe('第二輪 must-fix——引號／跳脫模型要對齊真實 shell', () => {
  test("C9：bash 單引號字串裡插字面撇號（'\\''）後接 --no-verify 要擋", () =>
    assertBlocked(bash("git commit -m 'it'\\''s; done' --no-verify"), 'C9'));
  test('C12：訊息含跳脫分號（無引號）後接 -n 要擋', () =>
    assertBlocked(bash('git commit -m wip\\; -n'), 'C12'));
  test('C14：PowerShell 雙引號內反斜線是字面字元（以 \\ 收尾的路徑）不能併段漏看 -n', () =>
    assertBlocked(ps('git -C "C:\\repo\\" add -A; git commit -n -m x'), 'C14'));
  test('C15：bash 非 here-string 的 @"..."（沒接換行）不能整段吞到底', () =>
    assertBlocked(bash('echo a@"b"; git add -A; git commit -n -m y'), 'C15'));
  test('C23：bash 引號外的跳脫雙引號（\\"）不能誤判成未收尾字串', () =>
    assertBlocked(bash('git status \\"; git commit -n -m x; echo \\"'), 'C23'));
  test('C24：PowerShell 反引號跳脫的引號（`"）不能誤判成未收尾字串', () =>
    assertBlocked(ps('git status `"; git commit -n -m x; echo `"'), 'C24'));
});

// 第二輪對抗複審 must-fix（heredoc 用來寫 commit message 再 add && commit，FIELD_38 最常見的形狀）。
describe('第二輪 must-fix——heredoc 寫 commit message 再 add && commit 不能漏擋', () => {
  test('git commit -F - <<EOF 訊息含撇號後 add && commit -n 要擋', () =>
    assertBlocked(bash(`git commit -F - <<'EOF'\nfix: don't crash\nEOF\ngit add b && git commit -n -m y`), 'heredoc + add && commit -n'));
  test('cat > msg.txt <<EOF 訊息含撇號後 add -A && commit -n -q -F 要擋', () =>
    assertBlocked(bash(`cat > /tmp/msg.txt <<'EOF'\nfix: don't crash on empty input\nEOF\ngit add -A && git commit -n -q -F /tmp/msg.txt`), 'heredoc + add -A && commit -n -q -F'));
});

// 第二輪對抗複審 must-fix：多個 git 呼叫時（含包殼），第一個不是 commit 不能讓後面真正的
// --amend --no-verify 漏看（C13）。
describe('第二輪 must-fix——同指令內第二個以後的 commit 呼叫也要判', () => {
  test('C13：git commit -m a && bash -c "git commit --amend --no-verify -m b" 要擋', () =>
    assertBlocked(bash('git commit -m a && bash -c "git commit --amend --no-verify -m b"'), 'C13'));
});

// 第二輪對抗複審 must-fix：GIT_COMMIT_LOOSE_RE 保底原本沒有「看起來像包了殼層」的門檻，導致同一行
// 剛好同時出現 git…commit 字樣（如檔名 commit-gate.mjs）與 --no-verify 字面值（如 grep 查詢樣式）的
// 唯讀指令被誤判成想繞過 pre-commit。
describe('第二輪 must-fix——GIT_COMMIT_LOOSE_RE 保底不能誤攔唯讀指令', () => {
  test('git diff -- commit-gate.mjs | grep -n -- --no-verify 放行', () =>
    assertPassed(bash("git diff HEAD -- gates/commit-gate.mjs | grep -n -- '--no-verify'"), 'diff | grep -n --no-verify'));
  test('git log -S --no-verify --oneline -- commit-gate.mjs 放行', () =>
    assertPassed(bash('git log -S "--no-verify" --oneline -- gates/commit-gate.mjs'), 'log -S --no-verify'));
  test('git show HEAD:commit-gate.mjs | grep --no-verify 放行', () =>
    assertPassed(bash('git show HEAD:gates/commit-gate.mjs | grep -n -- "--no-verify"'), 'show | grep --no-verify'));
  test('git grep -e --no-verify -- commit-gate.mjs 放行', () =>
    assertPassed(bash('git grep -n -e --no-verify -- gates/commit-gate.mjs'), 'git grep -e --no-verify'));
  test('git commit-tree ... --no-verify 放行（commit-tree 不是 commit）', () =>
    assertPassed(bash('git commit-tree HEAD^{tree} -m x --no-verify'), 'commit-tree --no-verify'));
  test('PowerShell：git diff | Select-String --no-verify 放行', () =>
    assertPassed(ps("git diff -- gates/commit-gate.mjs | Select-String -Pattern '--no-verify'"), 'ps diff | Select-String'));
});

// 第三輪對抗複審 must-fix：GIT_COMMIT_LOOSE_RE 少了 must-fix 前的兩側邊界（(?<![=-])…(?!-)），
// commit-gate.mjs、src/commit-utils.ts、.git/hooks/pre-commit、--grep=commit 這類檔名/樣式裡的
// "commit" 字樣會誤觸前置關卡，讓 hooksPathBypass／三道檔案閘門這兩個「對整條指令字串」的判定連坐
// 擋下唯讀指令。用 staged 了 .env 的 repo 測試——staging 乾淨時三道閘門本來就 fail-open、測不出
// 「連坐擋下」這個問題，只有 staging 不乾淨時才會真的暴露（改前這些純檔名唯讀指令會被冠上
// 「staged 含 secrets」的擋下理由，儘管跟這條指令毫無關係）。
describe('第三輪 must-fix——GIT_COMMIT_LOOSE_RE 邊界收緊：唯讀指令連檔名都不該誤觸前置關卡（staged .env）', () => {
  let filenameRepo;
  before(() => {
    filenameRepo = mkdtempSync(join(tmpdir(), 'cg-filename-'));
    execFileSync('git', ['init', '-q'], { cwd: filenameRepo });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: filenameRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: filenameRepo });
    mkdirSync(join(filenameRepo, '.constellation'), { recursive: true });
    writeFileSync(join(filenameRepo, '.env'), 'SECRET=1\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: filenameRepo });
  });
  after(() => rmSync(filenameRepo, { recursive: true, force: true }));
  const fbash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: filenameRepo });
  const fps = (command) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: filenameRepo });

  test('git diff HEAD~1 -- gates/commit-gate.mjs 放行', () =>
    assertPassed(fbash('git diff HEAD~1 -- gates/commit-gate.mjs'), 'diff commit-gate.mjs filename'));
  test('git log --oneline -5 -- src/commit-utils.ts 放行', () =>
    assertPassed(fbash('git log --oneline -5 -- src/commit-utils.ts'), 'commit-utils.ts filename'));
  test('git blame -L 10,20 gates/commit-gate.mjs 放行', () =>
    assertPassed(fbash('git blame -L 10,20 gates/commit-gate.mjs'), 'blame commit-gate.mjs'));
  test('git log --all --oneline -- "**/commit-gate*" 放行', () =>
    assertPassed(fbash('git log --all --oneline -- "**/commit-gate*"'), 'log commit-gate*'));
  test('cat .git/hooks/pre-commit 放行（.git 與 pre-commit 都不是真正的 commit 呼叫）', () =>
    assertPassed(fbash('cat .git/hooks/pre-commit'), 'cat pre-commit'));
  test('PowerShell：Get-Content .git/hooks/pre-commit 放行', () =>
    assertPassed(fps('Get-Content .git/hooks/pre-commit'), 'ps Get-Content pre-commit'));
  test('git config --get core.hooksPath; ls -la .git/hooks/pre-commit 放行（排查用唯讀指令）', () =>
    assertPassed(fbash('git config --get core.hooksPath; ls -la .git/hooks/pre-commit'), 'config --get; ls pre-commit'));
  test('git config core.hooksPath && cat .git/hooks/pre-commit 放行（裸讀，沒有值＝沒有改向）', () =>
    assertPassed(fbash('git config core.hooksPath && cat .git/hooks/pre-commit'), 'config bare read && cat'));
  test('PowerShell：git config --get core.hooksPath; Get-Content .git/hooks/pre-commit 放行', () =>
    assertPassed(fps('git config --get core.hooksPath; Get-Content .git/hooks/pre-commit'), 'ps config --get; Get-Content'));
});

// 第三輪對抗複審 must-fix：hooksPathBypass 改前對整條指令字串做「看到 config…core.hooksPath 就擋」，
// 就算 staged 是乾淨的、也就算擋下理由跟 staged 內容無關的唯讀查詢，一樣連坐擋下——用一個 staged
// 了 .env 的 repo 確認：唯讀的 config 查詢不該因為 staging 剛好不乾淨就被冠上「改向 hooksPath」的
// 罪名（本來就該被 secrets 閘門擋下的話，理由應該是 secrets，不是 hooksPath）。
describe('第三輪 must-fix——hooksPathBypass 只認寫入形式（staged .env，確認不是巧合放行）', () => {
  let secretRepo2;
  before(() => {
    secretRepo2 = mkdtempSync(join(tmpdir(), 'cg-secret2-'));
    execFileSync('git', ['init', '-q'], { cwd: secretRepo2 });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: secretRepo2 });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: secretRepo2 });
    mkdirSync(join(secretRepo2, '.constellation'), { recursive: true });
    writeFileSync(join(secretRepo2, '.env'), 'SECRET=1\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: secretRepo2 });
  });
  after(() => rmSync(secretRepo2, { recursive: true, force: true }));
  const s2bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: secretRepo2 });

  test('git log --grep=commit --oneline 放行（=commit 是查詢樣式，不是真正的 commit 呼叫）', () =>
    assertPassed(s2bash('git log --grep=commit --oneline'), 'log --grep=commit'));
  test('git config --get core.hooksPath; git log --oneline -3 -- gates/commit-gate.mjs 放行', () =>
    assertPassed(s2bash('git config --get core.hooksPath; git log --oneline -3 -- gates/commit-gate.mjs'), 'config --get; log filename'));
  test('讀查詢與真正 commit 同一條指令混寫：讀的那段不該連坐擋下真正 commit（staged .env 本來就該擋，但理由要是 secrets）', () => {
    const r = commitGateCheck(s2bash('git config --get core.hooksPath; git commit -m "x"'));
    assert.equal(r.block, true, '應擋下（staged .env）');
    assert.match(r.message, /secrets/, `擋下理由應是 secrets，不是誤判成 hooksPath 改向，實際：${r.message}`);
  });
});

// 第三輪對抗複審 must-fix：LOOKS_WRAPPED_RE 改前只要整條指令出現任何括號就當「看起來像包了殼」，
// PowerShell 的 `.Trim()`、bash 的子殼都算——這裡用「唯讀指令裡剛好同時有 git…log（非 commit 子命令）
// 與帶括號的無關片段、外加 --no-verify 字面值」組合，重現「明明沒有真正的 commit 呼叫，卻因為整條
// 字串同時湊到括號與 --no-verify 字樣而被擋下」。
describe('第三輪 must-fix——LOOKS_WRAPPED_RE 收緊：無關括號＋巧合字樣不誤判成包殼繞過', () => {
  test('git log --grep commit | grep -- --no-verify ; (pwd) 放行', () =>
    assertPassed(bash('git log --grep commit | grep -- --no-verify ; (pwd)'), 'log --grep commit | grep --no-verify ; (pwd)'));
  test('PowerShell：git log --grep commit | Select-String -- "--no-verify"; (Get-Date).ToString() 放行', () =>
    assertPassed(ps('git log --grep commit | Select-String -- "--no-verify"; (Get-Date).ToString()'), 'ps grep commit; (Get-Date).ToString()'));
});

// 第三輪對抗複審 must-fix：splitChainSegments 引號沒收尾時（segments===null）退回的保底原本只看長式
// --no-verify、還要 LOOKS_WRAPPED_RE 命中才看，短式 -n 在這條路徑上完全漏看。另外 bash 註解裡的撇號
// （don't）會被誤判成單引號起頭而讓切段回 null——但既然 -n 本來就在註解之前，退回的保底本來就抓得到，
// 這裡直接驗證「確實仍會擋下」，不特別區分是靠切段成功還是靠保底。
describe('第三輪 must-fix——引號/heredoc 沒收尾時，短式 -n 不能漏擋', () => {
  test("bash 註解裡的撇號（# don't run hooks）不能讓 -n 漏擋", () =>
    assertBlockedNoVerify(bash("git commit -n -m wip  # don't run hooks"), 'comment apostrophe + -n'));
  test('真的未收尾的雙引號（echo "it\'s done 沒有收尾）不能讓 -n 漏擋', () =>
    assertBlockedNoVerify(bash('git commit -n -m wip; echo "it\'s done'), 'unterminated quote + -n'));
  test('PowerShell：# 註解裡的撇號（# don\'t）不能讓 -n 漏擋', () =>
    assertBlockedNoVerify(ps('git commit -n -m "wip" # don\'t'), 'ps comment apostrophe + -n'));
  test('heredoc 訊息內文含未跳脫的英吋符號（27"）不能讓 -n 漏擋', () =>
    assertBlockedNoVerify(bash(`git commit -n -m "$(cat <<'EOF'\nfeat: 支援 27" 螢幕\nEOF\n)"`), 'inch mark in heredoc + -n'));
  test('heredoc 訊息內文含未收尾的中文引號描述（未收尾字串）不能讓 -n 漏擋', () =>
    assertBlockedNoVerify(bash(`git add -A && git commit -n -m "$(cat <<'EOF'\nfix: 修正 "未收尾字串\nEOF\n)"`), 'unterminated quote text in heredoc + -n'));
});

// 第三輪對抗複審 must-fix：CMD_C_WRAPPER_RE／SH_C_WRAPPER_RE 改前只認殼名後面緊接 -c／-Command、
// cmd 後面緊接 /c，`powershell -NoProfile -Command`（Windows 上呼叫工具幾乎都這樣寫）、
// `pwsh -NoLogo -c`、`bash -lc`／`bash -l -c`、`cmd /d /c` 都認不出來，短式 -n 藏在這些包殼裡就漏擋。
describe('第三輪 must-fix——包殼旗標組合擴充：更多殼層寫法要能精準展開', () => {
  test('powershell -NoProfile -Command "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('powershell -NoProfile -Command "git commit -n -m x"'), 'powershell -NoProfile -Command'));
  test('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "git commit -n -m x"'), 'powershell.exe multi-flag -Command'));
  test('pwsh -NoLogo -c "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('pwsh -NoLogo -c "git commit -n -m x"'), 'pwsh -NoLogo -c'));
  test('bash -lc "git commit -n -m x" 要擋（合寫短旗標）', () =>
    assertBlockedNoVerify(bash('bash -lc "git commit -n -m x"'), 'bash -lc'));
  test('bash -l -c "git commit -n -m x" 要擋（分寫旗標）', () =>
    assertBlockedNoVerify(bash('bash -l -c "git commit -n -m x"'), 'bash -l -c'));
  test('cmd /d /c "git commit -n -m x" 要擋', () =>
    assertBlockedNoVerify(bash('cmd /d /c "git commit -n -m x"'), 'cmd /d /c'));
});

// 第二輪對抗複審 should-fix：findCommitCallsInSegment（現已併入 findGitCallsInSegment）對每個 commit
// 呼叫都把 rest 收到段尾是平方級——8000 次重複在改前要 7 秒多，改後應在幾百毫秒內完成（含實際 git
// 子行程開銷），差距夠大不會誤判。
describe('第二輪 should-fix——病態輸入（同段大量 git commit 字樣）不能逼近逾時', () => {
  test("'git commit '.repeat(8000) 要在 3 秒內判完", () => {
    const t0 = Date.now();
    commitGateCheck(bash('git commit '.repeat(8000)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回 O(n²)`);
  });
});

// 第四輪對抗複審 must-fix：GIT_COMMIT_LOOSE_RE 帶 /i 比第三輪的邊界收緊還要寬——`--format="COMMIT
// %ad"`（awk 慣用寫法）、`echo "--- LAST COMMIT ---"`、註解裡的 `Commit`、標題字串裡的
// `Git commit gate: fix` 這類唯讀指令的大寫/混寫字樣都會誤觸前置關卡，讓 staged 有 secrets 時連坐
// 擋下。用 staged .env 的夾具才量得到（空 staging 三道閘門天然 fail-open，測不出「連坐擋下」）。
describe('第四輪 must-fix——GIT_COMMIT_LOOSE_RE 拿掉 /i：大寫/混寫的 COMMIT 字樣不誤觸前置關卡（staged .env）', () => {
  let looseRepo;
  before(() => {
    looseRepo = mkdtempSync(join(tmpdir(), 'cg-loose-'));
    execFileSync('git', ['init', '-q'], { cwd: looseRepo });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: looseRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: looseRepo });
    mkdirSync(join(looseRepo, '.constellation'), { recursive: true });
    writeFileSync(join(looseRepo, '.env'), 'SECRET=1\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: looseRepo });
  });
  after(() => rmSync(looseRepo, { recursive: true, force: true }));
  const lbash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: looseRepo });
  const lps = (command) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: looseRepo });

  test('git log --format="COMMIT %ad" 交給 awk 解析放行', () =>
    assertPassed(lbash(`git log --diff-filter=A --name-only --format="COMMIT %ad" --date=short -- tests/ | awk '/^COMMIT /{d=$2; next} /\\.ts$/{print d}' | sort | uniq -c`), 'awk COMMIT format'));
  test('echo "--- LAST COMMIT ---" 放行', () =>
    assertPassed(lbash('git status --short && echo "--- LAST COMMIT ---" && git log -1 --oneline'), 'echo LAST COMMIT'));
  test('--pretty=format:"COMMIT %h %s" 放行', () =>
    assertPassed(lbash('git log -1 --pretty=format:"COMMIT %h %s"'), 'pretty format COMMIT'));
  test('# 註解裡大寫的 Commit 放行', () =>
    assertPassed(lbash('git show --stat HEAD  # 看 Commit 內容'), 'comment Commit'));
  test('gh pr create 標題字串裡的 "Git commit gate: fix" 放行', () =>
    assertPassed(lbash('gh pr create --title "Git commit gate: fix" --body "x"'), 'gh pr title Git commit'));
  test('PowerShell：Write-Host "=== LAST COMMIT ===" 放行', () =>
    assertPassed(lps('git status --short; Write-Host "=== LAST COMMIT ==="; git log -1 --oneline'), 'ps Write-Host LAST COMMIT'));
  test('對照組：小寫 commit 字面值仍會誤觸前置關卡而被擋（staged .env，非本輪要修的退步，維持現況）', () =>
    assertBlocked(lbash('git log -1 --format="commit %h"'), 'control lowercase commit'));
});

// 第四輪對抗複審 must-fix：tokenizeSeg 不認 PowerShell here-string（@'…'@／@"…"@），會被拆成散字
// token——訊息本文裡的裸 git 字樣、條列用的不成對 `1)`/`a)`、表情符號 `:)` 都會讓
// findGitCallsInSegment 收 rest 提早收工，收尾的 `'@` 進不了 rest，stripMessageValues 的 here-string
// 規則對不上訊息本文，PowerShell 運算子（-and/-join/-not…）被當成 --no-verify/-n 的組合旗標掃描。
describe('第四輪 must-fix——tokenizeSeg 認得 PowerShell here-string，訊息裡的 -and/-join/-not/括號/表情符號不誤擋', () => {
  test('-and 串接 + 條列 1)/2) 放行', () =>
    assertPassed(ps(`git add -A; git commit -m @'\nfix(filter): 篩選條件改用 -and 串接\n\n驗過兩種情況：1) 空值 2) 非空值\n'@`), '-and + 條列'));
  test('-join 欄位 + 條列 a)/b)/c) 放行', () =>
    assertPassed(ps(`git add -A; git commit -m @'\nfix(export): 匯出前先 -join 欄位\n\n步驟：a) 讀檔 b) 串接 c) 寫回\n'@`), '-join + a)b)c)'));
  test('find -name + 表情符號 :) 放行', () =>
    assertPassed(ps(`git commit -m @'\ndocs: 說明 find -name 的用法 :)\n'@`), 'find -name + :)'));
  test('雙引號 here-string（@"…"@）+ -not 判斷 + 條列 1) 放行', () =>
    assertPassed(ps(`git commit -m @"\nfix: 條件改成 -not 判斷（1) 空值）\n"@`), '@"…"@ -not + 1)'));
  test('-join 組路徑，再交給 git 處理（訊息本文裡的裸 git 字樣）放行', () =>
    assertPassed(ps(`git commit -m @'\nfix(path): 改用 -join 組路徑，再交給 git 處理\n'@`), 'message body has literal git word'));
  test('sed -n 不再被當成 --no-verify（訊息本文裡的裸 -n 樣式）放行', () =>
    assertPassed(ps(`git add -A; git commit -m @'\nfix(gates): sed -n 不再被當成 --no-verify\n\n- 只看真正的 git 呼叫\n'@`), 'sed -n in message body'));
});

// 第四輪對抗複審 should-fix：LOOKS_WRAPPED_RE 命中但定位不到 commit 呼叫時的保底，改前用兩段懶惰
// 匹配（[\s\S]*?…[\s\S]*?）掃整條指令找 --no-verify，指令裡沒有 --no-verify 時耗時隨長度三次方成長，
// 病態輸入（大量 $(git …)／(git …) 反覆出現）會逼近 hook 逾時。改後應在幾百毫秒內完成。
describe('第四輪 should-fix——LOOKS_WRAPPED_RE 保底不能逼近逾時（兩種病態形狀）', () => {
  test("'echo $(git rev-parse HEAD) `git commit`; '.repeat(1600) 要在 3 秒內判完", () => {
    const t0 = Date.now();
    commitGateCheck(bash('echo $(git rev-parse HEAD) `git commit`; '.repeat(1600)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回三次方成長`);
  });
  test("'(git status); 用 git 做 commit; '.repeat(2500) 要在 3 秒內判完", () => {
    const t0 = Date.now();
    commitGateCheck(bash('(git status); 用 git 做 commit; '.repeat(2500)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回三次方成長`);
  });
});
