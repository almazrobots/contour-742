// OS-INSP-1.2.24 Шифр, раздел и редакция документа — из имени файла (реестра в пакете нет, T-129).
// Формы имён сняты с реального пакета (SRC-INSP-11, docs/gera/inspector/survey-m023.md), коды в тестах — синтетические:
//   «1. П-2099-01.001-ПЗ.pdf»                     стадия впереди, базовый шифр, марка
//   «1. Раздел 1 ЖС-РД-000000-П-ОПЗ 2024.pdf»     базовый шифр впереди, стадия и марка в хвосте
//   «4. П-2099-01-001-КР(27.04.26) (1).pdf»       редакция датой, «(1)» — копия при скачивании
//   «3. Раздел АР от 12_02_2025.pdf»              шифра нет, раздел назван словом «Раздел»
//   «133-0000-ОК-1-ГП1_изм.3.pdf»                 цифровой шифр договора с литерой объекта, стадии нет (T-132)
// Базовый шифр связывает ПД и РД одного комплекта (OS-INSP-3.1.11, LNK-01): «2099-01.001» и «2099-01-001» — один шифр.

export interface DocName {
  document_code: string | null;
  base: string | null;
  stage_letter: string | null;
  discipline: string | null;
  mark: string | null;
  revision: string;
  section_no: string | null;
}

/** Разделы ПД (ПП РФ № 87) и основные комплекты РД (ГОСТ Р 21.101). Ключ — буквы марки, значение — раздел. */
const DISCIPLINES: Record<string, string> = {
  ПЗ: "ПЗ", ОПЗ: "ПЗ", ПЗУ: "ПЗУ", СПОЗУ: "ПЗУ", АР: "АР", КР: "КР", КЖ: "КЖ", КЖИ: "КЖИ", КМ: "КМ", КМД: "КМД", КД: "КД",
  ИОС: "ИОС", ПБ: "ПБ", ПОС: "ПОС", ПОД: "ПОД", ООС: "ООС", ОДИ: "ОДИ", ЭЭ: "ЭЭ", БЭО: "БЭО", ТБЭО: "ТБЭО", ТХ: "ТХ", ТР: "ТР",
  ПГМ: "ПГМ", ГОЧС: "ГОЧС", ИТМ: "ИТМ", СМ: "СМ", ОВ: "ОВ", ОВИК: "ОВ", ВК: "ВК", НВК: "НВК", ЭОМ: "ЭОМ", ЭМ: "ЭМ", ЭО: "ЭО",
  ЭН: "ЭН", ЭС: "ЭС", ТС: "ТС", ТМ: "ТМ", АОВ: "АОВ", АВК: "АВК", СС: "СС", ГП: "ГП", ГС: "ГС", АС: "АС", АИ: "АИ", ПС: "ПС",
  ПТ: "ПТ", АПС: "АПС", СОУЭ: "СОУЭ", ПОР: "ПОР", ОДД: "ОДД", ИЛО: "ИЛО", АД: "АД",
};

// Латинские буквы, неотличимые от кириллических: в текстовом слое и в именах встречаются вперемешку
const TWINS: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };

function cyr(s: string): string {
  return s.replace(/[ABCEHKMOPTXY]/g, (c) => TWINS[c]);
}

