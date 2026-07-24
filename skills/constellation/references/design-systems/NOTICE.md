# 設計系統來源與授權（NOTICE）

本目錄 150 套品牌設計系統取自開源專案 **[nexu-io/open-design](https://github.com/nexu-io/open-design)**（Apache-2.0），打包進 Flow 供 `/flow-spec` UI 階段當品牌基底（lazy 載入，只讀選中的那一套）。

## 上游來源

- **產品系統**（`linear-app` / `stripe` / `vercel` / `notion` / `figma` …）← [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)（MIT, © VoltAgent contributors），經 [getdesign](https://www.npmjs.com/package/getdesign) npm 套件匯入。
- **design skills**（`glassmorphism` / `brutalism` / `bento` / `neumorphism` …）← [bergside/awesome-design-skills](https://github.com/bergside/awesome-design-skills)。
- **`kami`（紙）** ← [tw93/kami](https://github.com/tw93/kami)（MIT, © Tw93 and contributors）。
- **`cisco` / `webex`** 及 starter（`default` / `warm-editorial` / `atelier-zero`）為 open-design 手寫。

## ⚠️ 重要聲明

**這些設計系統是「美學靈感（aesthetic inspirations）」，並非所引用品牌的官方資產**，不代表 Linear / Stripe / Apple 等品牌的背書或授權。商用前請自行確認各品牌的商標與品牌使用規範。

## 每套內含

- `DESIGN.md` — 9 段式設計規範（色彩 / 排版 / 間距 / 佈局 / 元件 / 動效 / 語氣 / 品牌 / 反模式）
- `tokens.css` — 編譯好的 CSS 變數（可直接餵 Tailwind / mockup）
- `components.html` — 元件參考 fixture

分類索引見 `index.md`（由 `build-index.mjs` 生成，可重跑）。完整來源與重新同步方式見上游 open-design 的 `design-systems/README.md`。
