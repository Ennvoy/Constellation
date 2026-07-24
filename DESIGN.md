# Asteria Constellation — 設計藍圖

> 全新 AI 開發工作流，取代 Flow。把散落的需求星點連成完整星座。
> 本文件是訪談（2026-07-24）的合成產物，凍結前經使用者審閱定稿。

## 0. 一句話定位與設計目標

**訪談問到透 → UI 先定稿 → 拆票平行做 → 實跑驗證關票**。四個第一級設計目標（依優先序）：

1. **快**：儀式最少化、票平行生成、閘門只設在關鍵點。
2. **真**：驗證走真實鏈路（真點擊／真 API／真 DB），機器擋假完成，AI 的嘴不算數。
3. **可接續**：狀態全部外部化成檔案，換 session 讀檔即接手，不靠對話記憶。
4. **雙 runtime 真共用**：一份母本源碼，Claude Code 與 Codex 同時生效，改一次兩邊同步。

反教訓（來自 Flow 病理報告）：harness 本體 11,081 行、12 hooks、31 個 subcommand；13 天實際使用 verify 嘗試 315 次僅 9 次過關、spec-review 同一份需求跑 17–19 輪。**harness 本身不得成為工作量**——每加一個機制前先問：它省下的時間有沒有超過它消耗的時間。

## 1. 主幹流程（五步，依任務大小自動伸縮）

```
① 訪談 (grill)      批次彈窗問到 frontier 清空，決議即時落檔
② UI 定稿 (design)   Claude Code 生成多變體真元件 → Claude Design canvas 挑選微調 → 定稿即最終品
③ 合成拆票 (weave)   不再發問；把決議合成任務卡＋垂直拆票（含驗收條件、檔案界線）
④ 逐票實作 (build)   無依賴票平行 fan-out、序列整合；每票內部輕量：測試先行 → 實作 → 實跑驗證 → 關票
⑤ 出貨 (ship)       全量真鏈路驗證＋獨立兩軸審查（Standards / Spec 分開報告，不合併排名）
```

**大小分岔**：訪談收尾時 agent 依改動範圍估算（預計動幾個檔、有無新資料結構、跨不跨模組）提議走大流程或小流程，使用者一鍵拍板；拍板結果寫入固定決議檔 `decisions/grill-close.md`（記大小分岔＋是否需要 UI＋高風險標記——是否涉權限／金流／個資），此檔同時是機讀的「訪談已完成」標記——總控據此路由，**無此檔一律回到訪談增量重訪**，防止訪談中斷被誤判為已完成。
- **小流程**：③不拆多票——weave 直接產**單一任務卡**（本質是一張票，含驗收條件與 config.json 驗證設定），單線程做完＋實跑驗證，再走輕量⑤（驗證範圍即該卡全部驗收條件，兩軸審查照做）。
- **大流程**：完整五步。
- 是否需要②（UI 定稿）與大小流程**正交**：純後端／無 UI 任務跳過②，大小流程皆然。

## 2. 訪談機制（batch frontier，借鑑 batch-grill-me）

- 把待釐清範圍建成**設計樹**：每個決策的前置依賴＝其父決策。
- **Frontier**＝所有前置已拍板、可以問的題，決定出題順序；答案解鎖新題，依賴未拍板的題必須遞延。
- **提問形式（開放問題＝純文字一次一題，不用彈窗）**：

  > **Q：問題本身（白話，禁術語轟人）**
  > 1. 選項 A（推薦）— 一句話講後果與取捨
  > 2. 選項 B — 一句話講後果與取捨
  > 3. 選項 C — …（2–4 個選項）
  > 回數字選擇；回「ok」＝採推薦；或直接打自己的想法（自由回答隨時可推翻選項）。

  一則訊息只放一題、置於結尾醒目處。**封閉確認**（答案固定二三選一、點一下最快者：階段核准、偏離預設平行策略時的確認、破壞性操作同意）仍用 AskUserQuestion 彈窗。
- **鐵律**（沿用 grilling 家族）：
  - 每題附推薦答案（含理由與代價，白話、不用術語轟人）。
  - **事實不問人**：能讀檔、跑工具、查官方文件得到的答案，agent 自己查；只有真決策才問。
  - **frontier 清空前禁止動手實作**；清空後仍須使用者確認才進下一步。
- 訪談中的決議**即時落檔**（不批次）：詞彙進 CONTEXT.md、關鍵取捨進決策記錄（見 §4）。

