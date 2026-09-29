// «Карта ТЗ»: полный текст ТЗ (data/seed/tz-fulltext.json) размечается пунктами трассы и атомами декомпозиции.
// Блок получает пункт по якорю (`find`), следующие блоки наследуют его до нового пункта или заголовка.
// Ручные решения — docs/tz/tz-blocks.yaml: привязать блок к пункту или объявить «требований нет» с причиной.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const norm = (s) => s.replace(/\s+/g, " ").trim();
const words = (s) => new Set(norm(s).toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9_]+/).filter((w) => w.length > 3));

export function buildTzDoc(root, model, decomposition) {
  const f = join(root, "data/seed/tz-fulltext.json");
  if (!existsSync(f)) return null;
  const pages = JSON.parse(readFileSync(f, "utf8"));
  const ov = existsSync(join(root, "docs/tz/tz-blocks.yaml")) ? parse(readFileSync(join(root, "docs/tz/tz-blocks.yaml"), "utf8")) : { blocks: [] };
  const items = [];
  for (const t of model.tz ?? []) if (t.find) items.push({ id: t.id, find: norm(t.find) });
  for (const s of decomposition?.sections ?? []) for (const it of s.items) if (it.new && it.find) items.push({ id: it.id, find: norm(it.find) });
  const atomsOf = new Map();
  for (const s of decomposition?.sections ?? []) for (const it of s.items) atomsOf.set(it.id, it.atoms);

  const blocks = pages.flatMap((p) => p.blocks.map((b) => ({ ...b, page: p.page })));
  let current = null;
  for (const b of blocks) {
    const t = norm(b.text);
    const o = (ov.blocks ?? []).find((x) => t.startsWith(norm(x.starts)));
    const hits = items.filter((i) => t.includes(i.find));
    if (o?.note) b.note = o.note;
    if (o?.item) (b.item = o.item), (current = o.item);
    else if (o?.none) (b.none = o.none), (current = o.keep ? current : null);
    else if (hits.length) (b.item = hits[0].id), (b.also = hits.slice(1).map((h) => h.id)), (current = hits.at(-1).id);
    else if (b.kind === "heading" || /^\d{1,2}\.\d{1,2}\.\s/.test(t)) (current = null), (b.none = b.kind === "heading" ? "Заголовок раздела" : null);
    else if (current) (b.item = current), (b.cont = true);
    if (b.kind === "empty") b.none = "Страница без текстового слоя (обложка)";
  }
  // атомы пункта раскладываются по его блокам: блок с наибольшим совпадением слов
  const byItem = new Map();
  for (const b of blocks) for (const id of [b.item, ...(b.also ?? [])].filter(Boolean)) byItem.set(id, [...(byItem.get(id) ?? []), b]);
  for (const [id, bs] of byItem) {
    for (const a of atomsOf.get(id) ?? []) {
      const wa = words(a.t);
      let best = bs[0], score = -1;
      for (const b of bs) {
        const wb = words(b.text);
        let c = 0;
        for (const w of wa) if (wb.has(w)) c++;
        if (c > score) (score = c), (best = b);
      }
      (best.atoms ??= []).push(a.id);
    }
  }
  const unlinked = blocks.filter((b) => !b.item && !b.none);
  return { pages: pages.map((p) => ({ page: p.page, blocks: blocks.filter((b) => b.page === p.page) })), unlinked };
}
