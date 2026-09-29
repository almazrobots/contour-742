// Эшелоны: L1 (реестр видов: регистрация, поиск, упоминания, запись гипотезы), L3 (границы: пустые meta и рамки, нет
// упоминаний), L6 (ошибки данных: незнакомый, встроенный, повторный вид, поздняя регистрация). OS-INSP-7.1.20–7.1.24, T-186.
// Файл не импортирует passport.ts: реестр здесь ещё открыт, отказы регистрации проверяются напрямую.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertKnownKinds, baseMention, BUILTIN_EXTRACTOR_KINDS, BUILTIN_VALUE_KINDS, disciplineKey, kindMentions, kindOf, kindSpec, registerKind, registeredKinds,
  kindSlice, sealKinds, SUSPICION_REFS_MAX, suspicionRecord, UnknownParamKind, type KindMention, type KindRow, type ParamKind,
} from "../src/domain/param-kinds.ts";
import type { ParamPassport } from "../src/domain/passport.ts";

const schema = (kind: string, extra: z.ZodRawShape = {}) => z.object({ kind: z.literal(kind), ...extra });
const def = (kind: string, ex: string, more: Partial<ParamKind> = {}): ParamKind => ({
  kind, value: schema(kind), extractor: schema(ex),
  evaluate: () => ({ status: "MISSING_EVIDENCE", expected: null, actual: null, delta: null, reason: "", fragments: [], stage_notes: {}, suspicions: [], provenance: { ops: [], mentions: [] } }),
  ...more,
});

const row = (over: Partial<KindRow> = {}): KindRow => ({
  file_id: "f1", sha256: "a".repeat(64), doc_stage: "PD", document_code: "П-2099-01-001-АР", revision: "1", approval_status: "APPROVED", revision_role: "CURRENT",
  discipline: "ар2", value_num: 12.5, value_text: "есть", page: 3, bbox_json: "[0.1,0.2,0.3,0.4]", anchor_bbox_json: "[0,0,0.1,0.1]",
  meta_json: JSON.stringify({ quote: "… есть …", excluded: "NEIGHBOR", excluded_why: "соседнее здание", text_source: "pdf-text" }), line_text: "строка", confidence: 0.9,
  ...over,
});

describe("реестр видов: регистрация (OS-INSP-7.1.20)", () => {
  it("встроенные виды ordinal/quantity и их извлекатели — вне реестра", () => {
    expect(BUILTIN_VALUE_KINDS).toEqual(["ordinal", "quantity"]);
    expect(BUILTIN_EXTRACTOR_KINDS).toEqual(["class_mentions", "quantity_mentions"]);
    expect(kindOf("ordinal")).toBeNull();
    expect(kindOf("quantity")).toBeNull();
  });
  it("зарегистрированный вид находится по value.kind и виден в списке в порядке регистрации", () => {
    const a = registerKind(def("u_alpha", "u_alpha_mentions"));
    const b = registerKind(def("u_beta", "u_beta_mentions"));
    expect(kindOf("u_alpha")).toBe(a);
    expect(registeredKinds().slice(-2)).toEqual([a, b]);
  });
  it("встроенный вид зарегистрировать нельзя", () => {
    expect(() => registerKind(def("quantity", "q2"))).toThrow("реестр видов: «quantity» — встроенный вид, регистрировать нельзя");
    expect(() => registerKind(def("ordinal", "o2"))).toThrow("встроенный вид");
  });
  it("повтор вида — отказ", () => {
    expect(() => registerKind(def("u_alpha", "u_other"))).toThrow("реестр видов: вид «u_alpha» уже зарегистрирован");
  });
  it("kind схемы value не равен виду — отказ с обоими именами", () => {
    expect(() => registerKind({ ...def("u_gamma", "u_gamma_mentions"), value: schema("u_wrong") })).toThrow("реестр видов: kind схемы value (u_wrong) ≠ «u_gamma»");
    expect(() => registerKind({ ...def("u_gamma", "u_gamma_mentions"), value: z.object({ x: z.string() }) })).toThrow("kind схемы value (undefined) ≠ «u_gamma»");
    expect(kindOf.bind(null, "u_gamma")).toThrow(UnknownParamKind);
  });
  it("извлекатель занят встроенным, другим видом или без kind-литерала — отказ", () => {
    expect(() => registerKind(def("u_d1", "class_mentions"))).toThrow("реестр видов: извлекатель «class_mentions» уже занят");
    expect(() => registerKind(def("u_d2", "quantity_mentions"))).toThrow("извлекатель «quantity_mentions» уже занят");
    expect(() => registerKind(def("u_d3", "u_alpha_mentions"))).toThrow("извлекатель «u_alpha_mentions» уже занят");
    expect(() => registerKind({ ...def("u_d4", "x"), extractor: z.object({ kind: z.string() }) })).toThrow("извлекатель «undefined» уже занят");
    // отказ ничего не оставляет в реестре
    for (const k of ["u_d1", "u_d2", "u_d3", "u_d4"]) expect(() => kindOf(k)).toThrow(UnknownParamKind);
  });
});

