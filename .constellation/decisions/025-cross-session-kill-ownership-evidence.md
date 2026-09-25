# 025 跨 session 誤殺 headless 瀏覽器：殺行程前改認三種歸屬證據，不做自動掃殺

背景：使用者反映機器上常看到殘留的 headless 瀏覽器行程，懷疑是決議 020 三層治理沒堵到的第四種洩漏。六路排查後推翻這個假設：**這台機器上的 Playwright 不會留下沒人管的瀏覽器**，看得到的「殘留」其實是別的 session 正在用的瀏覽器被誤殺。crm-system 一個 session 09-23 當天 3 次把 `chrome-headless-shell.exe` 當孤兒殺掉、共殺掉 4 組瀏覽器行程，實際上全是 AI_project_hub 另一個 session 正在跑的背景驗證：兩邊建立／啟動時間逐一吻合（台北時間 vs 對方 UTC 背景啟動）——20:33:04 對 12:32:59（`agent-a605315224437aa48`）、20:34:17 對 12:34:05~13（`agent-aa165ad640ba5e71a`）、20:42:36 對 12:42:30、20:50:38 對 12:50:34（後兩者皆同一 agent）；crm 每殺一次，對方立刻報 `Target page, context or browser has been closed`（crm 主線 12:39:52 殺 8 支 → 對方 12:40:27 C-37 失敗、12:41:21 B-19 失敗；crm 整合員 12:49:36 殺 4 支 → 12:50:12 B-32 失敗；12:55:11 殺 4 支 → 12:55:50 B-31 失敗），對方把這些中斷誤判成「記憶體尖峰」。crm 整合員自己兩次開頁（19:57、20:54）跑完其實零殘留，它回報的「`browser.close()` 仍殘留是 Windows 已知現象」是誤判——它殺的是別人的瀏覽器，不是自己沒收乾淨。同期 AI_project_hub 也殺過 crm 的出貨 runner 一次，兩天內跨 session 互殺 4 次，同一類錯誤：憑程式名／共用路徑片段／命令列相同去判定「這是孤兒」，沒有查證控制它的 node 是否還活著。持續造成傷害的源頭是 crm 記憶檔 `feedback-kill-orphan-processes.md`「09-23 新形狀」段與 T-133 的 brief，把「收工必殺帶 `ms-playwright` 的 `chrome-headless-shell`」寫成了規矩。

實測（Node 24.14、本機 Playwright）：
- node 自己起的**直接**子行程只要沒設 `detached`，父行程結束（正常結束、`taskkill /F` 不帶 `/T` 硬殺）系統就會連坐收掉，零殘留——但這個連坐只管直接子行程，隔一層 cmd 或 bash 就斷鏈。補測 5 種形狀（`taskkill /F` 不帶 `/T`）：`node→node` 殺父行程、子行程死；`node→node→node` 殺頂層、全部死；`node→cmd（shell:true，等於 npx／pnpm 的 .cmd 包殼）→node` 殺頂層，cmd 死但底下的 node 還活著；`node→cmd→node` 殺中間的 cmd，底下的 node 還活著；`node→Git Bash→node` 殺頂層，bash fork 出來的子行程和 node 都還活著。
- Playwright 原始碼（`playwright-core@1.61.1/lib/coreBundle.js`）在 Windows 上啟動瀏覽器用 `detached: process.platform !== "win32"`，即非 detached，且沒有另外包殼——它起瀏覽器是控制端 node 的**直接**子行程，走的正是會被系統連坐收掉那條路。但前提是控制它的那支 node 本身也是直接子行程；如果那支 node 是隔著 cmd／bash 掛上去的（例如 Claude Code 的 Bash 工具就是 `node→bash→node` 這個形狀），連坐鏈在更上層就已經斷了，這支 node 和它開的瀏覽器都可能是真孤兒。
- 用 crm-system 裝的 Playwright 實際起 headless 瀏覽器，分別以「硬殺**直接**控制它的 node」「正常 `browser.close()`」「腳本丟例外崩潰」三種方式收尾：主行程與 4 個子行程（gpu、utility、renderer 等）全部消失，三種情境皆零殘留——這三種驗證的都是「直接控制」的情況。
- 另實測 `TaskStop` 會收掉整棵行程樹（`node→node` 兩層全死），證據②可靠。
- 結論：瀏覽器跟著**直接**控制它的那支 node 一起死；看得到活著的 `chrome-headless-shell.exe`，只代表那支**直接控制它的 node** 還活著，那支 node 本身是自己的、別人的還是已經是孤兒，仍要照三種歸屬證據查——程式名相同從來不是孤兒的證據，但「連坐」也不是萬能的，中間隔了 cmd／bash 就會斷（真孤兒的歸屬一樣判不出來，見下面「決定 4」的適用範圍）。

