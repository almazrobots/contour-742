// Эшелоны: L1 (правила М-082 и М-087), L3 (граница порога 10 %, одновременный старт), L5 (fast-check: рост в пределах
// порога не даёт кандидата), L6 (отказы: нет графика, рабочие дни, этап без пары, двусмысленное название).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-213. Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateSchedule, inversions, isCritical, matchStages, MAX_ORDER_PAIRS, MAX_STAGE_ROWS, orderable, overrun, pickSchedule, qualifiersDiffer, ruRegExp, similarity, stageKey, techWords, type ScheduleRow, type SchedulePassport } from "../src/domain/stage-schedule.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { ParamPassport } from "../src/domain/passport.ts";

// T-233: паспорта графика — в data/seed/passports/draft/ до цифр замера; загрузчик их не читает
const draftPassport = (code: string) => ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft", `${code}.json`), "utf8")));
import { extractorSpec } from "../src/domain/passport.ts";
import { schedulePassportOf, scheduleMentions } from "../src/domain/kinds/schedule.ts";
import { kindMentions, kindOf, kindSlice, suspicionRecord, type KindRow } from "../src/domain/param-kinds.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const SRC: SchedulePassport["sources"] = {
  PD: [{ discipline: "ПОС", label: "Проект организации строительства, календарный план — источник Матрицы" }, { discipline: "*" }],
  RD: [{ discipline: "ППР", label: "ППР — источник Матрицы" }, { discipline: "*" }],
  ID: [{ discipline: "*" }],
};
const P082: SchedulePassport = { tolerance_pct: 10, checks: ["duration"], critical: ["каркас", "подземн", "^(?:итого|всего)"], technologies: [], sources: SRC };
const TECH = [
  { id: "monolithic", title: "монолитный железобетон", pattern: "монолитн" },
  { id: "precast", title: "сборный железобетон", pattern: "сборн\\w*\\s+(?:ж\\.?\\s?/?\\s?б|железобетон|конструкц|элемент)" },
];
const P087: SchedulePassport = { tolerance_pct: 0, checks: ["order", "technology"], critical: [], technologies: TECH, sources: SRC };

const PARAM = (code: string, over: Partial<Param> = {}): Param => ({
  code,
  section: "ПОС",
  parameter_name: code === "M-082" ? "Продолжительность этапов строительства (Календарный график)" : "Технологическая последовательность возведения",
  unit: "дни",
  source_pd: "Текст ПОС; Календарный план",
  source_rd: "Укрупненный график СМР (ППР)",
  source_id: "Общий журнал работ",
  trigger_logic: code === "M-082" ? "Превышение продолжительности критического этапа в графике РД > 10%." : "Самовольное изменение критических технологий (например, монолит на сборный ЖБ).",
  review_priority: "MEDIUM",
  data_type: "string",
  compare: { kind: "delta_pct", tolerance: 10 },
  anchors: ["Продолжительность этапов строительства"],
  regex_pattern: null,
  value_scale: null,
  applicability: null,
  is_active: true,
  ...over,
});

const R = (stage: Stage, order: number, name: string, days: number | null, over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  stage,
  file_id: over.file_id ?? (stage === "PD" ? "pd1" : stage === "RD" ? "rd1" : "id1"),
  sha256: "a".repeat(64),
  document_code: stage === "PD" ? "П-100-ПОС" : "П-100-ППР",
  revision: "1",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
  role: "CURRENT",
  discipline: stage === "PD" ? "ПОС" : "ППР",
  table: 0,
  group: 0,
  seq: false,
  order,
  name,
  days,
  calendar: true,
  start: null,
  end: null,
  critical: false,
  total: false,
  tech: null,
  page: 3,
  bbox: [0.1, 0.2, 0.8, 0.22],
  quote: name,
  confidence: 1,
  ...over,
});

const PD3 = () => [R("PD", 1, "Подготовительный период", 30), R("PD", 2, "Устройство подземной части", 90), R("PD", 3, "Возведение каркаса надземной части", 120)];
const run = (rows: ScheduleRow[], passport = P082, code = "M-082", loaded: Stage[] = ["PD", "RD"], over: Partial<Param> = {}) =>
  evaluateSchedule({ param: PARAM(code, over), passport, rows, loadedStages: loaded, profile: {} });