describe("незнакомый вид — ошибка данных с именем вида (OS-INSP-7.1.24)", () => {
  it("kindOf: имя вида и место в сообщении", () => {
    let err: unknown;
    try {
      kindOf("geometry", "M-777");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownParamKind);
    expect(err).toMatchObject({ name: "UnknownParamKind", field: "value", kind: "geometry" });
    expect((err as Error).message).toBe("M-777: вид значения «geometry» не зарегистрирован в реестре видов (domain/param-kinds.ts, domain/kinds/index.ts)");
    expect(() => kindOf("geometry")).toThrow(/^вид значения «geometry» не зарегистрирован/);
  });
  it("assertKnownKinds: сырой паспорт — незнакомый value.kind и extractor.kind названы", () => {
    expect(() => assertKnownKinds({ value: { kind: "geometry" }, extractor: { kind: "class_mentions" } }, "паспорт M-050.json")).toThrow("паспорт M-050.json: вид значения «geometry» не зарегистрирован");
    expect(() => assertKnownKinds({ value: { kind: "quantity" }, extractor: { kind: "layers_mentions" } }, "паспорт M-051.json")).toThrow(
      "паспорт M-051.json: вид извлекателя «layers_mentions» не зарегистрирован",
    );
  });
  it("assertKnownKinds: встроенные и зарегистрированные виды проходят; нет полей — решает схема", () => {
    expect(() => assertKnownKinds({ value: { kind: "ordinal" }, extractor: { kind: "class_mentions" } }, "x")).not.toThrow();
    expect(() => assertKnownKinds({ value: { kind: "quantity" }, extractor: { kind: "quantity_mentions" } }, "x")).not.toThrow();
    expect(() => assertKnownKinds({ value: { kind: "u_alpha" }, extractor: { kind: "u_alpha_mentions" } }, "x")).not.toThrow();
    for (const raw of [null, 5, "s", {}, { value: {}, extractor: {} }, { value: { kind: 1 }, extractor: { kind: 2 } }]) expect(() => assertKnownKinds(raw, "x")).not.toThrow();
  });
});

describe("строки извлечения → упоминания", () => {
  it("baseMention: поля файла, раздел по марке, рамки, отсев, цитата и след источника", () => {
    expect(baseMention(row())).toEqual({
      stage: "PD", file_id: "f1", sha256: "a".repeat(64), document_code: "П-2099-01-001-АР", revision: "1", approval_status: "APPROVED", role: "CURRENT",
      discipline: "АР", base: "2099-01-001", value: "есть", num: 12.5, excluded: "NEIGHBOR", excluded_why: "соседнее здание",
      page: 3, bbox: [0.1, 0.2, 0.3, 0.4], anchor_bbox: [0, 0, 0.1, 0.1], quote: "… есть …", confidence: 0.9,
      meta: { quote: "… есть …", excluded: "NEIGHBOR", excluded_why: "соседнее здание", text_source: "pdf-text" },
      source: "pdf-text", readings: null, reader_outcome: null, judge: null,
    });
  });
  it("baseMention: пустые meta и рамки, раздел из шифра, цитата — строка, уверенности нет — 0", () => {
    const m = baseMention(row({ meta_json: null, bbox_json: null, anchor_bbox_json: undefined, discipline: null, confidence: null, value_text: null, value_num: null }));
    expect(m).toMatchObject({ meta: {}, bbox: null, anchor_bbox: null, discipline: "АР", quote: "строка", confidence: 0, excluded: null, excluded_why: null, value: null, num: null, source: null });
    expect(baseMention(row({ meta_json: "{}", line_text: null })).quote).toBe("");
    expect(baseMention(row({ meta_json: JSON.stringify({ quote: 5, excluded: 1, excluded_why: true }) }))).toMatchObject({ quote: "строка", excluded: null, excluded_why: null });
  });
  it("kindMentions: своя функция вида или baseMention", () => {
    expect(kindMentions(def("u_m", "u_m_x"), [row(), row({ page: 4 })]).map((m) => m.page)).toEqual([3, 4]);
    const own = def("u_m2", "u_m2_x", { mentions: (rs) => rs.map((r) => ({ ...baseMention(r), value: "своё" })) });
    expect(kindMentions(own, [row()]).map((m) => m.value)).toEqual(["своё"]);
  });
  it("disciplineKey: буквенная часть марки", () => {
    expect([disciplineKey("АР1"), disciplineKey(" ios5.4"), disciplineKey("12"), disciplineKey(null), disciplineKey(undefined)]).toEqual(["АР", "IOS", null, null, null]);
  });
});

