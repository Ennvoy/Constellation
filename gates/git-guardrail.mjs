#!/usr/bin/env node
// gates/git-guardrail.mjs — Constellation git 危險指令守門（PreToolUse on Bash|PowerShell）。
// 從 Flow flow-git-guardrail.mjs 原封搬入並去 Flow 化（本檔邏輯本就與 Flow 無關——純 regex、零 fs、
// 不碰 .constellation/任何專案狀態，對任何專案都成立，是這五件閘門組裡唯一「專案無關」的一支）。
// 把使用者全域規則「開/切分支、破壞性 git 操作 SHALL 先問過我」從純散文自律升成確定性閘門：模型不能滑過。
// 逃生口：命令帶 CONSTELLATION_GIT_OK=1 賦值（使用者已經用 AskUserQuestion 明示同意後才重跑）→ 直接放行。
// 威脅模型（GUARD-05 澄清）：逃生口防「遺忘/意外」、不防對抗性模型——模型技術上可自帶 token，
// 本閘門的確定性在「預設攔下＋放行必在命令留 CONSTELLATION_GIT_OK 審計痕跡」這一層，不宣稱對抗完備。
// 誤攔權衡：寧可多攔一次要求確認（逃生口便宜），不可放過真的開分支/force push——判到危險子命令一律照攔，
// 不因解析不完美而放水；「裸 checkout 一律攔」「裸 switch 一律攔」正是這個 fail-safe 精神的直接體現。
import { pathToFileURL } from 'node:url';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 本檔邏輯抽成 gitGuardrailCheck(input) → { block, message }，供未來若把多支 PreToolUse 閘門合併成
// 單一 dispatcher 時直接 import 呼叫；也保留獨立 main() 讓本檔仍可單獨當 hook 跑（測試/相容）。
// **只有直接執行本檔時才掛 stdin/跑 main**——被其他程式 import 時不可自動跑，否則會搶先 exit 短路呼叫端。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return process.exit(0); }
    let r; try { r = gitGuardrailCheck(input); } catch { r = null; }   // fail-open
    if (r && r.block) { process.stderr.write(String(r.message || '') + '\n'); process.exit(2); }
    process.exit(0);
  });
}

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 拍板後放行的逃生口指引，兩道規則的 BLOCK 訊息都附這句。
const HINT = '依使用者全域規則，開/切分支與破壞性 git 操作 SHALL 先用 AskUserQuestion 取得使用者明示同意；' +
  "取得同意後在命令中帶 CONSTELLATION_GIT_OK=1 重跑放行（bash：CONSTELLATION_GIT_OK=1 git …；PowerShell：$env:CONSTELLATION_GIT_OK='1'; git …）。";

