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
// 本檔是防模型手滑的護欄，不是 shell 解析器：切段與 token 化維持樸素寫法，新增的阻擋一律以「在既有
// token 上加規則」的方式補上，不追求對抗性寫法的完備。
// 判定是 gitGuardrailCheck(input) → { block, message }，由 gates/pre-tool-use.mjs import 呼叫。

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

// GUARD-07：整段是 `cmd /c "<指令>"` 包一層殼——取引號內容重新拆段判定（內容可能又是複合指令，故直接
// 呼叫 splitSegments；不求跳脫符號的完美還原，只求不因套一層殼就整段漏判），原段也照判。`bash`／`sh`／
// `zsh -c`（含 -lc、-l -c）、`powershell`／`pwsh -Command`／`-c`（可帶 -NoProfile 等旗標）同理，但只在引號
// 內容以 git 開頭時展開，免得把 echo 印出的字串當成 git 呼叫；複合指令裡的 git 段，外層樸素切段本來就切得出。
const SHELL_WRAPPER_RES = [
  /^\s*"?cmd(?:\.exe)?"?\s+\/c\s+(["'])([\s\S]*)\1\s*$/i,
  /^\s*(?:(?:ba|z)?sh|powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-\w*c(?:ommand)?\s+(["'])(\s*git\b[\s\S]*)\1\s*$/i,
];
function expandShellWrapper(segment) {
  const m = SHELL_WRAPPER_RES.map(re => segment.match(re)).find(Boolean);
  return m ? [segment, ...splitSegments(m[2])] : [segment];
}

function splitSegments(cmd) {
  const rough = cmd.split(/&&|\|\||;|\||\r?\n/);
  const out = [];
  for (const seg of rough) {
    for (const piece of splitOnBareAmpersand(seg)) out.push(...expandShellWrapper(piece));
  }
  return out;
}

// token 化：引號段整段當一個 token——處理 `-C "/my repo"` 這種帶空白的引號值不被拆散。
function tokenize(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}
const stripQuotes = t => t.replace(/^["']|["']$/g, '');
const GIT_RE = /(^|[\\/])git(\.exe)?$/i;
// 包在命令替換／子殼裡的 git（`echo $(git stash drop)`、`(cd x && git clean -fdx)`）也要判：Bash 認 $( 與
// 反引號、PowerShell 認 $( 與 @(，出現在段內哪裡都算；( 只認段首（子殼）。段中間的裸 ( 不算：heredoc
// 訊息內文「修正 (git branch -D x) 誤判」這類敘述不是呼叫。
function wrappedGitAt(t, k, ps) {
  const m = stripQuotes(t).match(ps ? /^((?:[$@]?\()+)(.*)$/ : /^((?:\$?\(|`)+)(.*)$/);
  return !!m && (k === 0 || /[$@`]/.test(m[1])) && GIT_RE.test(m[2]);
}
// 收尾字元 ) ` }：loose 模式剝掉 token 結尾的再判；兩種模式都丟掉空字串 token，以及沒加引號、只由收尾字元組成、
// 段內又有對應開頭字元（( {；Bash 反引號要成對）的 token，所以 `{ git branch }`、`(git branch )` 視同裸 git branch
// 放行：本檔唯一比舊寫法放寬的類別。沒有開頭字元或加了引號（Bash 的 `git branch }`、`git branch ")"`）照舊當分支名。
const trimClose = t => stripQuotes(t.replace(/[)`}]+$/, ''));
const parenDepth = t => (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
// 短旗標（可組合，如 -fd、-fu、-SW）是否含某個字元。
const hasShort = (rest, ch) => rest.split(/\s+/).some(t => new RegExp(`^-[A-Za-z]*${ch}[A-Za-z]*$`).test(t));

// GUARD-01：git global option 裡「值佔下一個 token」的旗標（-C <path>、-c <k=v>…；`--git-dir=<path>`
// 等 = 連寫形式是單一 token、走一般旗標跳過即可）。
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// 從 git token（toks[gi]）往後跳過**所有** global option（含帶值旗標的值 token），第一個非旗標 token 才是
// 子命令（GUARD-01：堵 `git -c k=v checkout -b`／`git --no-pager push --force`）；找不到回 null。非 loose 與
// 舊寫法相同（只多丟掉上述空字串 token 與 closer 認得的收尾字元 token）；loose 另把開了括號的值（-C $(git
// rev-parse …)、PowerShell -C (Split-Path $f -Parent)）跳到括號收齊（收不齊照一般寫法只跳一個值）。
function callFrom(toks, gi, loose, end, closer) {
  for (let i = gi + 1; i < end; i++) {
    const t = stripQuotes(toks[i]);
    if (t.startsWith('-')) {
      if (VALUE_FLAGS.has(t)) i += 1;
      let j = i, d = loose ? parenDepth(toks[i] || '') : 0;
      while (d > 0 && j + 1 < end) d += parenDepth(toks[++j]);
      if (d <= 0) i = j;
      continue;
    }
    const clean = loose ? trimClose : stripQuotes;
    return { sub: clean(toks[i]), rest: toks.slice(i + 1, end).filter(t => !closer.test(t)).map(clean).filter(Boolean).join(' ') };
  }
  return null;
}

// 一段命令要判的 git 呼叫：段內第一個不帶前綴的 git（舊寫法，參數看到段尾）＋每個命令替換／子殼裡的 git
// （參數只看到下一個 git 為止，病態輸入才維持線性），各用兩種模式判、任一個擋就擋。舊寫法那個呼叫永遠在列，
// 所以除了收尾字元類，新規則只會多擋；前提是判定不拋例外（呼叫端會 fail-open 整條放行），故取參數一律帶預設值。
function extractGitCalls(segment, ps) {
  // 段以 & 開頭（前面可能有空白）視為 PowerShell call operator 殘留，去掉後照常判。
  const leadTrimmed = segment.replace(/^\s+/, '');
  const seg = leadTrimmed.startsWith('&') ? leadTrimmed.slice(1) : segment;
  const toks = tokenize(seg), calls = [];
  const closer = new RegExp(`^[${seg.includes('(') ? ')' : ''}${seg.includes('{') ? '}' : ''}${!ps && /`[^`]*`/.test(seg) ? '`' : ''}]+$`);
  const add = (gi, end) => calls.push(callFrom(toks, gi, false, end, closer), callFrom(toks, gi, true, end, closer));
  const wrapped = toks.flatMap((t, k) => (wrappedGitAt(t, k, ps) ? [k] : []));
  const bare = toks.findIndex(t => GIT_RE.test(stripQuotes(t)));
  wrapped.forEach((gi, n) => add(gi, Math.min(wrapped[n + 1] ?? toks.length, bare > gi ? bare : toks.length)));
  if (bare >= 0) add(bare, toks.length);
  return calls.filter(Boolean);
}

// 只看「git 之後第一個非旗標 token」當子命令——不對整段命令字串做關鍵字掃描，避免 commit message 裡出現
// "checkout"/"branch" 這類字眼被誤判成子命令（例：git commit -m "checkout old approach" 不該被攔）。
// 誠實說明（Y5）：splitSegments 對整段命令做 &&/;/||/|/換行的樸素切割、不理解引號與 heredoc，所以 commit
// message／字串參數／heredoc 或 here-string 內文被切成獨立片段後，恰好含「git＋危險子命令」、$(git …)、段首
// (git …、Bash 反引號包住的 `git …`（markdown 行內碼）時，會被保守誤攔。這是刻意的 fail-safe 取捨（寧可
// 多攔一次要求確認，不可放過真的危險操作）；誤攔時逃生口 CONSTELLATION_GIT_OK=1 一樣放行。
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
      const first = (rest.match(/^\s*(\S+)/) || [, ''])[1];  // 引號值開頭帶空白（' x'）也不能拋例外
      if (!first.startsWith('-')) {
        // 第一個參數不是旗標 → `git branch <名稱>`，正在建分支。
        return BLOCK([
          'Constellation git 守門：擋下 `git branch <名稱>` —— 這是建立新分支。',
          `  ${HINT}`,
        ].join('\n'));
      }
      // 帶旗標：-D（強制刪除，大寫 D）算破壞性；-d/-m/--list/-a/-r/-v 等非建立用法放行。
      if (hasShort(rest, 'D')) {
        return BLOCK([
          'Constellation git 守門：擋下 `git branch -D` —— 強制刪除分支（破壞性，未合併的 commit 會直接丟失）。',
          `  ${HINT}`,
        ].join('\n'));
      }
      // GUARD-06：-f/--force（強制建立/移動 ref、或 --delete --force 冗長形強刪）同樣可能丟 commit。
      if (/(^|\s)--force\b/.test(rest) || hasShort(rest, 'f')) {
        return BLOCK([
          'Constellation git 守門：擋下 `git branch -f`/`--force` —— 強制移動/刪除 ref（破壞性，可能丟失 commit）。',
          `  ${HINT}`,
        ].join('\n'));
      }
      return null;
    }

    case 'push':
      // -f 可與其他短旗標合寫（-fu、-uf），含 f 就算強推。
      if (/(^|\s)--force(-with-lease)?(\s|=|$)/.test(rest) || hasShort(rest, 'f')) {
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
      // --delete／-d／以 : 開頭的 refspec 刪遠端分支；--mirror 讓遠端整份照本地覆寫（本地沒有的遠端分支會被刪）。
      if (/(^|\s)--(delete|mirror)\b/.test(rest) || hasShort(rest, 'd') || /(^|\s):\S/.test(rest)) {
        return BLOCK([
          'Constellation git 守門：擋下 `git push --delete`/`-d`/`:<分支>`/`--mirror` —— 會刪除遠端分支或讓遠端整份照本地覆寫。',
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
      const hasForce = /(^|\s)--force\b/.test(rest) || hasShort(rest, 'f');
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
      const hasWorktree = /(^|\s)--worktree\b/.test(rest) || hasShort(rest, 'W');
      const hasStaged = /(^|\s)--staged\b/.test(rest) || hasShort(rest, 'S');
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

  // 續行（Bash 行尾 \、PowerShell 行尾 `）接回同一行再切段判一次（原樣切段也照判），免得危險旗標被換行切走。
  const ps = tool === 'PowerShell';
  const joined = cmd.replace(ps ? /`\r?\n/g : /\\\r?\n/g, ' ');
  for (const segment of [...splitSegments(cmd), ...(joined === cmd ? [] : splitSegments(joined))]) {
    for (const call of extractGitCalls(segment, ps)) {
      const verdict = judgeSubcommand(call.sub, call.rest);
      if (verdict) return verdict;
    }
  }
  return PASS;
}
