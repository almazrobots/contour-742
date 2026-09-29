// Эшелоны: L1 (правила М-043 и М-106: CMP-17, норма CMP-06, ворота), L3 (границы: нет стадии, только Л/П, оговорка нормы,
// раздел не из паспорта), L5 (fast-check: CANDIDATE тогда и только тогда, когда есть «наружу → внутрь» без оговорки),
// L6 (ловушки: марка без признака эвакуационной, отрицание, другой комплект ПД, противоречие внутри стадии).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-214. Только синтетика.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { directionConflict, directionPairs, directionPassport, evaluateDirectionParam, isSource, MAX_MENTIONS, pickDirections, plural, type DirectionMention, type DirectionPassport } from "../src/domain/direction-param.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { extractorSpec, ParamPassport } from "../src/domain/passport.ts";
import type { Param, Stage } from "../src/domain/types.ts";
import { passports } from "../src/services/passports.ts";
import { direction, directionMentions } from "../src/domain/kinds/direction.ts";
import { kindOf, kindSlice, registeredKinds, type KindRow } from "../src/domain/param-kinds.ts";

const M043 = passports().byCode.get("M-043")!;
// T-233: паспорт М-106 — в data/seed/passports/draft/ до цифр замера
const M106 = ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft/M-106.json"), "utf8")));
const P43: DirectionPassport = directionPassport(M043)!;
const P106: DirectionPassport = directionPassport(M106)!;

const param = (code: string, trigger = "Дверь открывается внутрь помещения или блокирует смежный поток эвакуации."): Param => ({
  code,
  section: code === "M-043" ? "АР" : "ППМ",
  parameter_name: "Направление открывания эвакуационных дверей",
  unit: "—",
  source_pd: "Планы этажей; Схемы эвакуации (АР)",
  source_rd: "Рабочие планы; Графические схемы (АР)",
  source_id: "Акты проверки систем ПЗ; Фотофиксация",
  trigger_logic: trigger,
  review_priority: "HIGH",
  data_type: "string",
  compare: { kind: "equal" },
  anchors: [],
  regex_pattern: null,
  value_scale: null,
  applicability: null,
  is_active: true,
});

let seq = 0;
const M = (stage: Stage, value: DirectionMention["value"], mark: string | null, over: Partial<DirectionMention> = {}): DirectionMention => ({
  stage,
  file_id: `f-${stage}-${++seq}`,
  sha256: "b".repeat(64),
  document_code: `П-2099-01-001-${over.discipline ?? "АР"}`,
  revision: "0",
  approval_status: stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED",
  role: "CURRENT",
  discipline: "АР",
  base: "2099-01-001",
  value,
  mark,
  exemption: null,
  evac: null,
  building: null,
  remaining_m: null,
  excluded: null,
  excluded_why: null,
  page: 4,
  bbox: [0.1, 0.2, 0.3, 0.25],
  quote: `${mark ?? "двери эвакуационных выходов"} — ${value}`,
  confidence: 1,
  ...over,
});
const run43 = (mentions: DirectionMention[], loaded: Stage[] = ["PD", "RD"], profile = {}) => evaluateDirectionParam({ param: param("M-043"), passport: P43, mentions, loadedStages: loaded, profile });
const run106 = (mentions: DirectionMention[], loaded: Stage[] = ["PD", "RD"]) => evaluateDirectionParam({ param: param("M-106"), passport: P106, mentions, loadedStages: loaded, profile: {} });

describe("паспорта М-043 и М-106 — вид «направление» (OS-INSP-3.1.170)", () => {
  it("паспорт направления: CMP-17, норма только у М-043, разделы-источники разные", () => {
    expect(M043.value.kind).toBe("direction");
    expect(P43.norm?.basis).toMatch(/СП 1\.13130\.2020, п\. 4\.2\.6/);
    expect(P106.norm).toBeNull();
    expect(P43.sources.PD.map((s) => s.discipline)).toEqual(["АР", "ПБ", "ПЗ"]);
    expect(P106.sources.PD.map((s) => s.discipline)).toEqual(["ПБ", "АР"]);
    expect(extractorSpec(M043).kind).toBe("direction_mentions");
    expect(extractorSpec(M106)).toEqual(M106.extractor);
    expect(directionPassport(passports().byCode.get("M-023")!)).toBeNull();
  });
  it("раздел вне списка паспорта — не источник параметра", () => {
    expect(isSource(P106, "RD", "АР")).toBe(true);
    expect(isSource(P106, "RD", "ОВ")).toBe(false);
    expect(isSource(P106, "RD", null)).toBe(false);
    expect(isSource(P43, "RD", "ОВ")).toBe(true); // «*» в РД М-043
    expect(isSource(P43, "PD", "КР")).toBe(false);
    const st = pickDirections([M("RD", "inward", "Д1", { discipline: "ОВ" })], "RD", P106, null);
    expect(st.doors.size).toBe(0);
    expect(st.dropped[0].why).toMatch(/раздел ОВ — не источник параметра на стадии РД/);
  });
});

