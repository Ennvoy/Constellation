// gates/test/git-guardrail.test.mjs — P22 回歸表：git 守門既有規則不能退步 + 補上漏擋的強推／
// 刪遠端分支／包殼寫法。gitGuardrailCheck 是純函式（git-guardrail.mjs 沒有任何自動執行的入口），
// 直接 import 呼叫最快，不必為這支閘門另外 spawn 子行程。
//
// 案例依健檢報告 P22 節：改法①（push 補強推／--delete／-d／:refspec／--mirror）、②（bash -c／sh -c／
// 子殼／$(...) 展開檢查）。git-guardrail 不是 shell 解析器：新增阻擋都是在既有樸素切段與 token 上加規則
// （包殼只在引號內容以 git 開頭時展開；段首 ( 與 $(、Bash 反引號、PowerShell @( 視為子殼／命令替換，
// 且與舊寫法的「段內第一個 git」都要判；帶值旗標的值括號沒收齊就跳到收齊，收不齊照舊只跳一個值；續行
// 先接回同一行）。hasShort 共用小 helper 是外觀整理、訊息逐字不變，不另測。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gitGuardrailCheck } from '../git-guardrail.mjs';

const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command } });

function assertBlocked(input, label) {
  const r = gitGuardrailCheck(input);
  assert.equal(r.block, true, `${label}：應擋下，實際 ${JSON.stringify(r)}`);
}
function assertPassed(input, label) {
  const r = gitGuardrailCheck(input);
  assert.equal(r.block, false, `${label}：應放行，實際 ${JSON.stringify(r)}`);
}

describe('git-guardrail：既有規則不能退步（回歸）', () => {
  test('裸 checkout 一律攔', () => assertBlocked(bash('git checkout main'), 'checkout main'));
  test('checkout -b 建新分支一律攔', () => assertBlocked(bash('git checkout -b feature'), 'checkout -b'));
  test('switch 切分支一律攔', () => assertBlocked(bash('git switch main'), 'switch'));
  test('branch <名稱> 建分支要攔', () => assertBlocked(bash('git branch newbranch'), 'branch <name>'));
  test('branch -D 強刪要攔', () => assertBlocked(bash('git branch -D worktree-wf_x'), 'branch -D'));
  test('branch --force 移動 ref 要攔', () => assertBlocked(bash('git branch --force main abc123'), 'branch --force'));
  test('push --force 要攔', () => assertBlocked(bash('git push --force origin main'), 'push --force'));
  test('push -f 要攔', () => assertBlocked(bash('git push -f origin main'), 'push -f'));
  test('push +refspec 強推要攔', () => assertBlocked(bash('git push origin +main'), 'push +refspec'));
  test('reset --hard 要攔', () => assertBlocked(bash('git reset --hard HEAD~1'), 'reset --hard'));
  test('clean -fd 要攔', () => assertBlocked(bash('git clean -fd'), 'clean -fd'));
  test('restore（未加 --staged）要攔', () => assertBlocked(bash('git restore file.txt'), 'restore'));
  test('restore --worktree 要攔（即使同時有 --staged）', () =>
    assertBlocked(bash('git restore --staged --worktree file.txt'), 'restore --staged --worktree'));
  test('裸 rebase 要攔', () => assertBlocked(bash('git rebase main'), 'rebase'));
  test('worktree add -b 建新分支要攔', () => assertBlocked(bash('git worktree add -b wf ../wt'), 'worktree add -b'));
  test('reflog expire 要攔', () => assertBlocked(bash('git reflog expire --all'), 'reflog expire'));
  test('stash drop 要攔', () => assertBlocked(bash('git stash drop'), 'stash drop'));
  test('stash clear 要攔', () => assertBlocked(bash('git stash clear'), 'stash clear'));
  test('cmd /c 包殼裡的 checkout 仍要展開偵測', () =>
    assertBlocked(bash('cmd /c "git checkout main"'), 'cmd /c wrapper'));

  test('CONSTELLATION_GIT_OK=1 逃生口放行（Bash）', () =>
    assertPassed(bash('CONSTELLATION_GIT_OK=1 git checkout main'), 'escape hatch bash'));
  test('$env:CONSTELLATION_GIT_OK 逃生口放行（PowerShell）', () =>
    assertPassed(ps("$env:CONSTELLATION_GIT_OK='1'; git branch -D x"), 'escape hatch ps'));
  test('唯讀 git 指令放行', () => assertPassed(bash('git status && git log -3 && git diff'), 'readonly git'));
  test('commit message 內文含 checkout 字樣不誤攔', () =>
    assertPassed(bash('git commit -m "checkout old approach"'), 'message keyword'));
  test('restore --staged（不含 --worktree）放行', () =>
    assertPassed(bash('git restore --staged file.txt'), 'restore --staged only'));
  test('rebase --continue 放行', () => assertPassed(bash('git rebase --continue'), 'rebase --continue'));
  test('worktree add（無 -b）放行', () => assertPassed(bash('git worktree add ../wt'), 'worktree add no -b'));
  test('branch -d 小寫刪已合併分支放行', () => assertPassed(bash('git branch -d feature'), 'branch -d'));
  test('reflog show 放行', () => assertPassed(bash('git reflog show'), 'reflog show'));
  test('stash pop 放行', () => assertPassed(bash('git stash pop'), 'stash pop'));
});

