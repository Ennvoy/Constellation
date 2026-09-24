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
// 本檔邏輯抽成 gitGuardrailCheck(input) → { block, message }，供 pre-tool-use.mjs 動態 import 直接
// 呼叫（PreToolUse 路徑）；本檔不再保留獨立 main()，手動除錯改用 echo <json> | node pre-tool-use.mjs。

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 拍板後放行的逃生口指引，兩道規則的 BLOCK 訊息都附這句。
const HINT = '依使用者全域規則，開/切分支與破壞性 git 操作 SHALL 先用 AskUserQuestion 取得使用者明示同意；' +
  "取得同意後在命令中帶 CONSTELLATION_GIT_OK=1 重跑放行（bash：CONSTELLATION_GIT_OK=1 git …；PowerShell：$env:CONSTELLATION_GIT_OK='1'; git …）。";

// 組「擋下」訊息的共用樣板：what＝擋下的操作描述（含句尾｡），tips＝額外提示行（可 0～多行）。
// 所有規則訊息固定「Constellation git 守門：擋下 」開頭、HINT 收尾，抽出來後新規則不必再抄一次樣板。
function deny(what, ...tips) {
  return BLOCK([
    `Constellation git 守門：擋下 ${what}`,
    ...tips.map(t => `  ${t}`),
    `  ${HINT}`,
  ].join('\n'));
}

// 判斷 rest 裡是否有「含指定字元的短旗標組合」（例如 -f、-fd、-D、-anm）；ch 只傳單一字母，無注入疑慮。
function hasShort(rest, ch) {
  return rest.split(/\s+/).some(t => new RegExp(`^-[A-Za-z]*${ch}[A-Za-z]*$`).test(t));
}

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

