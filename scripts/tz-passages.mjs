#!/usr/bin/env node
// Исходные абзацы ТЗ под каждый пункт трассы: по якорной фразе `find` из model.yaml находит место в PDF ТЗ,
// берёт абзац (до пустой строки или следующего заголовка) и номер страницы. Результат — data/seed/tz-passages.json:
// карта трассы собирается и без PDF (ТЗ лежит вне git).
//   node scripts/tz-passages.mjs [путь к PDF]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const pdf = process.argv[2] ?? join(root, "ТЗ/10. Мосстройнадзор.pdf");
if (!existsSync(pdf)) {
  console.error(`Нет PDF ТЗ: ${pdf} — пропускаю, остаётся прежний data/seed/tz-passages.json`);
  process.exit(0);
}
const raw = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
const pages = raw.split("\f");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const HEADING = /^\s{0,8}\d{1,2}(\.\d{1,2}){0,2}\.\s+[А-ЯA-Z]/;

const model = parse(readFileSync(join(root, "docs/gera/inspector/model.yaml"), "utf8"));
const out = [];
const missed = [];
const allAnchors = (model.tz ?? []).filter((t) => t.find).map((t) => ({ id: t.id, head: t.find.slice(0, 14) }));
for (const t of model.tz ?? []) {
  if (!t.find) continue;
  let hit = null;
  for (let p = 0; p < pages.length && !hit; p++) {
    const lines = pages[p].split("\n");
    for (let i = 0; i < lines.length; i++) {
      // якорь может переноситься на следующую строку — ищем в окне из двух строк
      const win = norm(lines[i] + " " + (lines[i + 1] ?? ""));
      if (win.includes(t.find) && (norm(lines[i]).includes(t.find.slice(0, 12)) || norm(lines[i + 1] ?? "").includes(t.find.slice(0, 12)))) {
        hit = { p, i: norm(lines[i]).includes(t.find.slice(0, 12)) ? i : i + 1, lines };
        break;
      }
    }
  }
  if (!hit) {
    missed.push(t.id);
    continue;
  }
  const { p, i, lines } = hit;
  const take = [];
  let blank = 0;
  for (let k = i; k < lines.length && take.length < 22; k++) {
    const l = lines[k];
    if (k > i && HEADING.test(l)) break;
    // абзац заканчивается там, где начинается формулировка другого пункта ТЗ
    if (k > i && allAnchors.some((a) => a.id !== t.id && norm(l).includes(a.head))) break;
    if (/^\s*\d+\s*$/.test(l)) continue; // номер страницы
    if (!l.trim()) {
      if (++blank >= 2 && take.length > 2) break;
      continue;
    }
    blank = 0;
    take.push(l.replace(/\s{2,}/g, "  ").trim());
  }
  out.push({ id: t.id, page: p + 1, find: t.find, text: take.join("\n") });
}
writeFileSync(join(root, "data/seed/tz-passages.json"), JSON.stringify(out, null, 1));
console.log(`Абзацев ТЗ: ${out.length}; якорь не найден: ${missed.length ? missed.join(", ") : "нет"}`);