describe('git-guardrail：P22 補洞——push 漏擋的強推／刪遠端分支寫法（改後應擋下）', () => {
  test('push -fu（合寫短旗標含 f）要擋', () => assertBlocked(bash('git push -fu origin main'), 'push -fu'));
  test('push -uf（f 在後）要擋', () => assertBlocked(bash('git push -uf origin main'), 'push -uf'));
  test('push --mirror 要擋', () => assertBlocked(bash('git push --mirror origin'), 'push --mirror'));
  test('push --delete 刪遠端分支要擋', () => assertBlocked(bash('git push origin --delete feature-x'), 'push --delete'));
  test('push :refspec 刪遠端分支要擋', () => assertBlocked(bash('git push origin :feature-x'), 'push :refspec'));
  test('push -d 刪遠端分支要擋（短式）', () => assertBlocked(bash('git push -d origin feature-x'), 'push -d'));
});

describe('git-guardrail：P22 補洞——bash -c／sh -c／子殼／$(...) 展開檢查（改後應擋下）', () => {
  test('bash -c 包裹的 reset --hard 要展開偵測', () =>
    assertBlocked(bash('bash -c "git reset --hard"'), 'bash -c reset --hard'));
  test('sh -c 包裹的 clean -fdx 要展開偵測', () =>
    assertBlocked(bash("sh -c 'git clean -fdx'"), 'sh -c clean -fdx'));
  test('括號子殼包裹的 clean -fdx 要展開偵測', () =>
    assertBlocked(bash('(cd sub && git clean -fdx)'), 'subshell clean -fdx'));
  test('$(...) 命令替換內的 stash drop 要展開偵測', () =>
    assertBlocked(bash('echo $(git stash drop)'), '$(...) stash drop'));
});