// GUARD-08：`bash -c "<指令>"` / `sh -c '<指令>'` 包裹——比照 cmd /c，取引號內容遞迴當指令重新拆段
// 判定。不認 `-lc` 等其他旗標組合、也不展開 powershell -Command（同樣的包殼問題留給 commit-gate 的
// 檔頭誠實記錄：無對抗完備承諾，只求不因套一層殼就整段漏判）。
const SH_C_WRAPPER_RE = /^\s*(?:\/[\w.\/-]*\/)?(?:bash|sh)\s+-c\s+(["'])([\s\S]*)\1\s*$/i;
function expandShWrapper(segment) {
  const m = segment.match(SH_C_WRAPPER_RE);
  if (!m) return [segment];
  return splitSegments(m[2]);
}

// 對抗審查 should-fix：切段前先把續行拿掉——bash 的 `\`+換行、PowerShell 的反引號+換行都是續行
// 語法，樸素的換行切段會把續行後半段（常常就是 --force/--hard 這些旗標）切成不相干的下一段而漏判。
function stripContinuations(cmd, tool) {
  return tool === 'PowerShell' ? cmd.replace(/`\r?\n/g, ' ') : cmd.replace(/\\\r?\n/g, ' ');
}

function splitSegments(cmd) {
  const rough = cmd.split(/&&|\|\||;|\||\r?\n/);
  const out = [];
  for (const seg of rough) {
    for (const piece of splitOnBareAmpersand(seg)) {
      for (const expanded of expandCmdWrapper(piece)) out.push(...expandShWrapper(expanded));
    }
  }
  return out;
}

// token 化：引號段整段當一個 token——處理 `-C "/my repo"` 這種帶空白的引號值不被拆散。
// GUARD-09：`(`/`)` 各自獨立成一個 token（不併入一般 bareword）——`(cd sub && git clean -fdx)` 這種
// 括號子殼、`echo $(git stash drop)` 這種命令替換，樸素切段會把左右括號黏在鄰接字詞上（如 `-fdx)`），
// 讓子命令/旗標判斷失準；拆開後括號變成無害的孤立 token，git 呼叫本身照常被找到、旗標照常被判到。
// 對抗審查 must-fix：只有「真的獨立出現」的 `(`/`)` 才拆成孤立 token——被引號包住（`wt")"`）或跳脫
// （bash `wt\)`、PowerShell `` wt`) ``）的括號字面上是普通字元，不該被拆開變成假的子殼收尾括號，
// 否則 `git worktree add wt")" -b feat` 這種值裡剛好帶括號的路徑，會讓 -b/--force 等後續旗標整個
// 漏判。bareword 一律把「跳脫字元＋下一字」「引號段」「反引號段」當成連續內容吃掉，只有落單的
// `(`/`)` 才切開。
// P22-fix：額外記每個 token 在原字串裡的起訖位置（start/end）——判斷「這個 token 跟上一個 token 中間
// 有沒有空白」要靠位置，光看 token 陣列本身分不出來（見 skipFlagValue）。
// 第三輪對抗複審 must-fix：bareword 不能不分 shell 套同一套跳脫規則——反斜線跳脫是 bash 語意，
// 反引號跳脫是 PowerShell 語意，兩套混用時，PowerShell 路徑結尾的反斜線（`..\`、`C:\work\repo\`，
// Tab 補完常見）會被誤判成「反斜線跳脫下一個字元」，把結尾反斜線後面的空白吃掉，跟下一個字併成一個
// token（子命令被當成旗標值吞掉）；bash 的反引號命令替換同理會被誤判成跳脫字元而不是定界符。
// tool==='PowerShell' 時反斜線是一般字元（不跳脫，不吃空白）；否則（Bash）反引號是命令替換的定界符
// （`[^`]*` 整段當一個 token），反斜線才是跳脫字元，雙引號內另外允許 \" 跳脫（不提前收尾）。
function tokenize(segment, tool) {
  const re = tool === 'PowerShell'
    ? /(?:`.|"[^"]*"|'[^']*'|[^\s()`"'])+|[()]/g
    : /(?:\\.|"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\s()\\`"'])+|[()]/g;
  const out = [];
  let m;
  while ((m = re.exec(segment)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}
const stripQuotes = t => t.replace(/^["']|["']$/g, '');

// GUARD-01：git global option 裡「值佔下一個 token」的旗標（-C <path>、-c <k=v>…；`--git-dir=<path>`
// 等 = 連寫形式是單一 token、走一般旗標跳過即可）。
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// P22-fix：算每個 token 之前的括號巢狀深度，一次掃過整段預先算好（前綴陣列，O(n)）——舊寫法每個
// git token 各自從頭重算一次（O(n) × git token 數＝O(n²)），病態輸入（同一段裡塞幾萬個 git 字樣）
// 會逼近 hook 逾時（對抗審查 should-fix）。只數獨立的 `(`/`)` token（不含引號內或跳脫的括號——
// tokenize 已經不會把它們拆成獨立 token）。用來判斷後面收 rest 時，遇到的 `)` 是不是收攏「包住這個
// git 呼叫本身」的外層子殼／命令替換，而不是這個 git 呼叫自己參數裡開的括號。
function depthPrefix(toks) {
  const prefix = new Array(toks.length);
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    prefix[k] = depth;
    if (toks[k].text === '(') depth++;
    else if (toks[k].text === ')') depth = Math.max(0, depth - 1);
  }
  return prefix;
}

// P22-fix，對抗審查 must-fix 擴充：`-C`/`--git-dir` 這類帶值旗標的值，可能橫跨多個 token 且中間帶
// 空白——`$(pwd)`、`$(git rev-parse --show-toplevel)`、`(Split-Path $PWD)`、`(Get-Location).Path`
// 都是「一個值」，但 tokenize 會把 `$`、`(`、內容、`)`、緊跟的殘留字拆成獨立 token，命令替換/子殼
// 內部還常常帶空白（旗標、多個字）。判準改成：值裡一旦開了 `(`（不論是不是緊貼著），就依括號深度
// 一路吃到配對的 `)` 為止（可跨空白，因為這整段本來就是一個值）；深度歸零後再吃緊貼在後面的殘留字
// （沿用「token 之間沒有空白就算延續」判準）。mustGlue＝true 時，只有下一個 token緊貼著旗標本身
// （中間沒有空白）才當作延續值起頭，用於 `=` 連寫的全域旗標（`--git-dir=$(pwd)/.git`）：碰到 `(`
// 沒有 VALUE_FLAGS 那種「一定有值」的保證，只在確定黏在一起時才吃，不誤吃後面空白分隔的真子命令
// （如 `--no-pager push` 不該把 push 吃掉）。回傳吃完之後、下一個 token 的 index。
const isGitLikeText = text => /^git(\.exe)?$/i.test(stripQuotes(text)) || /[\\/]git(\.exe)?$/i.test(stripQuotes(text));

function skipFlagValue(toks, i, mustGlue) {
  let j = i + 1;
  if (j >= toks.length) return j;
  // 第三輪對抗複審 should-fix：值的第一個 token 若本身就是另一個 git 呼叫（病態輸入如
  // `'git -C '.repeat(n)` 反覆出現），不要吞成這個旗標的值——當這個旗標沒有值，讓外層迴圈之後輪到
  // 那個 git token 時自己處理，避免每個 git token 都把值掃到段尾造成 O(n²)。
  if (isGitLikeText(toks[j].text)) return j;
  if (mustGlue && toks[j].start !== toks[i].end) return j; // 沒有黏在旗標本身後面，不是延續值
  let end = toks[j].end;
  let depth = toks[j].text === '(' ? 1 : 0;
  j++;
  while (j < toks.length) {
    if (depth > 0) {
      // 值裡開了括號：不管有沒有空白，一路吃到配對的右括號為止。
      if (toks[j].text === '(') depth++;
      else if (toks[j].text === ')') depth--;
      end = toks[j].end;
      j++;
      continue;
    }
    if (toks[j].start !== end) break; // 深度歸零後，只吃緊貼著的殘留字
    if (toks[j].text === '(') { depth++; end = toks[j].end; j++; continue; }
    end = toks[j].end;
    j++;
  }
  return j;
}

// 有判斷規則的子命令集合——不在這個集合裡的（如 status／log／commit…）judgeSubcommand 一律回 null，
// 收 rest 對結果沒有任何影響，找到 sub 後可以直接收工，不必再把 rest 掃到段尾（對抗審查 should-fix：
// 病態輸入如 `'git '.repeat(25000)` 每個 git token 都會把 rest 收到段尾，O(n²)）。
const RULED_SUBCOMMANDS = new Set([
  'checkout', 'switch', 'branch', 'push', 'reset', 'clean',
  'restore', 'rebase', 'worktree', 'reflog', 'gc', 'stash',
]);

// 從一段命令找出**所有**git 呼叫（不只第一個——`GIT_DIR=$(git rev-parse --git-dir) git push --force`
// 這種前面子殼先取值、後面才是真正危險呼叫的寫法，只看第一個 git token 會漏掉後面那個）。每個 git
// token 各自往後找子命令：跳過**所有** global option（含帶值旗標的值，見 skipFlagValue）→
// 第一個非旗標 token 才是子命令。GUARD-01：堵 `git -c k=v checkout -b`／`git --no-pager push --force`
// 這類「前綴旗標讓第一 token 以 - 開頭而落 default 放行」的繞法。
// rest（子命令後的參數字串）用「這個 git token 出現時的括號巢狀深度」當底線：只收在同一層或更深處
// 新出現的內容，遇到會把深度收回底線以下的 `)`（代表收攏包住這個 git 呼叫本身的外層子殼／命令替換）
// 就停手不收——不這樣做，`(git branch) -match 'x'`、`for b in $(git branch); do …` 這種唯讀列分支
// 會把子殼的收尾括號當成 `git branch` 的第一個參數，誤判成「建立新分支」而擋下。
function extractGitCalls(segment, tool) {
  // 切出的段若以 & 開頭（前面可能有空白），視為 PowerShell call operator 殘留——去掉開頭的 &
  // 後照常判該段，不讓它干擾 git token 的定位。
  const leadTrimmed = segment.replace(/^\s+/, '');
  const seg = leadTrimmed.startsWith('&') ? leadTrimmed.slice(1) : segment;
  const toks = tokenize(seg, tool);
  const ambientOf = depthPrefix(toks); // 每個 token 之前的括號深度，一次算好（見 depthPrefix）
  const isGitTok = t => isGitLikeText(t.text);
  const calls = [];
  for (let gi = 0; gi < toks.length; gi++) {
    if (!isGitTok(toks[gi])) continue;
    const ambient = ambientOf[gi];
    let depth = ambient;
    let sub = null;
    const restToks = [];
    for (let i = gi + 1; i < toks.length; i++) {
      const raw = toks[i];
      // 第三輪對抗複審 should-fix：不論是在找子命令、還是在收 rest，遇到下一個 git 呼叫就收工——
      // 病態輸入（如 `'git branch ( '.repeat(n)`）每個 git 呼叫都把 rest 收到段尾會是 O(n²)；外層
      // 迴圈本來就會輪到那個 git token 自己處理，這裡不需要重複掃過。
      if (isGitTok(raw)) break;
      if (raw.text === '(') {
        depth++;
        if (sub !== null) restToks.push(raw.text);
        continue;
      }
      if (raw.text === ')') {
        if (depth <= ambient) break; // 收攏外層子殼的括號——這個 git 呼叫到此為止
        depth--;
        if (sub !== null) restToks.push(raw.text);
        continue;
      }
      // 對抗審查 should-fix：PowerShell script block／雜湊表收尾的落單 `}`，比照收攏外層子殼的
      // `)` 直接停手——`ForEach-Object { git branch }` 這種唯讀列分支，`}` 不是 git 的參數。
      if (raw.text === '}') break;
      if (sub === null) {
        const t = stripQuotes(raw.text);
        if (t.startsWith('-')) {
          // 對抗審查 must-fix：不再只認 VALUE_FLAGS 裡「空白分隔」的旗標——`=` 連寫的全域旗標
          // （--git-dir=$(pwd)/.git）值黏在旗標本身後面，也要用同一套括號深度規則跳過，否則
          // `(`/`pwd`/`)` 會被誤判成子命令與其參數。VALUE_FLAGS 是「一定有值」（空白分隔），
          // 其餘旗標只在值緊貼著旗標本身時才當作延續（mustGlue），不誤吃空白分隔的下一個真子命令
          // （如 `--no-pager push` 的 push 不該被吞）。
          i = skipFlagValue(toks, i, !VALUE_FLAGS.has(t)) - 1;
          continue;
        }
        sub = t;
        // 對抗審查 should-fix：不在判斷規則裡的子命令（status/log/commit…）收不收 rest 都不影響
        // 結果，直接收工，不必把 rest 一路掃到段尾（避免病態輸入 O(n²)，見 RULED_SUBCOMMANDS）。
        if (!RULED_SUBCOMMANDS.has(sub)) break;
        continue;
      }
      restToks.push(stripQuotes(raw.text));
    }
    if (sub !== null) calls.push({ sub, rest: restToks.join(' ') });
  }
  return calls;
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
      return deny(
        '`git checkout` —— 可能是切分支（新建或既有）或丟棄工作區變更，命令字串難以安全區分。',
        '只是想取消暫存（不動檔案內容）？用 `git restore --staged <path>`（本守門不攔）；還原檔案內容屬破壞性，同樣要先問。',
      );

    case 'switch':
      // `switch -c/-C`（建新分支）與裸 `switch <ref>`（切既有分支）都是「切分支」，一律攔。
      return deny('`git switch` —— 這是切分支操作（含 -c/-C 新建分支，或切到既有分支）。');

    case 'branch': {
      if (!rest) return null;                                // 裸 `git branch`（列表）→ 放行
      // 對抗審查 should-fix：rest 以空字串 token 開頭時（例如 `git branch "" -D main`）match 回傳
      // null，直接取 [1] 會拋例外——PreToolUse 依約定 fail-open，反而把這個破壞性操作放行。
      const first = (rest.trim().match(/^(\S+)/) || [, ''])[1];
      if (!first.startsWith('-')) {
        // 第一個參數不是旗標 → `git branch <名稱>`，正在建分支。
        return deny('`git branch <名稱>` —— 這是建立新分支。');
      }
      // 帶旗標：-D（強制刪除，大寫 D）算破壞性；-d/-m/--list/-a/-r/-v 等非建立用法放行。
      if (hasShort(rest, 'D')) {
        return deny('`git branch -D` —— 強制刪除分支（破壞性，未合併的 commit 會直接丟失）。');
      }
      // GUARD-06：-f/--force（強制建立/移動 ref、或 --delete --force 冗長形強刪）同樣可能丟 commit。
      if (/(^|\s)--force\b/.test(rest) || hasShort(rest, 'f')) {
        return deny('`git branch -f`/`--force` —— 強制移動/刪除 ref（破壞性，可能丟失 commit）。');
      }
      return null;
    }

    case 'push': {
      if (/(^|\s)--force(-with-lease)?(\s|=|$)/.test(rest) || hasShort(rest, 'f')) {
        return deny('`git push --force`/`-f`（含 --force-with-lease）—— 會覆寫遠端歷史，可能沖掉他人的 commit。');
      }
      // GUARD-02：refspec 的 `+` 前綴（git push origin +main / +src:dst）＝對該 ref 強推，與 --force 同等破壞力。
      if (/(^|\s)\+\S/.test(rest)) {
        return deny('`git push` 帶 `+<refspec>` —— refspec 的 + 前綴＝強推該 ref（等同 --force），會覆寫遠端歷史。');
      }
      // GUARD-10：刪遠端分支的三種寫法——長式 --delete、短式 -d（含旗標組合如 -df）、
      // 空 src 的 `:<ref>` refspec（`git push origin :feature-x`）——殺傷力等同強推，一律擋。
      if (/(^|\s)--delete\b/.test(rest) || hasShort(rest, 'd') || /(^|\s):\S/.test(rest)) {
        return deny('`git push --delete`/`-d`/`:<ref>` —— 會刪除遠端分支，不可逆。');
      }
      // GUARD-10：--mirror 用本地 refs 整個覆寫遠端（含刪除遠端獨有的分支/標籤），破壞力最大。
      if (/(^|\s)--mirror\b/.test(rest)) {
        return deny('`git push --mirror` —— 會用本地 refs 整個覆寫遠端（含刪除遠端獨有的分支/標籤）。');
      }
      return null;
    }

    case 'reset':
      if (/(^|\s)--hard\b/.test(rest)) {
        return deny('`git reset --hard` —— 會不可逆丟棄工作區與暫存區的未提交變更。');
      }
      return null;

    case 'clean': {
      // 短旗標可能組合（-fd、-fx、-dfx…），只要出現含小寫 f 的短旗標 token，或明式 --force，都算強制清除。
      if (/(^|\s)--force\b/.test(rest) || hasShort(rest, 'f')) {
        return deny('`git clean -f`（含 -fd/-fx 等組合）—— 會不可逆刪除未追蹤的檔案與目錄。');
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
      return deny(
        '`git restore` —— 會覆寫工作區檔案內容（未加 --staged，或帶 --worktree/-W 的用法不可逆）。',
        '只是想取消暫存？只帶 `--staged`（不加 --worktree）即放行。',
      );
    }

    case 'rebase':
      // --continue/--abort/--skip 是在收尾既有 rebase（使用者已經在流程中），裸 rebase（開新的
      // rebase，含互動式）才是需要先問過的高風險操作——會改寫既有 commit 歷史。
      if (/(^|\s)--(continue|abort|skip)\b/.test(rest)) return null;
      return deny(
        '裸 `git rebase` —— 會改寫既有 commit 歷史（互動式 rebase 尤其危險）。',
        '只是要收尾既有 rebase？用 `--continue`/`--abort`/`--skip`（本守門不攔）。',
      );

    case 'worktree': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok !== 'add') return null; // list/remove/prune/lock 等不在此規則範圍
      // 帶 -b/-B（明示建立新分支）比照「開分支」規則：先問過。
      if (/(^|\s)-[bB]\b/.test(rest)) {
        return deny('`git worktree add -b`/`-B` —— 這會建立新分支（比照開分支規則）。');
      }
      return null;
    }

    case 'reflog': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok === 'expire') {
        return deny('`git reflog expire` —— 會清除 reflog 紀錄，之後難以復原已捨棄的 commit。');
      }
      return null;
    }

    case 'gc':
      if (/(^|\s)--prune(\s|=|$)/.test(rest)) {
        return deny('`git gc --prune` —— 會立即清除已失去引用的物件，可能讓 reflog 復原路徑失效。');
      }
      return null;

    case 'stash': {
      const firstTok = (rest.match(/^(\S+)/) || [, ''])[1];
      if (firstTok === 'drop' || firstTok === 'clear') {
        return deny(`\`git stash ${firstTok}\` —— 會不可逆刪除 stash 內容。`);
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

  // 對抗審查 should-fix：續行先拿掉再切段（見 stripContinuations）——bash `\`+換行、PowerShell
  // 反引號+換行都是續行語法，續行後半段常常就是 --force/--hard 這些旗標，樸素換行切段會漏判。
  for (const segment of splitSegments(stripContinuations(cmd, tool))) {
    for (const call of extractGitCalls(segment, tool)) {
      const verdict = judgeSubcommand(call.sub, call.rest);
      if (verdict) return verdict;
    }
  }
  return PASS;
}
