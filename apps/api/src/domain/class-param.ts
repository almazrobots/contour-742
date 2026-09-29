// Порядковый параметр-класс по паспорту (T-129): М-023 «Класс конструктивной пожарной опасности».
// Каталог TO-BE: ENT-16 (упоминания), NRM-03/NRM-04 (шкала), LNK-01 (комплект по базовому шифру), VER-15 (приоритет
// источника), GTE-01…03 (ворота), CMP-04 (понижение по шкале), CMP-30 (противоречие внутри стадии), DEC-01 (provenance).
// Правила — OS-INSP-3.1.10–3.1.15. Порядок ворот тот же, что в compare.ts: применимость → редакции → комплектность → сравнение.
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";
import { stageRequired } from "./compare.ts";
import { preferCorrections } from "./revisions.ts";

export interface ClassPassport {
  scale: string[]; // от худшего к лучшему: С3, С2, С1, С0; для шкалы с dims — линейное продолжение частичного порядка
  sources: Record<Stage, Array<{ discipline: string }>>; // приоритет разделов по стадиям; «*» — прочие
  link: "base_cipher" | null;
  // T-172 (OS-INSP-3.1.30–3.1.36): измерения частичного порядка (арматура, EI, кабели), поэлементное сравнение,
  // CMP-26 (ИД против РД), текст порядка для причины
  dims?: ScaleDim[] | null;
  per_element?: boolean;
  cert_match?: boolean;
  order_note?: string;
}

/** Измерение шкалы с частичным порядком (T-172): число, лестница токенов или набор признаков. */
export type ScaleDim =
  | { name: string; kind: "number" }
  | { name: string; kind: "ladder"; tokens: string[] }
  | { name: string; kind: "flags"; tokens: string[]; implies?: Record<string, string[]> };

const HOMOGLYPH: Record<string, string> = { А: "A", В: "B", С: "C", Е: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T", Х: "X", У: "Y", І: "I" };

/**
 * Свёртка обозначения класса для сравнения написаний (NRM-03, OS-INSP-2.2.40): NFKC, верхний регистр, без пробелов,
 * все тире — «-» (между буквой и числом тире нет), запятая — точка, кириллические гомоглифы — латиница; буква O — ноль, З — тройка только
 * рядом с цифрой или в конце короткого префикса класса («КМО», «СО», «КМЗ»): в словах и токенах шкал O остаётся буквой. Та же функция —
 * ml/inspector_ml/class_mentions.py::fold_class; канон хранится отдельно, свёртка — только ключ.
 */
export function foldClass(raw: string): string {
  return raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/(\p{L})-(?=\d)/gu, "$1") // «EI-60», «А-400» — тире между буквой и числом не значимо (каталог §20.3)
    .replace(/,/g, ".")
    .replace(/[АВСЕНКМОРТХУІ]/g, (c) => HOMOGLYPH[c])
    .replace(/(?<=\d)O|O(?=\d)/g, "0")
    .replace(/(?<=\d)З|З(?=\d)/g, "3")
    .replace(/^(\p{L}{1,3})O$/u, "$10")
    .replace(/^(\p{L}{1,3})З$/u, "$13");
}