describe("вид «направление» в реестре видов (T-186, OS-INSP-7.1.20)", () => {
  it("вид direction зарегистрирован: схема паспорта, извлекатель, оценка через реестр", () => {
    expect(kindOf("direction")).toBe(direction);
    expect(registeredKinds()).toContain(direction);
    expect(direction.extractor.shape.kind.value).toBe("direction_mentions");
    const row = (value_text: string | null, meta: Record<string, unknown>): KindRow => ({
      file_id: "f1", sha256: "c".repeat(64), doc_stage: "RD", document_code: "Р-2099-01-001-АР", revision: "0", approval_status: "FOR_CONSTRUCTION", revision_role: "CURRENT",
      discipline: "АР", value_num: null, value_text, page: 2, bbox_json: null, meta_json: JSON.stringify(meta), line_text: "Д1 внутрь", confidence: 1,
    });
    const ms = directionMentions([row("inward", { mark: "Д1", evac: true, building: "Б", remaining_m: "x", exemption: 5, quote: "ц".repeat(5000), excluded_why: "п".repeat(1000) }), row("чужое", {}), row(null, {})]);
    expect(ms).toHaveLength(1);
    expect([ms[0].quote.length, ms[0].excluded_why!.length]).toEqual([500, 300]); // W3-06: строки из недоверенного PDF обрезаются
    expect(ms[0]).toMatchObject({ value: "inward", mark: "Д1", evac: true, building: "Б", remaining_m: null, exemption: null, discipline: "АР" });
    const ev = direction.evaluate({ param: param("M-043"), passport: kindSlice(M043), mentions: ms, loadedStages: ["RD"], profile: {}, kitBases: new Set(), pdKitPresent: false });
    expect(ev.status).toBe("CANDIDATE");
  });
});

