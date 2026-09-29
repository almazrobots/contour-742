#!/usr/bin/env node
// Вёрстка ТЗ с координатами — для «Детальной трассы»: страница → строки → слова с рамками в пунктах PDF.
// Источник — текстовый слой PDF (pdftotext -bbox-layout). Картинки страниц не нужны: страница собирается
// из слов на исходных местах, а PDF ТЗ так и остаётся вне git. Результат — data/seed/tz-layout.json.
//   node scripts/tz-layout.mjs [путь к PDF]
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pdf = process.argv[2] ?? join(root, "ТЗ/10. Мосстройнадзор.pdf");
if (!existsSync(pdf)) {
  console.error(`Нет PDF ТЗ: ${pdf} — пропускаю, остаётся прежний data/seed/tz-layout.json`);
  process.exit(0);
}
const xml = execFileSync("pdftotext", ["-bbox-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const r1 = (x) => Math.round(Number(x) * 10) / 10;

const pages = [];
for (const [, w, h, body] of xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
  const lines = [];
  let block = 0;
  for (const [, bbody] of body.matchAll(/<block [^>]*>([\s\S]*?)<\/block>/g)) {
    block++;
    for (const [, x0, y0, x1, y1, lbody] of bbody.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
      const words = [...lbody.matchAll(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([\s\S]*?)<\/word>/g)].map(([, a, b, t]) => [r1(a), r1(b), unesc(t)]);
      lines.push({ b: block, x0: r1(x0), y0: r1(y0), x1: r1(x1), y1: r1(y1), w: words });
    }
  }
  // номер страницы внизу — служебная строка, не содержание ТЗ
  const last = lines.at(-1);
  const printed = last && last.w.length === 1 && /^\d{1,2}$/.test(last.w[0][2]) && last.y0 > Number(h) * 0.9 ? Number(lines.pop().w[0][2]) : null;
  pages.push({ page: pages.length + 1, printed, w: r1(w), h: r1(h), lines });
}
writeFileSync(join(root, "data/seed/tz-layout.json"), JSON.stringify({ source: "ТЗ/10. Мосстройнадзор.pdf", pages }));
console.log(`Страниц: ${pages.length}; строк: ${pages.reduce((s, p) => s + p.lines.length, 0)}`);