**完整性三保險（避免「有東西沒談到」）**：
1. **frontier 清空才算完成**：設計樹每個分支走到底、沒有任何東西被默默假設；清空後仍須使用者明確確認才進下一步。
2. **收尾盲點掃描**：frontier 清空後，引擎自動以獨立視角掃設計樹（邊界情況、錯誤路徑、權限、資料生命週期、相依故障），掃出漏網即生成新題再問一輪，直到掃描零新發現。
3. **增量重訪**：訪談決議全落檔，任何時候可重開 `/grill`——既有決議視為已拍板節點、重算 frontier 只補問新增與遺漏，不重複問。（全落檔＝詞彙＋達門檻的決策；未達升格門檻的隨口偏好不落檔，重訪時可重問。）

**獨立入口**：`/grill` 採「殼＋引擎分離」——訪談引擎可被主流程呼叫，也可由使用者單獨呼叫，對任何想法／決定做拷問（不限開發任務）。

## 3. UI 產線（Code 先行＋canvas 定稿）

解決的根本問題：mockup 與成品不符。做法是**讓定稿物就是最終品**——定稿的是真元件真 code，不是圖。

1. 訪談定版後，Claude Code 直接在專案 repo 生成 UI：**預設 3 個結構上不同的風格變體**（上限 5），優先掛在既有頁面用 `?variant=` 參數切換（空白路由是真空環境，會讓每個變體都顯得好看）；變體起點從 150 套品牌設計系統資產庫挑基底（沿用使用者既有偏好，資產庫自 flow-toolkit 原封搬入），三個變體共用同一套品牌基底——隔離結構變因，避免把風格差異誤當結構差異。
2. 變體 push 上 Claude Design canvas（DesignSync 工具），使用者視覺化挑選＋手動微調。
3. 定稿 pull 回 repo——**這些元件直接進入實作，不重畫**。後續拆出的每張票都對著定稿 UI 開發。
4. **降級路徑**：Claude Design 不可用（離線／額度／Codex runtime）時退化為純本地變體走查（瀏覽器開 `?variant=` 切換），流程其餘不變。

## 4. 真相載體（換 session 接續的持久狀態）

每個專案 repo 內一個 `.constellation/` 目錄，兩軌：

**工作軌——票（tickets/）**：一票一 markdown 檔。票模板：

```markdown
# T-003 <票名，用名字不用裸編號溝通>
status: open | in-progress | blocked | done
blocked-by: T-001            # 依賴關係
zone: src/auth/**, tests/auth/**   # 檔案界線（平行時互斥用）

## 目標（行為契約，禁寫實作內部路徑/程式碼片段——durability over precision）
## 驗收條件（合成階段寫定，逐條可勾）
- [ ] ...實跑可驗證的條件...
## 決議記錄（實作期小事自決落此，可追溯）
## 驗證證據（關票時由 runner 寫入：指令＋結果摘要＋時間）
```

