// Количественный параметр по паспорту (T-132): М-001 «Площадь застройки».
// Каталог TO-BE: ENT-15 (ТЭП), NRM-01/NRM-02 (число и единица), LNK-01 (комплект по шифру РД), VER-15 (приоритет
// источника), GTE-01…03 (ворота), CMP-01 (равенство с абсолютным допуском), CMP-30 (противоречие внутри стадии),
// DEC-01 (provenance). Правила — OS-INSP-3.1.18–3.1.20. Порядок ворот тот же, что в compare.ts и class-param.ts.
//
// Расширения W1 (T-173, OS-INSP-3.1.40–3.1.44) — общие для всех количественных параметров, включаются полями паспорта:
// - direction "increase" (CMP-03, bad_direction = up) и bad_direction при «любом изменении»: улучшение (BETTER) не нарушение,
//   но называется в причине;
// - norm (CMP-06): значение одной стадии против предела — из документа (упоминание с limit) или из паспорта; эталон в
//   карточке — норма, а не ПД;
// - variants: разные показатели одного оборота («с НДС» / «без НДС») сравниваются только между собой;
// - unit_scales (VER-13): значение без единицы, отличающееся ровно в кратность единиц паспорта, — NOT_COMPARABLE;
// - aspects (CMP-18 и др.): второй показатель параметра со своей единицей и правилом (отметка низа подземной части).
//
// Расширения W3 (T-211, OS-INSP-3.1.140–3.1.149):
// - несколько норм у показателя (М-033: крутизна не выше максимума и уклон не ниже минимума водоотвода) и норма у аспекта
//   (М-048: высота подступенка ≤ 150 мм, проступь ≥ 300 мм);
// - multi_object: показатель у многих объектов (уклон участка, марш лестницы) — норма проверяется у каждого значения стадии,
//   а при разных значениях внутри стадии пара ПД–РД не угадывается: NOT_COMPARABLE вместо сравнения случайной пары;
// - ops: операции каталога, которые паспорт добавляет явно (CMP-18 уклона, CMP-07 счёта).
import type { ClassEvaluation, Mention, MentionUse } from "./class-param.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import { preferCorrections } from "./revisions.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

export type QuantityDirection = "both" | "decrease" | "increase";

/** Предел нормы для CMP-06: max — значение не выше, min — не ниже. value — из паспорта (null — только из документа). */
export interface QuantityNorm {
  kind: "max" | "min";
  value: number | null;
  basis: string;
  code?: string; // T-211: код причины нарушения нормы (SLOPE_FLATTER_BELOW_MIN)
  level?: "fail" | "warn"; // T-211 (OS-INSP-3.1.148): warn — рекомендация (гипотеза в карточке), fail (по умолчанию) — норма
}

/** Одна норма или несколько (T-211, OS-INSP-3.1.141): max и min одного показателя проверяются по очереди. */
export type QuantityNorms = QuantityNorm | QuantityNorm[] | null | undefined;

/** Нормы паспорта списком: одна — как раньше, несколько — по порядку паспорта (OS-INSP-3.1.141). */
export function normList(n: QuantityNorms): QuantityNorm[] {
  return n ? (Array.isArray(n) ? n : [n]) : [];
}

/** Второй показатель параметра (OS-INSP-3.1.44): свои единица, допуск и направление; optional — отсутствие не блокирует. */
export interface QuantityAspect {
  key: string;
  title: string;
  unit: string;
  tolerance: number;
  tolerance_pct: number;
  direction: QuantityDirection;
  optional: boolean;
  norm?: QuantityNorms; // T-211 (OS-INSP-3.1.145, CMP-06): норма аспекта — высота подступенка, проступь
  change_codes?: QuantityPassport["change_codes"]; // T-211 (OS-INSP-3.1.144): код и уровень изменения размера по направлению
}

export interface QuantityPassport {
  unit: string;
  tolerance: number; // абсолютный допуск в единицах параметра: половина разряда точности документа
  tolerance_pct: number; // относительный порог Матрицы, % от эталона (0 — нет)
  direction: QuantityDirection; // decrease — нарушение только уменьшение (М-003), increase — только рост (М-008, CMP-03)
  bad_direction?: "up" | "down" | null; // при «любом изменении» — какая сторона хуже (CMP-03 в карточке)
  norm?: QuantityNorms; // CMP-06; несколько — T-211 (OS-INSP-3.1.141)
  variants?: Array<{ code: string; title: string }> | null; // порядок — приоритет варианта для сравнения
  unit_scales?: number[] | null; // множители единиц паспорта к канону (тыс. руб. — 1, руб. — 0,001)
  aspects?: QuantityAspect[] | null;
  // T-211 (OS-INSP-3.1.140): код и уровень изменения по направлению — рост и уменьшение сверх допуска; уровень none —
  // не нарушение (код в причине), suspicion — гипотеза, candidate (по умолчанию) — нарушение
  change_codes?: Partial<Record<"up" | "down", { code: string; level: "none" | "suspicion" | "candidate" }>> | null;
  multi_object?: boolean; // T-211 (OS-INSP-3.1.142): показатель многих объектов — участков дорог, маршей
  main_optional?: boolean; // T-211 (OS-INSP-3.1.145): нет основного показателя — решают аспекты (число ступеней не указано)
  ops?: string[]; // T-211: операции каталога, добавленные паспортом (CMP-18, CMP-07)
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: "base_cipher" | null;
}