// 把 chain 命令（&&/;/||/|/換行，以及引號外、兩側有空白的單一 &）拆段，逐段找 git 呼叫——串接中段
// 出現的 git 子命令也要抓（例：`git add . && git checkout -b x` 第二段沒有 && 之前的內容干擾）。
//
// 單一 & 的判斷限定「引號外」且「左右緊鄰空白」，逐字元掃描、追蹤是否在引號內：這樣一方面能切開
// cmd.exe 風格的 `cmd1 & cmd2` 串接／POSIX shell 的背景執行 `cmd1 & cmd2`，另一方面不誤傷
// PowerShell call operator（`& "C:\Program Files\App\app.exe" arg`）——call operator 的 & 通常在
// 片段開頭、前面沒有空白字元（是整段第一個字元），不滿足「兩側都有空白」而不會被切開。
function splitOnBareAmpersand(segment) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '&' && segment[i + 1] !== '&' && segment[i - 1] !== '&') {
      const prevIsSpace = i > 0 && /\s/.test(segment[i - 1]);
      const nextIsSpace = i + 1 < segment.length && /\s/.test(segment[i + 1]);
      if (prevIsSpace && nextIsSpace) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// GUARD-07：`cmd /c "<指令>"` / `cmd.exe /c "<指令>"` 包裹——偵測到就取引號內容遞迴當指令重新
// 拆段判定（引號內可能又是複合指令，含 &&/;/| 等，故直接遞迴呼叫 splitSegments）。不支援跳脫符號的
// 完美還原，只求「引號內的內容會被當成指令重新掃過一次」，不因為套一層 cmd /c 殼就整段被漏判。
const CMD_C_WRAPPER_RE = /^\s*"?cmd(?:\.exe)?"?\s+\/c\s+(["'])([\s\S]*)\1\s*$/i;
function expandCmdWrapper(segment) {
  const m = segment.match(CMD_C_WRAPPER_RE);
  if (!m) return [segment];
  return splitSegments(m[2]);
}

function splitSegments(cmd) {
  const rough = cmd.split(/&&|\|\||;|\||\r?\n/);
  const out = [];
  for (const seg of rough) {
    for (const piece of splitOnBareAmpersand(seg)) out.push(...expandCmdWrapper(piece));
  }
  return out;
}

// token 化：引號段整段當一個 token——處理 `-C "/my repo"` 這種帶空白的引號值不被拆散。
function tokenize(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}
const stripQuotes = t => t.replace(/^["']|["']$/g, '');

// GUARD-01：git global option 裡「值佔下一個 token」的旗標（-C <path>、-c <k=v>…；`--git-dir=<path>`
// 等 = 連寫形式是單一 token、走一般旗標跳過即可）。
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// 從一段命令找出 git 呼叫：定位 git token → 跳過**所有** global option（含帶值旗標的值 token）→
// 第一個非旗標 token 才是子命令。GUARD-01：堵 `git -c k=v checkout -b`／`git --no-pager push --force`
// 這類「前綴旗標讓第一 token 以 - 開頭而落 default 放行」的繞法。找不到 git 呼叫/子命令回 null。
function extractGitCall(segment) {
  // 切出的段若以 & 開頭（前面可能有空白），視為 PowerShell call operator 殘留——去掉開頭的 &
  // 後照常判該段，不讓它干擾 git token 的定位。
  const leadTrimmed = segment.replace(/^\s+/, '');
  const seg = leadTrimmed.startsWith('&') ? leadTrimmed.slice(1) : segment;
  const toks = tokenize(seg);
  const gi = toks.findIndex(t => /^git(\.exe)?$/i.test(stripQuotes(t)) || /[\\/]git(\.exe)?$/i.test(stripQuotes(t)));
  if (gi < 0) return null;
  for (let i = gi + 1; i < toks.length; i++) {
    const t = stripQuotes(toks[i]);
    if (t.startsWith('-')) { if (VALUE_FLAGS.has(t)) i += 1; continue; }
    return { sub: t, rest: toks.slice(i + 1).map(stripQuotes).join(' ') };
  }
  return null;
}

// 只看「git 之後第一個非旗標 token」當子命令——不對整段命令字串做關鍵字掃描，避免 commit message 裡出現
// "checkout"/"branch" 這類字眼被誤判成子命令（例：git commit -m "checkout old approach" 不該被攔）。
// 誠實說明（Y5）：這道防護不是無懈可擊——splitSegments 對整段命令做 &&/;/||/|/換行的樸素切割，
// 並不理解引號，所以當 commit message／字串參數內含 `;` 或換行時，該訊息會被切成獨立片段，
// 若切出的片段恰好含 git 子命令關鍵字，會被保守誤攔。這是刻意的 fail-safe 取捨（寧可多攔一次
// 要求確認，不可放過真的危險操作），不是「不會誤判」的完美保證；誤攔時逃生口 CONSTELLATION_GIT_OK=1
// 一樣放行，行為不因此改變。
function judgeSubcommand(sub, rest) {
  switch (sub) {
    case 'checkout':
      // 裸 checkout 一律攔：可能是切既有分支、可能是 `checkout -b/-B` 建新分支、也可能是
      // `checkout .`/`checkout -- .` 這種破壞性丟棄整個工作區——三者從命令字串上難以安全區分，
      // 還原單一檔案這種正當用法也混在裡面，索性全攔、fail-safe。
      return BLOCK([
        'Constellation git 守門：擋下 `git checkout` —— 可能是切分支（新建或既有）或丟棄工作區變更，命令字串難以安全區分。',
        '  只是想取消暫存（不動檔案內容）？用 `git restore --staged <path>`（本守門不攔）；還原檔案內容屬破壞性，同樣要先問。',
        `  ${HINT}`,
      ].join('\n'));

    case 'switch':
      // `switch -c/-C`（建新分支）與裸 `switch <ref>`（切既有分支）都是「切分支」，一律攔。
      return BLOCK([
        'Constellation git 守門：擋下 `git switch` —— 這是切分支操作（含 -c/-C 新建分支，或切到既有分支）。',
        `  ${HINT}`,
      ].join('\n'));

    case 'branch': {
      if (!rest) return null;                                // 裸 `git branch`（列表）→ 放行
      const first = rest.match(/^(\S+)/)[1];
      if (!first.startsWith('-')) {
        // 第一個參數不是旗標 → `git branch <名稱>`，正在建分支。
        return BLOCK([
          'Constellation git 守門：擋下 `git branch <名稱>` —— 這是建立新分支。',
          `  ${HINT}`,
        ].join('\n'));
      }
      // 帶旗標：-D（強制刪除，大寫 D）算破壞性；-d/-m/--list/-a/-r/-v 等非建立用法放行。
      if (/(^|\s)-[A-Za-z]*D[A-Za-z]*(\s|$)/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git branch -D` —— 強制刪除分支（破壞性，未合併的 commit 會直接丟失）。',
          `  ${HINT}`,
        ].join('\n'));
      }
      // GUARD-06：-f/--force（強制建立/移動 ref、或 --delete --force 冗長形強刪）同樣可能丟 commit。
      if (/(^|\s)--force\b/.test(rest) || rest.split(/\s+/).some(t => /^-[A-Za-z]*f[A-Za-z]*$/.test(t))) {
        return BLOCK([
          'Constellation git 守門：擋下 `git branch -f`/`--force` —— 強制移動/刪除 ref（破壞性，可能丟失 commit）。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    case 'push':
      if (/(^|\s)--force(-with-lease)?(\s|=|$)/.test(rest) || /(^|\s)-f(\s|$)/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git push --force`/`-f`（含 --force-with-lease）—— 會覆寫遠端歷史，可能沖掉他人的 commit。',
          `  ${HINT}`,
        ].join('\n'));
      }
      // GUARD-02：refspec 的 `+` 前綴（git push origin +main / +src:dst）＝對該 ref 強推，與 --force 同等破壞力。
      if (/(^|\s)\+\S/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git push` 帶 `+<refspec>` —— refspec 的 + 前綴＝強推該 ref（等同 --force），會覆寫遠端歷史。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;

    case 'reset':
      if (/(^|\s)--hard\b/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git reset --hard` —— 會不可逆丟棄工作區與暫存區的未提交變更。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;

    case 'clean': {
      // 短旗標可能組合（-fd、-fx、-dfx…），只要出現含小寫 f 的短旗標 token，或明式 --force，都算強制清除。
      const hasForce = /(^|\s)--force\b/.test(rest) ||
        rest.split(/\s+/).some(t => /^-[A-Za-z]*f[A-Za-z]*$/.test(t));
      if (hasForce) {
        return BLOCK([
          'Constellation git 守門：擋下 `git clean -f`（含 -fd/-fx 等組合）—— 會不可逆刪除未追蹤的檔案與目錄。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    case 'restore': {
      // 只有「純 --staged（不含 --worktree）」才是安全的取消暫存操作、放行；一旦帶 --worktree
      // （長式 --worktree 或短式 -W，含旗標 bundle 如 -SW）就會覆寫工作區內容——即使同時帶了
      // --staged 也要攔，不能讓 --staged 的存在掩護 --worktree 的破壞性。
      const hasWorktree = /(^|\s)--worktree\b/.test(rest) ||
        rest.split(/\s+/).some(t => /^-[A-Za-z]*W[A-Za-z]*$/.test(t));
      const hasStaged = /(^|\s)--staged\b/.test(rest) ||
        rest.split(/\s+/).some(t => /^-[A-Za-z]*S[A-Za-z]*$/.test(t));
      if (hasStaged && !hasWorktree) return null;
      return BLOCK([
        'Constellation git 守門：擋下 `git restore` —— 會覆寫工作區檔案內容（未加 --staged，或帶 --worktree/-W 的用法不可逆）。',
        '  只是想取消暫存？只帶 `--staged`（不加 --worktree）即放行。',
        `  ${HINT}`,
      ].join('\n'));
    }

    case 'rebase':
      // --continue/--abort/--skip 是在收尾既有 rebase（使用者已經在流程中），裸 rebase（開新的
      // rebase，含互動式）才是需要先問過的高風險操作——會改寫既有 commit 歷史。
      if (/(^|\s)--(continue|abort|skip)\b/.test(rest)) return null;
      return BLOCK([
        'Constellation git 守門：擋下裸 `git rebase` —— 會改寫既有 commit 歷史（互動式 rebase 尤其危險）。',
        '  只是要收尾既有 rebase？用 `--continue`/`--abort`/`--skip`（本守門不攔）。',
        `  ${HINT}`,
      ].join('\n'));

    case 'worktree': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok !== 'add') return null; // list/remove/prune/lock 等不在此規則範圍
      // 帶 -b/-B（明示建立新分支）比照「開分支」規則：先問過。
      if (/(^|\s)-[bB]\b/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git worktree add -b`/`-B` —— 這會建立新分支（比照開分支規則）。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    case 'reflog': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok === 'expire') {
        return BLOCK([
          'Constellation git 守門：擋下 `git reflog expire` —— 會清除 reflog 紀錄，之後難以復原已捨棄的 commit。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    case 'gc':
      if (/(^|\s)--prune(\s|=|$)/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git gc --prune` —— 會立即清除已失去引用的物件，可能讓 reflog 復原路徑失效。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;

    case 'stash': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok === 'drop' || firstTok === 'clear') {
        return BLOCK([
          `Constellation git 守門：擋下 \`git stash ${firstTok}\` —— 會不可逆刪除 stash 內容。`,
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    default:
      return null;
  }
}

// 純判定（不碰 exit/stderr）。呼叫端負責 fail-open（try-catch）與輸出。
export function gitGuardrailCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return PASS;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cmd = String(ti.command ?? '');
  if (!cmd) return PASS;
  // GUARD-05：只認「賦值形式**且值明確為 1**」的逃生口（bash 前綴 CONSTELLATION_GIT_OK=1 …／
  // PowerShell $env:CONSTELLATION_GIT_OK='1'）——純子字串比對（不管值是什麼）會被 =0／空值／=true
  // 這類「看起來像設過但其實沒同意」的寫法誤放行；(?!\d) 排除 =10/=123 這種數字延伸不算 =1。
  const GIT_OK_BASH_RE = /(^|[\s;&(|])CONSTELLATION_GIT_OK=(['"]?)1\2(?!\d)/;
  const GIT_OK_PS_RE = /\$env:CONSTELLATION_GIT_OK\s*=\s*(['"]?)1\1(?!\d)/i;
  if (GIT_OK_BASH_RE.test(cmd) || GIT_OK_PS_RE.test(cmd)) return PASS;

  for (const segment of splitSegments(cmd)) {
    const call = extractGitCall(segment);
    if (!call) continue;
    const verdict = judgeSubcommand(call.sub, call.rest);
    if (verdict) return verdict;
  }
  return PASS;
}