/** Значение класса по измерениям шкалы (OS-INSP-3.1.31). Число не найдено — NaN (значение вне шкалы). */
export function decompose(dims: ScaleDim[], value: string): Array<number | Set<string>> {
  const f = foldClass(value);
  return dims.map((d) => {
    if (d.kind === "number") {
      const m = f.match(/\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : Number.NaN;
    }
    if (d.kind === "ladder") {
      let best = -1;
      let len = 0;
      d.tokens.forEach((t, i) => {
        const ft = foldClass(t);
        if (f.includes(ft) && ft.length > len) [best, len] = [i, ft.length];
      });
      return best;
    }
    const set = new Set(d.tokens.filter((t) => f.includes(foldClass(t))));
    for (const t of [...set]) for (const x of d.implies?.[t] ?? []) set.add(x);
    return set;
  });
}

/**
 * Значение раскладывается по всем измерениям шкалы (OS-INSP-3.1.37): число найдено, ступень лестницы опознана.
 * Иначе сравнение по измерениям не определено — ворота сопоставимости, а не молчаливое «не хуже».
 */
export function classComparable(p: Pick<ClassPassport, "scale" | "dims">, v: string): boolean {
  if (!p.dims?.length) return classRank(p.scale, v) !== null;
  return decompose(p.dims, v).every((x) => x instanceof Set || (Number.isFinite(x) && x >= 0));
}

/**
 * b хуже a (CMP-04, OS-INSP-3.1.31): для линейной шкалы — ниже по рангу; для шкалы с измерениями — хуже хотя бы
 * по одному измерению (меньше число, ниже ступень, потерян признак), даже если по другому лучше.
 */
export function classWorse(p: Pick<ClassPassport, "scale" | "dims">, a: string, b: string): boolean {
  if (!p.dims?.length) return classRank(p.scale, b)! < classRank(p.scale, a)!;
  const da = decompose(p.dims, a);
  const db = decompose(p.dims, b);
  return da.some((x, i) => {
    const y = db[i];
    if (x instanceof Set) return [...x].some((t) => !(y as Set<string>).has(t));
    return (y as number) < x;
  });
}

/** Упоминание класса в документе (извлечение ML + метаданные файла из реестра). */
export interface Mention {
  stage: Stage;
  file_id: string;
  sha256: string;
  document_code: string;
  revision: string;
  approval_status: Fragment["approval_status"];
  role: RevisionRole;
  discipline: string | null;
  base: string | null; // базовый шифр комплекта
  value: string; // нормализованный класс («С0»)
  qualifier: "min" | null; // «не ниже»
  element?: string | null; // T-172 (OS-INSP-2.2.43): класс конструкции/элемента — ключ поэлементного сравнения
  subject_key?: string | null; // M-022: явный корпус/секция/пожарный отсек; null — объект реестра
  subject_quote?: string | null;
  subject_bbox?: [number, number, number, number] | null;
  excluded: string | null; // причина отсева: правила (NEIGHBOR, NORM_TABLE, HEADING) или локальная VLM (VLM_NEIGHBOR, VLM_NORM)
  excluded_why: string | null;
  page: number;
  bbox: [number, number, number, number] | null;
  anchor_bbox?: [number, number, number, number] | null; // оборот «класс … опасности» на листе: прицел захватывает его с классом (T-132)
  quote: string;
  confidence: number; // уверенность правил — до судьи VLM: судья не влияет на порядок выбора (OWASP LLM01, SEC-02)
  // T-130 (OS-INSP-2.2.20, 4.1.18): для карточки инспектора — откуда текст, кто что прочитал, что сказал судья
  source?: "pdf-text" | "scan-ocr" | "scan-reader" | "structured" | null;
  readings?: Array<{ by: string; value: string | null }> | null;
  reader_outcome?: string | null;
  judge?: { outcome: string; value: string | null; subject: string | null; note: string } | null;
}

export type MentionUse = "chosen" | "considered" | "reference" | "dropped" | "flagged";

export interface StagePick {
  chosen: Mention | null;
  considered: Mention[]; // годные упоминания связанного комплекта (включая выбранное)
  reference: Mention[]; // упоминания другого комплекта ПД — справочно
  dropped: Mention[]; // отсеянные правилами, вне шкалы, устаревшие редакции
  flagged: Mention[]; // отсеяны только локальной VLM: не кандидаты в значение стадии, но остаются в проверке противоречия
  note: string | null;
}

export interface ClassSuspicion {
  stage: Stage;
  values: string[];
  description: string;
  mentions: Mention[];
  dedup_key: string;
}

export interface ClassEvaluation extends Evaluation {
  suspicions: ClassSuspicion[];
  provenance: {
    ops: string[];
    mentions: Array<{
      stage: Stage; use: MentionUse; why: string | null; value: string; qualifier: "min" | null; discipline: string | null; document_code: string; file_id: string; page: number; quote: string;
      // T-130: место на листе, источник текста, прочтения читателей, вердикт судьи, код отсева — карточка инспектора
      bbox: [number, number, number, number] | null; anchor_bbox?: [number, number, number, number] | null; excluded: string | null; source: string | null;
      readings: Array<{ by: string; value: string | null }> | null; reader_outcome: string | null;
      judge: { outcome: string; value: string | null; subject: string | null; note: string } | null;
    }>;
  };
}

export const CLASS_OPS = ["ENT-16", "NRM-03", "NRM-04", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-04", "CMP-30", "VER-02", "DEC-01"];

/** Ранг класса на шкале: 0 — худший. Значение вне шкалы — null (NOT_COMPARABLE, а не угадывание). */
export function classRank(scale: string[], value: string): number | null {
  const i = scale.indexOf(value);
  return i >= 0 ? i : null;
}

/** Приоритет раздела на стадии: индекс в списке паспорта; неизвестный раздел — как «прочие» («*»). */
/**
 * Раздел — источник параметра по паспорту (T-233, точность): список стадии без «*» — строгий, раздел вне списка и документ
 * с неопознанным разделом значения не дают («ширина двери» из ПБ, «толщина плиты» из расчёта КНС, «квартир» из буклета).
 * Пустой список или «*» — любой раздел, как раньше.
 */
export function inPassportSources(sources: Partial<Record<Stage, Array<{ discipline: string }>>>, stage: Stage, discipline: string | null): boolean {
  const list = sources[stage] ?? [];
  if (!list.length || list.some((s) => s.discipline === "*")) return true;
  return discipline !== null && list.some((s) => s.discipline === discipline);
}

export function sourceRank(p: Pick<ClassPassport, "sources">, stage: Stage, discipline: string | null): number {
  const list = p.sources[stage] ?? [];
  const i = discipline ? list.findIndex((s) => s.discipline === discipline) : -1;
  if (i >= 0) return i;
  const any = list.findIndex((s) => s.discipline === "*");
  return any >= 0 ? any : list.length;
}

const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };

/**
 * Значение стадии (OS-INSP-3.1.10, 3.1.11). Порядок: раздел выше по приоритету → точное значение раньше ограничения
 * «не ниже» → актуальная редакция → уверенность. При равенстве эталон ПД берётся строже (лучший класс), а поздние стадии —
 * хуже (худший класс): система не прячет понижение за удачным выбором упоминания. Остальное — для детерминизма.
 */
export function pickStage(mentions: Mention[], stage: Stage, p: ClassPassport, primaryBases: Set<string> | null, preferFacts = false): StagePick {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped = own.filter((m) => (m.excluded !== null && !isVlmFlag(m)) || classRank(p.scale, m.value) === null || m.role === "SUPERSEDED");
  // T-233: значение из поправки «Корр.N» главнее значения базового файла того же документа
  const live = own.filter((m) => !dropped.includes(m));
  const rest = preferCorrections(live);
  dropped.push(...live.filter((m) => !rest.includes(m)));
  // VLM только понижает (OWASP LLM01): её отсев убирает упоминание из выбора значения, но не прячет противоречие —
  // надпись в документе («соседнее здание») не должна скрыть неудобный класс от проверки CMP-30
  let flagged = rest.filter(isVlmFlag);
  const usable = rest.filter((m) => !flagged.includes(m));
  let considered = usable;
  let reference: Mention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && primaryBases && primaryBases.size) {
    const linked = usable.filter((m) => m.base !== null && primaryBases.has(m.base));
    if (linked.length) {
      considered = linked;
      reference = usable.filter((m) => !linked.includes(m));
      const inKit = (m: Mention) => m.base !== null && primaryBases.has(m.base);
      reference = [...reference, ...flagged.filter((m) => !inKit(m))];
      flagged = flagged.filter(inKit);
    } else if (usable.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД";
  }
  const better = stage === "PD" ? -1 : 1;
  const key = (m: Mention) => [preferFacts && m.qualifier ? 1 : 0, sourceRank(p, stage, m.discipline), m.qualifier ? 1 : 0, ROLE_ORDER[m.role], -m.confidence, better * -classRank(p.scale, m.value)!, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  return { chosen: sorted[0] ?? null, considered: sorted, reference, dropped, flagged, note };
}

const SOURCES = new Set(["pdf-text", "scan-ocr", "scan-reader", "structured"]);
const OUTCOMES = new Set(["agree", "majority-reader", "majority-ensemble", "no-majority", "ensemble-only", "reader-only", "reader-only-confirmed", "reader-only-unconfirmed"]);
const JUDGE = new Set(["confirmed", "conflict", "unreadable", "excluded", "error", "skipped"]);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length ? v.slice(0, max) : null);

/**
 * След упоминания для карточки инспектора (OS-INSP-2.2.20, 4.1.18, T-130) из meta ответа ML. meta — вход от модуля,
 * который читает недоверенные PDF: берутся только известные поля и значения, строки обрезаются, чужое отбрасывается.
 */
export function mentionTrace(meta: unknown): Pick<Mention, "source" | "readings" | "reader_outcome" | "judge"> {
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  // Set.has сам отвергает не-строку: отдельная проверка типа была бы лишней (эквивалентный мутант, Stryker T-130)
  const source = SOURCES.has(m.text_source as string) ? (m.text_source as Mention["source"]) : null;
  const readings = Array.isArray(m.readings)
    ? m.readings.slice(0, 5).filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({ by: str(r.by, 80) ?? "—", value: str(r.value, 20) }))
    : null;
  const reader_outcome = OUTCOMES.has(m.reader_outcome as string) ? (m.reader_outcome as string) : null;
  const v = (m.vlm ?? {}) as Record<string, unknown>;
  const judge = JUDGE.has(v.outcome as string) ? { outcome: v.outcome as string, value: str(v.value, 20), subject: str(v.subject, 20), note: str(v.note) ?? "" } : null;
  return { source, readings, reader_outcome, judge };
}