/** Упоминание показателя: как упоминание класса, но значение — число. */
export interface QuantityMention extends Omit<Mention, "value" | "qualifier"> {
  num: number;
  anchor_bbox?: [number, number, number, number] | null; // подпись показателя на листе: прицел захватывает её вместе с числом
  unit?: string | null; // единица, найденная рядом со значением (null — не найдена; нет поля — не проверялась)
  unit_from?: "value" | "page" | null; // откуда единица: у значения или из шапки листа (T173-M3: шапка — не доказательство)
  variant?: string | null; // вариант показателя из паспорта («vat_incl»)
  limit?: boolean; // предельное значение нормы («не более 60 %»), а не значение объекта (CMP-06)
  aspect?: string | null; // ключ аспекта паспорта (нет — основной показатель)
  object?: string | null; // T-211 (OS-INSP-3.1.149): объект значения — марка («п-1», «лм-1») или подпись строки таблицы
}

/**
 * Поля упоминания количества из meta ML (OS-INSP-2.2.51–2.2.53, T-173): единица (null — не найдена; ответ ML до 14-й
 * ревизии — поля нет, страж кратности не срабатывает), вариант, предел нормы, аспект.
 */
export function quantityMeta(meta: Record<string, unknown>): Pick<QuantityMention, "unit" | "unit_from" | "variant" | "limit" | "aspect" | "object"> {
  return {
    ...("object" in meta ? { object: typeof meta.object === "string" ? meta.object : null } : {}), // T-211: объект значения
    ...("unit" in meta ? { unit: typeof meta.unit === "string" ? meta.unit : null } : {}),
    ...(meta.unit_from === "value" || meta.unit_from === "page" ? { unit_from: meta.unit_from } : {}),
    variant: typeof meta.variant === "string" ? meta.variant : null,
    limit: meta.limit === true,
    aspect: typeof meta.aspect === "string" ? meta.aspect : null,
  };
}

export interface QuantityPick {
  chosen: QuantityMention | null;
  considered: QuantityMention[];
  reference: QuantityMention[]; // другой комплект ПД — справочно
  dropped: QuantityMention[]; // отсеянные правилами и устаревшие редакции
  note: string | null;
}

export interface QuantitySuspicion {
  stage: Stage;
  description: string;
  mentions: QuantityMention[];
  dedup_key: string;
}

export interface QuantityEvaluation extends Evaluation {
  code?: string | null; // T-211: код причины из паспорта (SLOPE_STEEPER …); null — паспорт кода не задаёт
  suspicions: QuantitySuspicion[];
  provenance: ClassEvaluation["provenance"];
}

export const QUANTITY_OPS = ["ENT-15", "NRM-01", "NRM-02", "NRM-06", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-01", "CMP-30", "VER-02", "DEC-01"];
/** Операции, которые добавляет паспорт: направление — CMP-03, норма — CMP-06, кратность единиц — VER-13, аспект — CMP-18. */
export function quantityOps(p: QuantityPassport): string[] {
  const extra = [
    p.direction !== "both" || p.bad_direction ? "CMP-03" : null,
    p.tolerance_pct ? "CMP-02" : null,
    normList(p.norm).length || p.aspects?.some((a) => normList(a.norm).length) ? "CMP-06" : null,
    p.unit_scales && p.unit_scales.length > 1 ? "VER-13" : null,
    p.aspects?.length ? "CMP-18" : null,
  ].filter((x): x is string => x !== null);
  return [...new Set([...QUANTITY_OPS, ...extra, ...(p.ops ?? [])])];
}

const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };
const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };

/** Число по-русски: запятая, без хвостовых нулей, разряды не разделяются («3009,4»). */
export function fmtNum(n: number): string {
  return String(Math.round(n * 1000) / 1000).replace(".", ",");
}

const where = (m: QuantityMention) => m.discipline ?? m.document_code;

/**
 * Значение стадии (OS-INSP-3.1.18): раздел выше по приоритету → актуальная редакция → уверенность → файл, страница.
 * ПД — только комплект с базовым шифром РД пакета (kitBases), если такой комплект в ПД есть.
 */
