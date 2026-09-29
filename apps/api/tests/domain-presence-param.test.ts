// Эшелоны: L1 (правила CMP-09 и CMP-23 по паспорту), L3 (границы: молчание, смешанные упоминания, счётный показатель),
// L5 (fast-check: молчание поздней стадии никогда не нарушение), L6 (ловушки: чужой контекст, другой комплект ПД).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-212. Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareTerms, evaluatePresenceParam, MAX_MENTIONS, presencePassport, itemState, pickPresence, presenceConflicts, type PresenceMention, type PresencePassport } from "../src/domain/presence-param.ts";
import { extractorSpec } from "../src/domain/passport.ts";
import { kindOf, registeredKinds } from "../src/domain/param-kinds.ts";
import { passports } from "../src/services/passports.ts";
import { presenceMentions } from "../src/domain/kinds/presence.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const SOURCES: PresencePassport["sources"] = {
  PD: [{ discipline: "АР", label: "Текст АР: звукоизоляция перегородок — источник Матрицы" }, { discipline: "*" }],
  RD: [{ discipline: "АР", label: "Узлы примыкания перегородок (АР) — источник Матрицы" }, { discipline: "*" }],
  ID: [{ discipline: "*", label: "Акты АОСР на устройство прокладок — источник Матрицы" }],
};
const NOISE: PresencePassport = { kind: "presence", aspects: { damper: "демпферные ленты в сопряжениях перегородок и перекрытий" }, terms: {}, pd_silent: "MISSING_EVIDENCE", count: null, sources: SOURCES, link: "base_cipher" };
const GROUND: PresencePassport = {
  ...NOISE,
  aspects: { lightning: "элементы молниезащиты", grounding: "заземлители" },
  count: { aspect: "grounding", unit: "шт", title: "Число заземлителей" },
};
const METHOD: PresencePassport = {
  kind: "method",
  aspects: { main: "метод демонтажа" },
  terms: {
    dismantle: { title: "разборка", parent: null },
    element: { title: "поэлементная разборка", parent: "dismantle" },
    crane: { title: "поэлементная разборка краном", parent: "element" },
    manual: { title: "ручная разборка", parent: "dismantle" }, // как в паспорте М-091; чужой для словаря метод — «не распознан»
    mechanized: { title: "механизированная разборка", parent: "dismantle" },
    plasma: { title: "плазменная резка", parent: null },
    collapse: { title: "обрушение", parent: null },
  },
  pd_silent: "MISSING_EVIDENCE",
  count: null,
  sources: SOURCES,
  link: "base_cipher",
};
const PARAM: Param = {
  code: "M-053",
  section: "АР",
  parameter_name: "Конструктивные мероприятия по защите от шума",
  unit: "—",
  source_pd: "Текст АР: Звукоизоляция перегородок",
  source_rd: "Чертежи деформационных швов; Прокладки (АР)",
  source_id: "Акты АОСР на устройство прокладок",
  trigger_logic: "Отсутствие в РД демпферных лент в местах сопряжения перегородок и перекрытий.",
  review_priority: "MEDIUM",
  data_type: "string",
  compare: { kind: "equal" },
  anchors: ["Конструктивные мероприятия по защите от шума"],
  regex_pattern: null,
  value_scale: null,
  applicability: null,
  is_active: true,
};

let seq = 0;
const M = (stage: Stage, state: PresenceMention["state"], over: Partial<PresenceMention> = {}): PresenceMention => ({
  stage,
  file_id: `f${++seq}`,
  sha256: "b".repeat(64),
  document_code: over.document_code ?? `${stage === "PD" ? "П" : "Р"}-200-${over.discipline ?? "АР"}`,
  revision: "1",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
  role: "CURRENT",
  discipline: "АР",
  base: "200",
  state,
  aspect: "damper",
  term: null,
  excluded: null,
  excluded_why: null,
  page: 5,
  bbox: [0.1, 0.1, 0.3, 0.12],
  quote: state === "present" ? "Предусмотрены демпферные ленты" : "Демпферные ленты не предусматриваются",
  confidence: 1,
  source: "pdf-text",
  ...over,
});
const ALL: Stage[] = ["PD", "RD", "ID"];
const run = (mentions: PresenceMention[], p = NOISE, loaded: Stage[] = ALL, over: Partial<Param> = {}, profile: Record<string, boolean> = {}, kit = new Set(["200"]), pdKitPresent = false) =>
  evaluatePresenceParam({ param: { ...PARAM, ...over }, passport: p, mentions, loadedStages: loaded, profile, kitBases: kit, pdKitPresent });