describe("ENT-24 и NRM-06: канон названия и сопоставление этапов (OS-INSP-3.1.161)", () => {
  it("канон этапа: номер строки, регистр, «ё», служебные слова и окончания не различают этапы", () => {
    expect(stageKey("1.2. Работы по устройству подземной части")).toBe(stageKey("Устройство подземной частИ"));
    expect(stageKey("Этап 3 Возведение каркаса")).toBe("каркас");
    // сокращения, скобки, окончания: «Надземная ч.» = «надземная часть», «ИС» = «инженерные системы»
    expect(stageKey("Надземная ч.")).toBe(stageKey("Надземная часть"));
    expect(stageKey("ИС")).toBe(stageKey("Инженерные системы"));
    expect(stageKey("Гидроизоляция стен (с внутренней стороны)")).toBe(stageKey("гидроизоляция стены"));
    expect(stageKey("Монтаж ёмкостей")).toBe(stageKey("монтаж емкостей"));
    expect(stageKey("Секция 1")).not.toBe(stageKey("Секция 2"));
  });

  it("этапы сопоставляются по канону, затем по взаимно лучшему сходству слов", () => {
    const pd = PD3();
    const rd = [R("RD", 1, "Подготовительные работы", 28), R("RD", 2, "Устройство подземной части здания", 95), R("RD", 3, "Каркас надземной части — возведение", 125)];
    const m = matchStages(pd, rd);
    expect(m.pairs.map((p) => [p.pd.order, p.rd.order]).sort()).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(m.unmatchedPd).toEqual([]);
    expect(m.unmatchedRd).toEqual([]);
  });

  it("сходство — доля слов короткого названия в длинном; сокращение слова «земл.» = «земляные»; объединённый этап не делится", () => {
    expect(similarity(stageKey("Фундаменты"), stageKey("Фундаментная плита"))).toBe(1);
    expect(similarity(stageKey("Земл. работы"), stageKey("Земляные работы"))).toBe(1);
    expect(similarity(stageKey("Кровля"), stageKey("Отделка"))).toBe(0);
    expect(similarity("", "каркас")).toBe(0);
    // «Наружные работы (кровля, фасады)» объединяет два этапа ПД: скобки не участвуют, пары нет
    const m = matchStages([R("PD", 1, "Кровля", 30), R("PD", 2, "Фасады", 60)], [R("RD", 1, "Наружные работы (кровля, фасады)", 150)]);
    expect(m.pairs).toEqual([]);
    // два этапа ПД одинаково похожи на один этап РД — пары нет ни у одного
    const tie = matchStages([R("PD", 1, "Монтаж каркаса", 30), R("PD", 2, "Каркас", 60)], [R("RD", 1, "Каркас здания", 150)]);
    expect(tie.pairs).toEqual([]);
  });

  it("двусмысленное название — пары нет: этап называется, а не угадывается", () => {
    const pd = [R("PD", 1, "Монтаж каркаса", 60)];
    const rd = [R("RD", 1, "Монтаж каркаса А", 40), R("RD", 2, "Монтаж каркаса Б", 40)];
    const m = matchStages(pd, rd);
    expect(m.pairs).toEqual([]);
    expect(m.ambiguous).toEqual([pd[0]]);
    const twins = matchStages([R("PD", 1, "Кровля", 10), R("PD", 2, "Кровля", 12)], [R("RD", 1, "Кровля", 11)]);
    expect(twins.pairs).toEqual([]);
    expect(twins.ambiguous).toHaveLength(2);
  });

  it("похожие, но разные этапы не сопоставляются: номер секции или корпуса и уточнение объекта разводят этапы", () => {
    const m = matchStages([R("PD", 1, "Монтаж каркаса 1 секции", 60), R("PD", 2, "Устройство кровли", 20)], [R("RD", 1, "Монтаж каркаса 2 секции", 90), R("RD", 2, "Устройство кровли паркинга", 40)]);
    expect(m.pairs).toEqual([]);
    expect(m.unmatchedPd.map((r) => r.name)).toEqual(["Монтаж каркаса 1 секции", "Устройство кровли"]);
    expect(qualifiersDiffer(stageKey("Каркас корпуса А"), stageKey("Каркас"))).toBe(true);
    expect(qualifiersDiffer(stageKey("Устройство подземной части здания"), stageKey("Устройство подземной части"))).toBe(false);
    // та же секция в обоих — пара есть; CMP-22 не сравнивает каркас 1 секции с каркасом 2 секции
    const same = matchStages([R("PD", 1, "Монтаж каркаса 1 секции", 60), R("PD", 2, "Монтаж каркаса 2 секции", 60)], [R("RD", 1, "Каркас 2 секции — монтаж", 90), R("RD", 2, "Каркас 1 секции — монтаж", 61)]);
    expect(same.pairs.map((p) => [p.pd.name, p.rd.name])).toEqual([
      ["Монтаж каркаса 1 секции", "Каркас 1 секции — монтаж"],
      ["Монтаж каркаса 2 секции", "Каркас 2 секции — монтаж"],
    ]);
    const ev = run([R("PD", 1, "Монтаж каркаса 1 секции", 60), R("RD", 1, "Монтаж каркаса 2 секции", 200)]);
    expect(ev.status).toBe("NOT_COMPARABLE");
  });

  it("слова технологии и «железобетон» не различают этап: монолитный и сборный каркас — один этап", () => {
    const pd = [R("PD", 1, "Возведение каркаса из монолитного железобетона", 120)];
    const rd = [R("RD", 1, "Возведение каркаса из сборного ж/б", 120)];
    expect(matchStages(pd, rd).pairs).toHaveLength(0);
    expect(matchStages(pd, rd, techWords(P087)).pairs).toHaveLength(1);
    expect(ruRegExp("сборн\\w*\\s+ж").test("Сборного ж/б")).toBe(true);
  });
});