export function pickQuantity(mentions: QuantityMention[], stage: Stage, p: QuantityPassport, kitBases: Set<string>, pdKitPresent = false): QuantityPick {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped = own.filter((m) => m.excluded !== null || m.role === "SUPERSEDED");
  // T-233: значение из поправки «Корр.N» главнее значения базового файла того же документа
  const live = own.filter((m) => !dropped.includes(m));
  const usable = preferCorrections(live);
  dropped.push(...live.filter((m) => !usable.includes(m)));
  let considered = usable;
  let reference: QuantityMention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && kitBases.size) {
    const linked = usable.filter((m) => m.base !== null && kitBases.has(m.base));
    if (linked.length) {
      considered = linked;
      reference = usable.filter((m) => !linked.includes(m));
    } else if (pdKitPresent) {
      // комплект ПД с шифром РД в пакете есть, но показателя в нём нет: значение чужого проекта не подставляется
      considered = [];
      reference = usable;
    } else if (usable.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД";
  }
  const key = (m: QuantityMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  return { chosen: sorted[0] ?? null, considered: sorted, reference, dropped, note };
}

/** Допустимое отклонение от эталона: большее из абсолютного (точность документа) и относительного (порог Матрицы). */
export function allowed(p: QuantityPassport, ref: number): number {
  return Math.max(p.tolerance, (p.tolerance_pct * Math.abs(ref)) / 100);
}

/** Нарушает ли фактическое значение правило паспорта относительно эталона (OS-INSP-3.1.20, 3.1.40: CMP-01, CMP-02, CMP-03). */
export function breaks(p: QuantityPassport, ref: number, v: number): boolean {
  const d = v - ref;
  // сравнение с запасом 1e-9: 100,05 − 100 в двоичной арифметике чуть больше 0,05
  return (p.direction === "decrease" ? -d : p.direction === "increase" ? d : Math.abs(d)) > allowed(p, ref) + 1e-9;
}

/** Изменение в лучшую сторону больше допуска (CMP-03 BETTER): не нарушение, но называется в карточке (OS-INSP-3.1.40). */
export function better(p: QuantityPassport, ref: number, v: number): boolean {
  const bad = p.direction === "increase" ? "up" : p.direction === "decrease" ? "down" : (p.bad_direction ?? null);
  if (!bad) return false;
  const d = v - ref;
  return (bad === "up" ? -d : d) > allowed(p, ref) + 1e-9;
}

/** Нарушает ли значение предел нормы с допуском точности документа (CMP-06, OS-INSP-3.1.41). */
export function normBreaks(n: { kind: QuantityNorm["kind"]; value: number | null; basis?: string }, v: number, tol: number): boolean {
  if (n.value === null) return false;
  return (n.kind === "max" ? v - n.value : n.value - v) > tol + 1e-9;
}

/**
 * Страж кратности единиц (OS-INSP-3.1.43, VER-13): у одного из значений единица не найдена, а отношение значений в пределах
 * 50 % совпадает с пересчётом единиц паспорта (руб. против тыс. руб., мм против м) — сравнение не выполняется. Кратность или null.
 */
export function scaleMismatch(p: QuantityPassport, a: QuantityMention, b: QuantityMention): number | null {
  const scales = p.unit_scales ?? [];
  // единица из шапки листа (unit_from = page) — догадка, а не единица значения: для стража она как отсутствующая (T173-M3)
  const known = (m: QuantityMention) => m.unit !== null && m.unit_from !== "page";
  if (scales.length < 2 || (known(a) && known(b)) || a.num === 0) return null;
  const r = b.num / a.num;
  // рост стоимости в 1000 раз не бывает: отношение в пределах ±50 % от кратности единиц — это единица, а не изменение (T173-M3)
  for (const f of scales) for (const g of scales) if (f !== g && Math.abs(r / (f / g) - 1) <= 0.5) return f / g;
  return null;
}

/** «ПЗУ — 3009,4 (стр. 11); ПЗ — 3009,4 (стр. 10)»: раздел — значение — все страницы, в порядке появления. */
export function valueList(ms: QuantityMention[]): string {
  const groups = new Map<string, number[]>();
  for (const m of ms) {
    const head = `${where(m)} — ${fmtNum(m.num)}`;
    const pages = groups.get(head) ?? [];
    if (!pages.includes(m.page)) pages.push(m.page);
    groups.set(head, pages);
  }
  return [...groups.entries()].map(([h, pages]) => `${h} (стр. ${pages.join(", ")})`).join("; ");
}

/** Противоречие внутри стадии (OS-INSP-3.1.19, CMP-30): значения разделов расходятся больше допуска. */
export function quantityConflict(pick: QuantityPick, stage: Stage, p: QuantityPassport): QuantitySuspicion | null {
  const all = pick.considered;
  if (all.length < 2) return null;
  const lo = Math.min(...all.map((m) => m.num));
  const hi = Math.max(...all.map((m) => m.num));
  if (hi - lo <= allowed(p, lo) + 1e-9) return null;
  const firstOf = new Map<string, QuantityMention>();
  for (const m of all) if (!firstOf.has(fmtNum(m.num))) firstOf.set(fmtNum(m.num), m);
  return {
    stage,
    description: `Внутреннее противоречие ${STAGE_RU[stage]}: значение указано по-разному — ${valueList(all)}`,
    mentions: all,
    dedup_key: `quantity-conflict:${stage}:${[...firstOf.values()].map((m) => `${m.file_id}@${m.page}:${fmtNum(m.num)}`).sort().join("|")}`,
  };
}

function frag(m: QuantityMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: fmtNum(m.num), kind };
}

export interface QuantityEvalInput {
  param: Param;
  passport: QuantityPassport;
  mentions: QuantityMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>; // базовые шифры документов РД пакета (LNK-01), а не только РД-упоминаний
  pdKitPresent?: boolean; // в ПД пакета есть документы с шифром РД — откат на «все ПД» запрещён
}