describe("CMP-09: мероприятие ПД в поздней стадии (OS-INSP-3.1.151)", () => {
  it("ПД предусматривает, РД явно исключает — CANDIDATE с фрагментами обеих стадий", () => {
    const ev = run([M("PD", "present", { page: 7 }), M("RD", "absent", { page: 3 })]);
    expect(ev.status).toBe("CANDIDATE");
    expect([ev.expected, ev.actual, ev.delta]).toEqual(["предусмотрено: демпферные ленты в сопряжениях перегородок и перекрытий", "исключено: демпферные ленты в сопряжениях перегородок и перекрытий", "предусмотрено → исключено"]);
    expect(ev.reason).toContain("предусмотрено в ПД (АР, стр. 7), исключено в РД (АР, стр. 3)");
    expect(ev.reason).toContain("Правило Матрицы: Отсутствие в РД демпферных лент");
    expect(ev.fragments.map((f) => [f.stage, f.kind])).toEqual([["PD", "expected"], ["RD", "actual"]]);
    expect(ev.aspects).toEqual([{ aspect: "damper", title: NOISE.aspects.damper, status: "CANDIDATE", change: null, text: expect.any(String) }]);
  });
  it("обе стадии предусматривают — NEGATIVE_VERIFIED", () => {
    const ev = run([M("PD", "present"), M("RD", "present")]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("предусмотрено в ПД и в РД");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
  });
  it("ИД исключает при РД с мероприятием — CANDIDATE по ИД", () => {
    const ev = run([M("PD", "present"), M("RD", "present"), M("ID", "absent", { discipline: null, document_code: "АОСР-12" })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("исключено в ИД (АОСР-12, стр. 5)");
  });
});

describe("CMP-09: молчание и отказы (OS-INSP-3.1.152)", () => {
  it("ПД предусматривает, РД не упоминает — MISSING_EVIDENCE, не нарушение: причина называет ПД и чего не хватает", () => {
    const ev = run([M("PD", "present", { page: 7 })], NOISE, ["PD", "RD"]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("предусмотрено в ПД (АР, стр. 7), в РД не упомянуто");
    expect(ev.reason).toContain("РД: узлы примыкания перегородок (АР)");
    expect(ev.reason).toContain("ИД: акты АОСР на устройство прокладок — стадия не загружена");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected"]);
  });
  it("ПД не упоминает — по паспорту MISSING_EVIDENCE или NOT_APPLICABLE", () => {
    expect(run([M("RD", "absent")]).status).toBe("MISSING_EVIDENCE");
    const na = run([M("RD", "absent")], { ...NOISE, pd_silent: "NOT_APPLICABLE" });
    expect(na.status).toBe("NOT_APPLICABLE");
    expect(na.reason).toContain("не входит");
  });
  it("ПД не загружена — MISSING_EVIDENCE: эталона нет", () => {
    const ev = run([M("RD", "absent")], NOISE, ["RD"]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("ПД не загружена");
  });
  it("свойство: молчание или «предусмотрено» поздних стадий никогда не даёт нарушения", () => {
    fc.assert(
      fc.property(fc.subarray(["RD", "ID"] as Stage[]), fc.subarray(["RD", "ID"] as Stage[]), (present, loaded) => {
        const ev = run([M("PD", "present"), ...present.map((s) => M(s, "present"))], NOISE, ["PD", ...loaded]);
        expect(ev.status).not.toBe("CANDIDATE");
      }),
    );
  });
});

describe("CMP-09: ПД исключает, противоречие, чужой контекст (OS-INSP-3.1.153–3.1.155)", () => {
  it("ПД явно исключает — NOT_APPLICABLE, что бы ни было в РД", () => {
    for (const rd of ["present", "absent"] as const) {
      const ev = run([M("PD", "absent"), M("RD", rd)]);
      expect(ev.status).toBe("NOT_APPLICABLE");
      expect(ev.reason).toContain("ПД явно не предусматривает");
    }
  });
  it("в РД и предусмотрено, и исключено — NOT_COMPARABLE и гипотеза о противоречии, не нарушение", () => {
    const ev = run([M("PD", "present"), M("RD", "present", { discipline: "АР", page: 2 }), M("RD", "absent", { discipline: "КР", page: 9 })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.suspicions).toHaveLength(1);
    expect(ev.suspicions[0].description).toContain("Внутреннее противоречие РД");
    expect(ev.suspicions[0].description).toContain("предусмотрено (АР, стр. 2), и исключено (КР, стр. 9)");
  });
  it("в ПД и предусмотрено, и исключено — NOT_COMPARABLE: эталон не определён", () => {
    const ev = run([M("PD", "present"), M("PD", "absent", { discipline: "КР" }), M("RD", "absent")]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("эталон не определён");
  });
  it("отрицание в чужом контексте отсеяно с причиной и не делает кандидата", () => {
    const foreign = M("RD", "absent", { excluded: "FOREIGN", excluded_why: "относится к соседнему или существующему зданию" });
    const ev = run([M("PD", "present"), foreign, M("RD", "present")]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    const row = ev.provenance.mentions.find((m) => m.file_id === foreign.file_id)!;
    expect([row.use, row.why, row.excluded]).toEqual(["dropped", "относится к соседнему или существующему зданию", "FOREIGN"]);
    expect(pickPresence([foreign], "RD", NOISE, new Set()).considered).toEqual([]);
  });
  it("другой комплект ПД — справочно; комплект с шифром РД без мероприятия — эталона нет", () => {
    const other = M("PD", "absent", { base: "999" });
    const ev = run([M("PD", "present"), other, M("RD", "present")]);
    expect(ev.provenance.mentions.find((m) => m.file_id === other.file_id)!.use).toBe("reference");
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    const alien = run([M("PD", "present", { base: "999" }), M("RD", "absent")], NOISE, ALL, {}, {}, new Set(["200"]), true);
    expect(alien.status).toBe("MISSING_EVIDENCE");
    const loose = pickPresence([other], "PD", NOISE, new Set(["200"]), false);
    expect([loose.considered.length, loose.note]).toEqual([1, "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД"]);
    expect(pickPresence([other], "PD", NOISE, new Set(["200"]), true).considered).toEqual([]);
  });
  it("устаревшая редакция отсеяна, спорная — CLARIFICATION_REQUIRED", () => {
    expect(run([M("PD", "present"), M("RD", "absent", { role: "SUPERSEDED" }), M("RD", "present")]).status).toBe("NEGATIVE_VERIFIED");
    const ev = run([M("PD", "present"), M("RD", "absent", { role: "CONFLICT", document_code: "Р-200-АР", revision: "2" })]);
    expect([ev.status, ev.reason]).toEqual(["CLARIFICATION_REQUIRED", "Не определена актуальная редакция: Р-200-АР ред. 2"]);
  });
  it("неприменим к объекту по профилю — NOT_APPLICABLE до сравнения", () => {
    const ev = run([M("PD", "present"), M("RD", "absent")], NOISE, ALL, { applicability: "demolition" }, { demolition: false });
    expect([ev.status, ev.reason]).toEqual(["NOT_APPLICABLE", "Неприменим к объекту: demolition"]);
  });
  it("состояние аспекта: есть, исключено, и то и другое, ничего", () => {
    expect(itemState([M("RD", "present")], "damper")).toBe("PRESENT");
    expect(itemState([M("RD", "absent")], "damper")).toBe("ABSENT");
    expect(itemState([M("RD", "absent"), M("RD", "present")], "damper")).toBe("MIXED");
    expect(itemState([M("RD", "absent")], "other")).toBe("SILENT");
    expect(presenceConflicts(pickPresence([M("RD", "present")], "RD", NOISE, new Set()), "RD", NOISE)).toEqual([]);
  });
});

describe("CMP-09: аспекты и счётный показатель (OS-INSP-3.1.156)", () => {
  const G = (stage: Stage, state: PresenceMention["state"], aspect: string, count: number | null = null, over: Partial<PresenceMention> = {}) => M(stage, state, { aspect, count, discipline: "ИОС", ...over });
  it("решение по каждому аспекту и сводное по худшему: молниезащита исключена в РД — CANDIDATE", () => {
    const ev = run([G("PD", "present", "lightning"), G("PD", "present", "grounding", 8), G("RD", "absent", "lightning"), G("RD", "present", "grounding", 8)], GROUND);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.aspects.map((a) => [a.aspect, a.status])).toEqual([["lightning", "CANDIDATE"], ["grounding", "NEGATIVE_VERIFIED"]]);
    expect(ev.reason).toContain("«элементы молниезащиты» предусмотрено в ПД");
  });
  it("число заземлителей уменьшено — CANDIDATE; не меньше — NEGATIVE_VERIFIED; без числа — по наличию", () => {
    const fewer = run([G("PD", "present", "grounding", 8, { page: 4 }), G("RD", "present", "grounding", 6, { page: 2 })], GROUND);
    expect([fewer.status, fewer.expected, fewer.actual, fewer.delta]).toEqual(["CANDIDATE", "предусмотрено: заземлители (8 шт)", "предусмотрено: заземлители (6 шт)", "8 → 6 шт"]);
    expect(fewer.reason).toContain("Число заземлителей уменьшено: ПД — 8 шт (ИОС, стр. 4), РД — 6 шт (ИОС, стр. 2)");
    expect(run([G("PD", "present", "grounding", 8), G("RD", "present", "grounding", 10)], GROUND).status).toBe("NEGATIVE_VERIFIED");
    expect(run([G("PD", "present", "grounding", 8), G("RD", "present", "grounding", 8)], GROUND).status).toBe("NEGATIVE_VERIFIED");
    expect(run([G("PD", "present", "grounding"), G("RD", "present", "grounding", 2)], GROUND).status).toBe("NEGATIVE_VERIFIED");
  });
  it("аспект, о котором ПД молчит, не решает: другой аспект подтверждён — NEGATIVE_VERIFIED", () => {
    const ev = run([G("PD", "present", "grounding"), G("RD", "present", "grounding"), G("RD", "absent", "lightning")], GROUND);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.aspects.find((a) => a.aspect === "lightning")!.status).toBe("NOT_APPLICABLE");
  });
  it("худший аспект: MISSING_EVIDENCE по одному аспекту перевешивает подтверждённый другой", () => {
    const ev = run([G("PD", "present", "grounding"), G("PD", "present", "lightning"), G("RD", "present", "grounding")], GROUND);
    expect(ev.status).toBe("MISSING_EVIDENCE");
  });
});

describe("CMP-23: смена метода по словарю паспорта (OS-INSP-3.1.157, 3.1.158)", () => {
  const T = (stage: Stage, term: string | null, state: PresenceMention["state"] = "present", over: Partial<PresenceMention> = {}) => M(stage, state, { aspect: "main", term, discipline: "ПОД", ...over });
  it("шкала SAME / REFINED / CHANGED: уточнение и обобщение — REFINED, соседнее уточнение — CHANGED", () => {
    expect(compareTerms(METHOD, "element", "element")).toBe("SAME");
    expect(compareTerms(METHOD, "dismantle", "crane")).toBe("REFINED");
    expect(compareTerms(METHOD, "crane", "dismantle")).toBe("REFINED");
    expect(compareTerms(METHOD, "element", "mechanized")).toBe("CHANGED");
    expect(compareTerms(METHOD, "plasma", "collapse")).toBe("CHANGED");
    expect(compareTerms({ ...METHOD, terms: { a: { title: "a", parent: "b" }, b: { title: "b", parent: "a" } } }, "a", "c")).toBe("CHANGED");
  });
  it("метод изменён (поэлементная разборка → обрушение) — CANDIDATE", () => {
    const ev = run([T("PD", "element", "present", { page: 12 }), T("RD", "collapse", "present", { page: 4 })], METHOD);
    expect([ev.status, ev.expected, ev.actual, ev.delta]).toEqual(["CANDIDATE", "поэлементная разборка", "обрушение", "поэлементная разборка → обрушение"]);
    expect(ev.aspects[0].change).toBe("CHANGED");
    expect(ev.reason).toContain("метод изменён: в ПД — поэлементная разборка (ПОД, стр. 12), в РД — обрушение (ПОД, стр. 4)");
  });
  it("метод тот же — NEGATIVE_VERIFIED (SAME); уточнён — NEGATIVE_VERIFIED (REFINED)", () => {
    const same = run([T("PD", "element"), T("RD", "element")], METHOD);
    expect([same.status, same.aspects[0].change]).toEqual(["NEGATIVE_VERIFIED", "SAME"]);
    const ref = run([T("PD", "dismantle"), T("RD", "crane")], METHOD);
    expect([ref.status, ref.aspects[0].change]).toEqual(["NEGATIVE_VERIFIED", "REFINED"]);
    expect(ref.reason).toContain("уточнён без смены сути: разборка → поэлементная разборка краном");
  });
  it("метод, запрещённый в ПД, применён в РД — CHANGED; запрет в РД не считается методом", () => {
    expect(run([T("PD", "element"), T("PD", "collapse", "absent"), T("RD", "collapse")], METHOD).status).toBe("CANDIDATE");
    expect(run([T("PD", "element"), T("RD", "element"), T("RD", "collapse", "absent")], METHOD).status).toBe("NEGATIVE_VERIFIED");
  });
  it("неизвестный метод — NOT_COMPARABLE, а не угадывание", () => {
    const rd = run([T("PD", "element"), T("RD", null)], METHOD);
    expect([rd.status, rd.actual]).toEqual(["NOT_COMPARABLE", null]);
    expect(rd.reason).toContain("в РД метод не распознан по словарю паспорта");
    expect(run([T("PD", null), T("RD", "collapse")], METHOD).status).toBe("NOT_COMPARABLE");
    const mix = run([T("PD", "element"), T("RD", "element"), T("ID", null)], METHOD);
    expect([mix.status, mix.reason]).toEqual(["NEGATIVE_VERIFIED", expect.stringContaining("в ИД метод не распознан")]);
  });
  it("метод не указан в РД — MISSING_EVIDENCE; не указан в ПД — по паспорту", () => {
    expect(run([T("PD", "element")], METHOD, ["PD", "RD"]).status).toBe("MISSING_EVIDENCE");
    expect(run([T("RD", "collapse")], METHOD).status).toBe("MISSING_EVIDENCE");
    expect(run([T("PD", "collapse", "absent"), T("RD", "collapse")], METHOD).status).toBe("NOT_APPLICABLE");
  });
  it("один и тот же метод в стадии и назван, и запрещён — гипотеза о противоречии", () => {
    const ev = run([T("PD", "element"), T("RD", "collapse", "present", { page: 1 }), T("RD", "collapse", "absent", { page: 2 })], METHOD);
    expect(ev.suspicions.map((s) => s.description)).toEqual([expect.stringContaining("«обрушение» и предусмотрено (ПОД, стр. 1), и исключено (ПОД, стр. 2)")]);
    expect(ev.provenance.ops).toContain("CMP-23");
  });
});

describe("паспорта T-212 (OS-INSP-3.1.159)", () => {
  const codes = ["M-053", "M-063", "M-070", "M-091", "M-092", "M-095", "M-122"];
  it("паспорта мероприятий и метода читаются схемой и дают конфигурацию сравнения и экстрактора", () => {
    for (const c of codes) {
      const pp = passports().byCode.get(c)!;
      expect(pp, c).toBeTruthy();
      const cfg = presencePassport(pp)!;
      expect(cfg.kind).toBe(c === "M-091" ? "method" : "presence");
      const spec = extractorSpec(pp);
      expect(spec.kind).toBe(c === "M-091" ? "method_mentions" : "presence_mentions");
      expect(spec.value_kind).toBe(cfg.kind);
      if (c === "M-091") expect((spec.terms as unknown[]).length).toBeGreaterThan(3);
    }
    expect(presencePassport(passports().byCode.get("M-001")!)).toBeNull();
  });
  it("провенанс называет операции CMP-09 и все упоминания стадий", () => {
    const ev = run([M("PD", "present"), M("RD", "present"), M("RD", "present")]);
    expect(ev.provenance.ops).toContain("CMP-09");
    expect(ev.provenance.mentions.map((m) => m.use)).toEqual(["chosen", "chosen", "considered"]);
  });
});

describe("сборка упоминаний из строк ML (OS-INSP-3.1.150)", () => {
  const row = (meta: Record<string, unknown> | null) => ({
    file_id: "f1", sha256: "c".repeat(64), doc_stage: "RD" as Stage, document_code: "Р-200-АР1", revision: "1", approval_status: null, revision_role: "CURRENT" as const,
    discipline: "АР1", value_num: null, value_text: null, page: 3, bbox_json: "[0.1,0.1,0.2,0.2]", anchor_bbox_json: null, line_text: "строка", confidence: 0.9, meta_json: meta ? JSON.stringify(meta) : null,
  });
  it("сборка упоминаний: берутся только известные поля, строки без состояния и аспекта отбрасываются", () => {
    const [m, ...rest] = presenceMentions([
      row({ state: "absent", aspect: "damper", term: 5, count: "8", hint: "maybe", excluded: "FOREIGN", excluded_why: "чужое", quote: "Ленты не предусматриваются" }),
      row({ state: "maybe", aspect: "damper" }),
      row({ state: "present" }),
      row(null),
    ]);
    expect(rest).toEqual([]);
    expect([m.state, m.aspect, m.term, m.count, m.hint, m.excluded, m.discipline, m.base, m.quote, m.bbox]).toEqual(["absent", "damper", null, null, null, "FOREIGN", "АР", null, "Ленты не предусматриваются", [0.1, 0.1, 0.2, 0.2]]);
  });
});

describe("подсказки упоминания: узел без элемента, ссылка без содержания, другой элемент (OS-INSP-3.1.151, 3.1.154)", () => {
  it("узел РД без элемента ПД (implied) — CANDIDATE; элемент в другом листе РД — NEGATIVE_VERIFIED; в ПД не учитывается", () => {
    const ev = run([M("PD", "present"), M("RD", "absent", { hint: "implied", page: 4 })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("в РД показан узел без элемента (АР, стр. 4)");
    expect(run([M("PD", "present"), M("RD", "absent", { hint: "implied" }), M("RD", "present")]).status).toBe("NEGATIVE_VERIFIED");
    expect(run([M("PD", "absent", { hint: "implied" }), M("RD", "absent")]).status).toBe("MISSING_EVIDENCE");
  });
  it("ссылка без содержания или другой элемент в РД — NOT_COMPARABLE, не нарушение и не молчание", () => {
    const ref = run([M("PD", "present"), M("RD", "present", { hint: "reference", page: 6 })]);
    expect([ref.status, ref.reason]).toEqual(["NOT_COMPARABLE", expect.stringContaining("только ссылка без содержания (АР, стр. 6)")]);
    const other = run([M("PD", "present"), M("RD", "present", { hint: "other" })]);
    expect([other.status, other.reason]).toEqual(["NOT_COMPARABLE", expect.stringContaining("другой элемент")]);
    expect(run([M("PD", "present"), M("RD", "present", { hint: "reference" }), M("RD", "present")]).status).toBe("NEGATIVE_VERIFIED");
    expect(run([M("PD", "present"), M("RD", "present", { hint: "other" }), M("RD", "absent")]).status).toBe("CANDIDATE");
    expect(run([M("PD", "present", { hint: "reference" }), M("RD", "absent")]).status).toBe("MISSING_EVIDENCE");
  });
  it("у метода ссылка без содержания в поздней стадии — NOT_COMPARABLE", () => {
    const T = (stage: Stage, term: string | null, over: Partial<PresenceMention> = {}) => M(stage, "present", { aspect: "main", term, discipline: "ПОД", ...over });
    expect(run([T("PD", "element"), T("RD", null, { hint: "reference" })], METHOD).status).toBe("NOT_COMPARABLE");
    expect(run([T("PD", "element"), T("RD", "collapse", { hint: "other" })], METHOD).status).toBe("NOT_COMPARABLE");
  });
});

describe("показатели аспекта: ухудшение в любую сторону (OS-INSP-3.1.156)", () => {
  const R: PresencePassport = { ...GROUND, aspects: { ...GROUND.aspects, resistance: "сопротивление заземляющего устройства" }, counts: [{ aspect: "resistance", unit: "Ом", title: "Сопротивление заземляющего устройства", worse: "increase" }] };
  const G = (stage: Stage, aspect: string, count: number | null) => M(stage, "present", { aspect, count, discipline: "ИОС" });
  it("рост сопротивления — CANDIDATE, равенство и снижение — NEGATIVE_VERIFIED", () => {
    const ev = run([G("PD", "resistance", 4), G("RD", "resistance", 10)], R);
    expect([ev.status, ev.delta]).toEqual(["CANDIDATE", "4 → 10 Ом"]);
    expect(ev.reason).toContain("Сопротивление заземляющего устройства увеличено");
    expect(run([G("PD", "resistance", 4), G("RD", "resistance", 4)], R).status).toBe("NEGATIVE_VERIFIED");
    expect(run([G("PD", "resistance", 4), G("RD", "resistance", 2.5)], R).status).toBe("NEGATIVE_VERIFIED");
  });
  it("несколько значений в стадии — берётся лучшее для объекта: ложного нарушения из части листа нет", () => {
    expect(run([G("PD", "grounding", 8), G("RD", "grounding", 4), M("RD", "present", { aspect: "grounding", count: 8, discipline: "ЭМ" })], GROUND).status).toBe("NEGATIVE_VERIFIED");
    expect(run([G("PD", "resistance", 4), G("RD", "resistance", 10), G("RD", "resistance", 4)], R).status).toBe("NEGATIVE_VERIFIED");
  });
});

describe("метод по частям здания (OS-INSP-3.1.157)", () => {
  const PARTS: PresencePassport = { ...METHOD, aspects: { main: "метод демонтажа", above: "надземная часть", foundation: "фундаменты" }, terms: { ...METHOD.terms, hammer: { title: "гидромолот", parent: null } } };
  const T = (stage: Stage, aspect: string, term: string) => M(stage, "present", { aspect, term, discipline: "ПОД" });
  it("метод части сравнивается только со своей частью; другая часть в РД — не смена метода", () => {
    expect(run([T("PD", "above", "element"), T("RD", "foundation", "hammer")], PARTS).status).toBe("MISSING_EVIDENCE");
    expect(run([T("PD", "above", "element"), T("PD", "foundation", "hammer"), T("RD", "foundation", "hammer"), T("RD", "above", "element")], PARTS).status).toBe("NEGATIVE_VERIFIED");
    expect(run([T("PD", "above", "element"), T("RD", "above", "collapse")], PARTS).status).toBe("CANDIDATE");
  });
  it("общий метод стадии относится к каждой части, у которой своего нет", () => {
    expect(run([T("PD", "main", "element"), T("RD", "above", "collapse")], PARTS).status).toBe("CANDIDATE");
    expect(run([T("PD", "main", "element"), T("RD", "above", "crane")], PARTS).status).toBe("NEGATIVE_VERIFIED");
    expect(run([T("PD", "above", "element"), T("RD", "main", "element")], PARTS).status).toBe("NEGATIVE_VERIFIED");
  });
});

describe("регистрация видов presence и method в реестре (OS-INSP-3.1.150, T-186)", () => {
  it("виды зарегистрированы одним модулем: свой извлекатель у каждого, оценка — общий presence-param", () => {
    expect(registeredKinds().map((k) => k.kind)).toEqual(expect.arrayContaining(["presence", "method"]));
    expect(kindOf("presence")!.extractor.shape.kind.value).toBe("presence_mentions");
    expect(kindOf("method")!.extractor.shape.kind.value).toBe("method_mentions");
    const ev = kindOf("presence")!.evaluate({ param: PARAM, passport: { value: { kind: "presence", aspects: NOISE.aspects, pd_silent: "MISSING_EVIDENCE", count: null, counts: [], note: "" }, extractor: { kind: "presence_mentions" }, sources: SOURCES, link: { by: "base_cipher", note: "" }, basis: "" }, mentions: [M("PD", "present"), M("RD", "absent")] as never, loadedStages: ALL, profile: {}, kitBases: new Set(["200"]), pdKitPresent: false });
    expect(ev.status).toBe("CANDIDATE");
  });
});

describe("недоверенный вход и отказобезопасность (OWASP W3-04, W3-07, W3-14; OS-INSP-3.1.150, 3.1.158)", () => {
  const T = (stage: Stage, term: string | null, state: PresenceMention["state"] = "present") => M(stage, state, { aspect: "main", term, discipline: "ПОД" });
  it("метод поздней стадии только с отрицанием и не родственный ПД — NOT_COMPARABLE, а не молчание и не нарушение", () => {
    expect(run([T("PD", "element"), T("RD", "collapse", "absent")], METHOD).status).toBe("NOT_COMPARABLE");
    expect(run([T("PD", "element"), T("RD", "crane", "absent")], METHOD).status).toBe("MISSING_EVIDENCE");
  });
  it("аспект и метод — только из паспорта: чужой аспект не упоминание, чужой метод — не распознан", () => {
    expect(run([M("PD", "present"), M("RD", "absent", { aspect: "__proto__" })]).status).toBe("MISSING_EVIDENCE");
    expect(run([T("PD", "element"), T("RD", "toString")], METHOD).status).toBe("NOT_COMPARABLE");
  });
  it("сверх предела упоминаний — первые MAX_MENTIONS, пометка в причине", () => {
    const many = Array.from({ length: MAX_MENTIONS + 5 }, () => M("RD", "present"));
    const ev = run([M("PD", "present"), ...many]);
    expect([ev.status, ev.reason]).toEqual(["NEGATIVE_VERIFIED", expect.stringContaining(`Учтены первые ${MAX_MENTIONS} упоминаний из ${MAX_MENTIONS + 6}`)]);
  });
});

describe("временные и вспомогательные сооружения — отдельная часть (OS-INSP-3.1.157)", () => {
  const SITE: PresencePassport = {
    ...METHOD,
    aspects: { main: "метод демонтажа", above: "надземная часть", temporary: "временные и вспомогательные сооружения стройплощадки" },
    separate: ["temporary"],
  };
  const T = (stage: Stage, aspect: string, term: string) => M(stage, "present", { aspect, term, discipline: "ПОД" });
  it("метод временных сооружений с методом основного здания не сравнивается", () => {
    expect(run([T("PD", "main", "element"), T("RD", "temporary", "collapse")], SITE).status).toBe("MISSING_EVIDENCE");
    expect(run([T("PD", "main", "element"), T("RD", "main", "element"), T("RD", "temporary", "collapse")], SITE).status).toBe("NEGATIVE_VERIFIED");
    expect(run([T("PD", "above", "element"), T("RD", "temporary", "collapse")], SITE).status).toBe("MISSING_EVIDENCE");
  });
  it("отказ рядом: метод основного здания сменился — CANDIDATE остаётся; временные с временными сравниваются", () => {
    expect(run([T("PD", "main", "element"), T("RD", "main", "collapse"), T("RD", "temporary", "element")], SITE).status).toBe("CANDIDATE");
    expect(run([T("PD", "temporary", "manual"), T("RD", "temporary", "collapse")], SITE).status).toBe("CANDIDATE");
  });
});
