#!/usr/bin/env node
// build-index.mjs — 掃 design-systems/<slug>/DESIGN.md 生分類 index.md（flow-spec lazy 選品牌用）。
// 可重跑：新增/移除品牌資料夾後再跑一次即更新索引。提取規則對齊 open-design 的 legacy file shape：
//   第一個 H1 = picker 標題（去 "Design System Inspired by " boilerplate 前綴）；其後 `> Category: X` 行 = 分組；再下一個 `> ...` 行 = 一句風格描述。
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = /^Design System Inspired by /i;

const entries = [];
for (const name of readdirSync(ROOT)) {
  if (name.startsWith('_') || name.startsWith('.')) continue; // 跳 _schema 等
  let st; try { st = statSync(path.join(ROOT, name)); } catch { continue; }
  if (!st.isDirectory()) continue;
  const dm = path.join(ROOT, name, 'DESIGN.md');
  if (!existsSync(dm)) continue;
  const lines = readFileSync(dm, 'utf8').split(/\r?\n/);
  let title = name, category = 'Other', desc = '';
  const h1 = lines.find((l) => l.startsWith('# '));
  if (h1) title = h1.slice(2).replace(PREFIX, '').trim();
  const cat = lines.find((l) => /^>\s*Category:/i.test(l));
  if (cat) {
    category = cat.replace(/^>\s*Category:\s*/i, '').trim();
    const next = lines[lines.indexOf(cat) + 1];
    if (next && /^>\s*/.test(next) && !/^>\s*Category:/i.test(next)) desc = next.replace(/^>\s*/, '').trim();
  }
  entries.push({ slug: name, title, category, desc });
}

const byCat = new Map();
for (const e of entries.sort((a, b) => a.slug.localeCompare(b.slug))) {
  if (!byCat.has(e.category)) byCat.set(e.category, []);
  byCat.get(e.category).push(e);
}

const out = [];
out.push('# Flow 內建品牌設計系統索引（lazy 選取用）');
out.push('');
out.push(`> 共 **${entries.length} 套**，取自 open-design（Apache-2.0；來源與「非官方品牌資產」聲明見 \`NOTICE.md\`）。`);
out.push('> `/flow-spec` UI 階段讓使用者選一個當基底，**只讀選中那套**的 `<slug>/DESIGN.md`（9 段規範）+ `tokens.css`（CSS 變數）注入 ui-ux-pro-max——context 零負擔。');
out.push('');
for (const c of [...byCat.keys()].sort()) {
  out.push(`## ${c}`);
  out.push('');
  out.push('| slug | 風格 |');
  out.push('|---|---|');
  for (const e of byCat.get(c)) out.push(`| \`${e.slug}\` | ${e.title}${e.desc ? ' — ' + e.desc : ''} |`);
  out.push('');
}
writeFileSync(path.join(ROOT, 'index.md'), out.join('\n'), 'utf8');
console.log(`✓ index.md：${entries.length} 套、${byCat.size} 類`);
