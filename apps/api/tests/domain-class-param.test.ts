// Эшелоны: L1 (правила М-023), L3 (границы шкалы и приоритетов), L5 (fast-check: инварианты выбора и сравнения),
// L6 (ловушки реального пакета: соседнее здание, таблица норм, другой комплект ПД, противоречие внутри стадии).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-129.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inPassportSources, classRank, conflictAnchor, evaluateClassParam, mentionTrace, pickStage, sourceRank, type ClassPassport, type Mention } from "../src/domain/class-param.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const SCALE = ["С3", "С2", "С1", "С0"];
const PASS: ClassPassport = {
  scale: SCALE,
  sources: {
    PD: [{ discipline: "ПЗ" }, { discipline: "ПБ" }, { discipline: "АР" }, { discipline: "КР" }, { discipline: "*" }],
    RD: [{ discipline: "АР" }, { discipline: "КР" }, { discipline: "КЖ" }, { discipline: "КМ" }, { discipline: "*" }],
    ID: [{ discipline: "*" }],
  },
  link: "base_cipher",
};
const PARAM: Param = {
  code: "M-023",
  section: "ПЗ",
  parameter_name: "Класс конструктивной пожарной опасности",
  unit: "Класс (С0–С3)",
  source_pd: "Раздел ПЗ",
  source_rd: "АР/КР Общие данные",
  source_id: "Заключение ГПН",
  trigger_logic: "Снижение класса в РД",
  review_priority: "HIGH",
  data_type: "enum",
  compare: { kind: "decrease" },
  anchors: ["Класс конструктивной пожарной опасности"],
  regex_pattern: null,
  value_scale: SCALE,
  applicability: null,
  is_active: true,
};

let seq = 0;
const M = (stage: Stage, value: string, over: Partial<Mention> = {}): Mention => ({
  stage,
  file_id: `f-${stage}-${over.discipline ?? "АР"}-${++seq}`,
  sha256: "a".repeat(64),
  document_code: `П-2099-01-001-${over.discipline ?? "АР"}`,
  revision: "0",
  approval_status: stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED",
  role: "CURRENT",
  discipline: "АР",
  base: "2099-01-001",
  value,
  qualifier: null,
  excluded: null,
  excluded_why: null,
  page: 3,
  bbox: [0.1, 0.2, 0.3, 0.25],
  quote: `класс конструктивной пожарной опасности – ${value}`,
  confidence: 1,
  ...over,
});
const run = (mentions: Mention[], loaded: Stage[] = ["PD", "RD"], profile = {}) => evaluateClassParam({ param: PARAM, passport: PASS, mentions, loadedStages: loaded, profile });

