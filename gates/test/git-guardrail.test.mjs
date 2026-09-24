// gates/test/git-guardrail.test.mjs — P22 回歸表：git 守門既有規則不能退步 + 補上漏擋的強推／
// 刪遠端分支／包殼寫法。gitGuardrailCheck 是純函式（檔案頂部有 import.meta.url 守衛，被 import 時
// 不會自動掛 stdin），直接 import 呼叫最快，不必為這支閘門另外 spawn 子行程。
//
// 案例依 scratchpad/audit/report.md 的 ### P22 節：改法①（push 補強推／--delete／-d／:refspec／
// --mirror）、②（bash -c／sh -c／子殼／$(...) 展開檢查）。改法③（deny/hasShort 共用小 helper、304→265
// 行）是外觀重構、訊息逐字不變，不是可觀察的黑箱行為，這裡不測。
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

// 對抗審查 must-fix：`-C`/`--git-dir` 的值若是 $(...)／@(...)／(...) 這類子殼/命令替換展開後的多
// token 值，舊寫法只跳一個 token（GUARD-09 拆括號後連 `$` 都跳不過），值後面真正的子命令（push
// --force、reset --hard…）就落到 default 分支被放行。改法：值的 token 之間只要沒有空白就視為同一個
// 值的延續，一路吃到出現空白為止（見 git-guardrail.mjs 的 skipFlagValue）。
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

// 對抗審查 must-fix：段內只判第一個 git token，漏掉「前面子殼先取值、後面才是真正危險呼叫」的寫法。
describe('git-guardrail：對抗審查 must-fix——同段內第二個以後的 git 呼叫也要判', () => {
  test('GIT_DIR=$(git rev-parse --git-dir) git push --force 要擋（真正的 push 在後面）', () =>
    assertBlocked(bash('GIT_DIR=$(git rev-parse --git-dir) git push --force'), 'GIT_DIR=$(...) git push'));
  test('env X=$(git config user.name) git reset --hard 要擋（真正的 reset 在後面）', () =>
    assertBlocked(bash('env X=$(git config user.name) git reset --hard'), 'env X=$(...) git reset'));
});

// 對抗審查 should-fix：GUARD-09 拆括號後，子殼/命令替換裡的唯讀 `git branch`（列分支）會把外層子殼的
// 收尾括號黏進 rest，誤判成「git branch <名稱>＝建分支」而擋下。改法：rest 只收在「這個 git 呼叫出現
// 時的括號深度」或更深處新增的內容，遇到收攏到這個深度以下的 `)` 就停手（見 ambientDepthAt）。
describe('git-guardrail：對抗審查 should-fix——子殼裡唯讀的 git branch 不該被外層括號誤傷', () => {
  test('for b in $(git branch); do … 要放行（純列分支）', () =>
    assertPassed(bash('for b in $(git branch); do echo $b; done'), '$(git branch) in for'));
  test('PowerShell：(git branch) -match \'x\' 要放行（子殼輸出再比對，不是建分支）', () =>
    assertPassed(ps("(git branch) -match 'main'"), '(git branch) -match'));
  test('echo $(git branch) 要放行（既有案例，改法不能破壞）', () =>
    assertPassed(bash('echo $(git branch)'), 'echo $(git branch)'));
  test('(git branch --show-current) 要放行（既有案例，改法不能破壞）', () =>
    assertPassed(bash('(git branch --show-current)'), '(git branch --show-current)'));
});