/** M-022: ограниченный ключ из недоверенного ML. Неверная структура не становится общим объектом. */
export function fireSubjectKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > 100) return "unresolved";
  const id = "(?:[0-9]{1,4}(?:[.\\-][0-9]{1,3})?[А-ЯA-Z]?|[А-ЯA-Z])";
  const rx = new RegExp(`^(?:building:${id}(?:/section:${id})?(?:/fire_compartment:${id})?|section:${id}(?:/fire_compartment:${id})?|fire_compartment:${id})$`);
  return raw.length && !raw.startsWith("/") && rx.test(raw) ? raw : "unresolved";
}

export function fireSubjectTrace(meta: Record<string, unknown>): Pick<Mention, "subject_key" | "subject_quote" | "subject_bbox"> {
  const b = meta.subject_bbox;
  const bbox = Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) && b[0] < b[2] && b[1] < b[3]
    ? b as [number, number, number, number] : null;
  return { subject_key: fireSubjectKey(meta.subject_key), subject_quote: str(meta.subject_quote, 240), subject_bbox: bbox };
}

/** Упоминание отсеяно только судьёй VLM (а не правилами). */
export function isVlmFlag(m: Mention): boolean {
  return m.excluded !== null && m.excluded.startsWith("VLM_");
}

const show = (m: Mention) => (m.qualifier === "min" ? `не ниже ${m.value}` : m.value);
const where = (m: Mention) => `${m.discipline ?? m.document_code} — ${show(m)} (стр. ${m.page})`;