/** Чего не хватает стадии — первый по приоритету источник паспорта, со строчной буквы и без пометки Матрицы. */
export function needOf(p: QuantityPassport, s: Stage): string {
  const label = p.sources[s]?.[0]?.label ?? "источник стадии";
  const t = label.replace(/\s+—\s+источник Матрицы$/, "");
  // сокращение («ТЭП подземной части») не опускается в строчные
  return /^[А-ЯЁA-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

/** Вариант показателя для сравнения (OS-INSP-3.1.42): общий для эталонной и поздней стадии, по порядку паспорта. */
export function selectVariant(ms: QuantityMention[], p: QuantityPassport): { keep: QuantityMention[]; out: Map<QuantityMention, string>; note: string | null; conflict: string | null } {
  const out = new Map<QuantityMention, string>();
  const variants = p.variants ?? [];
  if (!variants.length) return { keep: ms, out, note: null, conflict: null };
  const title = (v: string | null) => (v === null ? "не указан" : (variants.find((x) => x.code === v)?.title ?? v));
  const usable = ms.filter((m) => m.excluded === null && m.role !== "SUPERSEDED");
  const stages = STAGES.filter((s) => usable.some((m) => m.stage === s));
  if (stages.length < 2) return { keep: ms, out, note: null, conflict: null };
  const vs = (s: Stage) => new Set(usable.filter((m) => m.stage === s).map((m) => m.variant ?? null));
  const [first, ...rest] = stages;
  const common = [...variants.map((v) => v.code), null].find((v) => vs(first).has(v) && rest.some((s) => vs(s).has(v)));
  if (common !== undefined) {
    for (const m of ms) if ((m.variant ?? null) !== common) out.set(m, `другой вариант показателя — ${title(m.variant ?? null)}`);
    return { keep: ms.filter((m) => !out.has(m)), out, note: common === null ? null : `Сравнивался вариант показателя — ${title(common)}.`, conflict: null };
  }
  const known = new Set(usable.map((m) => m.variant ?? null).filter((v) => v !== null));
  if (known.size <= 1) return { keep: ms, out, note: "Сравнение условное: вариант показателя указан не во всех стадиях.", conflict: null };
  const list = stages.map((s) => `${STAGE_RU[s]}: ${[...vs(s)].map(title).join(", ")}`).join("; ");
  return { keep: ms, out, note: null, conflict: `Варианты показателя в стадиях разные — ${list}. Сравнивается только одинаковый вариант. Запросите значение того же варианта.` };
}

interface NormRef {
  kind: QuantityNorm["kind"];
  code: string | null;
  level: "fail" | "warn";
  value: number;
  text: string;
  mention: QuantityMention | null;
}

/**
 * Предел CMP-06 (OS-INSP-3.1.41): из документа — ранняя стадия, раздел по приоритету; нет в документах — из паспорта.
 * При нескольких нормах (OS-INSP-3.1.141) упоминание-предел не говорит, какая это граница, — берётся только паспорт.
 */
export function normOf(p: QuantityPassport, limits: QuantityMention[], n: QuantityNorm | undefined = normList(p.norm)[0]): NormRef | null {
  if (!n) return null;
  if (normList(p.norm).length > 1) limits = [];
  const sym = n.kind === "max" ? "≤" : "≥";
  const key = (m: QuantityMention) => [STAGES.indexOf(m.stage), sourceRank(p, m.stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.page] as const;
  const usable = limits
    .filter((m) => m.excluded === null && m.role !== "SUPERSEDED")
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
  const m = usable[0];
  if (m) return { kind: n.kind, code: n.code ?? null, level: n.level ?? "fail", value: m.num, mention: m, text: `${sym} ${fmtNum(m.num)} ${p.unit} (${n.basis}; ${where(m)}, стр. ${m.page})` };
  if (n.value === null) return null;
  return { kind: n.kind, code: n.code ?? null, level: n.level ?? "fail", value: n.value, mention: null, text: `${sym} ${fmtNum(n.value)} ${p.unit} (${n.basis})` };
}

/** Одна проверка паспорта: основной показатель или аспект (у аспекта своя конфигурация, без нормы и вариантов). */
function evaluateCore(input: QuantityEvalInput, all: QuantityMention[], passport: QuantityPassport, aspect: QuantityAspect | null): QuantityEvaluation {
  const { param, loadedStages, profile, kitBases, pdKitPresent = false } = input;
  const limits = all.filter((m) => m.limit);
  const variant = selectVariant(
    all.filter((m) => !m.limit),
    passport,
  );
  const mentions = variant.keep;
  const unitOf = (m: QuantityMention) => `${fmtNum(m.num)} ${passport.unit}`;
  const norms = normList(passport.norm)
    .map((n) => normOf(passport, limits, n))
    .filter((x): x is NormRef => x !== null);
  const refMention = norms.find((n) => n.mention)?.mention ?? null;
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickQuantity(mentions, s, passport, kitBases, pdKitPresent)])) as Record<Stage, QuantityPick>;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : picks[s].chosen ? "USED" : "NO_VALUE";
  const label = aspect ? ` (${aspect.title})` : "";
  const provenance: QuantityEvaluation["provenance"] = {
    ops: quantityOps(passport),
    mentions: STAGES.flatMap((s) => {
      const pk = picks[s];
      const use = (m: QuantityMention): [MentionUse, string | null] =>
        m.limit
          ? ["reference", m === refMention ? "предельное значение нормы — эталон CMP-06" : "предельное значение нормы — справочно"]
          : variant.out.has(m)
            ? ["dropped", variant.out.get(m)!]
            : m === pk.chosen
              ? ["chosen", pk.note]
              : pk.dropped.includes(m)
                ? ["dropped", m.excluded_why ?? "устаревшая редакция"]
                : pk.reference.includes(m)
                  ? ["reference", "другой комплект ПД — шифр не совпадает с РД пакета"]
                  : ["considered", null];
      return all.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        const value = m.limit ? `${normList(passport.norm)[0]?.kind === "min" ? "≥" : "≤"} ${unitOf(m)}` : `${unitOf(m)}${label}`;
        return {
          stage: s, use: u, why, value, qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: null, reader_outcome: null, judge: null,
        };
      });
    }),
  };
  const suspicions = STAGES.map((s) => quantityConflict(picks[s], s, passport)).filter((x): x is QuantitySuspicion => x !== null);
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, provenance };
  const rule = `Правило Матрицы: ${param.trigger_logic}`;

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const used = STAGES.filter((s) => notes[s] === "USED").map((s) => picks[s].chosen!);
  // 2. Актуальность редакций (GTE-03)
  const disputed = used.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(m, "actual")) };
  }
  // 4. Сравнение между стадиями (CMP-01/02/03): эталон — самая ранняя стадия, отклонение больше допуска — кандидат
  const [exp, ...later] = used;
  let worst: QuantityMention | null = null;
  const turnOf = (m: QuantityMention) => passport.change_codes?.[m.num > exp.num ? "up" : "down"] ?? null;
  const levelOf = (m: QuantityMention) => turnOf(m)?.level ?? "candidate";
  if (exp) for (const m of later) if (breaks(passport, exp.num, m.num) && levelOf(m) === "candidate" && (!worst || Math.abs(m.num - exp.num) > Math.abs(worst.num - exp.num))) worst = m;
  // изменение с уровнем паспорта ниже нарушения (T-211, OS-INSP-3.1.140): гипотеза или только код в причине
  const soft = exp ? later.filter((m) => breaks(passport, exp.num, m.num) && levelOf(m) !== "candidate") : [];
  for (const m of soft.filter((x) => levelOf(x) === "suspicion"))
    suspicions.push({
      stage: m.stage,
      description: `${aspect ? cap(aspect.title) : param.parameter_name}: ${STAGE_RU[m.stage]} (${where(m)}, стр. ${m.page}) ${m.num > exp.num ? "больше" : "меньше"} ${STAGE_RU[exp.stage]} (${where(exp)}, стр. ${exp.page}) на ${fmtNum(Math.abs(m.num - exp.num))} ${passport.unit} — допуск ±${fmtNum(allowed(passport, exp.num))} ${passport.unit} (${turnOf(m)!.code}).`,
      mentions: [exp, m],
      dedup_key: `quantity-turn:${aspect?.key ?? "main"}:${m.file_id}@${m.page}:${fmtNum(m.num)}`,
    });
  const scale = exp ? later.map((m) => ({ m, k: scaleMismatch(passport, exp, m) })).find((x) => x.k !== null) : undefined;
  const turn = (m: QuantityMention) => (better(passport, exp.num, m.num) ? "в лучшую сторону (CMP-03, BETTER)" : "в плохую сторону (CMP-03, WORSE)");
  const cmpSentence = (w: QuantityMention) =>
    `${STAGE_RU[w.stage]} (${where(w)}, стр. ${w.page}) ${w.num > exp.num ? "больше" : "меньше"} ${STAGE_RU[exp.stage]} (${where(exp)}, стр. ${exp.page}) на ${fmtNum(Math.abs(w.num - exp.num))} ${passport.unit} — допуск ${passport.direction === "decrease" ? "на уменьшение " : passport.direction === "increase" ? "на увеличение " : ""}±${fmtNum(allowed(passport, exp.num))} ${passport.unit}${passport.direction === "both" && passport.bad_direction ? `; изменение ${turn(w)}` : ""}.`;
  // 5. Норма (CMP-06, OS-INSP-3.1.41): одна стадия против предела; эталон в карточке — норма. Нормы — по порядку паспорта
  // (OS-INSP-3.1.141); у показателя многих объектов проверяется каждое значение стадии, а не только выбранное (3.1.142)
  const usedStages = STAGES.filter((s) => notes[s] === "USED");
  // у показателя многих объектов норма проверяется у всех вариантов (поперечный уклон тоже), а не только у сравниваемого
  const pool = passport.multi_object
    ? STAGES.filter((s) => notes[s] !== "NOT_APPLICABLE").flatMap((s) => pickQuantity(all.filter((m) => !m.limit), s, passport, kitBases, pdKitPresent).considered)
    : used;
  // рекомендация (OS-INSP-3.1.148): не выполнена, а норма выполнена — гипотеза для инспектора, а не нарушение
  const fails = norms.filter((n) => n.level === "fail");
  const warned = norms
    .filter((n) => n.level === "warn")
    .flatMap((n) => pool.filter((m) => normBreaks(n, m.num, passport.tolerance) && !fails.some((f) => normBreaks(f, m.num, passport.tolerance))).map((m) => ({ n, m })));
  const who = aspect ? cap(aspect.title) : param.parameter_name;
  for (const { n, m } of warned)
    suspicions.push({
      stage: m.stage,
      description: `${who}: ${STAGE_RU[m.stage]} (${where(m)}, стр. ${m.page}) — ${unitOf(m)} — не выполняет рекомендацию ${n.text}${fails.length ? `, норму ${fails.map((f) => f.text).join("; ")} выполняет` : ""} (CMP-06).`,
      mentions: [m],
      dedup_key: `quantity-warn:${aspect?.key ?? "main"}:${m.file_id}@${m.page}:${fmtNum(m.num)}`,
    });
  for (const norm of fails) {
    const bad = pool.filter((m) => normBreaks(norm, m.num, passport.tolerance));
    if (bad.length) {
      const top = bad.reduce((a, b) => (Math.abs(b.num - norm.value) > Math.abs(a.num - norm.value) ? b : a));
      const extra = worst && !scale && !variant.conflict ? ` ${cmpSentence(worst)}` : "";
      const over = top.num - norm.value;
      return {
        ...base,
        status: "CANDIDATE",
        expected: norm.text,
        actual: fmtNum(top.num),
        delta: `${over > 0 ? "+" : ""}${fmtNum(over)} ${passport.unit} к пределу`,
        reason: `Норма нарушена (CMP-06): ${bad.map((m) => `${STAGE_RU[m.stage]} (${where(m)}, стр. ${m.page}) — ${unitOf(m)}`).join(", ")} при пределе ${norm.text}.${extra}${norm.code ? ` Код причины: ${norm.code}.` : ""} ${rule}`,
        code: norm.code,
        fragments: [...(norm.mention ? [frag(norm.mention, "expected")] : []), ...bad.map((m) => frag(m, "actual"))],
      };
    }
  }
  // 3. Разные варианты показателя (OS-INSP-3.1.42): «с НДС» против «без НДС» — не сравнение; норма проверена выше (T-211)
  if (variant.conflict) return { ...base, status: "NOT_COMPARABLE", reason: variant.conflict, fragments: used.map((m) => frag(m, "actual")) };
  // 6. Комплектность (GTE-02): эталон и хотя бы одна поздняя стадия. В причине — что найдено и чего не хватает.
  if (used.length < 2) {
    // T-211 (OS-INSP-3.1.146): в другой стадии значение есть, но без единицы («уклон 2°», «уклон 5») — не «нет значения», а
    // значение не сопоставимо: NOT_COMPARABLE с просьбой указать единицу
    const unitless = used.length === 1 ? all.find((m) => m.excluded === "NO_UNIT" && m.stage !== used[0].stage && m.role !== "SUPERSEDED") : undefined;
    if (unitless) {
      return {
        ...base,
        status: "NOT_COMPARABLE",
        expected: fmtNum(used[0].num),
        reason: `Единица значения не определена: ${STAGE_RU[unitless.stage]} (${where(unitless)}, стр. ${unitless.page}) — «${unitless.quote}»; ${STAGE_RU[used[0].stage]} — ${unitOf(used[0])}. Запросите значение с единицей (${passport.unit}).`,
        fragments: [frag(used[0], "expected"), frag(unitless, "actual")],
      };
    }
    const missing = STAGES.filter((s) => notes[s] === "NO_VALUE");
    const notLoaded = STAGES.filter((s) => !loadedStages.includes(s) && stageRequired(param, s));
    const ref = picks.PD.reference;
    const found = used.length
      ? `${STAGE_RU[used[0].stage]} — ${unitOf(used[0])} (${valueList(picks[used[0].stage].considered)})`
      : ref.length
        ? `в комплекте ПД, связанном с РД, показателя нет; в другом комплекте — ${valueList(ref)} (справочно)`
        : "значение не найдено ни в одной стадии";
    const need = [...missing, ...notLoaded].map((s) => `${STAGE_RU[s]}: ${needOf(passport, s)}${notLoaded.includes(s) ? " — стадия не загружена" : " — показателя нет"}`);
    return {
      ...base,
      status: "MISSING_EVIDENCE",
      expected: used[0] ? `${fmtNum(used[0].num)}` : null,
      reason: `Сравнить не с чем: ${found}.${need.length ? ` Запросите ${need.join("; ")}.` : ""}`,
      fragments: used.map((m) => frag(m, "expected")),
    };
  }
  // 6а. Многие объекты (OS-INSP-3.1.142): в стадии разные значения (участки, марши) — пару ПД–РД по тексту не определить
  const spread = passport.multi_object ? suspicions.filter((x) => x.dedup_key.startsWith("quantity-conflict:") && usedStages.includes(x.stage)) : [];
  if (spread.length) {
    return {
      ...base,
      status: "NOT_COMPARABLE",
      expected: fmtNum(exp.num),
      actual: fmtNum(later[later.length - 1].num),
      reason: `Сравнение ПД и РД не выполнено: ${spread.map((x) => `в ${STAGE_RU[x.stage]} несколько разных значений — ${valueList(x.mentions)}`).join("; ")}. Значения относятся к разным объектам (участкам, маршам), какое с каким сопоставлять, по тексту не определить.${fails.length ? ` Нормы соблюдены у всех значений (CMP-06): ${fails.map((n) => n.text).join("; ")}.` : ""} Запросите ведомость с привязкой значений к объектам.`,
      fragments: used.map((m, i) => frag(m, i === 0 ? "expected" : "actual")),
    };
  }
  // 7. Кратность единиц (VER-13, OS-INSP-3.1.43): значение без единицы ровно в 1000 раз больше — не нарушение, а вопрос
  if (scale) {
    const unsure = (m: QuantityMention) => m.unit === null || m.unit_from === "page";
    const [u, k] = unsure(scale.m) ? [scale.m, exp] : [exp, scale.m];
    const show = (m: QuantityMention) => (m.unit === null ? `${fmtNum(m.num)} без единицы` : m.unit_from === "page" ? `${fmtNum(m.num)} (единица «${m.unit}» только в шапке листа)` : unitOf(m));
    return {
      ...base,
      status: "NOT_COMPARABLE",
      expected: fmtNum(exp.num),
      actual: fmtNum(scale.m.num),
      reason: `Единица значения не определена: ${STAGE_RU[u.stage]} — ${show(u)}, ${STAGE_RU[k.stage]} — ${show(k)}; отношение совпадает с пересчётом единиц паспорта (×${fmtNum(scale.k!)}). Запросите значение с единицей.`,
      fragments: [frag(exp, "expected"), frag(scale.m, "actual")],
    };
  }
  const fragments = [frag(exp, "expected"), ...later.map((m) => frag(m, "actual"))];
  const act = worst ?? later[later.length - 1];
  const d = act.num - exp.num;
  const pct = exp.num ? (d / exp.num) * 100 : 0;
  const delta = `${d > 0 ? "+" : ""}${fmtNum(d)} ${passport.unit} (${d > 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")} %)`;
  const extras = [variant.note].filter((x): x is string => x !== null);
  if (worst) {
    // фраза инспектора: что больше/меньше, на сколько, какой допуск; правило Матрицы — отдельным предложением
    const code = turnOf(worst)?.code ?? null;
    return { ...base, status: "CANDIDATE", code, expected: fmtNum(exp.num), actual: fmtNum(worst.num), delta, reason: [cmpSentence(worst), ...(code ? [`Код причины: ${code}.`] : []), ...extras, rule].join(" "), fragments };
  }
  const ruleText =
    passport.direction === "decrease"
      ? `не уменьшилось больше чем на ${fmtNum(allowed(passport, exp.num))} ${passport.unit}`
      : passport.direction === "increase"
        ? `не увеличилось больше чем на ${fmtNum(allowed(passport, exp.num))} ${passport.unit}`
        : passport.tolerance_pct
          ? `отклонение в пределах ${fmtNum(passport.tolerance_pct)} %`
          : `совпало в пределах точности ТЭП (±${fmtNum(passport.tolerance)} ${passport.unit})`;
  const good = later.filter((m) => better(passport, exp.num, m.num));
  if (good.length) extras.push(`Изменение в лучшую сторону (CMP-03, BETTER): ${good.map((m) => `${STAGE_RU[m.stage]} ${fmtNum(m.num)}`).join(", ")} против ${STAGE_RU[exp.stage]} ${fmtNum(exp.num)} — не нарушение, зафиксировано для инспектора.`);
  if (fails.length) extras.push(`Норма соблюдена (CMP-06): ${fails.map((n) => n.text).join("; ")}.`);
  if (warned.length) extras.push(`Рекомендация не выполнена — гипотеза для инспектора, не нарушение: ${warned.map(({ n, m }) => `${STAGE_RU[m.stage]} ${unitOf(m)} при ${n.text}`).join("; ")}.`);
  const softCode = soft.length ? turnOf(soft[0])!.code : null;
  if (softCode) extras.push(`Код причины: ${softCode} (уровень паспорта — ${levelOf(soft[0]) === "none" ? "не нарушение" : "гипотеза"}).`);
  const head = `${param.parameter_name}: ${ruleText}`;
  return { ...base, status: "NEGATIVE_VERIFIED", code: softCode, expected: fmtNum(exp.num), actual: fmtNum(act.num), delta, reason: extras.length ? `${head}. ${extras.join(" ")}` : head, fragments };
}