// `-C`/`--git-dir` 的值是 $(...)／@(...)／(...) 這類不含空白的子殼/命令替換時，值只佔一個 token，
// 值後面真正的子命令（push --force、reset --hard…）照判。
describe('git-guardrail：對抗審查 must-fix——`-C`/`--git-dir` 值是 $(...)/@(...)/(...) 時不能漏擋', () => {
  test('git -C $(pwd) push --force 要擋', () => assertBlocked(bash('git -C $(pwd) push --force'), '-C $(pwd) push --force'));
  test('git -C $(pwd) reset --hard 要擋', () => assertBlocked(bash('git -C $(pwd) reset --hard'), '-C $(pwd) reset --hard'));
  test('git -C $(pwd) checkout -b feat 要擋', () => assertBlocked(bash('git -C $(pwd) checkout -b feat'), '-C $(pwd) checkout -b'));
  test('git -C $(pwd) switch -c feat 要擋', () => assertBlocked(bash('git -C $(pwd) switch -c feat'), '-C $(pwd) switch -c'));
  test('git -C $(pwd) branch -D old 要擋', () => assertBlocked(bash('git -C $(pwd) branch -D old'), '-C $(pwd) branch -D'));
  test('git --git-dir $(pwd)/.git reset --hard 要擋（值後面黏著殘留字）', () =>
    assertBlocked(bash('git --git-dir $(pwd)/.git reset --hard'), '--git-dir $(pwd)/.git'));
  test('git -C $(pwd)/sub clean -fdx 要擋（值後面黏著殘留字）', () =>
    assertBlocked(bash('git -C $(pwd)/sub clean -fdx'), '-C $(pwd)/sub'));
  test('git -C sub/$(date) push -f 要擋（值前面黏著殘留字）', () =>
    assertBlocked(bash('git -C sub/$(date) push -f'), '-C sub/$(date)'));
  test('PowerShell：git -C $(Get-Location) push --force 要擋', () =>
    assertBlocked(ps('git -C $(Get-Location) push --force'), 'ps -C $(Get-Location)'));
  test('git -C @(pwd) push --force 要擋（@(...) 同 $(...)）', () =>
    assertBlocked(bash('git -C @(pwd) push --force'), '-C @(pwd)'));
  test('git -C (Get-Location).Path push --force 要擋（純括號值＋後面黏著殘留字）', () =>
    assertBlocked(bash('git -C (Get-Location).Path push --force'), '-C (Get-Location).Path'));
  test('對照組：git -C (Get-Location) push --force（無 $ 前綴）本來就擋，改法不能讓它變放行', () =>
    assertBlocked(ps('git -C (Get-Location) push --force'), 'control -C (Get-Location)'));
});

// 前面用 VAR=$(git …) 取值、後面才是真正的危險呼叫：VAR=$(git 不算 git 呼叫（不在段首、也不是
// 以 $( 開頭的 token），段內第一個 git 呼叫就是後面那個。
describe('git-guardrail：前綴 VAR=$(git …) 取值後的危險呼叫也要判', () => {
  test('GIT_DIR=$(git rev-parse --git-dir) git push --force 要擋（真正的 push 在後面）', () =>
    assertBlocked(bash('GIT_DIR=$(git rev-parse --git-dir) git push --force'), 'GIT_DIR=$(...) git push'));
  test('env X=$(git config user.name) git reset --hard 要擋（真正的 reset 在後面）', () =>
    assertBlocked(bash('env X=$(git config user.name) git reset --hard'), 'env X=$(...) git reset'));
});

// 段內前面先有 $(git …)／`git …` 取值、後面才是真正的危險呼叫：兩個 git 呼叫都要判，前面取值的那個
// 不能把後面那個蓋掉（上一輪差分裁定在語料外找到的放行漏洞）。
describe('git-guardrail：段內前置的 $(git …) 不能吃掉後面真正的呼叫', () => {
  test('env -C $(git rev-parse --show-toplevel) git clean -fdx 要擋', () =>
    assertBlocked(bash('env -C $(git rev-parse --show-toplevel) git clean -fdx'), 'env -C $(git) git clean'));
  test('env -C $(git rev-parse --show-toplevel) git push --force 要擋', () =>
    assertBlocked(bash('env -C $(git rev-parse --show-toplevel) git push --force'), 'env -C $(git) git push'));
  test('timeout 60 $(git config x) git reset --hard 要擋', () =>
    assertBlocked(bash('timeout 60 $(git config x) git reset --hard'), 'timeout $(git) git reset'));
  test('env -C `git rev-parse --show-toplevel` git checkout -b feat 要擋', () =>
    assertBlocked(bash('env -C `git rev-parse --show-toplevel` git checkout -b feat'), 'env -C `git` git checkout'));
});

