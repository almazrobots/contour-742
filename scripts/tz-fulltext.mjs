#!/usr/bin/env node
// Полный текст ТЗ посимвольно — для «Карты ТЗ»: страница → блоки (абзацы, строки таблиц, заголовки).
// Текст берётся из текстового слоя PDF (pdftotext -layout) без правок; блок = строки до пустой строки.
// Результат — data/seed/tz-fulltext.json (PDF ТЗ лежит вне git).
//   node scripts/tz-fulltext.mjs [путь к PDF]
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pdf = process.argv[2] ?? join(root, "ТЗ/10. Мосстройнадзор.pdf");
if (!existsSync(pdf)) {
  console.error(`Нет PDF ТЗ: ${pdf} — пропускаю, остаётся прежний data/seed/tz-fulltext.json`);
  process.exit(0);
}
const raw = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
const HEADING = /^\d{1,2}(\.\d{1,2}){0,2}\.\s+[А-ЯA-Z]/;
const pages = raw.split("\f").filter((p, i, a) => p.trim() || i < a.length - 1);

const out = [];
let n = 0;
pages.forEach((page, pi) => {
  const lines = page.split("\n").map((l) => l.replace(/\s+$/, ""));
  // номер страницы внизу — служебная строка, не содержание ТЗ
  while (lines.length && /^\s*$/.test(lines.at(-1))) lines.pop();
  if (lines.length && /^\s*\d{1,2}\s*$/.test(lines.at(-1))) lines.pop();
  const blocks = [];
  if (!lines.some((l) => l.trim())) blocks.push({ n: ++n, kind: "empty", text: "" });
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const indent = Math.min(...cur.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    const text = cur.map((l) => l.slice(indent)).join("\n");
    const first = text.trim().split("\n")[0].trim();
    // таблица: в строке несколько колонок, разделённых широкими пробелами
    const colsLines = cur.filter((l) => /\S\s{3,}\S/.test(l.trim())).length;
    const kind = HEADING.test(first) && first.length < 110 && cur.length === 1 && !/[.:;]$/.test(first) ? "heading" : colsLines >= Math.max(2, cur.length / 3) ? "table" : "prose";
    blocks.push({ n: ++n, kind, text });
    cur = [];
  };
  // начало абзаца прозы: отступ первой строки, маркер списка или номер пункта (в вёрстке PDF пустых строк между абзацами нет)
  const indentOf = (l) => l.match(/^ */)[0].length;
  const isTableLine = (l) => /\S\s{3,}\S/.test(l.trim());
  const starts = (l, prev) =>
    !isTableLine(l) && (/^\s*(•|–|-)\s/.test(l) || HEADING.test(l.trim()) || /^\s*\d{1,2}\.\s+[А-ЯA-Z]/.test(l) || (indentOf(l) >= 3 && indentOf(l) <= 12 && prev !== undefined && indentOf(prev) < 3 && !isTableLine(prev)));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { flush(); continue; }
    if (cur.length && !isTableLine(cur.at(-1)) && starts(l, cur.at(-1))) flush();
    cur.push(l);
  }
  flush();
  out.push({ page: pi + 1, blocks });
});
writeFileSync(join(root, "data/seed/tz-fulltext.json"), JSON.stringify(out, null, 1));
const all = out.flatMap((p) => p.blocks);
console.log(`Страниц: ${out.length}; блоков: ${all.length} (абзацев ${all.filter((b) => b.kind === "prose").length}, таблиц ${all.filter((b) => b.kind === "table").length}, заголовков ${all.filter((b) => b.kind === "heading").length}); символов: ${all.reduce((s, b) => s + b.text.length, 0)}`);
