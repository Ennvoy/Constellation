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
// 第四輪對抗複審 should-fix：SH_C_WRAPPER_RE 依鏡像原則同步 commit-gate.mjs 的擴充版——改前只認殼名
// 後面緊接 -c，`powershell -NoProfile -Command`（Windows 上呼叫工具幾乎都這樣寫）、`pwsh -NoLogo -c`、
// `bash -lc`／`bash -l -c` 這些包殼寫法都展不開，包在殼裡的危險子命令會漏判。
describe('git-guardrail：第四輪 should-fix——SH_C_WRAPPER_RE 同步擴充：更多殼層寫法要能精準展開', () => {
  test('powershell -NoProfile -Command "git reset --hard" 要擋', () =>
    assertBlocked(bash('powershell -NoProfile -Command "git reset --hard"'), 'powershell -NoProfile -Command'));
  test('pwsh -NoLogo -c "git reset --hard" 要擋', () =>
    assertBlocked(bash('pwsh -NoLogo -c "git reset --hard"'), 'pwsh -NoLogo -c'));
  test('bash -lc "git reset --hard" 要擋（合寫短旗標）', () =>
    assertBlocked(bash('bash -lc "git reset --hard"'), 'bash -lc'));
  test('bash -l -c "git reset --hard" 要擋（分寫旗標）', () =>
    assertBlocked(bash('bash -l -c "git reset --hard"'), 'bash -l -c'));
});

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

// 第二輪對抗複審 must-fix：引號／跳脫包住的字面括號（不是真的子殼收尾）被拆成孤立 `)` token，
// ambient 深度歸零時遇到就誤判成「收攏外層子殼」而提早收工，後面的 -b/--force 等旗標整個漏看。
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

// 第二輪對抗複審 must-fix：`=` 連寫的全域旗標（--git-dir=、--work-tree=…）碰到 $(...) 只把深度加一，
// 下一個字被誤判成子命令，真正的危險子命令（reset/push/clean…）反而落到 default 放行。
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

// 第二輪對抗複審 must-fix（skipFlagValue 空白值）＋ should-fix（同一缺口的更多寫法）：
// -C/--git-dir 的值若是「含空白的命令替換／子殼」（$(git rev-parse --show-toplevel)、
// (Split-Path $PWD) 這類最常見的慣用寫法），舊版只吃到第一個空白就停，值的殘餘字被誤判成子命令。
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

// 第二輪對抗複審 should-fix：續行寫法（bash `\`+換行、PowerShell 反引號+換行）不能把危險旗標切到
// 認不出來的下一段。
describe('第二輪 should-fix——續行寫法不能漏擋', () => {
  test('bash：push --force 用 \\ 續行要擋', () =>
    assertBlocked(bash('git push origin main \\\n  --force'), 'bash continuation push --force'));
  test('PowerShell：reset --hard 用反引號續行要擋', () =>
    assertBlocked(ps('git reset `\n  --hard'), 'ps continuation reset --hard'));
});

// 第二輪對抗複審 should-fix：PowerShell script block／雜湊表收尾的落單 `}` 不該被當成 git branch
// 的第一個參數而誤判成「建分支」。
describe('第二輪 should-fix——PowerShell script block 收尾的 } 不誤傷唯讀 git branch', () => {
  test('ForEach-Object { git -C $_.FullName branch } 要放行', () =>
    assertPassed(ps('Get-ChildItem -Directory | ForEach-Object { git -C $_.FullName branch }'), 'ForEach-Object { git branch }'));
  test('if (Test-Path .git) { git branch } 要放行', () =>
    assertPassed(ps('if (Test-Path .git) { git branch }'), 'if { git branch }'));
  test('& { git branch } 要放行', () => assertPassed(ps('& { git branch }'), '& { git branch }'));
});

// 第二輪對抗複審 should-fix：rest 以空字串 token 開頭時 `.match(...)[1]` 會拋例外，
// PreToolUse fail-open 反而放行破壞性操作。
describe('第二輪 should-fix——git branch 空字串 token 不能讓判斷式拋例外而放行', () => {
  test('git branch "" -D main 要擋（-D 強制刪除，不能因為前面有空字串就放行）', () =>
    assertBlocked(bash('git branch "" -D main'), 'branch "" -D main'));
});

// 第二輪對抗複審 should-fix：段內 git 字樣越多，舊寫法（每個 git token 重算括號深度＋收 rest 到段尾）
// 耗時呈平方成長，病態輸入會逼近 hook 逾時。這裡不用精確計時斷言（機器快慢會飄），只給一個寬鬆上限
// （3 秒）——舊版對這個輸入量級要 40 秒以上，新版應在幾十毫秒內完成，差距夠大不會誤判。
// 第三輪對抗複審 must-fix：tokenize 不分 shell 套同一套跳脫規則——PowerShell 裡反斜線是一般字元，
// 結尾反斜線＋空白（`..\`、`C:\work\repo\`，Tab 補完常見）會被誤判成「反斜線跳脫下一個字元」而把
// 空白吃掉，跟下一個子命令併成一個 token（子命令被當成 -C 的值吞掉）；bash 的反引號命令替換同理
// 被誤判成跳脫字元而不是定界符，收尾反引號＋空白也會把下一個字併進來。
describe('第三輪 must-fix——tokenize 的跳脫規則要分 shell：反斜線（PowerShell）／反引號（bash）不能誤判成跳脫字元', () => {
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

// 第二輪對抗複審 should-fix：上面那條病態輸入測試只量到「'git '.repeat()」這一種形狀，還有兩種形狀
// 仍是平方級（旗標階段反覆出現 `-C git`、有規則的子命令反覆出現 `git branch (`）——8000 次重複在改前
// 分別要 3.7 秒／11 秒，改後應在幾十毫秒內完成，差距夠大不會誤判。
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
});