// 旗標值開了括號卻始終收不齊時，不能把子命令一起吞掉；收不齊就照舊只跳一個值（上一輪語料外漏洞）。
describe('git-guardrail：旗標值的括號收不齊時不能吞掉子命令', () => {
  test('git -c "user.name=Foo (Bar" push -f 要擋', () =>
    assertBlocked(bash('git -c "user.name=Foo (Bar" push -f'), '-c "(Bar" push -f'));
  test('git -c "a=(" push -f ")" 要擋（括號在子命令之後才收齊，也不能蓋掉舊判定）', () =>
    assertBlocked(bash('git -c "a=(" push -f ")"'), '-c "a=(" push -f ")"'));
});

// 反引號只在 Bash 是命令替換；PowerShell 的反引號是跳脫字元，here-string 內文的 markdown 行內碼不算呼叫。
// Bash heredoc 內文的 `git checkout`（沒加引號的 heredoc 會真的執行）保守擋下，屬已知誤攔。
describe('git-guardrail：反引號依工具判定', () => {
  test('PowerShell：here-string 訊息內文的 `git checkout` 放行', () =>
    assertPassed(ps("git commit -m @'\n修正 `git checkout` 誤判\n'@"), 'ps here-string inline code'));
  test('Bash：heredoc 內文的 `git checkout` 保守擋下（已知誤攔，逃生口可放行）', () =>
    assertBlocked(bash("git commit -F - <<'EOF'\n修正 `git checkout` 誤判\nEOF"), 'bash heredoc inline code'));
  test('Bash：heredoc 內文段中間的 (git branch -D x) 放行（段中間的裸 ( 不算子殼）', () =>
    assertPassed(bash("git commit -F - <<'EOF'\n修正 (git branch -D x) 誤判\nEOF"), 'bash heredoc mid paren'));
});

// 包殼旗標組合（powershell -NoProfile -Command、pwsh -NoLogo -c、bash -lc／-l -c）裡以 git 開頭的
// 內容也要展開判定。
describe('git-guardrail：包殼旗標組合裡的危險子命令要展開判定', () => {
  test('powershell -NoProfile -Command "git reset --hard" 要擋', () =>
    assertBlocked(bash('powershell -NoProfile -Command "git reset --hard"'), 'powershell -NoProfile -Command'));
  test('pwsh -NoLogo -c "git reset --hard" 要擋', () =>
    assertBlocked(bash('pwsh -NoLogo -c "git reset --hard"'), 'pwsh -NoLogo -c'));
  test('bash -lc "git reset --hard" 要擋（合寫短旗標）', () =>
    assertBlocked(bash('bash -lc "git reset --hard"'), 'bash -lc'));
  test('bash -l -c "git reset --hard" 要擋（分寫旗標）', () =>
    assertBlocked(bash('bash -l -c "git reset --hard"'), 'bash -l -c'));
});

// 子殼／命令替換裡唯讀的 `git branch`（列分支）：收尾括號剝掉後是裸 git branch，放行。
describe('git-guardrail：子殼裡唯讀的 git branch 不該被外層括號誤傷', () => {
  test('for b in $(git branch); do … 要放行（純列分支）', () =>
    assertPassed(bash('for b in $(git branch); do echo $b; done'), '$(git branch) in for'));
  test('PowerShell：(git branch) -match \'x\' 要放行（子殼輸出再比對，不是建分支）', () =>
    assertPassed(ps("(git branch) -match 'main'"), '(git branch) -match'));
  test('echo $(git branch) 要放行（既有案例，改法不能破壞）', () =>
    assertPassed(bash('echo $(git branch)'), 'echo $(git branch)'));
  test('(git branch --show-current) 要放行（既有案例，改法不能破壞）', () =>
    assertPassed(bash('(git branch --show-current)'), '(git branch --show-current)'));
});

