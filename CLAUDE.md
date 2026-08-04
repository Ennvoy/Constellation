# Constellation 母本

AI 開發工作流的單一源碼 repo：skill（`skills/`）＋閘門五件組（`gates/*.mjs`，無相依 Node script）＋一鍵部署（`install.ps1`）。以 junction 掛載到 `~/.claude/skills/` 與 `~/.codex/skills/`，改此處即時生效於雙 runtime。

- **`DESIGN.md` 是憲法**：任何機制修訂先改它、且須經使用者核准；skill 與閘門的行為都以它為準，文件間有出入時以它裁決。
- `.constellation/` 是本 repo 自身的工作流狀態（dogfood）：知識軌（CONTEXT.md＋decisions/）由 session 開場閘門自動注入；使用者拍板的取捨即時落 `decisions/NNN-slug.md`（背景＋決定＋原因＋證據）。
- 文件與程式註解一律繁體中文；每加一個機制前先問「它省下的時間有沒有超過它消耗的時間」（DESIGN.md §0）。
