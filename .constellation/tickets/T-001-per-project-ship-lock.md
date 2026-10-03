# T-001 出貨鎖改成每個專案一把
status: open
blocked-by:
zone: gates/lease.mjs, gates/verify-runner.mjs, gates/kill-guard.mjs, gates/test/**, DESIGN.md, README.md, skills/constellation/**, .constellation/**

## 目標（行為契約，禁寫實作內部路徑/程式碼片段——durability over precision）

出貨前的整套完整測試（`--scope ship`）的使用中燈，範圍從「整台機器一把」縮成「每個專案一把」：
- 兩個不同專案同時跑出貨全量時，彼此不排隊、各自開跑，只在開跑與紅燈收尾時看到一行「別人持有出貨鎖」的提醒；同一個專案（含同一個 repo 的其他工作區）同時跑出貨全量時，後到的排隊等先到的結束。
- 殺行程守門仍護著所有專案的出貨全量：不論有幾份登記，已死的登記或同 session 的登記都只跳過那一份、不讓整條殺行程指令提前放行；同 session 只有在自己的專案裡動手才放行。
- 只縮小鎖的範圍並修正守門，不新增機制、不新增設定欄位；決議 033 落檔、決議 026 與 032 檔頭加註被取代、各文件措辭與行為一致。

## 驗收條件（合成階段寫定，逐條可勾）
- [ ] 跨專案不等：A 專案的出貨鎖有人持有（行程活著）時，B 專案的 `--scope ship` 直接開跑、不印排隊訊息、不動 A 的登記，並印出別人持有的提醒；A 的登記在 B 跑完後仍在。
- [ ] 同專案才等：同專案（含同一個 repo 的另一個 worktree）有人持有時，後到的 `--scope ship` 排隊，逾時以代碼 3 結束；持有者正常跑完釋放時，後到者接手並印出「開跑」。
- [ ] 專案鍵：同一個 repo 的主工作樹與 worktree 同一把鍵；目錄連結（junction／symlink）與原路徑同一把鍵；不同 repo 不同鍵；登記寫在 `~/.constellation/leases/<鍵>/holder.json`；`lease.mjs list` 列出所有專案的登記，含舊版 `leases/machine/`。
- [ ] 提醒：出貨全量開跑時與紅燈收尾時、逐票驗證開跑時，只要別人持有出貨鎖就印一行提醒（含「先等對方結束再重跑一次判定」）；沒有別人持有時不印；舊版 `leases/machine/` 的登記也讀得到，但不讓新版排隊。
- [ ] 殺行程守門取聯集：一份已死登記＋一份別 session 活登記，殺活登記的行程仍擋；一份同 session 登記＋一份別 session 活登記，殺別人的仍擋；同 session 但 cwd 在另一個專案時仍擋，cwd 在同專案（含子目錄、同一個 repo 的另一個 worktree）時放行；新版讀得到舊 `leases/machine/` 登記（沒有專案鍵欄位）。
- [ ] 變異驗證：把迴圈裡「持有者已死」「同 session」兩處的跳過改回直接放行整條指令，以及其他關鍵改動（專案鍵、取聯集、舊目錄、提醒），對應的測試案例都會變紅（結果記在決議 033 證據）。
- [ ] 文件同步：決議 033 已落檔；決議 026、032 檔頭加註被取代、內文不改；`DESIGN.md`、`README.md`、`.constellation/CONTEXT.md`、`SKILL.md`、`phase-ship.md`、`verification-playbook.md`、`lease.mjs` 與 `kill-guard.mjs` 檔頭註解，凡提到機器鎖處都已改成同專案的出貨鎖，且與實作一致。
- [ ] 母本全部 gates 測試全綠；測試全程使用拋棄式假家目錄，沒有寫到真實的 `~/.constellation/leases/`（實跑前後逐項比對）。

## 決議記錄（實作期小事自決落此，可追溯）

## 驗證指令（可選；票級縮圈清單，weave 寫定——省略則 runner 跑 config 全量）
母本所有閘門的回歸測試，一條涵蓋全部：
- `node --test "gates/test/*.test.mjs"`

## 驗證證據（關票時由 runner 寫入：指令＋結果摘要＋時間）
