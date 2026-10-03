## 2026-10-03 出貨鎖改成每個專案一把，只有同專案才排隊，並修正殺行程守門，決議 033（小流程，T-001）獨立審查：兩軸（規格、並行安全），阻擋級 2 條與建議級 6 條已全數結案；全量測試：`node --test "gates/test/*.test.mjs"` 610 tests / 94 suites，610 pass、0 fail

出貨前整套完整測試（`--scope ship`）的使用中燈，從「整台機器一把」縮成「每個專案一把」：不同專案同時出貨各自開跑、只提醒；同專案（含同一個 repo 的其他工作區）後到的排隊等先到的。殺行程守門仍護著所有專案的出貨全量，並修正兩個會讓整條殺行程指令提前放行的縫（持有者已死、同 session 兩種登記改成只跳過那一份；同 session 只有在自己的專案裡動手才放行；`evidence.cjs` 壞掉時守門仍擋）。不新增機制、不新增設定欄位；決議 033 落檔，決議 026、032 檔頭加註被取代，文件與檔頭註解措辭同步。併回主線前須先確認 `leases/machine/` 沒有活著的舊版持有者（過渡期前置條件，見決議 033）。歸檔：`.constellation/archive/2026-10-03-per-project-ship-lock/`。

## 2026-10-03 提速四件：整套測試只在頭尾跑、不等進行中的批次＋流程外入口判定的快速通道、盲點審阻擋級先過反駁員、出貨 Spec 軸改拿原文逐款對照、出貨 Standards 軸起點改用上輪出貨歸檔，決議 032（流程外，無票）驗證：純文件改動、未動程式碼，未跑測試；使用者看過：是；對抗驗證：有（審查 15 條＋複審 3 條）

## 2026-10-01 發現當場結案：下輪待辦只收使用者親口選「下輪做」、發現先分誰該決定、既有問題問「現在修／記進 MAP」、審查前移到 build 每批整合後、出貨離場加「所有發現已結案」，決議 031（流程外，無票）獨立審查：無（流程外免出貨審查）；全量測試：`node --test "gates/test/*.test.mjs"` 576 tests / 91 suites，576 pass、0 fail（純文件與閘門註解改動，無新增測試）

## 2026-10-01 簽章與 worktree 脫鉤、凍結守衛補 Bash／PowerShell、commit 擋凍結名單縮水，決議 030（流程外，無票）獨立審查：無（流程外免出貨審查）；全量測試：`node --test "gates/test/*.test.mjs"` 576 tests / 91 suites，576 pass、0 fail（新增 `gates/test/worktree-frozen.test.mjs` 46 條）

## 2026-09-25 修正孤兒行程歸屬證據（決議 025）的複審意見——收斂到 agent 級證據、修正連坐範圍、記歸屬證據詞條（流程外，無票）獨立審查：無（流程外免出貨審查；本輪內容即回應一次外部複審意見的修正）；全量測試：`node --test "gates/test/*.test.mjs"` 373 tests / 61 suites，373 pass、0 fail（純文件改動，無新增測試）

決議 025 訂出「殺行程前只認三種歸屬證據、不做自動掃殺」後，複審點出兩個必須修正：①第③種證據原本認「命令列含本 session 暫存路徑」，分不出同一個 session 裡平行派工的多個 worker，改成認「自己這個 agent 起的那支腳本」（專屬檔名或 PID），並補齊 Codex 端腳本放置位置；②repo 內條文改了，但真正下令去殺的來源（crm-system 記憶檔、全域 `~/.claude/CLAUDE.md`）沒有改，這部分需要使用者核准逐字文字，非本次落地範圍，已在決議 025「後續」段落標記為未解決缺口。另修正四項建議：瀏覽器連坐只管「直接」父子關係，隔一層 cmd／bash 會斷鏈（不再宣稱「幾乎不會有真孤兒」）；補上 Codex 端腳本放置路徑；訂正決議 025 背景段的事件次數與一處措辭；記 `.constellation/CONTEXT.md`「歸屬證據」詞條、本行流程外記錄。改動範圍：`DESIGN.md` §6、`skills/constellation/references/phase-build.md`、`skills/constellation/references/verification-playbook.md`、`.constellation/decisions/025-cross-session-kill-ownership-evidence.md`，均為文字修正，無程式碼改動。