// 引號／跳脫包住的字面括號（不是真的子殼收尾）不能擋住後面的 -b/--force 等旗標。
describe('第二輪 must-fix——引號／跳脫包住的字面括號不能被當成子殼收尾', () => {
  test('git worktree add wt")" -b feat 要擋（雙引號包住的字面右括號）', () =>
    assertBlocked(bash('git worktree add wt")" -b feat'), 'wt")" -b feat'));
  test('git worktree add wt\\) -b feat 要擋（反斜線跳脫的字面右括號）', () =>
    assertBlocked(bash('git worktree add wt\\) -b feat'), 'wt\\) -b feat'));
  test('git clean \\) -fdx 要擋（跳脫括號後仍要看到 -fdx）', () =>
    assertBlocked(bash('git clean \\) -fdx'), 'clean \\) -fdx'));
  test('git push origin main\\) --force 要擋（跳脫括號後仍要看到 --force）', () =>
    assertBlocked(bash('git push origin main\\) --force'), 'push main\\) --force'));
  test('git restore --staged \\) --worktree . 要擋（--worktree 不能被跳脫括號擋住視線）', () =>
    assertBlocked(bash('git restore --staged \\) --worktree .'), 'restore \\) --worktree'));
  test('PowerShell：git worktree add wt`) -b feat 要擋（反引號跳脫的字面右括號）', () =>
    assertBlocked(ps('git worktree add wt`) -b feat'), 'ps wt`) -b feat'));
});

// `=` 連寫的全域旗標（--git-dir=、--work-tree=…）的值是 $(...) 時，後面真正的危險子命令照判。
describe('第二輪 must-fix——`=` 連寫全域旗標的 $(...) 值不能漏擋', () => {
  test('git --work-tree=$(pwd) push --force 要擋', () =>
    assertBlocked(bash('git --work-tree=$(pwd) push --force'), '--work-tree=$(pwd) push --force'));
  test('git --git-dir=$(pwd)/.git reset --hard 要擋', () =>
    assertBlocked(bash('git --git-dir=$(pwd)/.git reset --hard'), '--git-dir=$(pwd)/.git reset --hard'));
  test('git --namespace=$(whoami) push --force 要擋', () =>
    assertBlocked(bash('git --namespace=$(whoami) push --force'), '--namespace=$(whoami) push --force'));
  test('git --work-tree="$(pwd)" push --force 要擋（值本身加了引號）', () =>
    assertBlocked(bash('git --work-tree="$(pwd)" push --force'), '--work-tree="$(pwd)" push --force'));
  test('PowerShell：git --git-dir=$(Get-Location)\\.git branch -D old 要擋', () =>
    assertBlocked(ps('git --git-dir=$(Get-Location)\\.git branch -D old'), 'ps --git-dir=$(Get-Location)'));
  test('git --work-tree=x")" push --force origin main 要擋（值裡引號包住的括號）', () =>
    assertBlocked(bash('git --work-tree=x")" push --force origin main'), '--work-tree=x")" push --force'));
});

// -C/--git-dir 的值若是「含空白的命令替換／子殼」（$(git rev-parse --show-toplevel)、(Split-Path $PWD)
// 這類最常見的慣用寫法）：值開了括號沒在同一 token 收齊，就一路跳到收齊，殘段不被當成子命令。
describe('第二輪 must-fix／should-fix——`-C`/`--git-dir` 值含空白的命令替換不能漏擋', () => {
  test('git -C $(git rev-parse --show-toplevel) push --force 要擋', () =>
    assertBlocked(bash('git -C $(git rev-parse --show-toplevel) push --force'), '-C $(git rev-parse --show-toplevel)'));
  test('git -C $(dirname "$f") push --force 要擋', () =>
    assertBlocked(bash('git -C $(dirname "$f") push --force'), '-C $(dirname "$f")'));
  test('git --git-dir=$(git rev-parse --git-dir) push --force 要擋', () =>
    assertBlocked(bash('git --git-dir=$(git rev-parse --git-dir) push --force'), '--git-dir=$(git rev-parse --git-dir)'));
  test('PowerShell：git -C (Split-Path $f -Parent) push --force 要擋', () =>
    assertBlocked(ps('git -C (Split-Path $f -Parent) push --force'), 'ps -C (Split-Path $f -Parent)'));
  test('PowerShell：git -C (Resolve-Path .) push --force 要擋', () =>
    assertBlocked(ps('git -C (Resolve-Path .) push --force'), 'ps -C (Resolve-Path .)'));
});