/** Базовый шифр в сравнимом виде: «.», «_» и пробелы → «-», верхний регистр, латинские двойники → кириллица. */
export function normBase(s: string): string {
  return cyr(s.toUpperCase())
    .replace(/[._\s]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Один ли это комплект: базовые шифры равны после нормализации; пустой шифр ни с чем не совпадает. */
export function sameBase(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normBase(a);
  return x !== "" && x === normBase(b);
}

// Марка: буквы, номер, уточнения через точку — «ИОС1.1», «КЖ01», «КР.Р», «ВК1.2»
const MARK = String.raw`[А-ЯЁ]+\d*(?:\.(?:\d+|[А-ЯЁ]+))*`;
// марка кончается концом имени, пробелом, скобкой, «_», «,» или «-» перед уточнением («ИОС5.1-ИТП.ЭОМ»)
const MARK_END = String.raw`(?=$|[\s(_,-])`;
// «П-2099-01.001-ПЗ», «РД-2099-01-001-АР1», «Р-2099-01-001 ВК1.2»
const STAGE_FIRST = new RegExp(String.raw`(?:^|\s)(РД|Р|П)[-_](\d+(?:[.\-_]\d+)+)[-_\s](${MARK})${MARK_END}`);
// «ЖС-РД-000000-П-ОПЗ», «ЖС-РЛ-0000-2024-П-ИОС4», «ЖС-РД_000000_П_ПОС»
const BASE_FIRST = new RegExp(String.raw`(?:^|\s)([А-ЯЁ]{1,4}(?:[-_][А-ЯЁ0-9]+)+?)[-_](РД|Р|П)[-_](${MARK})${MARK_END}`);

// «133-0000-ОК-1-ГП1», «133-0000-ОК-1-ПЗ2_(Корр.1)»: цифровой шифр договора с литерой объекта, стадии в имени нет (T-132)
const NUMERIC_BASE = new RegExp(String.raw`(?:^|\s)(\d+(?:[-.]\d+)+(?:-[А-ЯЁ]{1,4}-\d+)?)[-_](${MARK})${MARK_END}`);

function discipline(mark: string): string | null {
  const m = /([А-ЯЁ]+)(\d*)(?:\.([А-ЯЁ]+))?/.exec(mark)!; // марка всегда начинается с букв
  const d = DISCIPLINES[m[1]];
  if (!d) return null;
  // у ИОС номер подраздела — часть раздела: ИОС1 (электроснабжение) ≠ ИОС4 (отопление)
  if (d === "ИОС" && m[2]) return `ИОС${Number(m[2])}`;
  // «ИОС.ТХ» — подраздел назван маркой, а не номером
  if (d === "ИОС" && m[3] && DISCIPLINES[m[3]]) return DISCIPLINES[m[3]];
  return d;
}

/**
 * Редакция из хвоста имени: «Изм. 1» → «1», «Корр.1» / «корр 2» → «к1» / «к2» (листы-поправки поверх базового документа,
 * T-233), дата «27.04.26» / «12_02_2025» / «13022025» → как дата; иначе «0».
 */
export function revisionOf(tail: string): string {
  const izm = /Изм\.?\s*(\d+)/i.exec(tail);
  if (izm) return String(Number(izm[1]));
  const korr = /Корр\.?\s*(\d+)/i.exec(tail);
  if (korr) return `к${Number(korr[1])}`;
  const d = /(?:^|[^\d])(\d{1,2})[._](\d{1,2})[._](\d{2}|\d{4})(?!\d)/.exec(tail);
  if (d && Number(d[1]) <= 31 && Number(d[2]) <= 12) return `${d[1]}.${d[2]}.${d[3]}`;
  const c = /(?:^|[^\d])(\d{2})(\d{2})(20\d{2})(?!\d)/.exec(tail);
  if (c && Number(c[1]) >= 1 && Number(c[1]) <= 31 && Number(c[2]) >= 1 && Number(c[2]) <= 12) return `${c[1]}.${c[2]}.${c[3]}`;
  return "0";
}

/** Разбор имени документа. Ничего не угадывает сверх формы: нет шифра и слова «Раздел» — раздел не определён. */
export function parseDocName(fileName: string): DocName {
  const baseName = fileName.split(/[\\/]/).pop()!;
  let stem = baseName.replace(/\.[A-Za-z0-9]{2,5}$/, "").trim();
  let section: string | null = null;
  // «5.1. П-…», «12 П-…» и слитно «5.1.П-…»
  const num = /^(\d+(?:\.\d+)*)(?:\.?\s+|\.(?=\D))/.exec(stem);
  if (num) {
    section = num[1];
    stem = stem.slice(num[0].length);
  }
  const razdel = /^Раздел(?:\s+(\d+(?:\.\d+)*))?\s+/i.exec(stem);
  if (razdel) {
    if (razdel[1]) section = razdel[1];
    stem = stem.slice(razdel[0].length);
  }
  // сравнение — по нормализованной строке той же длины, код — из исходной
  const upper = stem.toUpperCase();
  const src = upper.length === stem.length ? stem : upper;
  const norm = cyr(upper);

  const sf = STAGE_FIRST.exec(norm);
  const bf = sf ? null : BASE_FIRST.exec(norm);
  // цифровой шифр — только с известной маркой: «2024-ОТЧЕТ» не раздел
  const nb = sf || bf ? null : NUMERIC_BASE.exec(norm);
  if (nb && discipline(nb[2])) {
    const lead = nb[0].length - nb[0].trimStart().length;
    const start = nb.index + lead;
    const end = nb.index + nb[0].length;
    return { document_code: src.slice(start, end), base: normBase(nb[1]), stage_letter: null, discipline: discipline(nb[2]), mark: nb[2], revision: revisionOf(norm.slice(end)), section_no: section };
  }
  const hit = sf ?? bf;
  if (hit) {
    const lead = hit[0].length - hit[0].trimStart().length;
    const start = hit.index + lead;
    const end = hit.index + hit[0].length;
    const [stage, base, mark] = sf ? [sf[1], sf[2], sf[3]] : [bf![2], bf![1], bf![3]];
    return {
      document_code: src.slice(start, end),
      base: normBase(base),
      stage_letter: stage,
      discipline: discipline(mark),
      mark,
      revision: revisionOf(norm.slice(end)),
      section_no: section,
    };
  }
  let disc: string | null = null;
  let mark: string | null = null;
  if (razdel) {
    const m = new RegExp(String.raw`^(${MARK})(?=$|[\s(_,])`).exec(norm);
    if (m && discipline(m[1])) {
      mark = m[1];
      disc = discipline(m[1]);
    }
  }
  return { document_code: null, base: null, stage_letter: null, discipline: disc, mark, revision: revisionOf(norm), section_no: section };
}