describe("LNK-01 и VER-15: один график на стадию (OS-INSP-3.1.160)", () => {
  it("график стадии — из раздела с высшим приоритетом паспорта, затем по числу строк; устаревшая редакция не участвует", () => {
    const pos = PD3();
    const other = [R("PD", 1, "Подготовительный период", 40, { file_id: "pz", discipline: "ПЗ" }), R("PD", 2, "Каркас", 200, { file_id: "pz", discipline: "ПЗ" })];
    const old = [R("PD", 1, "Каркас", 10, { file_id: "old", role: "SUPERSEDED" })];
    const pk = pickSchedule([...other, ...old, ...pos], "PD", P082);
    expect(pk.chosen.map((r) => r.file_id)).toEqual(["pd1", "pd1", "pd1"]);
    expect(pk.others).toHaveLength(2);
    expect(pk.dropped).toEqual(old);
    // все этапы документа — и таблицы, и фразы — по порядку групп
    const two = pickSchedule([R("RD", 2, "В этап", 1, { group: 1 }), R("RD", 1, "Б этап", 1, { group: 1 }), R("RD", 1, "А этап", 1, { group: 0 })], "RD", P082);
    expect(two.chosen.map((r) => r.name)).toEqual(["А этап", "Б этап", "В этап"]);
  });

  it("спорная редакция графика — CLARIFICATION_REQUIRED, сравнение не выполняется", () => {
    const ev = run([...PD3(), R("RD", 1, "Каркас надземной части", 200, { role: "CONFLICT" })]);
    expect(ev.status).toBe("CLARIFICATION_REQUIRED");
    expect(ev.reason).toContain("П-100-ППР ред. 1");
  });
});

