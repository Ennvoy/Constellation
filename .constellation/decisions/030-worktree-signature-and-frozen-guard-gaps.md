# 030 簽章與 worktree 脫鉤、凍結守衛補 Bash／PowerShell、commit 擋凍結名單縮水

背景：AI_project_hub 回報三個閘門缺陷。①決議 403：worker 把 main merge 進自己的 worktree 後，commit 守門對 8 張 done 票判簽章不符，逐位元組比對內容與 main 相同——簽章綁的是「worktree 自己的根目錄」，同一份票換個 worktree 驗就對不上。②決議 406 成因 A：凍結守衛只掛在 `Edit|Write`（`close-gate.mjs`），`Bash|PowerShell` 走的 `pre-tool-use.mjs` 完全不看凍結名單，經 shell 寫檔改到了凍結檔。③決議 406 成因 B：兩支平行分支合併 `design-frozen.json` 衝突時人工解錯，`frozen` 陣列少了一行，閘門 5 照「名單沒有就放行」，之後兩張票的編輯無聲通過。

決定（流程外小改動，使用者同意在獨立 worktree 修、測全綠才合回 main）：

1. **簽章綁主工作樹根**：`evidence.cjs` 新增 `signingRoot`——從 `.git` 檔（worktree）讀 `gitdir`、再讀 `commondir` 解出共用 `.git`，其上一層即主工作樹根；主工作樹本身就是自己。純讀檔、不叫 git，任何一步讀不到就退回原本的根。`verify-runner.mjs` 改用它簽；驗簽端同時接受「主工作樹根」與「呼叫端給的根」（舊算法），既有證據不失效。欄位與串接順序不變，跨專案重放照樣擋。
2. **凍結判定抽成 `gates/frozen-guard.mjs`**：`close-gate.mjs` 改 import 同一份；`pre-tool-use.mjs` 加第四道 `frozenShellCheck`，從 shell 指令挑出寫入目標（重導向、tee、sed／perl -i、Set-Content／Add-Content／Out-File／Clear-Content、cp／Copy-Item 目的地、mv／Move-Item／Rename-Item／rm／Remove-Item、git checkout／restore／rm／mv、dd of=，並追蹤 cd），只在目標真的解析到凍結名單裡的檔案時擋。排在四道最前面，訊息講明是凍結檔。hook 設定檔（`hooks.claude.json`／`hooks.codex.json`）不用改——兩邊的 `Bash|PowerShell` 本來就掛 `pre-tool-use.mjs`。
3. **commit 守門擋凍結名單縮水**：`commit-gate.mjs` 新增 `frozenShrinkReason`，PreToolUse 與 git 原生 pre-commit 兩條路都跑：staged 的 `design-frozen.json` 比 HEAD 少掉的每個 `frozen` 路徑，staged log 裡都要有這次新增（HEAD log 沒有）的對應 `unfreeze`，否則擋下並列出被刪的路徑。HEAD 沒有這個檔、整份移出（出貨歸檔）、任一版讀不到或解析失敗都放行。

原因：三項都是既有閘門職責的漏洞補齊，不是新閘門（同決議 027 下輪待辦抽屜守衛的定位）。簽章要防的是跨專案重放，同一個 repo 的不同 worktree 本來就該驗得過；凍結守衛的承諾是「定稿畫面不被無聲改掉」，只看工具名稱會被 shell 寫檔繞過；名單本身被合併弄壞時，編輯當下的守衛無從得知，只能在名單進歷史那一刻比對前後版本。

證據：
- AI_project_hub `.constellation/decisions/403-commander-rulings-t578-t558-t560-t552.md`（a）段：8 張 done 票內容與 main blob 逐位元組相同仍判簽章不符。
- AI_project_hub `.constellation/decisions/406-ratify-frozen-edits-without-log.md` 決定第 3 點：成因 A（`grep -n frozen gates/pre-tool-use.mjs` 0 命中）、成因 B（`git show 499e65d -- .constellation/design-frozen.json` 顯示 frozen 少一行、log 正確合併）。
- 回歸測試 `gates/test/worktree-frozen.test.mjs` 46 條：先寫再修，修前紅燈 28 條（簽章跨 worktree 3 條、shell 寫凍結檔 21 條、名單縮水 4 條；跨專案重放反例與唯讀／合法放行案本來就綠），修後全綠；全量 `node --test "gates/test/*.test.mjs"` 576 條全綠。

代價與限制（DESIGN.md §11 同步揭露）：
- shell 判斷是啟發式、只切一層，`node -e`／`python -c` 腳本寫檔、變數或萬用字元路徑、`git apply`／`stash`／`reset --hard`／`checkout -- .` 認不出，照舊放行；由出貨 Spec 軸解凍日誌核對兜底。
- 決議 030 之前在 worktree 內簽的舊證據，只在那個 worktree 驗得過；worker 本來就不跑正式 runner，影響很小，不為此列舉所有登記過的 worktree。
- 縮水守衛只攔會跑 pre-commit 的 commit；沒有衝突、git 自動完成的 merge 不跑，但那種合併也不會手改 `frozen`。