// 續行寫法（bash `\`+換行、PowerShell 反引號+換行）先接回同一行，危險旗標不會被切到下一段。
describe('第二輪 should-fix——續行寫法不能漏擋', () => {
  test('bash：push --force 用 \\ 續行要擋', () =>
    assertBlocked(bash('git push origin main \\\n  --force'), 'bash continuation push --force'));
  test('PowerShell：reset --hard 用反引號續行要擋', () =>
    assertBlocked(ps('git reset `\n  --hard'), 'ps continuation reset --hard'));
  test('續行接回後第一個 git 變成別的呼叫，也不能蓋掉原樣切段的判定：git log \\ 換行 git reset --hard 要擋', () =>
    assertBlocked(bash('git log \\\ngit reset --hard'), 'continuation keeps raw-split verdict'));
  test('包殼展開後原段也照判：bash -c "git log" git reset --hard 要擋', () =>
    assertBlocked(bash('bash -c "git log" git reset --hard'), 'wrapper keeps raw-segment verdict'));
});

// PowerShell script block 收尾的落單 `}` 不是分支名：剝掉後是裸 git branch（列分支），放行。
// 這是 git-guardrail 唯一比 048fe66 舊寫法放寬的類別（見 git-guardrail.mjs 的 trimClose 註解）。
describe('第二輪 should-fix——PowerShell script block 收尾的 } 不誤傷唯讀 git branch', () => {
  test('ForEach-Object { git -C $_.FullName branch } 要放行', () =>
    assertPassed(ps('Get-ChildItem -Directory | ForEach-Object { git -C $_.FullName branch }'), 'ForEach-Object { git branch }'));
  test('if (Test-Path .git) { git branch } 要放行', () =>
    assertPassed(ps('if (Test-Path .git) { git branch }'), 'if { git branch }'));
  test('& { git branch } 要放行', () => assertPassed(ps('& { git branch }'), '& { git branch }'));
});

// 收尾字元 token 只在段內有對應開頭字元、而且沒加引號時才丟；否則它就是分支名，照舊當「建分支」擋下。
describe('收尾字元放寬的邊界：沒有開頭字元或加了引號時照舊擋', () => {
  test('Bash：git branch }（段內沒有 {，} 是字面分支名）要擋', () =>
    assertBlocked(bash('git branch }'), 'bash branch }'));
  test('git branch ")"（加了引號，是字面分支名）要擋', () =>
    assertBlocked(bash('git branch ")"'), 'branch ")"'));
  test("PowerShell：git branch ')' -a 要擋（加了引號）", () =>
    assertBlocked(ps("git branch ')' -a"), "ps branch ')' -a"));
  test('PowerShell：git branch ` `（反引號在 PowerShell 是跳脫字元，不收尾任何東西）要擋', () =>
    assertBlocked(ps('git branch ` `'), 'ps branch ` `'));
});

// rest 以空字串 token 開頭時判斷式不能拋例外（PreToolUse fail-open 會反而放行破壞性操作）。
describe('第二輪 should-fix——git branch 空字串 token 不能讓判斷式拋例外而放行', () => {
  test('git branch "" -D main 要擋（-D 強制刪除，不能因為前面有空字串就放行）', () =>
    assertBlocked(bash('git branch "" -D main'), 'branch "" -D main'));
});