/**
 * Перечень значений противоречия для инспектора: раздел — значение — все страницы, в порядке первого появления
 * («КР — С1 (стр. 6, 20, 27, 28); ПОС — С1 (стр. 13)»). Раньше называлось только первое упоминание каждого значения,
 * и второй раздел с тем же классом пропадал из текста гипотезы (прогон «Алтуфьевское 79Б», T-129).
 */
export function conflictList(ms: Mention[]): string {
  const groups = new Map<string, { head: string; pages: number[] }>();
  for (const m of ms) {
    const head = `${m.discipline ?? m.document_code} — ${show(m)}`;
    const g = groups.get(head) ?? { head, pages: [] };
    if (!g.pages.includes(m.page)) g.pages.push(m.page);
    groups.set(head, g);
  }
  return [...groups.values()].map((g) => `${g.head} (стр. ${g.pages.join(", ")})`).join("; ");
}

/** Противоречие внутри стадии (OS-INSP-3.1.12, CMP-30): разные точные классы или точный класс ниже ограничения. */
export function stageConflict(pick: StagePick, stage: Stage, scale: string[], dims: ScaleDim[] | null = null, element: string | null = null): ClassSuspicion | null {
  const all = [...pick.considered, ...pick.flagged];
  const points = all.filter((m) => m.qualifier === null);
  const mins = all.filter((m) => m.qualifier === "min");
  const distinct = [...new Set(points.map((m) => m.value))];
  const below = points.filter((m) => mins.some((x) => classWorse({ scale, dims }, x.value, m.value)));
  if (distinct.length < 2 && !below.length) return null;
  // ключ гипотезы — по первому упоминанию каждого значения (как раньше: гипотеза и решение по ней не дублируются при
  // пересчёте); показываются и ссылаются — все разделы с каждым своим значением (OS-INSP-3.1.17, T-130: ПОС выпадал)
  const firstOf = new Map<string, Mention>();
  for (const m of all) if (!firstOf.has(show(m))) firstOf.set(show(m), m);
  const keyed = [...firstOf.values()];
  const perSection = new Map<string, Mention>();
  for (const m of all) {
    const k = `${m.document_code}|${show(m)}`; // шифр документа определяет и раздел: раздел в ключе был бы лишним
    if (!perSection.has(k)) perSection.set(k, m);
  }
  const shown = [...perSection.values()];
  const values = [...new Set(all.map((m) => m.value))];
  const vlm = shown.filter(isVlmFlag);
  const vlmNote = vlm.length ? `. Локальная VLM относит ${vlm.map(where).join("; ")} к соседнему зданию или норме — проверьте по листу` : "";
  return {
    stage,
    values,
    description: `Внутреннее противоречие ${stage === "PD" ? "ПД" : stage === "RD" ? "РД" : "ИД"}${element ? ` (${element})` : ""}: класс указан по-разному — ${conflictList(all.filter((m) => !isVlmFlag(m)))}${vlmNote}`,
    mentions: shown,
    dedup_key: `class-conflict:${stage}:${element ? `${element}:` : ""}${keyed.map((m) => `${m.file_id}@${m.page}:${show(m)}`).sort().join("|")}`,
  };
}