**知識軌——CONTEXT.md ＋ decisions/**：
- `CONTEXT.md`：專案領域詞彙表。只收本專案特有詞（通用程式概念不收）；每詞 1–2 句；同義詞選一個定案、其餘列為 avoid。
- `decisions/NNN-slug.md`：極簡決策記錄（1–3 句：背景＋決定＋原因）。只在三條件同時成立才寫：難以逆轉＋沒背景會讓人驚訝＋真的經過權衡。過時用 `superseded by NNN` 標記，不刪除。

另有 **`config.json`**：該專案的驗證指令設定（`commands.test`＝逐票快速套件、`commands.journey`＝全量 journey），weave 階段生成、驗證 runner 讀取。

**接續**：新 session 開場由 session-start 閘門自動注入「有哪些票、各自狀態、進行中的做到哪」（含驗證 runner 的絕對路徑）。中斷即中斷，讀檔即接手。

## 5. 閘門五件組（確定性檢查點，全部小而專）

| # | 閘門 | 觸發 | 職責 |
|---|------|------|------|
| 1 | git 守門 | hook | 擋破壞性 git 操作與未經確認的開/切分支（自 Flow 原封搬入） |
| 2 | commit 守門 | hook | commit 前掃 secrets／垃圾產物（自 Flow 原封搬入） |
| 3 | session 開場注入 | hook | 從 `.constellation/` 重建現況並注入開場 |
| 4 | 驗證 runner | script | 實跑驗證（`--scope` 分逐票／出貨兩級），pass 證據附簽章寫入票 |
| 5 | 關票刷卡機 | hook | 票標 done 時機器驗證據簽章與新鮮度（24h），不過直接擋下 |

驗證證據由 runner 以本機 secret（install 時生成於使用者家目錄，不進 git）簽章、刷卡機驗簽——手填時間戳無法通過，「機器擋假完成」才真正成立。

原則：**每個閘門只在關鍵事件觸發，平時零開銷**。不設巨石 CLI；除此五件外，一切靠 skill 紀律，不加新硬閘（加閘門需回本文件修訂）。

## 6. 驗證（三道保險＋分級）

1. **測試先行（輕量 TDD）**：動手前先跟使用者確認過的 seam 上寫失敗測試，再實作轉綠。垂直切片（一測試→一實作），禁 tautological test（期望值與實作同算法）、禁 mock 冒充真依賴——真依賴未 ready 標 blocked。
2. **關票實跑**：真鏈路——涉 UI 用 Playwright 真點擊、涉 API 真打、涉資料真查 DB；資料類驗證走「真 create API seed → UI → 真 API → 真 DB 讀回」。證據落票，刷卡機把關。
3. **出貨獨立審**：ship 前另開乾淨 context 審一次，**兩軸平行、分開報告、不合併排名**：Standards 軸（code 品質，repo 規範優先、Fowler smells 為 baseline）＋ Spec 軸（與票的驗收條件逐條對照）。取代 Flow 的五層對抗。

**分級**：逐票跑 `commands.test`（快速套件）＋該票驗收條件的實跑檢查；`commands.journey`（全量 journey）留到 ship 一次跑齊——驗證 runner 以 `--scope ticket|ship` 區分兩級。審查產出固定三段報告（做了什麼／驗了什麼／證據在哪），發現分**阻擋級**（修完才出貨）與**建議級**。阻擋級修復後，除受影響範圍複驗綠燈外，並**針對該發現複審**確認修法成立（不重跑全量審查）。**涉權限／金流／個資的任務**（訪談收尾標記於 grill-close.md）兩軸自動加開第三軸——**security 紅軍**（獨立 context 以攻擊者視角實測攻擊面）；一般任務不加開，平時速度不變——審查跟著風險走，不跟著流程走。

## 7. 多工政策（票平行＋序列整合）

- 合成拆票時即劃定每票 `zone`（檔案界線），無依賴且 zone 不重疊的票**同批平行 fan-out**（Workflow 腳本，worker 用便宜模型）。
- 整合**一張張序列**：合併 → 跑該票驗證 → 關票 → 下一張。整合前檢查 worker 改動未越 zone。
- fan-out 僅三場景：①票平行實作 ②研究/盤點（背景跑不擋主線）③出貨獨立審。其餘一律主線直做。
- 明示代價：平行＝token 倍增；每批開工前正文一句告知本批平行張數。

## 8. 自駕程度（實作期）

- 訪談定版後實作期預設自駕：**小事自決**（命名、邊界處理細節）→ 記入票的「決議記錄」可追溯。
- **大事彈窗**（需求級分歧）：驗收條件矛盾／要動資料結構／涉權限、金流、個資 scope、破壞性 DB 操作 → 停下彈窗。
- 平行 worker 遇大事：該票標 blocked 留言，其餘票繼續，主線收集後統一彈窗。

## 9. 雙 runtime 真共用（Claude Code ✕ Codex）

> 已完成本機實測＋官方文件查證（2026-07-24，Codex CLI 0.145.0）。

**核心事實（查證＋紅軍實測確認）**：Codex 官方 skills 系統的 `SKILL.md` 格式與 Claude Code **核心相容**（同樣的 frontmatter `name`/`description` 必填）；Codex 個人全域路徑為 `~/.codex/skills/`；Windows junction 免管理員權限已本機實測成功；Codex hooks 事件名與 Claude Code 幾乎一一對應（SessionStart／PreToolUse／PostToolUse／Stop…），且經紅軍實測**兩邊 hooks schema 同構**（僅存放位置不同：settings.json vs ~/.codex/hooks.json）。Codex custom prompts 已被官方棄用、指名用 skills 取代。

**共用架構：單源母本＋junction 雙掛載＋觸發層各自適配**

- 母本 `Desktop\Constellation\skills\` 以 junction 同時掛到 `~/.claude/skills/` 與 `~/.codex/skills/`——兩邊 runtime 讀**同一份實體檔案**，改母本即時雙邊生效，零重複部署（字面意義的真共用；社群 vercel-labs/skills 已驗證此模式可行）。
- 每個 skill：一份 `SKILL.md` 主體（兩邊通用）＋ `agents/openai.yaml`（Codex 專屬外觀層，僅 display_name／short_description 兩欄，不含邏輯——照抄 mattpocock 慣例）。
- 閘門 script 本體（node `.mjs`）一份共用；觸發設定**分兩檔維護**：Claude Code 掛 `settings.json` hooks、Codex 掛 `~/.codex/hooks.json`——schema 同構故內容幾乎相同，仍分檔以備未來分岔；Codex 端 matcher 另需涵蓋其原生編輯工具 `apply_patch` 的輸入形狀（關票刷卡機已支援）。`install.ps1` 一次建好 junction＋雙邊觸發設定＋對賬檢查。
- 工作狀態天然共通：票與 CONTEXT.md 活在各專案 `.constellation/`，哪邊 runtime 接手都讀同一份。

**Codex 端降級表**（該端缺的工具，紀律不變、形式退化）：

| Claude Code 端 | Codex 端等效 |
|---|---|
| AskUserQuestion 彈窗訪談 | 文字批次問答（同 frontier 規則） |
| DesignSync／Claude Design canvas | 純本地變體瀏覽器走查 |
| Workflow 票平行編排 | Codex 自身並行或序列逐票 |

實務分工建議：訪談與 UI 定稿在 Claude Code 端做（工具全）；Codex 當第二實作／獨立審查 runtime。

**前車之鑑（本機實查）**：兩邊各自安裝的 `ui-ux-pro-max` skill 已經版本漂移（內容數字對不上）——正是「分開裝」的必然下場，junction 單源即根治此類漂移。

## 10. 母本 repo 結構（建置實況）

skill 入口收斂為兩個（總控＋獨立訪談），五步規則做成總控的 references 按需載入——入口越少、
觸發語彙越不打架，context 也不被常駐 description 吃掉。

```
Desktop\Constellation\
├── DESIGN.md              # 本文件（凍結後為憲法，修訂須經使用者）
├── README.md
├── skills/
│   ├── constellation/     # 總控：偵測 .constellation/ 現況、路由到對的一步
│   │   ├── SKILL.md ＋ agents/openai.yaml
│   │   └── references/    # phase-grill / phase-design / phase-weave / phase-build / phase-ship
│   │                      # ＋ ticket-template / verification-playbook / debugging-loop / merge-conflicts
│   │                      # ＋ design-systems/（150 套品牌資產庫，自 flow-toolkit 原封搬入）
│   └── grill/             # 獨立訪談入口（殼，引擎在 phase-grill.md）
│       └── SKILL.md ＋ agents/openai.yaml
├── gates/                 # 閘門五件組 .mjs ＋ hooks.claude.json / hooks.codex.json
└── install.ps1            # 一鍵部署：per-skill junction、掛雙邊 hooks、生成簽章 secret、對賬
```

## 11. 與舊 Flow 的關係

- **全新取代**。新流建好後新任務一律走 Constellation；Flow hooks 暫不拆，退役時機由使用者在新流跑順首個真實任務後拍板。
- 搬遷零件（血淚資產）：flow-git-guardrail、flow-commit-gate（→ 閘門 1、2）；session-start 重建思路（→ 閘門 3）；150 套 design-systems 資產庫（原封搬入）；另自 mattpocock 改寫除錯迴圈與衝突解法兩篇。EARS 語法不再沿用——票的驗收條件以「實跑可驗證」紀律取代結構化語法。
- 不搬：五階段儀式、SDD 三件套、31-subcommand 巨石 CLI、多層對抗審查、spec-review 收斂迴圈。

## 12. 建置計畫（藍圖核准後執行）

1. 母本骨架＋閘門五件組（先搬兩個血淚 hook，再寫 runner／刷卡機／session 注入）
2. `/constellation` 總控＋ grill skill（訪談引擎，本文件 §2 規則落地）
3. weave ＋ build skill（票模板、平行編排、整合序列）
4. design skill（DesignSync 接線＋降級路徑）＋ ship skill（兩軸審查）
5. install.ps1（junction 部署＋雙 runtime 對賬）
6. 以一個真實小任務跑通全流程 → 使用者驗收 → 決定 Flow 退役