// 命令替換／子殼裡的 git branch 第一個參數是開頭帶空白的引號字串（' x'）時，判斷式也不能拋例外——
// 拋了整支中斷、同一條指令後段的破壞性操作跟著 fail-open 放行，而 048fe66 舊寫法照樣擋得到後段。
describe('git branch 第一個參數開頭帶空白時不能拋例外而放行後段', () => {
  const cases = [
    [bash, "echo $(git branch ' x'); git reset --hard"],
    [bash, '(git branch " x"); git reset --hard'],
    [bash, "echo `git branch ' x'` && git push --force"],
    [ps, '@(git branch " x"); git reset --hard'],
    [ps, "$(git branch ' x'); git clean -fdx"],
    [bash, 'cmd /c "(git branch \' x\') & git reset --hard"'],
    [bash, 'git log -1; echo $(git -C . branch " x") ; git checkout -b feat'],
  ];
  for (const [mk, cmd] of cases) {
    test(`${cmd} 要擋，且不拋例外`, () => assertBlocked(mk(cmd), cmd));
  }
  test('bare git branch " x" 本身也照「建分支」擋下（不拋例外）', () =>
    assertBlocked(bash('git branch " x"'), 'branch " x"'));
});

// -C 的值以反斜線結尾（PowerShell 的 `..\`、`C:\work\repo\`，Tab 補完常見）或是 bash 反引號命令替換
// 時，值只佔一個 token，後面的子命令照判。
describe('-C 值以反斜線結尾／反引號命令替換：後面的子命令照判', () => {
  test('PowerShell：git -C ..\\ push --force 要擋（結尾反斜線不能吃掉後面的空白）', () =>
    assertBlocked(ps('git -C ..\\ push --force'), 'ps -C ..\\ push --force'));
  test('PowerShell：git -C C:\\work\\repo\\ reset --hard 要擋', () =>
    assertBlocked(ps('git -C C:\\work\\repo\\ reset --hard'), 'ps -C C:\\work\\repo\\ reset --hard'));
  test('PowerShell：git -C .\\ clean -fdx 要擋', () =>
    assertBlocked(ps('git -C .\\ clean -fdx'), 'ps -C .\\ clean -fdx'));
  test('PowerShell：git -C ..\\other\\ branch -D old 要擋', () =>
    assertBlocked(ps('git -C ..\\other\\ branch -D old'), 'ps -C ..\\other\\ branch -D old'));
  test('對照組：PowerShell 加引號的 "C:\\work\\repo\\" 本來就擋，改法不能讓它變放行', () =>
    assertBlocked(ps('git -C "C:\\work\\repo\\" push --force'), 'ps quoted -C push --force'));
  test('Bash：git -C `pwd` push --force 要擋（反引號命令替換不是跳脫字元，收尾反引號不能吃掉空白）', () =>
    assertBlocked(bash('git -C `pwd` push --force'), 'bash -C `pwd` push --force'));
});

describe('第二輪 should-fix——病態輸入（同段大量 git 字樣）不能逼近逾時', () => {
  test("'git '.repeat(25000) 要在 3 秒內判完", () => {
    const t0 = Date.now();
    gitGuardrailCheck(bash('git '.repeat(25000)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回 O(n²)`);
  });
});

// 病態輸入不能逼近 hook 逾時：不用精確計時斷言（機器快慢會飄），只給寬鬆上限 3 秒。另外兩種形狀：
// 旗標階段反覆出現 `-C git`、有規則的子命令反覆出現 `git branch (`。
describe('第二輪 should-fix——病態輸入的另外兩種形狀（-C git／有規則子命令反覆開括號）不能逼近逾時', () => {
  test("'git -C '.repeat(8000)（旗標階段反覆出現 git）要在 3 秒內判完", () => {
    const t0 = Date.now();
    gitGuardrailCheck(bash('git -C '.repeat(8000)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回 O(n²)`);
  });
  test("'git branch ( '.repeat(8000)（有規則子命令反覆把 rest 收到段尾）要在 3 秒內判完", () => {
    const t0 = Date.now();
    gitGuardrailCheck(bash('git branch ( '.repeat(8000)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回 O(n²)`);
  });
  test("'$(git branch -a '.repeat(8000)（段內大量命令替換裡的 git）要在 3 秒內判完", () => {
    const t0 = Date.now();
    gitGuardrailCheck(bash('$(git branch -a '.repeat(8000)));
    assert.ok(Date.now() - t0 < 3000, `耗時 ${Date.now() - t0}ms，疑似退回 O(n²)`);
  });
});