/**
 * Конфигурация аспекта как паспорт: источники, комплект и «много объектов» — общие, варианты — только у основного
 * показателя, норма — своя у аспекта (T-211, OS-INSP-3.1.145).
 */
export function aspectPassport(p: QuantityPassport, a: QuantityAspect): QuantityPassport {
  return {
    unit: a.unit, tolerance: a.tolerance, tolerance_pct: a.tolerance_pct, direction: a.direction, sources: p.sources, link: p.link,
    ...(a.norm ? { norm: a.norm } : {}),
    ...(a.change_codes ? { change_codes: a.change_codes } : {}),
    ...(p.multi_object ? { multi_object: true } : {}),
  };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const low = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/**
 * Сравнение количественного параметра (OS-INSP-3.1.18–3.1.20, 3.1.40–3.1.44). Аспекты паспорта сравниваются отдельно:
 * кандидат основного показателя важнее; иначе кандидат аспекта; нет основного значения — MISSING_EVIDENCE; спор или
 * несопоставимость аспекта понижает «нарушения нет»; необязательный аспект без значений не блокирует, но называется.
 */
export function evaluateQuantityParam(input: QuantityEvalInput): QuantityEvaluation {
  const p = input.passport;
  const byObject = p.multi_object ? objectGroups(input.mentions) : null;
  if (!byObject) return evaluatePlain(input);
  // T-211 (OS-INSP-3.1.149): у каждого значения известен объект, и хоть один объект есть в двух стадиях — стадии
  // сравниваются по объекту («П-1» с «П-1»), а не случайной парой; итог — худший по объектам
  const limits = input.mentions.filter((m) => m.limit);
  const evs = byObject.groups.map(([k, ms], i) => ({ k, ev: evaluatePlain({ ...input, mentions: [...ms, ...limits, ...(i === 0 ? byObject.rest : [])] }) }));
  const RANK: Record<string, number> = { CANDIDATE: 0, CLARIFICATION_REQUIRED: 1, NOT_COMPARABLE: 2, NEGATIVE_VERIFIED: 3, MISSING_EVIDENCE: 4, NOT_APPLICABLE: 5 };
  const top = evs.reduce((a, b) => ((RANK[b.ev.status] ?? 9) < (RANK[a.ev.status] ?? 9) ? b : a));
  const lone = evs.filter((x) => x !== top && x.ev.status === "MISSING_EVIDENCE").map((x) => `«${x.k}»`);
  return {
    ...top.ev,
    reason: `Объект «${top.k}»: ${top.ev.reason}${lone.length ? ` Без пары в другой стадии: ${lone.join(", ")}.` : ""}`,
    suspicions: evs.flatMap((x) => x.ev.suspicions),
    provenance: { ops: top.ev.provenance.ops, mentions: evs.flatMap((x) => x.ev.provenance.mentions) },
  };
}

/**
 * Группы по объекту (OS-INSP-3.1.149): только если у каждого действующего значения объект известен и хоть один объект
 * встречается в двух стадиях; иначе null — сравнение как без объектов. rest — отсеянные и устаревшие упоминания.
 */
export function objectGroups(ms: QuantityMention[]): { groups: Array<[string, QuantityMention[]]>; rest: QuantityMention[] } | null {
  const live = ms.filter((m) => m.excluded === null && m.role !== "SUPERSEDED" && !m.limit);
  if (!live.length || !live.every((m) => m.object)) return null;
  const groups = new Map<string, QuantityMention[]>();
  for (const m of live) groups.set(m.object!, [...(groups.get(m.object!) ?? []), m]);
  if (![...groups.values()].some((g) => new Set(g.map((m) => m.stage)).size > 1)) return null;
  return { groups: [...groups.entries()], rest: ms.filter((m) => !live.includes(m) && !m.limit) };
}

function evaluatePlain(input: QuantityEvalInput): QuantityEvaluation {
  const p = input.passport;
  const main = evaluateCore(input, input.mentions.filter((m) => !m.aspect), p, null);
  const aspects = p.aspects ?? [];
  if (!aspects.length) return main;
  const parts = aspects.map((a) => ({ a, ev: evaluateCore(input, input.mentions.filter((m) => m.aspect === a.key), aspectPassport(p, a), a) }));
  const merged = {
    suspicions: [...main.suspicions, ...parts.flatMap((x) => x.ev.suspicions)],
    provenance: { ops: main.provenance.ops, mentions: [...main.provenance.mentions, ...parts.flatMap((x) => x.ev.provenance.mentions)] },
  };
  const asPart = (x: (typeof parts)[number]) => ({ ...x.ev, ...merged, stage_notes: main.stage_notes, reason: `${cap(x.a.title)}: ${x.ev.reason}` });
  if (main.status === "NOT_APPLICABLE" || main.status === "CANDIDATE") return { ...main, ...merged };
  const cand = parts.find((x) => x.ev.status === "CANDIDATE");
  if (cand) return asPart(cand);
  if (main.status === "MISSING_EVIDENCE") {
    // T-211 (OS-INSP-3.1.145): основной показатель необязателен — решают аспекты, если их сравнили
    const say = parts.find((x) => x.ev.status === "CLARIFICATION_REQUIRED" || x.ev.status === "NOT_COMPARABLE") ?? parts.find((x) => x.ev.status === "NEGATIVE_VERIFIED");
    if (!p.main_optional || !say) return { ...main, ...merged };
    return { ...asPart(say), reason: `${cap(say.a.title)}: ${say.ev.reason} Основной показатель не сравнивался — ${low(main.reason)}` };
  }
  const doubt = parts.find((x) => x.ev.status === "CLARIFICATION_REQUIRED" || x.ev.status === "NOT_COMPARABLE" || (x.ev.status === "MISSING_EVIDENCE" && !x.a.optional));
  if (doubt && main.status === "NEGATIVE_VERIFIED") return asPart(doubt);
  const skipped = parts.filter((x) => x.ev.status === "MISSING_EVIDENCE").map((x) => `${cap(x.a.title)}: не сравнивалась — ${low(x.ev.reason)}`);
  return { ...main, ...merged, reason: [main.reason, ...skipped].join(". ") };
}
