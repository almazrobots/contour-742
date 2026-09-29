// ТЗ §10 Params: sp_reference, gost_reference, fz_reference (T-234). В Матрице редакции 1.1 отдельных колонок ссылок нет:
// нормативные документы названы в тексте Матрицы (логика ИИ-связи: «(СП 1.13130)»), в основании паспорта параметра
// и в справочнике норм. Функция раскладывает упоминания по видам документа — начальное наполнение колонок params.

export interface NormativeRefs {
  sp_reference: string | null;
  gost_reference: string | null;
  fz_reference: string | null;
  other_normative: string | null;
}

type Kind = keyof NormativeRefs;

// Порядок важен: сначала длинные виды (ГОСТ Р, СНиП), затем общие. Номер — до «;», «,» перед «п.», «(» или конца.
const PATTERNS: Array<[Kind, RegExp]> = [
  ["gost_reference", /ГОСТ(?:\s+Р)?(?:\s+(?:IEC|ISO|EN|МЭК))?\s+[\d.]+(?:[-–]\d{2,4})?/g],
  ["sp_reference", /(?:СП|СНиП)\s+[\d.]+(?:[-–]\d{2,4})?/g],
  ["fz_reference", /(?:Федеральный\s+закон\s+(?:от\s+[\d.]+\s+)?)?№?\s*\d+-ФЗ|Градостроительный\s+кодекс(?:\s+РФ|\s+Российской\s+Федерации)?/g],
  ["other_normative", /Постановлени[ея]\s+Правительства\s+(?:РФ|Российской\s+Федерации)\s+(?:от\s+[\d.]+\s+)?№\s*\d+|Приказ\s+[А-ЯЁа-яё]+(?:\s+России)?\s+(?:от\s+[\d.]+\s+)?№\s*[\d/]+\S*|ПУЭ/g],
];

/** Номер документа без пробелов по краям и без хвостовой точки; «№ 123-ФЗ» и «123-ФЗ» — одно и то же. */
function norm(kind: Kind, s: string): string {
  let x = s.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
  if (kind === "fz_reference") {
    const m = x.match(/(\d+)-ФЗ/);
    if (m) x = `${m[1]}-ФЗ`;
    else x = "Градостроительный кодекс РФ";
  }
  return x;
}

/**
 * Упоминания нормативных документов из текстов (Матрица, паспорт, справочник норм) → ссылки по видам: СП и СНиП,
 * ГОСТ, федеральные законы и кодексы, прочие акты (постановления, приказы, ПУЭ). Повторы убираются с учётом
 * редакции: «СП 1.13130» и «СП 1.13130.2020» — один документ, остаётся более полное. Вида нет — null.
 */
export function normativeRefs(texts: Array<string | null | undefined>): NormativeRefs {
  const found: Record<Kind, string[]> = { sp_reference: [], gost_reference: [], fz_reference: [], other_normative: [] };
  for (const t of texts) {
    if (!t) continue;
    let rest = t;
    for (const [kind, re] of PATTERNS) {
      for (const m of rest.match(re) ?? []) found[kind].push(norm(kind, m));
      rest = rest.replace(re, " "); // «ГОСТ Р 21.101» не станет ещё и «СП»; «№ 87» постановления — не ФЗ
    }
  }
  const out = {} as NormativeRefs;
  for (const kind of Object.keys(found) as Kind[]) {
    const uniq: string[] = [];
    for (const r of found[kind]) {
      const same = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}-`); // b — та же запись без года
      const i = uniq.findIndex((u) => same(u, r) || same(r, u));
      if (i < 0) uniq.push(r);
      else if (r.length > uniq[i].length) uniq[i] = r;
    }
    out[kind] = uniq.length ? uniq.join("; ") : null;
  }
  return out;
}
