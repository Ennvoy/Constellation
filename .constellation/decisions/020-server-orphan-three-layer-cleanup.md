# 020 殘留 server 三層治理：runner 血緣殺＋serve.mjs 記帳起停＋條文收尾

背景：使用者反映「驗證過程中有時候會殘留 server（port），一多就嚴重影響效能」。六路 workflow 調查（殘留鑑識／Playwright 生命週期實測／Windows 清理方案實測／條文缺口盤點／兩路反駁）確認三條洩漏源：①**主因**——agent 為了讓使用者走查畫面或餵下一張票的測試，手動背景起 server（`Start-Process -WindowStyle Hidden "cmd /c pnpm start > %TEMP%\prod-server-walkthrough2.log"`），流程被未回答的彈窗岔開、沒走到收尾（2026-09-02 port 3000 PID 29960 實錘：crm-system-worktrees/Function 的 session 10:05 起的，CIM 進程鏈＋log 檔建立時間＋session jsonl 逐字指令三方時間戳吻合；同 session 稍早成功收過兩次，證明會收、只是不在保證會執行的點上；crm 四張票寫「全程掛著手動 pnpm dev」、MAP.md 地雷段早已診斷「開發端重複開 dev server 囤積 idle 連線」拖垮資料庫）；②runner `spawnSync{shell:true}` 逾時只殺 cmd.exe 外殼，npx→playwright→webServer 孫進程鏈繼續跑（`start /b` 起 server 的指令還會讓 spawnSync 等 stdout handle 直到逾時）；③Playwright 主進程被粗暴殺（`taskkill /F` 不帶 `/T`、Ctrl+C、session 結束）時 webServer 100% 殘留，Windows 沒有連坐機制。殘留搭 `reuseExistingServer: !process.env.CI`（crm 本機恆 true、Playwright 只探測 URL 通不通、不驗是誰）會拿舊 build 跑 e2e 蓋出合格證據——是正確性問題，不只效能。

決定：三層全做。
①**runner**（`gates/verify-runner.mjs`）：改 `spawn`＋自管逾時＋`taskkill /PID <shell> /T /F` 殺整棵活樹為主線（對三層深樹、.bin shim、Electron 四進程樹實測有效）；埠差集補刀抓 shell 已退出的孤兒（`start /b`／`detached`），殺前比對進程 CreationDate 必須晚於本條指令開始、快照用 `netstat -ano` 含 IPv6、config 可設 `protectedPorts` 白名單、每次 reap 留 log；失敗路徑（斷路器 exit 2、一般 exit 1）所有出口先 reap 再退。
②**新增 `gates/serve.mjs`**：`start` 起 server 並登記 PID／埠／CreationDate／session 到 `.constellation/.servers.json`，`stop` 精準殺綁 socket 的進程（不是外殼），`list` 列現況；SessionEnd hook 自動收本 session 登記的；條文改「臨時 server 一律經它起」。只殺自己登記的、殺前比 CreationDate 防 pid 回收。
③**條文**：phase-design 5b 起 server 前查殘留、拍板後關掉並告知釋放哪個埠；verification-playbook 補「臨時起的 server 收工關掉並確認埠釋放」；ticket-template 補「這條指令需要 server」的寫法。
**否決**：埠差集單獨當主線（反駁實測：使用者在驗證窗口內重啟 dev server／開畫面會被誤殺、平行 session 互殺、pid 回收競態）；命令列含專案路徑掃殺（crm-system 前綴會殺到 crm-system-worktrees、分不出使用者 debug 用的 server、相對路徑指令全漏、CIM 掃描 3.3 秒）；Job Object（PowerShell 冷啟 2.5–4.2 秒、launcher 控制訊息污染 R1 簽章尾行）；任何自動殺「上一輪留下的」開場清掃（實測此刻就會點名使用者正在用的 3000）。

原因：主因的病灶是「起 server 的動作不在保證會執行的收尾點」，runner 怎麼改都管不到；記帳式起停把「起」與「收」綁在同一支工具、SessionEnd 兜底，只殺自己登記的、零猜測。runner 層是次因（逾時、粗暴中斷）的唯一機器保障。條文層是零成本的第一道。

證據：拍板脈絡＝彈窗「殘留網站」使用者選「三件都做（推薦）」（第一版提問術語密集被回「看不懂」，改白話場景版後拍板）。當時依據：workflow `wf_2a25023b-e8d` 六路報告——鑑識：PID 29960 祖先鏈 33164→29996→8740 存活、根 19900 已死，與 verify-runner／Playwright 進程樹零交集；pw-lab 四情境：正常結束釋放、逾時孫鏈續跑最終自清但時機不可控、`reuseExistingServer:true` 沿用舊 server 測試跑到舊 code、主進程被殺 100% 殘留（原始碼 `playwright-core/lib/coreBundle.js` launchProcess/killProcess 用 `taskkill /T /F` 但只在自己的 teardown 路徑）；taskC 四方案：`/T` 對活樹 100%、對孤兒 status=128 找不到處理程序；埠差集 combo 四情境乾淨、快照 88–529ms；命令列掃描前綴誤判實測 true；反駁實測：連坐殺／重啟殺／窗口內開畫面殺三條打掉「before 裡的就免疫」、Electron 四進程樹 `/T` 有效、IPv6 影子可抓、閒置 60 秒系統零新埠。

落地補記（三路實作各經兩輪對抗審查後）：
- 補刀第④道最終採**血緣判準**——候選沿 ParentProcessId 鏈須走得回本條指令的外殼 pid、每跳建立時間晚於指令開始（夾掉 pid 回收假鏈），取代第一版的「父進程已死」判準；後者實測仍會殺到別專案經 serve.mjs 起的 server 與別 session 的孤兒（跨專案假紅燈＋斷路器計數污染）。
- **覆蓋率誠實記錄**：血緣版對「外殼與中間層都已退出」的多層孤兒追不回（寧漏勿誤殺），而 Playwright 主進程被粗暴殺、agent 手動 Start-Process 起的 server 多屬此型——那一類的實際保障是 runner 逾時的 taskkill /T（活樹 100%）與 serve.mjs 記帳，補刀只罩得住 `start /b` 一層鏈與中間層仍活的多層鏈。
- 成本：候選為 0 時零 PowerShell（每條指令只多兩次 netstat，約 40–250ms）；候選非 0 時每條多付 2–20 秒（PowerShell 冷啟＋全機 CIM 進程表），只有會起 server 的指令才付。
- serve.mjs：reap 只碰本 session 的登記、整棵樹（含中間層）都死才刪登記、認不出 session 就不殺不刪；start 撞埠只回報不殺；殺前比對外殼與綁埠進程的建立時間。**subagent 經它起的登記記在 subagent 名下，主 session 的 SessionEnd 收不到**，靠 worker 自己 stop。
- 兩處失手供後人參考：埠差集補刀在調查期間真的殺過同機另一個 agent 的實驗 server（誤殺不是理論風險）；審查 agent 用命令列子字串過濾殺進程時把自己的 shell 一起殺了——殺進程的過濾條件永遠要先列清單再動手。