describe("спецификация извлекателя и запись гипотезы (OS-INSP-7.1.21, 7.1.23)", () => {
  const pp = { extractor: { kind: "u_alpha_mentions", anchor: "якорь" }, value: { kind: "u_alpha" }, sources: { PD: [], RD: [], ID: [] }, link: { by: "none", note: "" }, basis: "СП" } as unknown as ParamPassport;
  const x = kindSlice(pp);
  it("kindSpec: extractor паспорта как есть (копия) или своя функция вида", () => {
    expect(kindSlice({ ...pp, code: "M-1", steps: {} } as ParamPassport)).toEqual({ value: pp.value, extractor: pp.extractor, sources: pp.sources, link: pp.link, basis: "СП" });
    const s = kindSpec(def("u_s", "u_s_x"), x);
    expect(s).toEqual({ kind: "u_alpha_mentions", anchor: "якорь" });
    expect(s).not.toBe(pp.extractor);
    expect(kindSpec(def("u_s2", "u_s2_x", { spec: (p) => ({ from: p.extractor.anchor }) }), x)).toEqual({ from: "якорь" });
  });
  const m = (over: Partial<KindMention>): KindMention => ({ ...baseMention(row()), ...over });
  it("гипотеза ПД: ссылки на все упоминания, опора — первое с рамкой, минимум уверенности, ключ с кодом параметра", () => {
    const s = { stage: "PD" as const, description: "разные значения", dedup_key: "k1", mentions: [m({ bbox: null, confidence: 0.7, page: 1 }), m({ confidence: 0.5, page: 2, quote: "цитата" }), m({ confidence: 0.9, page: 5 })] };
    expect(suspicionRecord("M-777", s, "СП 1")).toEqual({
      confidence: 0.5,
      description: "M-777: разные значения",
      pd_reference: "П-2099-01-001-АР, ред. 1, стр. 1; П-2099-01-001-АР, ред. 1, стр. 2; П-2099-01-001-АР, ред. 1, стр. 5",
      rd_reference: null,
      normative_base: "СП 1",
      dedup_key: "M-777:k1",
      anchor: JSON.stringify({ file_id: "f1", page: 2, bbox: [0.1, 0.2, 0.3, 0.4], quote: "цитата" }),
    });
  });
  it("гипотеза РД: ссылки в rd_reference; своя цитата вида; без рамок — без опоры; без упоминаний — уверенность 0", () => {
    const s = { stage: "RD" as const, description: "d", dedup_key: "k", mentions: [m({ page: 7 })] };
    const r = suspicionRecord("M-1", s, null, (x) => `q:${x.page}`);
    expect([r.pd_reference, r.rd_reference, r.normative_base, JSON.parse(r.anchor!).quote]).toEqual([null, "П-2099-01-001-АР, ред. 1, стр. 7", null, "q:7"]);
    expect(suspicionRecord("M-1", { ...s, stage: "ID", mentions: [m({ bbox: null })] }, null).anchor).toBeNull();
    expect(suspicionRecord("M-1", { ...s, stage: "ID", mentions: [m({ bbox: null })] }, null).rd_reference).toBe("П-2099-01-001-АР, ред. 1, стр. 3");
    expect(suspicionRecord("M-1", { ...s, mentions: [] }, null)).toMatchObject({ confidence: 0, anchor: null, rd_reference: "" });
  });
  it("L3 · 10⁵ упоминаний: без RangeError от spread, минимум уверенности по всем, ссылок не больше предела и счёт остальных (OWASP-0253)", () => {
    const many = Array.from({ length: 100_000 }, (_, i) => m({ page: i + 1, confidence: i === 99_999 ? 0.1 : 0.8 }));
    const r = suspicionRecord("M-1", { stage: "PD", description: "d", dedup_key: "k", mentions: many }, null);
    expect(r.confidence).toBe(0.1);
    const refs = r.pd_reference!.split("; ");
    expect(refs).toHaveLength(SUSPICION_REFS_MAX + 1);
    expect(refs[0]).toBe("П-2099-01-001-АР, ред. 1, стр. 1");
    expect(refs.at(-1)).toBe(`и ещё ${100_000 - SUSPICION_REFS_MAX}`);
    // ровно на пределе — без хвоста
    const edge = suspicionRecord("M-1", { stage: "PD", description: "d", dedup_key: "k", mentions: many.slice(0, SUSPICION_REFS_MAX) }, null);
    expect(edge.pd_reference!.split("; ")).toHaveLength(SUSPICION_REFS_MAX);
  });
});

describe("поздняя регистрация (после построения схемы паспорта) — отказ", () => {
  it("sealKinds закрывает реестр: вид не пропадает молча из схемы", () => {
    sealKinds();
    expect(() => registerKind(def("u_late", "u_late_mentions"))).toThrow(
      "реестр видов: «u_late» зарегистрирован после построения схемы паспорта — модуль вида подключается в domain/kinds/index.ts",
    );
    expect(() => kindOf("u_late")).toThrow(UnknownParamKind);
  });
});