describe("CMP-17: направление по двери и по общему утверждению (OS-INSP-3.1.171)", () => {
  it("ПД по направлению эвакуации, РД внутрь — CANDIDATE", () => {
    const ev = run106([M("PD", "outward", "Д1", { discipline: "ПБ" }), M("RD", "inward", "Д1")]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("Д1 — по направлению выхода (наружу)");
    expect(ev.actual).toBe("Д1 — внутрь (против направления эвакуации)");
    expect(ev.reason).toMatch(/^ПД → РД: эвакуационная дверь открывается внутрь \(Д1\); Дверь открывается внутрь/);
    expect(ev.fragments.map((f) => [f.stage, f.kind])).toEqual([["PD", "expected"], ["RD", "actual"]]);
  });
  it("общее утверждение ПД и дверь РД по марке: дверь внутрь — CANDIDATE", () => {
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "outward", "Д1"), M("RD", "inward", "Д2", { evac: true })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("общее — по направлению выхода (наружу)");
    expect(ev.actual).toBe("Д2 — внутрь (против направления эвакуации)");
  });
  it("направление совпадает — NEGATIVE_VERIFIED", () => {
    const ev = run106([M("PD", "outward", "Д1", { discipline: "ПБ" }), M("RD", "outward", "Д1"), M("RD", "outward", "Д-5")]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toBe("Направление открывания эвакуационных дверей не ухудшено (1 сравнение)");
    expect(ev.delta).toBeNull();
  });
  it("внутрь → наружу — улучшение, а не нарушение (BETTER)", () => {
    const ev = run106([M("PD", "inward", "Д1", { discipline: "ПБ" }), M("RD", "outward", "Д1"), M("RD", "outward", "Д2"), M("PD", "outward", "Д2", { discipline: "ПБ" })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toBe("Направление открывания эвакуационных дверей не ухудшено (2 сравнения); лучше эталона (BETTER): Д1");
  });
  it("дверь той же марки в эталоне важнее общего утверждения", () => {
    const pd = { doors: new Map([["Д1", M("PD", "inward", "Д1")], ["*", M("PD", "outward", null)]]) } as never;
    const later = { doors: new Map([["Д1", M("RD", "inward", "Д1")], ["Д7", M("RD", "inward", "Д7")]]) } as never;
    // Д7 без признака эвакуационной против общего утверждения — не нарушение, а «не установлено»; признак той же марки из другой стадии — нарушение
    const plain = directionPairs(pd, later, false);
    expect(plain.pairs.map((x) => [x.actual.mark, x.expected!.mark, x.violation])).toEqual([["Д1", "Д1", false]]);
    expect(plain.unknown.map((m) => m.mark)).toEqual(["Д7"]);
    expect(directionPairs(pd, later, false, new Set(["Д7"])).pairs.map((x) => [x.actual.mark, x.expected!.mark, x.violation])).toEqual([["Д1", "Д1", false], ["Д7", null, true]]);
    expect(directionPairs(null, later, false)).toEqual({ pairs: [], other: [], unknown: [], blocks: [] });
    expect(directionPairs(null, later, true, new Set(["Д1", "Д7"])).pairs.map((x) => [x.expected, x.violation])).toEqual([[null, true], [null, true]]);
    expect(directionPairs(null, later, true).unknown).toHaveLength(2);
  });
});

describe("норма CMP-06 у М-043 (OS-INSP-3.1.173)", () => {
  it("эвакуационная дверь РД внутрь без ПД — CANDIDATE против нормы", () => {
    const ev = run43([M("RD", "inward", "Д3", { evac: true })], ["RD"]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("норма — по направлению выхода (наружу)");
    expect(ev.reason).toMatch(/^Норма → РД: эвакуационная дверь открывается внутрь \(Д3\); норма: СП 1\.13130\.2020, п\. 4\.2\.6/);
    expect(ev.fragments.map((f) => f.kind)).toEqual(["actual"]);
  });
  it("М-106 без нормы: та же дверь без ПД — MISSING_EVIDENCE", () => {
    const ev = run106([M("RD", "inward", "Д3", { evac: true })], ["PD", "RD"]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toBe("Недостаточно источников для сравнения направления открывания: данные только в РД; нет данных в ПД");
  });
  it("норма не проверяется на ПД: дверь ПД внутрь без поздних стадий — MISSING_EVIDENCE", () => {
    expect(run43([M("PD", "inward", "Д3")], ["PD", "RD"]).status).toBe("MISSING_EVIDENCE");
  });
  it("дверь РД наружу без ПД — не подтверждение, а MISSING_EVIDENCE", () => {
    expect(run43([M("RD", "outward", "Д3")], ["PD", "RD"]).status).toBe("MISSING_EVIDENCE");
  });
});

describe("отказы: нет данных, Л/П, оговорка нормы (OS-INSP-3.1.172, 3.1.174, 3.1.175)", () => {
  it("нет данных в стадии — MISSING_EVIDENCE с названием стадии", () => {
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" })]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toBe("Недостаточно источников для сравнения направления открывания: данные только в ПД; нет данных в РД");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected"]);
    const none = run43([]);
    expect(none.reason).toBe("Недостаточно источников для сравнения направления открывания: направление не найдено ни в одной стадии; нет данных в ПД, РД");
    expect(none.fragments).toEqual([]);
  });
  it("у эвакуационной двери РД только Л/П — NOT_COMPARABLE, а не нарушение", () => {
    const ev = run106([M("PD", "outward", null, { discipline: "ПБ" }), M("RD", "hand", "Д1", { excluded: "HAND_ONLY", excluded_why: "только Л/П" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/^У эвакуационных дверей Д1 указана только сторона навески \(Л\/П\)/);
    expect(ev.provenance.mentions.find((m) => m.mark === "Д1")).toMatchObject({ use: "flagged", why: "только Л/П" });
  });
  it("оговорка своей марки («Д4 … не более 15 человек») — NOT_COMPARABLE и гипотеза", () => {
    const ex = M("RD", "inward", "Д4", { excluded: "EXEMPT", excluded_why: "оговорка нормы: ≤ 15 человек", quote: "Д4 — допускается открывание внутрь, помещение с одновременным пребыванием не более 15 человек" });
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д4", { evac: true }), ex]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Дверь внутрь (Д4) с оговоркой нормы (оговорка нормы: ≤ 15 человек): оговорку не угадываем — нужна проверка по плану");
    const s = ev.suspicions.find((x) => x.dedup_key.startsWith("direction-exempt:RD:"))!;
    expect(s.description).toMatch(/^Д4: внутрь \(против направления эвакуации\) при оговорке нормы \(«Д4 — допускается открывание внутрь/);
    expect(s.mentions).toContain(ex);
  });
  it("общая оговорка стадии или ПД («за исключением …») не снимает нарушение у двери с маркой — CANDIDATE с пометкой (W3-08)", () => {
    const general = M("RD", "inward", null, { excluded: "EXEMPT", excluded_why: "оговорка нормы: ≤ 15 человек" });
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д4", { evac: true }), general]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/\(Д4\); в стадии есть общая оговорка нормы \(оговорка нормы: ≤ 15 человек\) — к двери с маркой она не относится, проверьте по плану; /);
    const pd = M("PD", "outward", null, { discipline: "ПЗ", exemption: "за исключением помещений ≤ 15 человек" });
    const ev2 = run43([pd, M("RD", "inward", "Д4", { evac: true }), M("RD", "inward", "Д7", { evac: true })]);
    expect(ev2.status).toBe("CANDIDATE");
    expect(ev2.reason).toMatch(/\(Д4, Д7\); в стадии есть общая оговорка нормы \(за исключением помещений ≤ 15 человек\)/);
    expect(ev2.provenance.mentions.find((m) => m.stage === "PD")).toMatchObject({ use: "chosen", why: "за исключением помещений ≤ 15 человек" });
    // оговорка чужой марки не касается Д4
    expect(run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д4", { evac: true }), M("RD", "inward", "Д5", { excluded: "EXEMPT" })]).reason).not.toMatch(/оговорк/);
  });
  it("общее утверждение «внутрь» при общей оговорке — NOT_COMPARABLE, как раньше", () => {
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", null, { evac: true, exemption: "за исключением помещений ≤ 15 человек" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/^Дверь внутрь \(общее утверждение\) с оговоркой нормы/);
  });
  it("оговорка не прячет нарушение без оговорки в другой стадии", () => {
    const ev = run43([M("PD", "outward", "Д1", { discipline: "АР" }), M("RD", "outward", "Д1"), M("ID", "inward", "Д1", { discipline: "АКТ" }), M("RD", "inward", null, { excluded: "EXEMPT" })], ["PD", "RD", "ID"]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/^ПД → ИД/);
  });
});

describe("ворота и выбор источника (OS-INSP-3.1.170, 3.1.177)", () => {
  it("неприменим к объекту — NOT_APPLICABLE", () => {
    const p = { ...param("M-043"), applicability: "has_evacuation" };
    const ev = evaluateDirectionParam({ param: p, passport: P43, mentions: [M("RD", "inward", "Д1")], loadedStages: ["RD"], profile: { has_evacuation: false } });
    expect(ev.status).toBe("NOT_APPLICABLE");
    expect(ev.reason).toBe("Неприменим к объекту: has_evacuation");
  });
  it("спорная редакция выбранного значения — CLARIFICATION_REQUIRED", () => {
    const ev = run43([M("PD", "outward", "Д1"), M("RD", "inward", "Д1", { role: "CONFLICT", document_code: "Р-АР", revision: "2" })]);
    expect(ev.status).toBe("CLARIFICATION_REQUIRED");
    expect(ev.reason).toBe("Не определена актуальная редакция: Р-АР ред. 2");
  });
  it("устаревшая редакция и отсеянные ML упоминания не участвуют, но видны в карточке с причиной", () => {
    const ms = [
      M("PD", "outward", "Д1"),
      M("RD", "inward", "Д1", { role: "SUPERSEDED" }),
      M("RD", "inward", "Д2", { excluded: "NOT_EVAC", excluded_why: "нет признака эвакуационной" }),
      M("RD", "inward", "Д1", { excluded: "NEGATION", excluded_why: null }),
      M("RD", "outward", "Д1"),
    ];
    const ev = run43(ms);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.provenance.mentions.filter((m) => m.use === "dropped").map((m) => m.why)).toEqual(["устаревшая редакция", "NEGATION"]);
    expect(ev.provenance.mentions.find((m) => m.mark === "Д2")).toMatchObject({ use: "flagged", why: "нет признака эвакуационной" });
    expect(ev.provenance.ops).toContain("CMP-17");
  });
  it("приоритет раздела: ПД М-106 берёт ПБ раньше АР; при равенстве — худшее направление", () => {
    const st = pickDirections([M("PD", "inward", "Д1", { discipline: "АР" }), M("PD", "outward", "Д1", { discipline: "ПБ" })], "PD", P106, null);
    expect(st.doors.get("Д1")!.discipline).toBe("ПБ");
    const tie = pickDirections([M("RD", "outward", "Д1", { file_id: "a" }), M("RD", "inward", "Д1", { file_id: "b" })], "RD", P106, null);
    expect(tie.doors.get("Д1")!.value).toBe("inward");
    const conf = pickDirections([M("RD", "inward", "Д1", { confidence: 0.5 }), M("RD", "outward", "Д1", { confidence: 0.9 })], "RD", P106, null);
    expect(conf.doors.get("Д1")!.value).toBe("outward");
  });
  it("ПД — только комплект, связанный с РД по базовому шифру; другой комплект — справочно", () => {
    const other = M("PD", "inward", "Д1", { base: "1111-01-001" });
    const st = pickDirections([other, M("PD", "outward", "Д1")], "PD", P43, new Set(["2099-01-001"]));
    expect(st.doors.get("Д1")!.value).toBe("outward");
    expect(st.reference).toEqual([other]);
    const lone = pickDirections([other], "PD", P43, new Set(["2099-01-001"]));
    expect(lone.note).toBe("комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД");
    expect(run43([other, M("PD", "outward", "Д1"), M("RD", "outward", "Д1")]).provenance.mentions.find((m) => m.file_id === other.file_id)!.use).toBe("reference");
  });
});

describe("противоречие внутри стадии — гипотеза CMP-30 (OS-INSP-3.1.176)", () => {
  it("одна марка с разными направлениями в разделах стадии — гипотеза", () => {
    const st = pickDirections([M("RD", "outward", "Д1", { discipline: "АР", page: 2 }), M("RD", "inward", "Д1", { discipline: "КР", page: 9 })], "RD", P43, null);
    const s = directionConflict(st, "RD")!;
    expect(s.description).toMatch(/^Внутреннее противоречие РД по направлению открывания эвакуационных дверей: Д1 названа по-разному: /);
    expect(s.mentions).toHaveLength(2);
    expect(s.dedup_key).toMatch(/^direction-conflict:RD:/);
  });
  it("текст «по направлению выхода», а в ведомости той же стадии дверь внутрь — гипотеза", () => {
    const st = pickDirections([M("PD", "outward", null, { discipline: "ПЗ" }), M("PD", "inward", "Д2", { evac: true }), M("PD", "inward", "Д5"), M("PD", "outward", "Д3")], "PD", P43, null);
    const s = directionConflict(st, "PD")!;
    expect(s.description).toMatch(/текст — по направлению выхода \(наружу\) \(ПЗ, стр\. 4\), а в ведомости: Д2 внутрь \(против направления эвакуации\) \(АР, стр\. 4\)$/);
    expect(s.mentions.map((m) => m.mark)).toEqual(["Д2", null]);
  });
  it("согласованная стадия — гипотезы нет", () => {
    expect(directionConflict(pickDirections([M("RD", "outward", "Д1"), M("RD", "outward", "Д1"), M("RD", "outward", null)], "RD", P43, null), "RD")).toBeNull();
  });
});

describe("признак эвакуационной, вне требования, другой корпус (OS-INSP-3.1.178, 3.1.179)", () => {
  it("признак эвакуационной переносится по марке из другой стадии; без него «внутрь» против общего утверждения — NOT_COMPARABLE", () => {
    const base = [M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "outward", "Д5", { evac: true })];
    const ev = run43([...base, M("ID", "inward", "Д5", { discipline: "ИД" })], ["PD", "RD", "ID"]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/^ПД → ИД: эвакуационная дверь открывается внутрь \(Д5\)/);
    const unknown = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д6")]);
    expect(unknown.status).toBe("NOT_COMPARABLE");
    expect(unknown.reason).toMatch(/^Не установлено, на пути эвакуации ли двери Д6/);
  });
  it("та же марка сменила «наружу» на «внутрь» — CANDIDATE и без признака эвакуационной", () => {
    expect(run106([M("PD", "outward", "Д1", { discipline: "ПБ" }), M("RD", "inward", "Д1")]).status).toBe("CANDIDATE");
  });
  it("в поздней стадии только двери вне путей эвакуации или помещений ≤ 15 человек — NEGATIVE_VERIFIED", () => {
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д8", { excluded: "SMALL_ROOM", excluded_why: "помещение 4 чел." }), M("RD", "inward", "Д9", { excluded: "NOT_EVAC", excluded_why: "кладовая" })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toBe("Двери с открыванием не по направлению выхода — вне требования: Д8 (помещение 4 чел.); Д9 (кладовая)");
    expect(run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "inward", "Д8", { excluded: "SMALL_ROOM" }), M("RD", "inward", "Д2", { evac: true })]).status).toBe("CANDIDATE");
  });
  it("та же марка в другом корпусе — NOT_COMPARABLE; в том же корпусе — сравнение", () => {
    const ev = run106([M("PD", "outward", "ЭВ1", { discipline: "ПБ", building: "А" }), M("RD", "inward", "ЭВ1", { building: "Б", evac: true })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Двери ЭВ1 названы в разных корпусах стадий — двери чужого корпуса не сравниваются");
    expect(run106([M("PD", "outward", "ЭВ1", { discipline: "ПБ", building: "А" }), M("RD", "inward", "ЭВ1", { building: "А" })]).status).toBe("CANDIDATE");
    expect(run106([M("PD", "outward", "ЭВ1", { discipline: "ПБ", building: "А" }), M("RD", "inward", "ЭВ1")]).status).toBe("CANDIDATE");
  });
  it("раздвижная дверь вместо распашной наружу — CANDIDATE; раздвижная без эталона у М-106 — MISSING_EVIDENCE", () => {
    const ev = run106([M("PD", "outward", "ЭВ1", { discipline: "ПБ" }), M("RD", "sliding", "ЭВ1", { evac: true })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/раздвижная или вращающаяся вместо распашной по направлению выхода \(ЭВ1\)/);
    expect(run106([M("RD", "sliding", "ЭВ1", { evac: true })]).status).toBe("MISSING_EVIDENCE");
  });
  it("дверь сужает путь в коридоре — не нарушение, а гипотеза «проверить по плану» (норма не подтверждена); без признака эвакуационной — NOT_COMPARABLE", () => {
    const ev = run106([M("RD", "blocks", "Д6", { evac: true, remaining_m: 0.4 })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/^Дверь Д6 открывается в коридор и сужает путь эвакуации до 0,4 м — гипотеза, проверьте по плану; порог 1,0 м — пункт СП 1\.13130\.2020 не подтверждён/);
    const s = ev.suspicions.find((x) => x.dedup_key.startsWith("direction-blocks:RD:"))!;
    expect(s.description).toMatch(/^Д6: полотно двери, открывающейся в коридор, сужает путь эвакуации до 0,4 м — проверьте по плану \(порог 1,0 м — пункт СП 1\.13130\.2020 не подтверждён/);
    // сужение не превращается в CANDIDATE и рядом с настоящим нарушением: нарушение — по своей двери, гипотеза — отдельно
    const both = run106([M("PD", "outward", "Д1", { discipline: "ПБ" }), M("RD", "inward", "Д1"), M("RD", "blocks", "Д6", { evac: true, remaining_m: null })]);
    expect(both.status).toBe("CANDIDATE");
    expect(both.reason).not.toMatch(/Д6/);
    expect(both.suspicions.some((x) => x.description.startsWith("Д6: полотно двери") && x.description.includes("сужает путь эвакуации — проверьте"))).toBe(true);
    // рядом с подтверждённым направлением — не NEGATIVE_VERIFIED: сужение не проверено
    expect(run106([M("PD", "outward", "Д1", { discipline: "ПБ" }), M("RD", "outward", "Д1"), M("RD", "blocks", "Д6", { evac: true })]).status).toBe("NOT_COMPARABLE");
    expect(run106([M("RD", "blocks", "Д6")]).status).toBe("NOT_COMPARABLE");
    expect(run106([M("RD", "blocks", "Д6")]).suspicions).toEqual([]);
  });
  it("направление только на чертеже («см. графику») — NOT_COMPARABLE с причиной", () => {
    const ev = run106([M("PD", "outward", null, { discipline: "ПБ" }), M("RD", "graphic", null, { excluded: "GRAPHIC_ONLY" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/^Направление открывания в РД показано только на чертеже/);
  });
});

describe("неясная эвакуационная строка и пределы входа (W3-09, W3-04)", () => {
  it("эвакуационная строка поздней стадии с отрицанием или двумя направлениями — гипотеза и не NEGATIVE_VERIFIED", () => {
    const ms = [M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "outward", "Д2", { evac: true }), M("RD", "outward", "Д1", { evac: true, excluded: "NEGATION", excluded_why: "под отрицанием", quote: "Д1 эвакуационная не открывается наружу" })];
    const ev = run43(ms);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Направление эвакуационных дверей Д1 в РД записано неоднозначно (под отрицанием) — проверьте по плану; остальные двери не ухудшены");
    expect(ev.suspicions.find((x) => x.dedup_key.startsWith("direction-unclear:RD:"))!.description).toMatch(/^Д1: направление открывания записано неоднозначно \(под отрицанием\): «Д1 эвакуационная не открывается наружу» — проверьте по плану$/);
    // марка эвакуационная по другой стадии — тоже гипотеза
    const byMark = run43([M("PD", "outward", "Д1", { discipline: "ПЗ", evac: true }), M("RD", "outward", "Д1"), M("RD", "inward", "Д1", { excluded: "AMBIGUOUS" })]);
    expect(byMark.status).toBe("NOT_COMPARABLE");
    // не эвакуационная строка с отрицанием — отсев, вывод прежний
    expect(run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("RD", "outward", "Д2", { evac: true }), M("RD", "outward", "Д9", { excluded: "NEGATION" })]).status).toBe("NEGATIVE_VERIFIED");
    // ПД с отрицанием — не поздняя стадия, гипотезы нет
    expect(run43([M("PD", "outward", null, { discipline: "ПЗ" }), M("PD", "inward", "Д3", { evac: true, excluded: "NEGATION" }), M("RD", "outward", "Д2", { evac: true })]).status).toBe("NEGATIVE_VERIFIED");
  });
  it("на вход — не больше MAX_MENTIONS упоминаний, отброшенное — пометкой в provenance", () => {
    const many = Array.from({ length: MAX_MENTIONS + 7 }, (_, i) => M("RD", "outward", `Д${i}`, { evac: true }));
    const ev = run43([M("PD", "outward", null, { discipline: "ПЗ" }), ...many]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.provenance.mentions).toHaveLength(MAX_MENTIONS);
    expect(ev.provenance.limit).toBe(`на вход взято ${MAX_MENTIONS} упоминаний из ${MAX_MENTIONS + 8} — остальные не рассмотрены`);
    expect(run43([M("PD", "outward", null, { discipline: "ПЗ" })]).provenance.limit).toBeNull();
  });
});

describe("склонение числа сравнений в причине", () => {
  it("1, 2, 5, 11, 12, 21, 22, 25, 111", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 14, 104].map(plural)).toEqual(["сравнение", "сравнения", "сравнений", "сравнений", "сравнений", "сравнение", "сравнения", "сравнений", "сравнений", "сравнений", "сравнения"]);
  });
});

describe("свойство: CANDIDATE только при «наружу → внутрь» без оговорки (L5)", () => {
  it("CANDIDATE тогда и только тогда", () => {
    const arb = fc.array(fc.record({ stage: fc.constantFrom<Stage>("PD", "RD"), value: fc.constantFrom<"outward" | "inward">("outward", "inward"), mark: fc.constantFrom("Д1", "Д2", null) }), { maxLength: 6 });
    fc.assert(
      fc.property(arb, (xs) => {
        const ms = xs.map((x) => M(x.stage, x.value, x.mark, { discipline: x.stage === "PD" ? "ПБ" : "АР", evac: true }));
        const ev = run106(ms);
        const pd = pickDirections(ms, "PD", P106, null);
        const rd = pickDirections(ms, "RD", P106, null);
        const bad = [...rd.doors.entries()].some(([k, a]) => a.value === "inward" && (pd.doors.get(k) ?? pd.doors.get("*"))?.value === "outward");
        return (ev.status === "CANDIDATE") === bad;
      }),
    );
  });
});
