# Asteria Constellation

全新的 AI 開發工作流，取代 Flow。核心信念：**訪談問到透 → UI 先定稿 → 拆票平行做 → 實跑驗證關票**。
儀式最少化，閘門只設在關鍵點；狀態全部外部化成檔案（`.constellation/`），換 session 讀檔即接手，不靠對話記憶。
一份母本源碼，Claude Code 與 Codex 兩邊 runtime 同時生效，改一次兩邊同步。

## 目錄結構

```
Constellation/
├── DESIGN.md                    # 設計藍圖；凍結後即憲法，修訂須經使用者
├── skills/
│   ├── constellation/           # 總控：偵測 .constellation/ 現況，路由到對的步驟
│   │   ├── SKILL.md
│   │   ├── agents/openai.yaml   # Codex 外觀層
│   │   └── references/          # 按需載入，五步各一份規則檔
│   │       ├── phase-grill.md       # ① 訪談
│   │       ├── phase-design.md      # ② UI 定稿
│   │       ├── phase-weave.md       # ③ 合成拆票
│   │       ├── phase-build.md       # ④ 逐票實作
│   │       ├── phase-ship.md        # ⑤ 出貨
│   │       ├── ticket-template.md
│   │       ├── verification-playbook.md
│   │       ├── debugging-loop.md
│   │       ├── merge-conflicts.md
│   │       └── design-systems/      # 150 套品牌設計系統資產庫（索引 index.md）
│   └── grill/                   # 獨立訪談入口（殼＋引擎分離，可對任何想法拷問）
│       ├── SKILL.md
│       └── agents/openai.yaml
├── gates/                       # 閘門五件組：hooks 設定 + node scripts
│   ├── git-guardrail.mjs
│   ├── commit-gate.mjs
│   ├── session-start.mjs
│   ├── verify-runner.mjs
│   ├── close-gate.mjs
│   ├── hooks.claude.json        # Claude Code 端 hook 觸發設定
│   └── hooks.codex.json         # Codex 端 hook 觸發設定
├── install.ps1                  # 一鍵部署：建 junction、掛雙邊 hooks、對賬
└── README.md                    # 本檔
```

每個專案要用 Constellation 時，會在自己的 repo 裡建一個 `.constellation/` 工作目錄承載訪談決議與票的狀態：
`tickets/*.md`（票，模板與狀態機見 `DESIGN.md` §4）、`CONTEXT.md`＋`decisions/`（詞彙表與決策記錄，見 §4）、
`config.json`（驗證指令，形如 `{"commands": {"test": [...], "journey": [...]}}`，供閘門 4 驗證 runner 讀取；票清單經使用者核准後在此寫入 `"approved": true`）、
`ship-evidence.md`（出貨階段 `--scope ship` 全量驗證的簽章證據，閘門 4 寫入，見 §4／§6）、
`archive/`（出貨後把該輪 `tickets/`、`decisions/grill-close.md`、`ship-evidence.md` 歸檔到 `archive/<日期>-<摘要>/`，讓下一輪從乾淨狀態開始，見 §4）。

## 安裝

跑一次：

```powershell
./install.ps1
```

它做五件事：

1. **對 `skills/` 下每個 skill 各建三條 junction**：目前是 `constellation`、`grill` 兩個 skill，
   逐一各自建三條 junction，分別連到 `~/.claude/skills/<skill>`、`~/.codex/skills/<skill>` 與
   `~/.agents/skills/<skill>`（Codex 官方現行使用者層路徑，見 `DESIGN.md` §9）——不是把整個
   `skills/` 資料夾包成單一 junction。也就是共三組掛載點、每組各兩條（對應兩個 skill），一共六條
   junction。三邊 runtime 讀的是同一份實體檔案，不是各自複製一份。改母本任何一個 `SKILL.md` 或
   `references/`，Claude Code 與 Codex 立刻同步生效，不會有版本漂移的問題（Windows junction 免管理員
   權限，已本機實測成功）。
2. **掛雙邊 hooks**：閘門五件組的 node script 本體只有一份、兩邊共用；觸發設定分兩檔維護——
   Claude Code 用 `gates/hooks.claude.json` 接 `settings.json`，Codex 用 `gates/hooks.codex.json`
   接 `~/.codex/hooks.json`（經實測兩邊 hooks schema 同構，內容幾乎相同；分檔是為了 matcher 差異
   ——Codex 端要涵蓋 `apply_patch`——與未來可能的分岔）。**寫入設定不等於生效**：Codex 端還要使用者
   自己在 Codex 內跑一次 `/hooks` 審閱並信任這些 hook，設定才會真的啟用；install 的對賬步驟只會提醒
   這件事，實際執行 `/hooks` 需要使用者手動做。
3. **生成簽章 secret**：在使用者家目錄產生 `~/.constellation/secret`（不進 git，跨專案共用同一把）——
   驗證證據由 runner 用這把本機 secret 簽章、關票刷卡機驗簽（細節見 DESIGN.md §5）；已存在就不覆蓋，
   冪等，重跑安裝不會讓舊簽章失效。
4. **Codex hooks feature 檢查**：確認 Codex 端 hooks 功能有沒有開啟（近版預設開）；抓不到 `codex`
   指令或偵測不到 hooks 功能時，對賬報告只會提示、不會中止安裝，需要的話再自行到 Codex 端開啟。
5. **對賬檢查**：跑完後自動確認 junction 有沒有指到正確位置、兩邊 hooks 有沒有都掛上，
   避免「裝了但沒生效」的狀況。

## 與 Flow 共存注意

- Flow 退役前兩套 harness 並存：Flow 只對有 `.flow/` 的專案生效，Constellation 只認 `.constellation/`，互不干擾。
- git 守門的逃生口環境變數已改名：Flow 時代的 `FLOW_GIT_OK=1` 在 Constellation 的守門是 `CONSTELLATION_GIT_OK=1`。

## DESIGN.md 是憲法

本 repo 的一切實作以 `DESIGN.md` 為唯一依據。任何實作細節與 `DESIGN.md` 有出入時，
以 `DESIGN.md` 為準；真的需要偏離，先回頭修訂 `DESIGN.md` 並經使用者核准，不得自行擴充範圍。