決定：
1. **殺行程前的歸屬，只認三種證據**：①`serve.mjs` 登記過的 server，用 `stop` 收；②自己開的背景任務，用 `TaskStop` 收；③**自己這個 agent** 起的那支腳本——認的是起它時取的專屬檔名或當下記下的 PID，不是整個 session 共用的暫存路徑（同一個 session 裡平行派工的 worker 共用同一個 scratchpad，見決議 023，路徑本身分不出是哪個 agent；Codex 端因無 scratchpad，自寫驗證腳本改放命令列含 session id 的暫存目錄，例如 `%TEMP%\codex-<CODEX_SESSION_ID>\`，背景起的自己記下 PID）。殺之前先列候選清單，核對命令列含那支腳本的專屬檔名、建立時間晚於自己起它的時間、不是自己正在執行的那個殺指令 shell 本身，三者都對得上才殺。程式名、`ms-playwright` 路徑片段、命令列字串巧合相同、啟動時間早晚、記憶體高低、單獨的 session 暫存路徑（沒有專屬檔名或 PID 佐證），一律不算充分證據。
2. **瀏覽器不直接殺，殺直接控制它的那支腳本**：瀏覽器是控制端 node 的非 detached 子行程，那支 node 一收系統就連坐收掉瀏覽器，不必另外瞄準瀏覽器行程；但連坐只管**直接**子行程，中間隔一層 cmd／bash 就斷鏈（見上面實測），所以認的是「直接控制瀏覽器的那支 node」，不能隨便往上找一層就當成控制端。
3. **認不出是自己的就不殺**：不符合上面三種證據的行程（另一個 session 的驗證、另一個平行 worker 的驗證、使用者自己開的瀏覽器、瀏覽器 MCP 起的有頭 Chrome）一律彈窗問使用者，不得逕自當孤兒清掉。
4. **不做自動掃殺**（在 runner 或 SessionEnd 加一道「掃描 headless 瀏覽器」的機制）：直接控制瀏覽器的 node 只要跟瀏覽器同層（沒有中間 cmd／bash），死了就已經連坐收掉瀏覽器，這種情況做自動掃殺殺不到真孤兒，只是把「憑程式名判定」的誤殺自動化；中間隔層造成的真孤兒（`node→cmd/bash→node` 這個形狀）歸屬一樣判不出來——是不是自己的照樣得查三種證據，自動掃殺解不了這題。兩種情況都不做自動掃殺，改在收工紀律裡認證據。

原因：根因不是「洩漏」，是「誤殺」——crm 的收工紀律把「看到 `chrome-headless-shell` 就殺」寫成規矩，卻沒有查證那支瀏覽器是不是自己控制的，修法在條文層即可，不需要新機制、不需要新程式碼。另一個根因——Claude Code 自身記憶體壓力回收把 runner 砍掉——AI_project_hub 誤判為「記憶體尖峰」，Constellation 攔不到，也不建議關掉那個保護機制（保護的是整台機器）；能做的一樣是條文：資源緊張時只收自己的，別人的一律彈窗問，不因為誤以為是孤兒就跳過這道確認。

否決：
- **runner／SessionEnd 自動掃殺 headless 瀏覽器**（備案）：前置探測 `tasklist` 約 0.5～1.4 秒，只要機器上有 headless 瀏覽器就得再付一次 PowerShell 查行程約 3.5～8 秒；只要有別的 session 在跑 e2e，每次都得付這筆錢卻一支也殺不到（控制端多半還活著）；也接不上既有行程快照的時機——runner 的埠差集只在指令跑完後、且有候選時才查，`serve.mjs` 的 procSnapshot 只在本 session 有登記時才查，時機都對不上。違反 §0「機制省下的時間要超過它消耗的時間」與決議 020「只殺自己的」。
- **runner 呼叫一律加 `--cwd`**：會誘導比對命令列裡的專案路徑去殺，正是決議 020 已否決的做法；同一專案兩個 session 同時跑時仍分不出誰是誰。

證據：
- transcript：`…\AI-project-hub\0866f059-dd15-47a7-91c2-a969fde99ba6\subagents\workflows\wf_a7e39764-773\agent-a605315224437aa48.jsonl`、同目錄 `agent-aa165ad640ba5e71a.jsonl`、`…\crm-system-worktrees-round-0915\f932032b-e7dd-4539-9e7f-ca10c69cff12\subagents\agent-a0b82f20642a9909a.jsonl`。
- 本次調查全程沒有改動任何 repo 檔案；實驗僅在 scratchpad 起自己的行程，已複查零殘留、實驗腳本已刪除；調查當下機器上沒有需要處理的 headless 殘留。

後續（repo 外，待使用者核准，非本次落地範圍——**複審標記為未解決的缺口，不是可有可無的加分項**：條文這次只改了本 repo 內三處＋本檔，真正下令去殺的來源沒改；crm 每個新 session 開場就會載入下面兩份，`verification-playbook.md` 只在 build 階段才進 context，主線收工當下根本不在場，兩邊衝突時 agent 會照信任順位更高的全域規則走——不改這三處，同一種誤殺會重演）：
- crm-system 記憶檔 `feedback-kill-orphan-processes.md`「09-23 新形狀」段需改寫成「別碰，那多半是別的 session 正在用」；「09-22 反例」段「啟動時間早於本 session 才算別人的」也要一併改掉——那同樣是拿啟動時間判斷歸屬，跟本決議的三種證據互相矛盾。
- crm 整合員 brief 範本（T-133）刪掉「收工必殺帶 `ms-playwright` 的 `chrome-headless-shell`」。
- 全域 `~/.claude/CLAUDE.md`「可以直接殺」條的測試 runner 殘留一項，補上前提「父行程要實查已死；命令列、程式名相同、啟動時間早晚、CPU／記憶體高低都不算歸屬證據」。
- 這三處文字要先經使用者彈窗核准逐字內容才能落地——本決議的「一起處理」授權僅止於本 repo 內的條文修正，不涵蓋這三處全域／跨專案檔案的具體措辭。

流程提醒：本決議改動 `DESIGN.md` §6，依母本 `CLAUDE.md`「`DESIGN.md` 是憲法」，這段文字合併回主線前須經使用者核准；本次僅在獨立 worktree 完成修訂與回歸測試，未合併、未取得核准。