/**
 * Опорное упоминание гипотезы о противоречии (OS-INSP-3.1.12): худший класс среди показанных, с рамкой на листе —
 * по нему инспектор переводит гипотезу в кандидаты и видит лист. Нет ни одного с рамкой (DOCX, XML) — null.
 */
export function conflictAnchor(s: ClassSuspicion, scale: string[]): Mention | null {
  const withBox = s.mentions.filter((m) => m.bbox !== null);
  if (!withBox.length) return null;
  return withBox.reduce((w, m) => (classRank(scale, m.value)! < classRank(scale, w.value)! ? m : w));
}

function frag(m: Mention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: show(m), kind };
}

export interface ClassEvalInput {
  param: Param;
  passport: ClassPassport;
  mentions: Mention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
}

/** Пара «эталон → факт» одного элемента (OS-INSP-3.1.32–3.1.34). */
interface Pair {
  element: string | null;
  exp: Mention;
  act: Mention;
}

export function evaluateClassParam({ param, passport, mentions, loadedStages, profile }: ClassEvalInput): ClassEvaluation {
  const rdBases = new Set(mentions.filter((m) => m.stage !== "PD" && m.base).map((m) => m.base!));
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickStage(mentions, s, passport, rdBases)])) as Record<Stage, StagePick>;
  // OS-INSP-3.1.32 (T-172): поэлементный параметр — значение стадии выбирается отдельно для каждого класса конструкции;
  // упоминание без элемента — общее значение стадии (null)
  const perEl = passport.per_element === true;
  const bySubject = param.code === "M-022";
  const elOf = (m: Mention) => (bySubject ? (m.subject_key ?? null) : perEl ? (m.element ?? null) : null);
  const groups = [...new Set(mentions.map(elOf))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  const gp = new Map(groups.map((g) => [g, Object.fromEntries(STAGES.map((s) => [s, perEl || bySubject ? pickStage(mentions.filter((m) => elOf(m) === g), s, passport, rdBases, bySubject && s !== "PD") : picks[s]])) as Record<Stage, StagePick>]));
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : groups.some((g) => gp.get(g)![s].chosen) ? "USED" : "NO_VALUE";
  const chosenIn = (g: string | null, s: Stage) => gp.get(g)?.[s].chosen ?? null;
  const provenance: ClassEvaluation["provenance"] = {
    ops: passport.cert_match ? [...CLASS_OPS, "CMP-26"] : CLASS_OPS,
    mentions: STAGES.flatMap((s) => {
      const use = (m: Mention): [MentionUse, string | null] => {
        const pk = gp.get(elOf(m))![s];
        return m === pk.chosen ? ["chosen", pk.note] : pk.flagged.includes(m) ? ["flagged", m.excluded_why ?? "локальная VLM: не объект проверки"] : pk.dropped.includes(m) ? ["dropped", m.excluded_why ?? (m.role === "SUPERSEDED" ? "устаревшая редакция" : "значение вне шкалы")] : pk.reference.includes(m) ? ["reference", "другой комплект ПД"] : ["considered", null];
      };
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        return {
          stage: s, use: u, why, value: m.value, qualifier: m.qualifier, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: m.readings ?? null, reader_outcome: m.reader_outcome ?? null, judge: m.judge ?? null,
          ...(perEl ? { element: elOf(m) } : {}),
          ...(bySubject ? { subject_key: elOf(m), subject_quote: m.subject_quote ?? null, subject_bbox: m.subject_bbox ?? null, sha256: m.sha256, revision: m.revision, approval_status: m.approval_status } : {}),
        };
      });
    }),
  };
  // CMP-30: у поэлементного параметра разные классы разных элементов — норма; противоречие ищется внутри элемента
  const suspicions = groups.flatMap((g) => (perEl && g === null ? [] : STAGES.map((s) => stageConflict(gp.get(g)![s], s, passport.scale, passport.dims ?? null, g)))).filter((x): x is ClassSuspicion => x !== null);
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, provenance };

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const usedStages = STAGES.filter((s) => notes[s] === "USED");
  const used = groups.flatMap((g) => usedStages.map((s) => chosenIn(g, s)).filter((m): m is Mention => m !== null));
  // T-241 / OS-INSP-3.1.39: M-022 нельзя объявлять проверенным по одному удобному
  // упоминанию, если остальные действующие источники не позволяют установить факт.
  if (param.code === "M-022") {
    const relevant = groups.flatMap((g) => usedStages.flatMap((s) => [...gp.get(g)![s].considered, ...gp.get(g)![s].flagged]));
    const evidence = relevant.map((m) => frag(m, m.stage === "PD" ? "expected" : "actual"));
    const ambiguous = preferCorrections(mentions.filter((m) => m.role !== "SUPERSEDED")).filter((m) => loadedStages.includes(m.stage) && stageRequired(param, m.stage) && (m.excluded === "AMBIGUOUS_DEGREE" || m.excluded === "AMBIGUOUS_SUBJECT"));
    if (ambiguous.length) {
      return { ...base, status: "NOT_COMPARABLE", reason: "Неоднозначная степень или субъект M-022 требуют проверки исходного фрагмента", fragments: [...evidence, ...ambiguous.map((m) => frag(m, m.stage === "PD" ? "expected" : "actual"))] };
    }
    if (relevant.some((m) => m.subject_key === "unresolved")) {
      return { ...base, status: "NOT_COMPARABLE", reason: "Не распознан субъект M-022", fragments: evidence };
    }
    const unresolved = relevant.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
    if (unresolved.length || suspicions.length) {
      return { ...base, status: "CLARIFICATION_REQUIRED", reason: unresolved.length
        ? "Не определена актуальная редакция источников M-022"
        : "Противоречащие действующие значения степени огнестойкости требуют уточнения", fragments: evidence };
    }
    if (usedStages.length >= 2 && passport.link === "base_cipher") {
      const unlinked = groups.some((g) => {
        const pk = gp.get(g)!;
        const pdBases = new Set(pk.PD.considered.map((m) => m.base));
        return pk.PD.note !== null || used.filter((m) => elOf(m) === g).some((m) => m.base === null || (m.stage !== "PD" && !pdBases.has(m.base)));
      });
      if (unlinked) {
        return { ...base, status: "NOT_COMPARABLE", reason: "Не установлена связь комплектов ПД и поздних стадий M-022 по базовому шифру", fragments: evidence };
      }
    }
    if (used.some((m) => m.stage !== "PD" && m.qualifier === "min")) {
      return { ...base, status: "MISSING_EVIDENCE", reason: "В поздней стадии M-022 указано только ограничение, фактическая степень огнестойкости не установлена", fragments: evidence };
    }
    if (usedStages.length >= 2 && groups.some((g) => used.some((m) => elOf(m) === g) && usedStages.some((s) => !chosenIn(g, s)))) {
      return { ...base, status: "NOT_COMPARABLE", reason: "Не все субъекты M-022 сопоставлены между стадиями", fragments: evidence };
    }
  }
  // 2. Актуальность редакций (GTE-03)
  const disputed = used.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(m, "actual")) };
  }
  // 3. Комплектность (GTE-02): эталон и хотя бы одна поздняя стадия
  if (param.code === "M-021" || param.code === "M-124") {
    const current = preferCorrections(mentions.filter((m) => m.role !== "SUPERSEDED"));
    const incompatible = current.filter((m) => m.excluded === "ALT_SYSTEM"
      && loadedStages.includes(m.stage) && stageRequired(param, m.stage)
      && inPassportSources(passport.sources, m.stage, m.discipline)
      && !(m.stage === "PD" && passport.link === "base_cipher" && rdBases.size
        && picks.PD.chosen?.base && rdBases.has(picks.PD.chosen.base)
        && (m.base === null || !rdBases.has(m.base))));
    if (incompatible.length) {
      return { ...base, status: "NOT_COMPARABLE", reason: "Обнаружена иная шкала энергетических классов; соответствие шкале паспорта не установлено",
        fragments: [...used.map((m) => frag(m, "expected")), ...incompatible.map((m) => frag(m, "actual"))] };
    }
  }
  if (usedStages.length < 2) {
    // OS-INSP-3.1.38: стадия без значения шкалы, но с иной системой классификации (Г, В, Д, Т, РП вместо КМ) — несопоставимо
    const alt = mentions.filter((m) => m.excluded === "ALT_SYSTEM" && m.role !== "SUPERSEDED" && notes[m.stage] === "NO_VALUE");
    if (alt.length && used.length + new Set(alt.map((m) => m.stage)).size >= 2) {
      return { ...base, status: "NOT_COMPARABLE", reason: `Иная система классификации: ${[...new Set(alt.map((m) => `${m.stage} — ${m.value} (${m.excluded_why ?? "не шкала паспорта"})`))].join("; ")}`, fragments: [...used.map((m) => frag(m, "expected")), ...alt.map((m) => frag(m, "actual"))] };
    }
    const missing = STAGES.filter((s) => notes[s] === "NO_VALUE");
    return { ...base, status: "MISSING_EVIDENCE", reason: `Недостаточно источников для сравнения: ${used.length ? `класс найден только в ${used[0].stage}` : "класс не найден"}${missing.length ? `; нет значения в ${missing.join(", ")}` : ""}`, fragments: used.map((m) => frag(m, "expected")) };
  }
  // 4. Пары «эталон → факт» (OS-INSP-3.1.33–3.1.34): РД — против ПД; ИД — против ПД, а у CMP-26 — против РД
  // (материал по сертификату против спецификации РД), нет РД — против ПД. Элемент без значения на стадии эталона
  // сравнивается с общим значением этой стадии; «не ниже X» сравнивается как X
  const refOrder = (s: Stage): Stage[] => (s === "ID" && passport.cert_match ? ["RD", "PD"] : STAGES.filter((x) => STAGES.indexOf(x) < STAGES.indexOf(s)));
  const pairs: Pair[] = [];
  for (const g of groups)
    for (const s of usedStages) {
      const act = chosenIn(g, s);
      if (!act) continue;
      let exp: Mention | null = null;
      for (const r of refOrder(s)) {
        exp = chosenIn(g, r) ?? (g !== null && !bySubject ? chosenIn(null, r) : null);
        if (exp) break;
      }
      if (exp) pairs.push({ element: g, exp, act });
    }
  // Ворота сопоставимости (OS-INSP-3.1.37): пара, где эталон или факт не раскладывается по измерениям шкалы, не сравнивается
  const incomparable = pairs.filter((x) => !classComparable(passport, x.exp.value) || !classComparable(passport, x.act.value));
  pairs.splice(0, pairs.length, ...pairs.filter((x) => !incomparable.includes(x)));
  if (!pairs.length && incomparable.length) {
    return { ...base, status: "NOT_COMPARABLE", reason: `Класс не раскладывается по шкале: ${incomparable.map((x) => `${x.element ? `${x.element}: ` : ""}${show(x.exp)} → ${show(x.act)}`).join("; ")}`, fragments: incomparable.flatMap((x) => [frag(x.exp, "expected"), frag(x.act, "actual")]) };
  }
  if (!pairs.length) {
    return { ...base, status: "NOT_COMPARABLE", reason: `Элементы стадий не сопоставлены: ${used.map((m) => `${m.stage} ${elOf(m) ?? "общий"} ${show(m)}`).join("; ")}`, fragments: used.map((m) => frag(m, m.stage === "PD" ? "expected" : "actual")) };
  }
  // 5. Сравнение по шкале (CMP-04): худшая пара — по наибольшему падению ранга
  const worse = pairs.filter((x) => classWorse(passport, x.exp.value, x.act.value));
  const drop = (x: Pair) => classRank(passport.scale, x.exp.value)! - classRank(passport.scale, x.act.value)!;
  // OS-INSP-3.1.36: худшая — по падению ранга; при равном падении — детерминированно по элементу, стадии, файлу, странице
  const tie = (x: Pair) => [x.element ?? "", STAGES.indexOf(x.act.stage), x.act.file_id, x.act.page] as const;
  const before = (x: Pair, w: Pair) => {
    if (drop(x) !== drop(w)) return drop(x) > drop(w);
    const [a, b] = [tie(x), tie(w)];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const worst = worse.reduce<Pair | null>((w, x) => (!w || before(x, w) ? x : w), null);
  const fragments: Fragment[] = [];
  const seen = new Set<Mention>();
  for (const x of pairs)
    for (const [m, k] of [[x.exp, "expected"], [x.act, "actual"]] as const)
      if (!seen.has(m)) {
        seen.add(m);
        fragments.push(frag(m, k));
      }
  const label = (x: Pair) => `${x.element ? `${x.element}: ` : ""}${show(x.exp)} → ${show(x.act)}`;
  const note = passport.dims?.length ? (passport.order_note ?? passport.scale.join(" < ")) : passport.scale.join(" < ");
  if (worst) {
    const more = worse.length > 1 ? `; ещё понижено: ${worse.filter((x) => x !== worst).map(label).join(", ")}` : "";
    const cmp26 = worst.act.stage === "ID" && worst.exp.stage === "RD" ? " (ИД против спецификации РД, CMP-26)" : "";
    return { ...base, status: "CANDIDATE", expected: show(worst.exp), actual: show(worst.act), delta: label(worst), reason: `${worst.exp.stage} → ${worst.act.stage}${cmp26}: класс понижен (${label(worst)})${more}; ${param.trigger_logic}`, fragments };
  }
  if (incomparable.length) {
    return { ...base, status: "NOT_COMPARABLE", reason: `Понижения среди сопоставимых элементов нет, но класс не раскладывается по шкале: ${incomparable.map((x) => `${x.element ? `${x.element}: ` : ""}${show(x.exp)} → ${show(x.act)}`).join("; ")}`, fragments };
  }
  const last = pairs[pairs.length - 1];
  const delta = `${show(pairs[0].exp)} → ${show(last.act)}`;
  return { ...base, status: "NEGATIVE_VERIFIED", expected: show(pairs[0].exp), actual: show(last.act), delta, reason: `Класс не понижен по шкале ${note}${pairs.length > 1 && perEl ? ` (элементов сравнено: ${new Set(pairs.map((x) => x.element ?? "общий")).size})` : ""}`, fragments };
}