describe("М-023: шкала и приоритет источников", () => {
  it("шкала С3 < С2 < С1 < С0: ранг растёт к лучшему классу, вне шкалы — null", () => {
    expect(classRank(SCALE, "С3")).toBe(0);
    expect(classRank(SCALE, "С0")).toBe(3);
    expect(classRank(SCALE, "С4")).toBeNull();
    expect(classRank(SCALE, "")).toBeNull();
  });
  it("приоритет источников ПД: ПЗ, ПБ, АР, КР, затем прочие; неизвестный раздел — как прочие", () => {
    expect(["ПЗ", "ПБ", "АР", "КР", "ПОС", null].map((d) => sourceRank(PASS, "PD", d))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(["АР", "КР", "КЖ", "КМ", "ОВ"].map((d) => sourceRank(PASS, "RD", d))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("М-023: выбор значения стадии (OS-INSP-3.1.10, 3.1.11)", () => {
  it("значение стадии берётся из раздела с высшим приоритетом: в ПД АР важнее КР", () => {
    const p = pickStage([M("PD", "С1", { discipline: "КР" }), M("PD", "С0", { discipline: "АР" })], "PD", PASS, new Set(["2099-01-001"]));
    expect(p.chosen?.value).toBe("С0");
    expect(p.chosen?.discipline).toBe("АР");
  });
  it("в одном разделе точное значение важнее ограничения «не ниже»", () => {
    const p = pickStage([M("PD", "С1", { discipline: "ПБ", qualifier: "min" }), M("PD", "С0", { discipline: "ПБ" })], "PD", PASS, null);
    expect(p.chosen?.qualifier).toBeNull();
  });
  it("ПД берётся только из комплекта, связанного с РД по базовому шифру, другой комплект — справочно", () => {
    const own = M("PD", "С1", { discipline: "КР" });
    const other = M("PD", "С0", { discipline: "ПЗ", base: "ЖС-РД-000000" });
    const p = pickStage([own, other], "PD", PASS, new Set(["2099-01-001"]));
    expect(p.chosen).toBe(own);
    expect(p.reference).toEqual([other]);
  });
  it("если ни одно упоминание ПД не из связанного комплекта, берётся лучшее из всех с пометкой", () => {
    const other = M("PD", "С0", { discipline: "ПЗ", base: "ЖС-РД-000000" });
    const p = pickStage([other], "PD", PASS, new Set(["2099-01-001"]));
    expect(p.chosen).toBe(other);
    expect(p.note).toMatch(/не связан/);
  });
  it("отсеянные упоминания и значения вне шкалы не выбираются и перечисляются отдельно", () => {
    const n = M("PD", "С1", { discipline: "ПЗ", excluded: "NEIGHBOR", excluded_why: "соседнее здание" });
    const p = pickStage([n, M("PD", "С5", { discipline: "ПЗ" })], "PD", PASS, null);
    expect(p.chosen).toBeNull();
    expect(p.dropped.length).toBe(2);
  });
  it("устаревшая редакция не участвует в выборе", () => {
    const p = pickStage([M("RD", "С2", { role: "SUPERSEDED" })], "RD", PASS, null);
    expect(p.chosen).toBeNull();
  });
});

describe("М-023: сравнение по шкале (OS-INSP-3.1.13, 3.1.14)", () => {
  it("класс РД ниже класса ПД — CANDIDATE с фрагментами обеих стадий", () => {
    const e = run([M("PD", "С0"), M("RD", "С1")]);
    expect(e.status).toBe("CANDIDATE");
    expect(e.expected).toBe("С0");
    expect(e.actual).toBe("С1");
    expect(e.delta).toBe("С0 → С1");
    expect(e.fragments.map((f) => [f.stage, f.kind])).toEqual([["PD", "expected"], ["RD", "actual"]]);
  });
  it("класс РД не ниже класса ПД — NEGATIVE_VERIFIED с фрагментами обеих стадий", () => {
    expect(run([M("PD", "С1"), M("RD", "С1")]).status).toBe("NEGATIVE_VERIFIED");
    const up = run([M("PD", "С1"), M("RD", "С0")]);
    expect(up.status).toBe("NEGATIVE_VERIFIED");
    expect(up.fragments.length).toBe(2);
  });
  it("ограничение ПД «не ниже С1»: РД С0 — NEGATIVE_VERIFIED, РД С2 — CANDIDATE", () => {
    const pd = M("PD", "С1", { discipline: "ПБ", qualifier: "min" });
    const ok = run([pd, M("RD", "С0")]);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.expected).toBe("не ниже С1");
    expect(run([pd, M("RD", "С2")]).status).toBe("CANDIDATE");
  });
  it("нет значения РД — MISSING_EVIDENCE, нарушением не считается", () => {
    const e = run([M("PD", "С0")]);
    expect(e.status).toBe("MISSING_EVIDENCE");
    expect(e.stage_notes.RD).toBe("NO_VALUE");
  });
  it("нет ни одного упоминания — MISSING_EVIDENCE", () => {
    expect(run([]).status).toBe("MISSING_EVIDENCE");
  });
  it("выбранное значение из неутверждённой или спорной редакции — CLARIFICATION_REQUIRED", () => {
    expect(run([M("PD", "С0", { role: "UNRESOLVED" }), M("RD", "С0")]).status).toBe("CLARIFICATION_REQUIRED");
    expect(run([M("PD", "С0"), M("RD", "С0", { role: "CONFLICT" })]).status).toBe("CLARIFICATION_REQUIRED");
  });
  it("параметр неприменим к профилю объекта — NOT_APPLICABLE", () => {
    const e = evaluateClassParam({ param: { ...PARAM, applicability: "demolition" }, passport: PASS, mentions: [M("PD", "С0"), M("RD", "С1")], loadedStages: ["PD", "RD"], profile: { demolition: false } });
    expect(e.status).toBe("NOT_APPLICABLE");
  });
  it("стадия не загружена — отметка NOT_APPLICABLE у стадии, ИД не требуется для сравнения ПД и РД", () => {
    const e = run([M("PD", "С0"), M("RD", "С0")], ["PD", "RD"]);
    expect(e.stage_notes.ID).toBe("NOT_APPLICABLE");
    expect(e.status).toBe("NEGATIVE_VERIFIED");
  });
  it("РД и ИД: худшая из поздних стадий задаёт кандидата", () => {
    const e = run([M("PD", "С0"), M("RD", "С0"), M("ID", "С2", { discipline: null })], ["PD", "RD", "ID"]);
    expect(e.status).toBe("CANDIDATE");
    expect(e.actual).toBe("С2");
  });
});

describe("М-023: противоречие внутри стадии и provenance (OS-INSP-3.1.12, 3.1.15)", () => {
  it("разные классы в разделах ПД — гипотеза SUSPICION с фрагментом каждого значения", () => {
    const e = run([M("PD", "С0", { discipline: "АР" }), M("PD", "С1", { discipline: "КР", page: 12 }), M("RD", "С0")]);
    expect(e.status).toBe("NEGATIVE_VERIFIED");
    expect(e.suspicions).toHaveLength(1);
    expect(e.suspicions[0].stage).toBe("PD");
    expect(e.suspicions[0].values.sort()).toEqual(["С0", "С1"]);
    expect(e.suspicions[0].description).toMatch(/АР.*С0.*КР.*С1|КР.*С1.*АР.*С0/);
  });
  it("текст гипотезы называет каждый раздел с каждым значением и все его страницы (Алтуфьево: КР и ПОС с «С1»)", () => {
    const e = run([
      M("PD", "С0", { discipline: "ПБ", qualifier: "min", page: 7 }),
      M("PD", "С1", { discipline: "КР", page: 6 }), M("PD", "С1", { discipline: "КР", page: 20 }), M("PD", "С1", { discipline: "КР", page: 20 }),
      M("PD", "С1", { discipline: "ПОС", page: 13 }), M("RD", "С0"),
    ]);
    expect(e.suspicions[0].description).toBe("Внутреннее противоречие ПД: класс указан по-разному — ПБ — не ниже С0 (стр. 7); КР — С1 (стр. 6, 20); ПОС — С1 (стр. 13)");
  });
  it("гипотеза ссылается на каждый раздел с каждым значением, ключ гипотезы при этом прежний (OS-INSP-3.1.17, ПОС Алтуфьево)", () => {
    const base = [M("PD", "С0", { discipline: "ПБ", qualifier: "min", page: 7 }), M("PD", "С0", { discipline: "АР", page: 9 }), M("PD", "С1", { discipline: "КР", page: 6 }), M("PD", "С1", { discipline: "КР", page: 20 }), M("RD", "С0")];
    const pos = M("PD", "С1", { discipline: "ПОС", page: 13 });
    const odi = M("PD", "С0", { discipline: "ОДИ", page: 4 });
    const without = run(base).suspicions[0];
    const withAll = run([...base, pos, odi]).suspicions[0];
    const shown = withAll.mentions.map((m) => `${m.discipline}:${m.page}:${m.value}`);
    expect(shown).toEqual(["ПБ:7:С0", "АР:9:С0", "КР:6:С1", "ПОС:13:С1", "ОДИ:4:С0"]);
    expect(withAll.dedup_key).toBe(without.dedup_key); // решение инспектора по гипотезе не теряется при пересчёте
  });
  it("точное значение ниже ограничения той же стадии — тоже противоречие", () => {
    const e = run([M("PD", "С0", { discipline: "ПБ", qualifier: "min" }), M("PD", "С1", { discipline: "КР" }), M("RD", "С0")]);
    expect(e.suspicions).toHaveLength(1);
  });
  it("одинаковый класс во всех разделах — противоречия нет", () => {
    expect(run([M("PD", "С0", { discipline: "АР" }), M("PD", "С0", { discipline: "КР" }), M("RD", "С0")]).suspicions).toEqual([]);
  });
  it("provenance: операции каталога и все упоминания стадий с признаком выбранного и причиной отсева", () => {
    const e = run([M("PD", "С0"), M("PD", "С1", { excluded: "NEIGHBOR", excluded_why: "соседнее здание" }), M("RD", "С0")]);
    expect(e.provenance.ops).toEqual(expect.arrayContaining(["ENT-16", "NRM-04", "LNK-01", "VER-15", "CMP-04", "CMP-30"]));
    const pd = e.provenance.mentions.filter((m) => m.stage === "PD");
    expect(pd.filter((m) => m.use === "chosen")).toHaveLength(1);
    expect(pd.find((m) => m.use === "dropped")?.why).toBe("соседнее здание");
  });
});

describe("М-023: след упоминания для карточки инспектора (OS-INSP-2.2.20, 4.1.18, T-130)", () => {
  it("источник текста, прочтения, исход сведения и вердикт судьи — из meta ML", () => {
    const t = mentionTrace({ text_source: "scan-ocr", readings: [{ by: "ансамбль", value: "С1" }, { by: "PaddleOCR-VL-1.5", value: "С0" }], reader_outcome: "majority-reader", vlm: { outcome: "confirmed", value: "С0", subject: "object", note: "подтвердил" } });
    expect(t).toEqual({ source: "scan-ocr", readings: [{ by: "ансамбль", value: "С1" }, { by: "PaddleOCR-VL-1.5", value: "С0" }], reader_outcome: "majority-reader", judge: { outcome: "confirmed", value: "С0", subject: "object", note: "подтвердил" } });
  });
  it("meta — недоверенный вход: неизвестное отбрасывается, строки обрезаются, мусор не роняет пересчёт", () => {
    for (const bad of [null, undefined, 42, "x", [], { text_source: "<script>", reader_outcome: "drop table", vlm: { outcome: "pwned" }, readings: "нет" }]) {
      expect(mentionTrace(bad)).toEqual({ source: null, readings: null, reader_outcome: null, judge: null });
    }
    const long = mentionTrace({ readings: Array.from({ length: 50 }, () => ({ by: "x".repeat(500), value: 7 })) });
    expect(long.readings).toHaveLength(5);
    expect(long.readings![0]).toEqual({ by: "x".repeat(80), value: null });
  });
  it("прочтения: не-объекты отбрасываются, пустая строка и не-строка — пусто; судья без известного исхода — нет", () => {
    const t = mentionTrace({ readings: [null, 7, ["С0"], { by: "", value: "" }, { by: "PaddleOCR-VL-1.5", value: "С0" }], vlm: { outcome: 5 } });
    expect(t.readings).toEqual([{ by: "—", value: null }, { by: "—", value: null }, { by: "PaddleOCR-VL-1.5", value: "С0" }]);
    expect(t.judge).toBeNull();
    expect(mentionTrace({ vlm: "confirmed" }).judge).toBeNull();
    expect(mentionTrace({ vlm: null, text_source: ["pdf-text"], reader_outcome: 1 })).toEqual({ source: null, readings: null, reader_outcome: null, judge: null });
    expect(mentionTrace({ vlm: { outcome: "excluded", value: 1, subject: "", note: 3 } }).judge).toEqual({ outcome: "excluded", value: null, subject: null, note: "" });
  });
  it("provenance: исход сведения прочтений и причина по умолчанию у упоминания под сомнением доходят до карточки", () => {
    const e = run([M("PD", "С0", { page: 7, reader_outcome: "agree" }), M("PD", "С1", { discipline: "КР", excluded: "VLM_NEIGHBOR", excluded_why: null }), M("RD", "С0")]);
    expect(e.provenance.mentions.find((m) => m.page === 7)?.reader_outcome).toBe("agree");
    expect(e.provenance.mentions.find((m) => m.use === "flagged")?.why).toBe("локальная VLM: не объект проверки");
  });
  it("ключ гипотезы не зависит от порядка упоминаний; отсеянное судьёй не входит в перечень значений гипотезы", () => {
    const ms = [M("PD", "С0", { discipline: "ПБ", qualifier: "min", page: 7 }), M("PD", "С1", { discipline: "КР", page: 6 }), M("PD", "С0", { discipline: "АР", page: 9 }), M("RD", "С0")];
    expect(run([...ms].reverse()).suspicions[0].dedup_key).toBe(run(ms).suspicions[0].dedup_key);
    const flagged = M("PD", "С2", { discipline: "ОДИ", page: 4, excluded: "VLM_NORM", excluded_why: "норма" });
    const d = run([...ms, flagged]).suspicions[0].description;
    expect(d.split(". Локальная VLM")[0]).not.toMatch(/ОДИ/); // в перечне значений — только не отсеянное судьёй
    expect(d).toMatch(/Локальная VLM относит ОДИ — С2/);
  });
  it("provenance несёт рамку, источник, прочтения и вердикт судьи каждого упоминания", () => {
    const tr = mentionTrace({ text_source: "pdf-text", vlm: { outcome: "excluded", value: "С1", subject: "neighbor", note: "сосед" } });
    const e = run([M("PD", "С0", { page: 7, ...tr }), M("RD", "С0", { page: 3, bbox: [0.8, 0.6, 0.83, 0.62] })]);
    const [pd, rd] = e.provenance.mentions;
    expect(pd).toMatchObject({ source: "pdf-text", judge: { outcome: "excluded", subject: "neighbor" }, bbox: [0.1, 0.2, 0.3, 0.25] });
    expect(rd).toMatchObject({ source: null, judge: null, readings: null, bbox: [0.8, 0.6, 0.83, 0.62], excluded: null });
  });
});

describe("М-023: судья VLM не прячет противоречие (OWASP LLM01, SEC-02)", () => {
  const vlm = (stage: Stage, value: string, over: Partial<Mention> = {}) => M(stage, value, { excluded: "VLM_NEIGHBOR", excluded_why: "локальная VLM: соседнее здание", ...over });
  it("упоминание, отсеянное только VLM, не выбирается, но противоречие стадии с ним остаётся гипотезой с пометкой", () => {
    const r = run([M("PD", "С0", { discipline: "ПЗ" }), vlm("PD", "С1", { discipline: "КР" }), M("RD", "С0")]);
    expect(r.status).toBe("NEGATIVE_VERIFIED");
    expect(r.expected).toBe("С0");
    expect(r.suspicions).toHaveLength(1);
    expect(r.suspicions[0].values.sort()).toEqual(["С0", "С1"]);
    expect(r.suspicions[0].description).toMatch(/Локальная VLM относит КР — С1 .* проверьте по листу/);
    const use = r.provenance.mentions.find((m) => m.value === "С1")!;
    expect([use.use, use.why]).toEqual(["flagged", "локальная VLM: соседнее здание"]);
  });
  it("отсев правилами (не VLM) по-прежнему убирает упоминание и из противоречия", () => {
    const r = run([M("PD", "С0", { discipline: "ПЗ" }), M("PD", "С1", { discipline: "КР", excluded: "NEIGHBOR", excluded_why: "соседнее здание" }), M("RD", "С0")]);
    expect(r.suspicions).toEqual([]);
  });
  it("флаг VLM у упоминания другого комплекта ПД — справочно, противоречия связанного комплекта не создаёт", () => {
    const r = run([M("PD", "С0", { discipline: "ПЗ" }), vlm("PD", "С2", { base: "2024-99-999" }), M("RD", "С0")]);
    expect(r.suspicions).toEqual([]);
    expect(r.provenance.mentions.find((m) => m.value === "С2")!.use).toBe("reference");
  });
  it("все упоминания стадии РД отсеяны VLM — значения РД нет (MISSING_EVIDENCE), кандидата не выдумывает", () => {
    const r = run([M("PD", "С0", { discipline: "ПЗ" }), vlm("RD", "С2")]);
    expect(r.status).toBe("MISSING_EVIDENCE");
  });
});

describe("М-023: границы, найденные мутациями (L8, Stryker T-129)", () => {
  it("паспорт без «прочих»: неизвестный раздел — за последним известным; стадия без списка источников — ранг 0; «*» первым — ранг 0", () => {
    const noStar: ClassPassport = { ...PASS, sources: { PD: [{ discipline: "ПЗ" }, { discipline: "АР" }], RD: [{ discipline: "*" }, { discipline: "АР" }], ID: undefined as any } };
    expect(sourceRank(noStar, "PD", "ОВ")).toBe(2);
    expect(sourceRank(noStar, "RD", "ОВ")).toBe(0);
    expect(sourceRank(noStar, "ID", "АР")).toBe(0);
  });
  it("точный класс, равный ограничению «не ниже» той же стадии, — не противоречие; ограничение и точка — не два разных класса", () => {
    expect(run([M("PD", "С1", { discipline: "ПБ", qualifier: "min" }), M("PD", "С1", { discipline: "АР" }), M("RD", "С1")]).suspicions).toEqual([]);
    expect(run([M("PD", "С1", { discipline: "ПБ", qualifier: "min" }), M("PD", "С0", { discipline: "АР" }), M("RD", "С0")]).suspicions).toEqual([]);
  });
  it("противоречие внутри РД и ИД названо своей стадией", () => {
    const rd = run([M("PD", "С0"), M("RD", "С0", { discipline: "АР" }), M("RD", "С1", { discipline: "КР" })]);
    expect(rd.suspicions.map((x) => x.description.slice(0, 26))).toEqual(["Внутреннее противоречие РД"]);
    const id = run([M("PD", "С0"), M("RD", "С0"), M("ID", "С0", { discipline: null }), M("ID", "С2", { discipline: null, page: 5 })], ["PD", "RD", "ID"]);
    expect(id.suspicions.map((x) => x.description.slice(0, 26))).toContain("Внутреннее противоречие ИД");
  });
  it("ключ дедупликации гипотезы не зависит от порядка упоминаний и называет файлы и страницы", () => {
    const a = M("PD", "С0", { discipline: "АР", file_id: "fa", page: 9 });
    const b = M("PD", "С1", { discipline: "КР", file_id: "fb", page: 6 });
    const k1 = run([a, b, M("RD", "С0")]).suspicions[0].dedup_key;
    const k2 = run([b, a, M("RD", "С0")]).suspicions[0].dedup_key;
    expect(k1).toBe(k2);
    expect(k1).toBe("class-conflict:PD:fa@9:С0|fb@6:С1");
  });
  it("provenance: каждое упоминание ровно один раз и в своей стадии; выбранное помечено, устаревшая редакция — с причиной", () => {
    const ms = [M("PD", "С0"), M("PD", "С2", { role: "SUPERSEDED" }), M("RD", "С0"), M("RD", "С5" as any)];
    const e = run(ms);
    expect(e.provenance.mentions).toHaveLength(ms.length);
    expect(e.provenance.mentions.filter((m) => m.use === "chosen").map((m) => m.stage).sort()).toEqual(["PD", "RD"]);
    expect(e.provenance.mentions.find((m) => m.value === "С2")).toMatchObject({ stage: "PD", use: "dropped", why: "устаревшая редакция" });
    expect(e.provenance.mentions.find((m) => m.value === "С5")).toMatchObject({ stage: "RD", use: "dropped", why: "значение вне шкалы" });
  });
  it("применимость задана и профиль её подтверждает — параметр сравнивается", () => {
    const e = evaluateClassParam({ param: { ...PARAM, applicability: "demolition" }, passport: PASS, mentions: [M("PD", "С0"), M("RD", "С1")], loadedStages: ["PD", "RD"], profile: { demolition: true } });
    expect(e.status).toBe("CANDIDATE");
  });
  it("неутверждённая редакция: в причине названы документы", () => {
    const e = run([M("PD", "С0", { role: "UNRESOLVED", document_code: "П-2099-01-001-ПЗ" }), M("RD", "С0")]);
    expect(e.reason).toContain("П-2099-01-001-ПЗ");
  });
  it("худшая из поздних стадий: ИД лучше РД, РД ниже ПД — кандидата задаёт РД, а не последнее упоминание", () => {
    const e = run([M("PD", "С0"), M("RD", "С2"), M("ID", "С1", { discipline: null })], ["PD", "RD", "ID"]);
    expect([e.status, e.actual]).toEqual(["CANDIDATE", "С2"]);
  });
  it("опора гипотезы о противоречии — худший класс с рамкой; без рамок (DOCX) — нет опоры", () => {
    const e = run([M("PD", "С0", { discipline: "АР", page: 9 }), M("PD", "С2", { discipline: "КР", page: 6 }), M("PD", "С1", { discipline: "ПОС", page: 3 }), M("RD", "С0")]);
    expect(conflictAnchor(e.suspicions[0], SCALE)).toMatchObject({ value: "С2", page: 6 });
    const nobox = run([M("PD", "С0", { discipline: "АР", bbox: null }), M("PD", "С1", { discipline: "КР", bbox: null }), M("RD", "С0")]);
    expect(conflictAnchor(nobox.suspicions[0], SCALE)).toBeNull();
    const mixed = run([M("PD", "С0", { discipline: "АР" }), M("PD", "С1", { discipline: "КР", bbox: null }), M("RD", "С0")]);
    expect(conflictAnchor(mixed.suspicions[0], SCALE)).toMatchObject({ value: "С0" }); // худший без рамки — берётся лучший с рамкой
  });
  it("обе поздние стадии ниже ПД: берётся худшая, а не первая найденная", () => {
    const e = run([M("PD", "С0"), M("RD", "С1"), M("ID", "С3", { discipline: null })], ["PD", "RD", "ID"]);
    expect([e.status, e.actual]).toEqual(["CANDIDATE", "С3"]);
  });
  it("provenance: годное, но не выбранное упоминание помечено «учтено» без причины", () => {
    const e = run([M("PD", "С0", { discipline: "ПЗ" }), M("PD", "С0", { discipline: "КР" }), M("RD", "С0")]);
    expect(e.provenance.mentions.filter((m) => m.use === "considered")).toEqual([expect.objectContaining({ stage: "PD", discipline: "КР", why: null })]);
  });
});

describe("М-023: свойства (fast-check)", () => {
  const cls = fc.constantFrom(...SCALE);
  const disc = fc.constantFrom("ПЗ", "ПБ", "АР", "КР", "ПОС", "КЖ");
  const mention = (stage: Stage) => fc.record({ v: cls, d: disc, q: fc.boolean() }).map((x) => M(stage, x.v, { discipline: x.d, qualifier: x.q ? "min" : null }));
  it("порядок упоминаний не меняет статус, ожидаемое и фактическое", () => {
    fc.assert(
      fc.property(fc.array(mention("PD"), { minLength: 1, maxLength: 6 }), fc.array(mention("RD"), { minLength: 1, maxLength: 6 }), (pd, rd) => {
        const a = run([...pd, ...rd]);
        const b = run([...rd].reverse().concat([...pd].reverse()));
        expect([b.status, b.expected, b.actual]).toEqual([a.status, a.expected, a.actual]);
      }),
    );
  });
  it("CANDIDATE тогда и только тогда, когда ранг РД ниже ранга ПД", () => {
    fc.assert(
      fc.property(cls, cls, (a, b) => {
        const e = run([M("PD", a), M("RD", b)]);
        expect(e.status === "CANDIDATE").toBe(classRank(SCALE, b)! < classRank(SCALE, a)!);
      }),
    );
  });
  it("добавление отсеянных упоминаний не меняет результат", () => {
    fc.assert(
      fc.property(cls, cls, fc.array(fc.tuple(cls, fc.constantFrom("NEIGHBOR", "NORM_TABLE")), { maxLength: 5 }), (a, b, noise) => {
        const base = run([M("PD", a), M("RD", b)]);
        const noisy = run([M("PD", a), M("RD", b), ...noise.map(([v, x]) => M("RD", v, { discipline: "АР", excluded: x, excluded_why: x }))]);
        expect([noisy.status, noisy.actual]).toEqual([base.status, base.actual]);
      }),
    );
  });
});

describe("T-233: строгий источник по паспорту (точность)", () => {
  const src = { PD: [{ discipline: "АР" }], RD: [{ discipline: "КЖ" }, { discipline: "*" }], ID: [] };
  it("список стадии без «*» — раздел вне списка и неопознанный раздел значения не дают", () => {
    expect(inPassportSources(src, "PD", "АР")).toBe(true);
    expect(inPassportSources(src, "PD", "ПБ")).toBe(false); // «ширина двери» из раздела ПБ
    expect(inPassportSources(src, "PD", null)).toBe(false); // буклет без шифра раздела
  });
  it("«*» или пустой список — любой раздел, как раньше", () => {
    expect(inPassportSources(src, "RD", "ЭОМ")).toBe(true);
    expect(inPassportSources(src, "ID", null)).toBe(true);
  });
});