describe("CMP-22: длительность критического этапа, М-082 (OS-INSP-3.1.162, 3.1.163)", () => {
  it("критический этап РД длиннее ПД больше чем на 10 % — CANDIDATE с expected, actual и delta", () => {
    const ev = run([...PD3(), R("RD", 1, "Подготовительный период", 30), R("RD", 2, "Устройство подземной части", 95), R("RD", 3, "Возведение каркаса надземной части", 150)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("120 дн.");
    expect(ev.actual).toBe("150 дн.");
    expect(ev.delta).toBe("+30 дн. (+25 %)");
    expect(ev.reason).toContain("на 25 % дольше, порог 10 %");
    expect(ev.reason).toContain("Правило Матрицы: Превышение продолжительности");
    expect(ev.fragments.map((f) => [f.stage, f.kind, f.value])).toEqual([
      ["PD", "expected", "120 дн."],
      ["RD", "actual", "150 дн."],
    ]);
  });

  it("граница порога: ровно +10 % — не нарушение, +10,1 % — кандидат", () => {
    const at = (rd: number) => run([R("PD", 1, "Каркас", 100), R("RD", 1, "Каркас", rd)]).status;
    expect(at(110)).toBe("NEGATIVE_VERIFIED");
    expect(at(110.1)).toBe("CANDIDATE");
    expect(at(80)).toBe("NEGATIVE_VERIFIED");
    expect(overrun(R("PD", 1, "К", 0), R("RD", 1, "К", 5))).toBeNull();
  });

  it("некритический этап длиннее больше порога — не нарушение, но назван в причине", () => {
    // критический путь выделен в документе: каркас помечен, подготовительный период — нет
    const pd = [R("PD", 1, "Подготовительный период", 30), R("PD", 2, "Устройство подземной части", 90), R("PD", 3, "Возведение каркаса надземной части", 120, { critical: true })];
    const ev = run([...pd, R("RD", 1, "Подготовительный период", 60), R("RD", 2, "Устройство подземной части", 90), R("RD", 3, "Возведение каркаса надземной части", 120)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("этап не критический");
    expect(ev.reason).toContain("сопоставлено этапов — 3");
  });

  it("критичность: пометка в документе, итоговая строка или название из перечня паспорта", () => {
    expect(isCritical(R("PD", 1, "Отделка", 10, { critical: true }), P082)).toBe(true);
    expect(isCritical(R("PD", 1, "Общая продолжительность", 10, { total: true }), P082)).toBe(true);
    expect(isCritical(R("PD", 1, "Итого по объекту", 10), P082)).toBe(true);
    expect(isCritical(R("PD", 1, "Благоустройство", 10), P082)).toBe(false);
    // критический путь не выделен ни в одном графике — критичен каждый этап: решает инспектор
    expect(isCritical(R("PD", 1, "Благоустройство", 10), P082, false)).toBe(true);
    // этап из перечня паспорта или помеченный в документе — кандидат
    expect(run([R("PD", 1, "Монтаж лифтов", 35, { critical: true }), R("RD", 1, "Монтаж лифтов", 56)]).status).toBe("CANDIDATE");
    const ev = run([R("PD", 1, "Отделка", 30, { critical: true }), R("RD", 1, "Отделка", 40)]);
    expect(ev.status).toBe("CANDIDATE");
  });

  it("рабочие дни против календарных не сравниваются — NOT_COMPARABLE с причиной", () => {
    const ev = run([R("PD", 1, "Каркас", 120), R("RD", 1, "Каркас", 200, { calendar: false })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("рабочие и календарные дни не сравниваются");
    expect(run([R("PD", 1, "Каркас", null), R("RD", 1, "Каркас", 200)]).reason).toContain("нет длительности в ПД");
  });

  it("критический этап ПД без пары в РД — NOT_COMPARABLE, а не «в пределах порога»", () => {
    const ev = run([...PD3(), R("RD", 1, "Подготовительный период", 30), R("RD", 2, "Устройство подземной части", 90)]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("Критические этапы ПД не найдены в графике РД: «Возведение каркаса надземной части»");
    expect(ev.reason).toContain("Не сопоставлены (не нарушение)");
  });

  it("ни один этап не сопоставлен — NOT_COMPARABLE; сопоставлены только некритические — сравнивать нечего", () => {
    expect(run([R("PD", 1, "Каркас", 120), R("RD", 1, "Благоустройство территории", 30)]).status).toBe("NOT_COMPARABLE");
    const ev = run([R("PD", 1, "Благоустройство", 30), R("RD", 1, "Благоустройство", 31), R("RD", 2, "Отделка", 10, { critical: true })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("сравнить нечего");
  });
});

describe("GTE-01 и GTE-02: применимость и комплектность (OS-INSP-3.1.166)", () => {
  it("нет графика в РД — MISSING_EVIDENCE: что найдено и что запросить, не нарушение", () => {
    const ev = run(PD3());
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("в ПД график из 3 этапов (П-100-ПОС)");
    expect(ev.reason).toContain("РД: график производства работ ППР (таблица этапов) — графика в документах стадии нет");
    expect(ev.stage_notes).toEqual({ PD: "USED", RD: "NO_VALUE", ID: "NOT_APPLICABLE" });
    const none = run([], P082, "M-082", ["PD"]);
    expect(none.reason).toContain("графика нет ни в одной стадии");
    expect(none.reason).toContain("РД: график производства работ ППР (таблица этапов) — стадия не загружена");
    expect(run([R("RD", 1, "Каркас", 10)]).reason).toContain("в РД график из 1 этапов");
  });

  it("неприменимый параметр — NOT_APPLICABLE до сравнения", () => {
    const ev = run([...PD3(), R("RD", 3, "Возведение каркаса надземной части", 500)], P082, "M-082", ["PD", "RD"], { applicability: "new_build" });
    expect(evaluateSchedule({ param: PARAM("M-082", { applicability: "new_build" }), passport: P082, rows: PD3(), loadedStages: ["PD", "RD"], profile: { new_build: false } }).status).toBe("NOT_APPLICABLE");
    expect(ev.status).toBe("CANDIDATE");
  });

  it("карточка: все строки стадий с использованием — взятые, справочные, устаревшие", () => {
    const rows = [...PD3(), R("PD", 1, "Каркас", 10, { file_id: "old", role: "SUPERSEDED" }), R("PD", 1, "Каркас", 10, { file_id: "pz", discipline: "ПЗ" }), R("RD", 1, "Каркас надземной части", 120)];
    const ev = run(rows);
    expect(ev.provenance.ops).toContain("CMP-22");
    expect(ev.provenance.mentions.map((m) => m.use)).toEqual(["chosen", "chosen", "chosen", "dropped", "reference", "chosen"]);
    expect(ev.provenance.mentions[0].value).toBe("Подготовительный период: 30 дн.");
  });
});

describe("CMP-22 порядок и CMP-23 технология, М-087 (OS-INSP-3.1.164, 3.1.165)", () => {
  const pd = () => [R("PD", 1, "Фундаменты", 60), R("PD", 2, "Каркас", 120, { tech: "monolithic" }), R("PD", 3, "Кровля", 30)];

  it("тот же порядок и технология — NEGATIVE_VERIFIED", () => {
    const ev = run([...pd(), R("RD", 1, "Фундаменты", 70), R("RD", 2, "Каркас", 150, { tech: "monolithic" }), R("RD", 3, "Кровля", 30)], P087, "M-087");
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("порядок этапов тот же, технологии этапов те же");
  });

  it("этапы переставлены по датам начала — CANDIDATE с парой этапов обеих стадий", () => {
    const d = (stage: Stage, order: number, name: string, start: string) => R(stage, order, name, 30, { start, end: start });
    const ev = run([d("PD", 1, "Фундаменты", "2025-03-01"), d("PD", 2, "Каркас", "2025-05-01"), d("PD", 3, "Кровля", "2025-09-01"), d("RD", 1, "Фундаменты", "2025-03-01"), d("RD", 2, "Каркас", "2025-10-01"), d("RD", 3, "Кровля", "2025-08-01")], P087, "M-087");
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("порядок этапов изменён: в ПД «Каркас» (П-100-ПОС, стр. 3) раньше «Кровля»");
    expect(ev.reason).toContain("по датам начала");
    expect(ev.expected).toBe("Каркас → Кровля");
    expect(ev.actual).toBe("Кровля → Каркас");
    expect(ev.suspicions).toEqual([]);
  });

  it("явно заданная последовательность переставлена — CANDIDATE; разные фразы и параллельные работы не сравниваются", () => {
    const S = (stage: Stage, order: number, name: string, group = 0) => R(stage, order, name, null, { seq: true, group });
    const ev = run([S("PD", 1, "Гидроизоляция"), S("PD", 2, "Обратная засыпка"), S("RD", 1, "Обратная засыпка"), S("RD", 2, "Гидроизоляция")], P087, "M-087");
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("по явно заданной последовательности");
    // этапы из разных фраз РД: порядок фраз не задан — не сравнивается
    const apart = run([S("PD", 1, "Каркас"), S("PD", 2, "Кровля"), S("RD", 1, "Кровля", 0), S("RD", 1, "Каркас", 1)], P087, "M-087");
    expect(apart.status).toBe("NOT_COMPARABLE");
    // «параллельно»: равный номер — не перестановка
    const par = run([S("PD", 1, "Каркас"), S("PD", 2, "Отделка"), S("RD", 1, "Отделка"), S("RD", 1, "Каркас")], P087, "M-087");
    expect(par.status).toBe("NEGATIVE_VERIFIED");
  });

  it("этапы переставлены только в строках графика, без дат — гипотеза для инспектора, не кандидат", () => {
    const ev = run([...pd(), R("RD", 1, "Фундаменты", 60), R("RD", 2, "Кровля", 30), R("RD", 3, "Каркас", 120)], P087, "M-087");
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("Порядок этапов по датам или словам очерёдности подтвердить нельзя");
    expect(ev.reason).toContain("Гипотеза для инспектора, не нарушение: перестановка без дат и без слов очерёдности: «Каркас» и «Кровля»");
    expect(ev.suspicions).toHaveLength(1);
    expect(ev.suspicions[0].description).toContain("M-087: в графике РД этап «Кровля» стоит выше «Каркас», в ПД — наоборот; дат начала нет");
    expect(ev.suspicions[0].rows.map((r) => r.stage)).toEqual(["PD", "PD", "RD", "RD"]);
    expect(ev.suspicions[0].dedup_key).toBe("schedule-order:M-087:каркас>кровл");
    // смена технологии при этом остаётся кандидатом, гипотеза — в причине
    const tech = run([...pd(), R("RD", 1, "Фундаменты", 60), R("RD", 2, "Кровля", 30), R("RD", 3, "Каркас", 120, { tech: "precast" })], P087, "M-087");
    expect(tech.status).toBe("CANDIDATE");
    expect(tech.reason).toContain("Гипотеза для инспектора");
    expect(tech.suspicions).toHaveLength(1);
  });

  it("порядок по датам начала: одновременный старт — не перестановка, обратные даты — перестановка", () => {
    const d = (stage: Stage, order: number, name: string, start: string) => R(stage, order, name, 30, { start, end: start });
    const same = inversions(matchStages([d("PD", 1, "Каркас", "2025-03-01"), d("PD", 2, "Сети", "2025-04-01")], [d("RD", 1, "Сети", "2025-03-01"), d("RD", 2, "Каркас", "2025-03-01")]).pairs);
    expect(same).toEqual([]);
    const back = inversions(matchStages([d("PD", 1, "Каркас", "2025-03-01"), d("PD", 2, "Сети", "2025-04-01")], [d("RD", 1, "Каркас", "2025-05-01"), d("RD", 2, "Сети", "2025-04-01")]).pairs);
    expect(back.map(([a, b, by]) => [a.pd.name, b.pd.name, by])).toEqual([["Каркас", "Сети", "dates"]]);
  });

  it("монолит заменён сборным железобетоном — CANDIDATE со сменой технологии", () => {
    const ev = run(
      [R("PD", 1, "Возведение каркаса из монолитного железобетона", 120, { tech: "monolithic" }), R("RD", 1, "Возведение каркаса из сборного ж/б", 120, { tech: "precast" })],
      P087,
      "M-087",
    );
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("в ПД — монолитный железобетон, в РД — сборный железобетон");
    expect(ev.delta).toBe("смена технологии");
    expect(ev.fragments.map((f) => f.value)).toEqual(["монолитный железобетон", "сборный железобетон"]);
  });

  it("технология не распознана в одной стадии — не сравнивается; один этап без технологии — сравнивать нечего", () => {
    const ev = run([R("PD", 1, "Каркас", 120, { tech: "monolithic" }), R("RD", 1, "Каркас", 120)], P087, "M-087");
    expect(ev.status).toBe("NOT_COMPARABLE");
    const two = run([...pd(), R("RD", 1, "Фундаменты", 60), R("RD", 2, "Каркас", 120), R("RD", 3, "Кровля", 30)], P087, "M-087");
    expect(two.status).toBe("NEGATIVE_VERIFIED");
    expect(two.reason).not.toContain("технологии этапов те же");
  });
});

describe("паспорта М-082, М-087 (T-213)", () => {
  it("паспорта графика проходят схему, конфигурация сравнения и спецификация ML — из паспорта", () => {
    const m082 = draftPassport("M-082");
    const m087 = draftPassport("M-087");
    expect(schedulePassportOf(kindSlice(m082))).toMatchObject({ tolerance_pct: 10, checks: ["duration"] });
    expect(schedulePassportOf(kindSlice(m087)).technologies.map((t) => t.id)).toContain("precast");
    expect(extractorSpec(m087)).toMatchObject({ kind: "schedule_rows", technologies: expect.arrayContaining([expect.objectContaining({ id: "monolithic" }), expect.objectContaining({ id: "full_height", sentence: true })]) });
    const crit = schedulePassportOf(kindSlice(m082));
    expect(isCritical(R("PD", 1, "Устройство нулевого цикла", 1), crit)).toBe(true);
    expect(isCritical(R("PD", 1, "Благоустройство", 1), crit)).toBe(false);
  });
});

describe("свойства CMP-22 (L5)", () => {
  it("рост длительности каждого этапа не больше порога никогда не даёт кандидата; порядок тот же — нет перестановок", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 900 }), fc.double({ min: 0.5, max: 1.1, noNaN: true })), { minLength: 1, maxLength: 6 }), (xs) => {
        const pd = xs.map(([d], i) => R("PD", i + 1, `Каркас корпус ${i + 1}`, d));
        const rd = xs.map(([d, k], i) => R("RD", i + 1, `Каркас корпус ${i + 1}`, Math.round(d * k * 1000) / 1000));
        const ev = run([...pd, ...rd]);
        expect(ev.status).not.toBe("CANDIDATE");
        expect(inversions(matchStages(pd, rd).pairs)).toEqual([]);
      }),
    );
  });
});

describe("вид «schedule» в реестре видов (domain/kinds/schedule.ts)", () => {
  const row = (stage: Stage, meta: unknown, over: Partial<KindRow> = {}): KindRow => ({
    file_id: `${stage}-f`, value_num: 120, value_text: "Каркас", page: 4, bbox_json: "[0.1,0.2,0.3,0.25]", sha256: "c".repeat(64), doc_stage: stage,
    document_code: stage === "PD" ? "П-9-ПОС" : "П-9-ППР", revision: "1", approval_status: null, revision_role: "CURRENT", discipline: stage === "PD" ? "ПОС" : null,
    meta_json: meta === undefined ? null : JSON.stringify(meta), line_text: "Каркас 120 дн.", confidence: 0.9, ...over,
  });

  it("строки извлечения собираются в строки графика; чужие строки — мимо", () => {
    const m = scheduleMentions([
      row("PD", { kind: "schedule_row", table: 1, group: 3, seq: true, order: 2, start: "2025-03-01", end: "2025-06-28", calendar: false, critical: true, tech: "monolithic", quote: "Каркас 120 раб. дн." }),
      row("PD", undefined),
      row("PD", { kind: "other" }),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ table: 1, group: 3, seq: true, order: 2, calendar: false, critical: true, total: false, tech: "monolithic", discipline: "ПОС", start: "2025-03-01", quote: "Каркас 120 раб. дн.", bbox: [0.1, 0.2, 0.3, 0.25] });
    expect(scheduleMentions([row("RD", { kind: "schedule_row" })])[0]).toMatchObject({ group: 0, seq: false, start: null, tech: null });
  });

  it("вид зарегистрирован: оценка графиком; гипотеза перестановки без дат — общим путём записи с опорой на строку РД", () => {
    const kd = kindOf("schedule")!;
    const pp = draftPassport("M-087");
    const rows = [row("PD", { kind: "schedule_row", order: 1 }, { value_text: "Каркас" }), row("PD", { kind: "schedule_row", order: 2 }, { value_text: "Кровля" }), row("RD", { kind: "schedule_row", order: 1 }, { value_text: "Кровля" }), row("RD", { kind: "schedule_row", order: 2 }, { value_text: "Каркас", confidence: 0.7 })];
    const ev = kd.evaluate({ param: PARAM("M-087"), passport: kindSlice(pp), mentions: kindMentions(kd, rows), loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(), pdKitPresent: false });
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.suspicions).toHaveLength(1);
    const rec = suspicionRecord("M-087", ev.suspicions[0], pp.basis, kd.quote);
    expect(rec.dedup_key).toBe("M-087:schedule-order:M-087:каркас>кровл");
    expect(rec.description).toMatch(/^M-087: в графике РД этап «Кровля» стоит выше «Каркас»/);
    expect(rec.confidence).toBe(0.7);
    expect(JSON.parse(rec.anchor!)).toMatchObject({ page: 4, quote: "Каркас" });
    expect(kindOf("doc_requirements")).not.toBeNull();
  });
});

describe("аудит W3: пределы и несравнимые критические этапы", () => {
  it("W3-10: несравнимый критический этап не даёт NEGATIVE_VERIFIED, даже если другой этап сравнился", () => {
    const ev = run([R("PD", 1, "Каркас", 120), R("PD", 2, "Подземная часть", 90), R("RD", 1, "Каркас", 125), R("RD", 2, "Подземная часть", 100, { calendar: false })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("Длительность критических этапов сравнить нельзя");
    const noDays = run([R("PD", 1, "Каркас", 120), R("PD", 2, "Кровля", null), R("RD", 1, "Каркас", 125), R("RD", 2, "Кровля", 30)]);
    expect(noDays.status).toBe("NOT_COMPARABLE");
    // кандидат по другому этапу остаётся кандидатом
    expect(run([R("PD", 1, "Каркас", 100), R("PD", 2, "Кровля", null), R("RD", 1, "Каркас", 150), R("RD", 2, "Кровля", 30)]).status).toBe("CANDIDATE");
  });

  it("W3-04: тысячи этапов сопоставляются быстро; пары для порядка и этапы стадии ограничены", () => {
    const n = 1500;
    const pd = Array.from({ length: n }, (_, i) => R("PD", i + 1, `Работа участка ${i} позиция ${i * 7}`, 10));
    const rd = Array.from({ length: n }, (_, i) => R("RD", i + 1, `Работа участка ${i} позиция ${i * 7}`, 10));
    const t0 = Date.now();
    const ev = run([...pd, ...rd]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(pickSchedule(pd, "PD", P082).chosen).toHaveLength(MAX_STAGE_ROWS);
    const pairs = Array.from({ length: 300 }, (_, i) => ({ pd: R("PD", i, `Э${i}`, 1), rd: R("RD", i, `Э${i}`, 1) }));
    expect(orderable(pairs).length).toBe((MAX_ORDER_PAIRS * (MAX_ORDER_PAIRS - 1)) / 2);
  });

  it("W3-06: поля из ML обрезаются, даты — только ISO, длительность — только конечная", () => {
    const [m] = scheduleMentions([
      { file_id: "f", value_num: Infinity, value_text: "Э".repeat(500), page: 1, bbox_json: null, sha256: "c".repeat(64), doc_stage: "PD", document_code: "П-1-ПОС", revision: "1", approval_status: null, revision_role: "CURRENT", discipline: null,
        meta_json: JSON.stringify({ kind: "schedule_row", start: "01.03.2025", end: "2025-03-31", tech: "т".repeat(100), quote: "ц".repeat(1000) }), line_text: "", confidence: 1 },
    ]);
    expect([m.name.length, m.days, m.start, m.end, m.tech!.length, m.quote.length]).toEqual([200, null, null, "2025-03-31", 40, 240]);
  });
});

describe("слепой замер v2: критичность не установлена, нумерация — не очерёдность", () => {
  it("критический путь не выделен и этапа нет в перечне паспорта — превышение даёт гипотезу, а не кандидата", () => {
    const ev = run([R("PD", 1, "Монтаж лифтов", 35), R("RD", 1, "Монтаж лифтов", 56)]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("Критичность этапов не установлена");
    expect(ev.suspicions).toHaveLength(1);
    expect(ev.suspicions[0]).toMatchObject({ kind: "criticality", dedup_key: "schedule-critical:M-082:лифт" });  // ключ — основа слова (stem снимает «ов», NRM-06), а не словоформа
    expect(ev.suspicions[0].description).toContain("критичность этапа не установлена");
    // этап из перечня паспорта («каркас») — кандидат, как прежде; в пределах порога — ни гипотезы, ни кандидата
    expect(run([R("PD", 1, "Каркас", 100), R("RD", 1, "Каркас", 130)]).status).toBe("CANDIDATE");
    const ok = run([R("PD", 1, "Монтаж лифтов", 35), R("RD", 1, "Монтаж лифтов", 36)]);
    expect([ok.status, ok.suspicions.length]).toEqual(["NEGATIVE_VERIFIED", 0]);
    // критический путь выделен, этап не помечен — не нарушение без гипотезы
    const marked = run([R("PD", 1, "Монтаж лифтов", 35), R("PD", 2, "Каркас", 100, { critical: true }), R("RD", 1, "Монтаж лифтов", 56), R("RD", 2, "Каркас", 100)]);
    expect([marked.status, marked.suspicions.length]).toEqual(["NEGATIVE_VERIFIED", 0]);
    expect(marked.reason).toContain("этап не критический");
  });
});

