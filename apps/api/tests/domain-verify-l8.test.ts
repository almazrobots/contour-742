// Эшелоны: L1 (правила ворот GTE-04/05, VER-01…11, CMP-29), L3 (границы: зазор 5 % листа, порог уверенности, диапазон),
// L5 (fast-check: слой только понижает на всём пространстве статусов). Имена тестов — ссылки трассы (model.yaml → impl),
// T-177. Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ApprovedChange } from "../src/domain/changes.ts";
import type { Evaluation, FindingStatus, Fragment, RevisionRole, Stage } from "../src/domain/types.ts";
import {
  GateConfigSchema, L8_OPS, LOWER_TO, NEAR, ParamDepsSchema, atomsOf, canLower, cascadeRoots, changeLegit, changeNo, fold, gap, isRefinement, opFor, revNo, unitOf, verifyL8, violating,
  type ChangeMark, type FragmentFacts, type GateConfig, type L8Context, type RevisionInfo, type SearchedSheet,
} from "../src/domain/verify-l8.ts";

const GATES: GateConfig = {
  min_confidence: { default: 0.5, "CMP-04": 0.6 },
  methods: { "M-002": { PD: "ТЭП", RD: "ТЭП", ID: "БТИ" }, "M-009": { PD: "БС", RD: "МСК" } },
  equivalent_methods: [["БС", "БС-77"]],
  sheet_kinds: { "CMP-12": ["drawing"] },
};

const frag = (stage: Stage, kind: Fragment["kind"], value: string, o: Partial<Fragment> = {}): Fragment => ({
  file_id: `f-${stage}`, sha256: "a".repeat(64), stage, document_code: `001-${stage}`, revision: "1", approval_status: "APPROVED", page: 3, bbox: [0.4, 0.4, 0.5, 0.45], role: "CURRENT", value, kind, ...o,
});

const cand = (o: Partial<Evaluation> = {}): Evaluation => ({
  status: "CANDIDATE", expected: "100", actual: "90", delta: "-10", reason: "ПД → РД: уменьшение", stage_notes: {},
  fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90")], ...o,
});

const facts0: FragmentFacts = { confidence: 0.9, quality: "OK", doc_kind: null, unit: null };
const ctx = (o: Partial<L8Context> = {}): L8Context => ({
  param_code: "M-001", op: "CMP-01", threshold_rule: false, units_normalized: false, gates: GATES, facts: () => facts0,
  revisions: [], changes: [], marks: [], searched: [], ...o,
});

const change = (o: Partial<ApprovedChange> = {}): ApprovedChange => ({
  id: 1, inspection_id: "i", object_id: "o", number: "3", date: "2026-05-01", param_codes: ["M-001"], basis_file_id: null, basis_file_name: null, description: "", created_by: "u", created_at: "", ...o,
});
const mark = (o: Partial<ChangeMark> = {}): ChangeMark => ({ file_id: "f-RD", page: 3, kind: "cloud", number: "3", bbox: [0.38, 0.38, 0.52, 0.47], text: "", ...o });

describe("GTE-04 сопоставимость", () => {
  it("площадь ТЭП ПД и площадь БТИ ИД — разные методики: кандидат уходит в NOT_COMPARABLE", () => {
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("ID", "actual", "90")] });
    const r = verifyL8(ev, ctx({ param_code: "M-002" }));
    expect(r.status).toBe("NOT_COMPARABLE");
    expect(r.l8.reason_code).toBe("NOT_COMPARABLE");
    expect(r.reason).toMatch(/методикам: ID — БТИ|PD — ТЭП/);
    expect(r.l8.steps[0]).toMatchObject({ op: "GTE-04", from: "CANDIDATE", to: "NOT_COMPARABLE" });
  });
  it("одинаковая или равнозначная методика — ворота пройдены", () => {
    expect(verifyL8(cand(), ctx({ param_code: "M-002" })).status).toBe("CANDIDATE");
    const ev = cand();
    const g = { ...GATES, methods: { "M-009": { PD: "БС", RD: "БС-77" } } };
    expect(verifyL8(ev, ctx({ param_code: "M-009", gates: g })).status).toBe("CANDIDATE");
    const g2 = { ...GATES, methods: { "M-009": { PD: "БС", RD: "МСК" } } };
    expect(verifyL8(ev, ctx({ param_code: "M-009", gates: g2 })).status).toBe("NOT_COMPARABLE");
  });
  it("единицы не приведены (м и мм) на лексическом пути — NOT_COMPARABLE; паспортный путь единицы привёл сам", () => {
    const units = (f: Fragment): FragmentFacts => ({ ...facts0, unit: f.stage === "PD" ? "м" : "мм" });
    expect(verifyL8(cand(), ctx({ facts: units })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand(), ctx({ facts: units, units_normalized: true })).status).toBe("CANDIDATE");
    // единица записана только у одной стороны — сверять не с чем
    expect(verifyL8(cand(), ctx({ facts: (f) => ({ ...facts0, unit: f.stage === "PD" ? "м" : null }) })).status).toBe("CANDIDATE");
  });
  it("вид документа не годится для оператора — NOT_COMPARABLE; неизвестный вид не мешает", () => {
    const kinds = (f: Fragment): FragmentFacts => ({ ...facts0, doc_kind: f.stage === "RD" ? "specification" : "drawing" });
    expect(verifyL8(cand(), ctx({ op: "CMP-12", facts: kinds })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand(), ctx({ op: "CMP-12", facts: () => facts0 })).status).toBe("CANDIDATE");
    expect(verifyL8(cand(), ctx({ op: "CMP-01", facts: kinds })).status).toBe("CANDIDATE");
    // пороговое правило: ожидаемое — норма, проверяется только вид фактического фрагмента
    expect(verifyL8(cand({ fragments: [frag("RD", "actual", "90")] }), ctx({ op: "CMP-12", threshold_rule: true, facts: kinds })).status).toBe("NOT_COMPARABLE");
  });
  it("отрицательный результат понижается, только если несопоставимы все пары", () => {
    const nv = cand({ status: "NEGATIVE_VERIFIED", actual: "100", fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "100"), frag("ID", "actual", "100")] });
    expect(verifyL8(nv, ctx({ param_code: "M-002" })).status).toBe("NEGATIVE_VERIFIED");
    const onlyId = cand({ status: "NEGATIVE_VERIFIED", actual: "100", fragments: [frag("PD", "expected", "100"), frag("ID", "actual", "100")] });
    expect(verifyL8(onlyId, ctx({ param_code: "M-002" })).status).toBe("NOT_COMPARABLE");
  });
});

describe("GTE-05 качество извлечения", () => {
  it("страница LOW_QUALITY у фрагмента кандидата — NOT_COMPARABLE с причиной EXTRACTION_QUALITY", () => {
    const low = (f: Fragment): FragmentFacts => ({ ...facts0, quality: f.stage === "RD" ? "LOW_QUALITY" : "OK" });
    const r = verifyL8(cand(), ctx({ facts: low }));
    expect(r.status).toBe("NOT_COMPARABLE");
    expect(r.l8.reason_code).toBe("EXTRACTION_QUALITY");
    expect(verifyL8(cand(), ctx({ facts: () => ({ ...facts0, quality: "ABSTAIN" }) })).l8.reason_code).toBe("EXTRACTION_QUALITY");
  });
  it("порог уверенности оператора: ниже — NOT_COMPARABLE, ровно на пороге — пропуск", () => {
    const conf = (c: number) => () => ({ ...facts0, confidence: c });
    expect(verifyL8(cand(), ctx({ facts: conf(0.49) })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand(), ctx({ facts: conf(0.5) })).status).toBe("CANDIDATE");
    expect(verifyL8(cand(), ctx({ op: "CMP-04", facts: conf(0.55) })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand(), ctx({ facts: () => ({ ...facts0, confidence: null }) })).status).toBe("CANDIDATE");
    expect(verifyL8(cand(), ctx({ gates: { ...GATES, min_confidence: {} }, facts: conf(0.01) })).status).toBe("CANDIDATE");
    // порог параметра важнее порога оператора
    const g = { ...GATES, min_confidence: { default: 0.5, "CMP-04": 0.6, "M-001": 0.2 } };
    expect(verifyL8(cand(), ctx({ op: "CMP-04", gates: g, facts: conf(0.3) })).status).toBe("CANDIDATE");
    expect(verifyL8(cand(), ctx({ op: "CMP-04", gates: g, facts: conf(0.1) })).status).toBe("NOT_COMPARABLE");
  });
  it("отрицательный результат уходит в NOT_COMPARABLE, только если ненадёжна вся сторона", () => {
    const nv = cand({ status: "NEGATIVE_VERIFIED", actual: "100", fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "100"), frag("ID", "actual", "100")] });
    const idLow = (f: Fragment): FragmentFacts => ({ ...facts0, quality: f.stage === "ID" ? "LOW_QUALITY" : "OK" });
    expect(verifyL8(nv, ctx({ facts: idLow })).status).toBe("NEGATIVE_VERIFIED");
    const pdLow = (f: Fragment): FragmentFacts => ({ ...facts0, quality: f.stage === "PD" ? "LOW_QUALITY" : "OK" });
    expect(verifyL8(nv, ctx({ facts: pdLow })).status).toBe("NOT_COMPARABLE");
  });
  it("кандидат по нарушенному фрагменту: низкое качество другого фактического фрагмента не мешает", () => {
    const ev = cand({ actual: "90", fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "100")] });
    const idLow = (f: Fragment): FragmentFacts => ({ ...facts0, quality: f.stage === "ID" ? "LOW_QUALITY" : "OK" });
    expect(verifyL8(ev, ctx({ facts: idLow })).status).toBe("CANDIDATE");
  });
});

describe("VER-01 повтор ворот по фрагментам", () => {
  it("фрагмент спорной редакции — CLARIFICATION_REQUIRED", () => {
    for (const role of ["CONFLICT", "UNRESOLVED"] as RevisionRole[]) {
      const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { role })] });
      const r = verifyL8(ev, ctx());
      expect(r.status).toBe("CLARIFICATION_REQUIRED");
      expect(r.l8.steps[0].op).toBe("VER-01");
    }
  });
  it("кандидат собран из разных редакций одного документа — CLARIFICATION_REQUIRED", () => {
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("RD", "actual", "95", { revision: "2", file_id: "f-RD2" })] });
    const r = verifyL8(ev, ctx());
    expect(r.status).toBe("CLARIFICATION_REQUIRED");
    expect(r.reason).toMatch(/разных редакций 001-RD: 1, 2/);
  });
});

describe("VER-03 устаревшая редакция", () => {
  it("фрагмент SUPERSEDED или CANCELLED — CLARIFICATION_REQUIRED, отдельный флаг STALE_REVISION", () => {
    const a = verifyL8(cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { role: "SUPERSEDED" })] }), ctx());
    expect(a.status).toBe("CLARIFICATION_REQUIRED");
    expect(a.l8.flags).toContain("STALE_REVISION");
    expect(a.l8.reason_code).toBe("WRONG_REVISION");
    const b = verifyL8(cand({ fragments: [frag("PD", "expected", "100", { approval_status: "CANCELLED" }), frag("RD", "actual", "90")] }), ctx());
    expect(b.l8.flags).toContain("STALE_REVISION");
  });
  it("подмена редакции: в пакете есть более поздняя редакция документа — CLARIFICATION_REQUIRED", () => {
    const revs: RevisionInfo[] = [
      { file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "1", role: "CURRENT", approval_status: "APPROVED", stamp_change: null },
      { file_id: "f-RD2", stage: "RD", document_code: "001-RD", revision: "2", role: "SUPERSEDED", approval_status: "APPROVED", stamp_change: null },
    ];
    const r = verifyL8(cand(), ctx({ revisions: revs }));
    expect(r.status).toBe("CLARIFICATION_REQUIRED");
    expect(r.reason).toMatch(/более поздняя ред\. 2/);
    // другой документ или другая стадия — не соперник
    const other = revs.map((x) => (x.file_id === "f-RD2" ? { ...x, document_code: "002-RD" } : x));
    expect(verifyL8(cand(), ctx({ revisions: other })).status).toBe("CANDIDATE");
    const older = revs.map((x) => (x.file_id === "f-RD2" ? { ...x, revision: "0" } : x));
    expect(verifyL8(cand(), ctx({ revisions: older })).status).toBe("CANDIDATE");
  });
  it("подмена редакции по штампу: номера редакций не числа, а изменение в штампе соседа позже", () => {
    const revs: RevisionInfo[] = [
      { file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "А", role: "CURRENT", approval_status: "APPROVED", stamp_change: 1 },
      { file_id: "f-RD2", stage: "RD", document_code: "001-RD", revision: "Б", role: "SUPERSEDED", approval_status: "APPROVED", stamp_change: 2 },
    ];
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { revision: "А" })] });
    expect(verifyL8(ev, ctx({ revisions: revs })).l8.flags).toContain("STALE_REVISION");
    const same = revs.map((x) => ({ ...x, stamp_change: 1 }));
    expect(verifyL8(ev, ctx({ revisions: same })).status).toBe("CANDIDATE");
    const noOwn = revs.map((x) => (x.file_id === "f-RD" ? { ...x, stamp_change: null } : x));
    expect(verifyL8(ev, ctx({ revisions: noOwn })).status).toBe("CANDIDATE");
  });
});

describe("VER-02 двусторонность", () => {
  it("у кандидата нет фрагмента ожидаемого или фактического — NOT_COMPARABLE", () => {
    expect(verifyL8(cand({ fragments: [frag("RD", "actual", "90")] }), ctx()).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand({ fragments: [frag("PD", "expected", "100")] }), ctx()).status).toBe("NOT_COMPARABLE");
    // сравнение с нормой: ожидаемое — сама норма, хватает фактического
    expect(verifyL8(cand({ fragments: [frag("RD", "actual", "90")] }), ctx({ threshold_rule: true })).status).toBe("CANDIDATE");
  });
  it("для REMOVED фактическое — зона без элемента с рамкой; без рамки — NOT_COMPARABLE", () => {
    const zone = cand({ actual: "—", fragments: [frag("PD", "expected", "В2.7"), frag("RD", "actual", "—", { bbox: null })] });
    expect(verifyL8(zone, ctx()).l8.steps.find((s) => s.op === "VER-02")?.to).toBe("NOT_COMPARABLE");
  });
});

const sheet = (o: Partial<SearchedSheet> = {}): SearchedSheet => ({ file_id: "f-RD", stage: "RD", document_code: "001-RD", pages: 12, parsed: true, low_quality_pages: [], ...o });

describe("VER-05 доказательство отсутствия", () => {
  const removed = () => ({ ...cand({ actual: "—", fragments: [frag("PD", "expected", "В2.7"), frag("RD", "actual", "—")] }), absence: true });
  it("отсутствие доказано: листы стадии разобраны без LOW_QUALITY — кандидат остаётся, в карточке список просмотренных листов", () => {
    const r = verifyL8(removed(), ctx({ searched: [sheet(), sheet({ file_id: "f-RD-2", document_code: "001-ОВ2" }), sheet({ stage: "PD", file_id: "f-PD" })] }));
    expect(r.status).toBe("CANDIDATE");
    expect(r.l8.searched?.map((s) => s.document_code)).toEqual(["001-RD", "001-ОВ2"]);
  });
  it("лист не разобран или страница LOW_QUALITY — NOT_COMPARABLE; листов стадии нет — MISSING_EVIDENCE", () => {
    expect(verifyL8(removed(), ctx({ searched: [sheet({ low_quality_pages: [4] })] })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(removed(), ctx({ searched: [sheet({ parsed: false })] })).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(removed(), ctx({ searched: [sheet({ stage: "PD" })] })).status).toBe("MISSING_EVIDENCE");
  });
  it("MISSING_EVIDENCE — в карточке список просмотренных документов, статус тот же", () => {
    const r = verifyL8(cand({ status: "MISSING_EVIDENCE", fragments: [frag("PD", "expected", "100")] }), ctx({ searched: [sheet(), sheet({ stage: "PD" })] }));
    expect(r.status).toBe("MISSING_EVIDENCE");
    expect(r.l8.searched).toHaveLength(2);
    // значения нет только в РД — в списке только документы РД
    const rd = verifyL8(cand({ status: "MISSING_EVIDENCE", stage_notes: { PD: "USED", RD: "NO_VALUE", ID: "NOT_APPLICABLE" }, fragments: [frag("PD", "expected", "100")] }), ctx({ searched: [sheet(), sheet({ stage: "PD" })] }));
    expect(rd.l8.searched?.map((s) => s.stage)).toEqual(["RD"]);
  });
  it("обычный кандидат (не отсутствие) покрытие не проверяет", () => {
    const r = verifyL8(cand(), ctx({ searched: [sheet({ parsed: false })] }));
    expect(r.status).toBe("CANDIDATE");
    expect(r.l8.searched).toBeNull();
  });
});

describe("VER-07 детализация", () => {
  it("РД уточняет значение ПД — NEGATIVE_VERIFIED с причиной DETAIL_REFINEMENT", () => {
    const r = verifyL8(cand({ expected: "B25", actual: "В25 W6 F150", fragments: [frag("PD", "expected", "B25"), frag("RD", "actual", "В25 W6 F150")] }), ctx({ op: "CMP-05" }));
    expect(r.status).toBe("NEGATIVE_VERIFIED");
    expect(r.l8.reason_code).toBe("DETAIL_REFINEMENT");
  });
  it("признаки детализации: диапазон и ограничение ПД, уточнение марки; замена — не детализация", () => {
    expect(isRefinement("200…250", "220")).toBe(true);
    expect(isRefinement("200-250", "260")).toBe(false);
    expect(isRefinement("250-200", "200")).toBe(true);
    expect(isRefinement("не менее 150", "150 мм")).toBe(true);
    expect(isRefinement("не менее 150", "149")).toBe(false);
    expect(isRefinement("не более 35", "35")).toBe(true);
    expect(isRefinement("не более 35", "36")).toBe(false);
    expect(isRefinement("ВВГнг(А)-LS", "ВВГнг(А)-LS 5х10")).toBe(true);
    expect(isRefinement("ВВГнг(А)-FRLS", "ВВГнг(А)-LS")).toBe(false);
    expect(isRefinement("С1", "С1, С2")).toBe(false);
    expect(isRefinement("В2", "В25")).toBe(false);
    expect(isRefinement("100", "90")).toBe(false);
    expect(isRefinement("С", "С1")).toBe(false);
    expect(isRefinement("EI60", "EI60")).toBe(false);
    expect(isRefinement(null, "x")).toBe(false);
    expect(isRefinement("x", null)).toBe(false);
    expect(isRefinement("А500С", "A500C (ГОСТ 34028)")).toBe(true);
    expect(isRefinement("Ø20", "Ø20/Ø25")).toBe(false);
  });
  it("пороговое правило детализацией не снимается", () => {
    const ev = cand({ expected: "не менее 150", actual: "150", fragments: [frag("RD", "actual", "150")] });
    expect(verifyL8(ev, ctx({ threshold_rule: true })).status).toBe("CANDIDATE");
  });
});

describe("CMP-29 и VER-08 легитимность изменения", () => {
  it("облако с номером изменения рядом и нет регистрации — CANDIDATE с approved_change_ref и флагом CHANGE_APPROVAL_UNVERIFIED", () => {
    const r = verifyL8(cand(), ctx({ marks: [mark()] }));
    expect(r.status).toBe("CANDIDATE");
    expect(r.l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
    expect(r.l8.flags).toContain("CHANGE_APPROVAL_UNVERIFIED");
    expect(r.l8.approved_change_ref).toMatch(/облако изм\. 3 \(стр\. 3\)/);
  });
  it("изменение найдено на листе и подтверждено документом-основанием реестра — NEGATIVE_VERIFIED, причина APPROVED_CHANGE", () => {
    const basis = change({ basis_file_id: "f-basis", basis_file_name: "Письмо.pdf" });
    const r = verifyL8(cand(), ctx({ marks: [mark()], changes: [basis] }));
    expect(r.status).toBe("NEGATIVE_VERIFIED");
    expect(r.l8.reason_code).toBe("APPROVED_CHANGE");
    expect(r.l8.approved_change_ref).toBe("№ 3 от 01.05.2026, основание — Письмо.pdf");
    // основание без имени файла — ссылка на идентификатор
    expect(verifyL8(cand(), ctx({ marks: [mark()], changes: [change({ basis_file_id: "f-basis" })] })).l8.approved_change_ref).toMatch(/основание — f-basis$/);
    // запись реестра с основанием, но на листе отметки нет — утверждение системой не проверено, решает инспектор
    const onlyReg = verifyL8(cand(), ctx({ changes: [basis] }));
    expect(onlyReg.status).toBe("CANDIDATE");
    expect(onlyReg.l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
  });
  it("зарегистрировано без основания — CANDIDATE с флагом; изменение другого параметра не считается", () => {
    const a = verifyL8(cand(), ctx({ changes: [change()] }));
    expect(a.status).toBe("CANDIDATE");
    expect(a.l8.approved_change_ref).toMatch(/№ 3 от 01\.05\.2026 \(без документа-основания\)/);
    const b = verifyL8(cand(), ctx({ changes: [change({ param_codes: ["M-002"], basis_file_id: "x" })] }));
    expect(b.l8.change).toBe("NONE");
    expect(b.l8.approved_change_ref).toBe("NONE");
  });
  it("номер изменения на листе не совпадает с зарегистрированным — CLARIFICATION_REQUIRED", () => {
    const r = verifyL8(cand(), ctx({ marks: [mark({ number: "4" })], changes: [change({ basis_file_id: "b" })] }));
    expect(r.status).toBe("CLARIFICATION_REQUIRED");
    expect(r.l8.change).toBe("CHANGE_CONFLICT");
    expect(verifyL8(cand(), ctx({ marks: [mark({ number: "Изм. №3" })], changes: [change({ basis_file_id: "b" })] })).status).toBe("NEGATIVE_VERIFIED");
    // облако без номера не спорит с реестром, но и утверждения не подтверждает: номер не связан с изменением
    expect(verifyL8(cand(), ctx({ marks: [mark({ number: null })], changes: [change({ basis_file_id: "b" })] })).l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
  });
  it("изменение в штампе новее редакции реестра — флаг STAMP_REVISION_MISMATCH, кандидат остаётся и не снимается даже с основанием", () => {
    const revs: RevisionInfo[] = [{ file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "1", role: "CURRENT", approval_status: "APPROVED", stamp_change: 2 }];
    const r = verifyL8(cand(), ctx({ marks: [mark({ kind: "stamp_row", number: "2", bbox: null })], revisions: revs }));
    expect(r.status).toBe("CANDIDATE");
    expect(r.l8.flags).toEqual(["CHANGE_APPROVAL_UNVERIFIED", "STAMP_REVISION_MISMATCH"]);
    expect(r.l8.steps[0].why).toMatch(/в штампе 001-RD изм\. 2, а в реестре ред\. 1$/);
    const withBasis = verifyL8(cand(), ctx({ marks: [mark({ number: "2" })], revisions: revs, changes: [change({ number: "2", basis_file_id: "b" })] }));
    expect(withBasis.status).toBe("CANDIDATE");
    // без отметки изменения рядом номер штампа не проверяется
    expect(verifyL8(cand(), ctx({ revisions: revs })).status).toBe("CANDIDATE");
  });
  it("облако далеко от фрагмента, на другой странице или в другом файле — изменение не найдено", () => {
    const far = mark({ bbox: [0.4 + 0.1 + NEAR + 0.01, 0.4, 0.7, 0.45] });
    expect(verifyL8(cand(), ctx({ marks: [far] })).l8.change).toBe("NONE");
    expect(verifyL8(cand(), ctx({ marks: [mark({ page: 4 })] })).l8.change).toBe("NONE");
    expect(verifyL8(cand(), ctx({ marks: [mark({ file_id: "f-PD" })] })).l8.change).toBe("NONE");
    expect(verifyL8(cand(), ctx({ marks: [mark({ bbox: null })] })).l8.change).toBe("NONE");
    const edge = mark({ bbox: [0.5 + NEAR, 0.4, 0.7, 0.45] });
    expect(verifyL8(cand(), ctx({ marks: [edge] })).l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
  });
  it("строка таблицы изменений штампа того же листа — изменение найдено", () => {
    const r = changeLegit(ctx({ marks: [mark({ kind: "stamp_row", bbox: null, number: "2" })] }), cand());
    expect(r.result).toBe("CHANGE_APPROVAL_UNVERIFIED");
    expect(r.ref).toBe("таблица изменений штампа изм. 2 (стр. 3)");
  });
  it("не кандидат — CMP-29 не применяется", () => {
    const r = verifyL8(cand({ status: "NEGATIVE_VERIFIED" }), ctx({ marks: [mark()] }));
    expect(r.l8.change).toBeNull();
    expect(r.l8.approved_change_ref).toBeNull();
  });
});

describe("VER-11 атомизация", () => {
  it("кандидат по двум стадиям — два атомарных факта и флаг COMPOSITE", () => {
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "80")] });
    const r = verifyL8(ev, ctx());
    expect(r.l8.atoms).toEqual([{ stage: "RD", expected: "100", actual: "90", fragment: 1 }, { stage: "ID", expected: "100", actual: "80", fragment: 2 }]);
    expect(r.l8.flags).toContain("COMPOSITE");
  });
  it("совпавшая стадия фактом не считается; одна стадия — без флага", () => {
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "100")] });
    expect(atomsOf(ev, false)).toHaveLength(1);
    expect(verifyL8(ev, ctx()).l8.flags).not.toContain("COMPOSITE");
    expect(atomsOf(ev, true)).toHaveLength(2);
  });
});

describe("VER-12 корень и каскады", () => {
  const DEPS = { edges: [["M-003", "M-002"], ["M-002", "M-020"], ["M-001", "M-019"]] as Array<[string, string]> };
  it("полезная → общая → КИТ: производные кандидаты привязаны к корню derived_from", () => {
    const st = new Map<string, FindingStatus>([["M-003", "CANDIDATE"], ["M-002", "CANDIDATE"], ["M-020", "CANDIDATE"], ["M-019", "CANDIDATE"], ["M-001", "NEGATIVE_VERIFIED"]]);
    const r = cascadeRoots(st, DEPS);
    expect(r.get("M-002")).toEqual(["M-003"]);
    expect(r.get("M-020")).toEqual(["M-003"]);
    expect(r.has("M-003")).toBe(false);
    expect(r.has("M-019")).toBe(false); // предок не кандидат — не производный
  });
  it("цепочка прерывается не-кандидатом", () => {
    const st = new Map<string, FindingStatus>([["M-003", "CANDIDATE"], ["M-002", "NEGATIVE_VERIFIED"], ["M-020", "CANDIDATE"]]);
    expect(cascadeRoots(st, DEPS).size).toBe(0);
  });
  it("цикл в данных графа — корень наименьший код, без зацикливания", () => {
    const st = new Map<string, FindingStatus>([["A", "CANDIDATE"], ["B", "CANDIDATE"]]);
    const r = cascadeRoots(st, { edges: [["A", "B"], ["B", "A"]] });
    expect(r.get("B")).toEqual(["A"]);
    expect(r.has("A")).toBe(false);
  });
  it("два корня у производного — оба, по порядку", () => {
    const st = new Map<string, FindingStatus>([["M-005", "CANDIDATE"], ["M-006", "CANDIDATE"], ["M-004", "CANDIDATE"]]);
    expect(cascadeRoots(st, { edges: [["M-006", "M-004"], ["M-005", "M-004"]] }).get("M-004")).toEqual(["M-005", "M-006"]);
  });
});

describe("оператор и единица для ворот", () => {
  const P = (compare: any, o: any = {}) => ({ compare, value_scale: null, data_type: "number", ...o }) as any;
  it("оператор L7 по пути сравнения и правилу", () => {
    expect(opFor(P({ kind: "min", min: 1 }), "lexical")).toBe("CMP-06");
    expect(opFor(P({ kind: "max", max: 1 }), "lexical")).toBe("CMP-06");
    expect(opFor(P({ kind: "delta_pct", tolerance: 1 }), "lexical")).toBe("CMP-02");
    expect(opFor(P({ kind: "decrease" }), "lexical")).toBe("CMP-03");
    expect(opFor(P({ kind: "increase" }, { value_scale: ["A", "B"] }), "lexical")).toBe("CMP-04");
    expect(opFor(P({ kind: "equal" }), "lexical")).toBe("CMP-01");
    expect(opFor(P({ kind: "equal" }, { data_type: "string" }), "lexical")).toBe("CMP-05");
    expect(opFor(P({ kind: "equal" }), "class")).toBe("CMP-04");
    expect(opFor(P({ kind: "equal" }), "quantity", { direction: "decrease", tolerance_pct: 0 })).toBe("CMP-03");
    expect(opFor(P({ kind: "equal" }), "quantity", { direction: "both", tolerance_pct: 1 })).toBe("CMP-02");
    expect(opFor(P({ kind: "equal" }), "quantity", { direction: "both", tolerance_pct: 0 })).toBe("CMP-01");
    expect(opFor(P({ kind: "equal" }), "quantity")).toBe("CMP-01");
  });
  it("единица рядом со значением — кириллица без ложных совпадений внутри слов", () => {
    expect(unitOf("3,3 м")).toBe("м");
    expect(unitOf("3300 мм")).toBe("мм");
    expect(unitOf("1200 м2")).toBe("м²");
    expect(unitOf("1200 кв. м")).toBe("м²");
    expect(unitOf("1200 м²")).toBe("м²");
    expect(unitOf("35000 м3")).toBe("м³");
    expect(unitOf("35000 куб. м")).toBe("м³");
    expect(unitOf("12 м3/ч")).toBe("м³/ч");
    expect(unitOf("40 м³/сут")).toBe("м³/сут");
    expect(unitOf("25 см")).toBe("см");
    expect(unitOf("2 км")).toBe("км");
    expect(unitOf("150 кВт")).toBe("кВт");
    expect(unitOf("1,5 МВт")).toBe("МВт");
    expect(unitOf("0,8 Гкал/ч")).toBe("Гкал/ч");
    expect(unitOf("35 %")).toBe("%");
    expect(unitOf("мост")).toBeNull();
    expect(unitOf("200")).toBeNull();
    expect(unitOf(null)).toBeNull();
    expect(unitOf("класс С0")).toBeNull();
  });
  it("схемы данных слоя: годные данные проходят, битые — отказ", () => {
    expect(GateConfigSchema.safeParse({ min_confidence: { default: 0.4 }, methods: {}, equivalent_methods: [], sheet_kinds: {} }).success).toBe(true);
    expect(GateConfigSchema.safeParse({ min_confidence: { default: 1.5 }, methods: {}, equivalent_methods: [], sheet_kinds: {} }).success).toBe(false);
    expect(ParamDepsSchema.safeParse({ edges: [["M-1", "M-2"]] }).success).toBe(true);
    expect(ParamDepsSchema.safeParse({ edges: [["M-1"]] }).success).toBe(false);
  });
});

describe("вспомогательные", () => {
  it("зазор между рамками, номер изменения и редакции, свёртка двойников", () => {
    expect(gap([0, 0, 0.1, 0.1], [0.05, 0.05, 0.2, 0.2])).toBe(0);
    expect(gap([0, 0, 0.1, 0.1], [0.4, 0.1, 0.5, 0.2])).toBeCloseTo(0.3);
    expect(gap([0, 0, 0.1, 0.1], [0.13, 0.14, 0.2, 0.2])).toBeCloseTo(0.05);
    expect(changeNo("Изм. №03")).toBe("3");
    expect(changeNo("нет")).toBeNull();
    expect(changeNo(null)).toBeNull();
    expect(revNo("ред. 12")).toBe(12);
    expect(revNo("Б")).toBeNull();
    expect(revNo(undefined)).toBeNull();
    expect(fold(" b25   w6 ")).toBe("В25 W6");
    expect(violating(cand({ actual: "нет такого" }))).toHaveLength(1);
  });
  it("след: выполнены все проверки слоя по порядку; без понижения причина оператора не меняется", () => {
    const r = verifyL8(cand(), ctx());
    expect(r.l8.ops).toEqual([...L8_OPS]);
    expect(r.reason).toBe("ПД → РД: уменьшение");
    expect(r.l8.change).toBe("NONE");
    const low = verifyL8(cand(), ctx({ facts: () => ({ ...facts0, confidence: 0.1 }) }));
    expect(low.reason).toMatch(/^Качество извлечения ниже порога: .*\(GTE-05\)\. Оператор: ПД → РД: уменьшение$/);
  });
  it("вход не меняется: слой возвращает новый объект", () => {
    const ev = cand();
    verifyL8(ev, ctx({ facts: () => ({ ...facts0, confidence: 0.1 }) }));
    expect(ev.status).toBe("CANDIDATE");
  });
});


describe("добивка мутантов (Stryker T-177)", () => {
  it("детализация: границы диапазона, якоря и десятичные в ограничении, однобуквенная марка, второй класс той же серии", () => {
    expect(isRefinement("200…250", "250")).toBe(true);
    expect(isRefinement("2,5…3,5", "3")).toBe(true);
    expect(isRefinement("200…220,52", "220,55")).toBe(false);
    expect(isRefinement("до 200-250", "220")).toBe(false);
    expect(isRefinement("200…250", "марка 220")).toBe(false);
    expect(isRefinement("толщина не менее 150", "150")).toBe(false);
    expect(isRefinement("толщина не более 150", "150")).toBe(false);
    expect(isRefinement("не  менее 150", "150")).toBe(true);
    expect(isRefinement("не менее  150", "150")).toBe(true);
    expect(isRefinement("не  более 150", "150")).toBe(true);
    expect(isRefinement("не более  150", "150")).toBe(true);
    expect(isRefinement("не менее 150,25", "150,2")).toBe(false);
    expect(isRefinement("не более 150,25", "150,3")).toBe(false);
    expect(isRefinement("200", "200 мм")).toBe(true);
    expect(isRefinement("200", "200 (2 слоя по 100)")).toBe(false);
    expect(isRefinement("С", "С 1")).toBe(false);
    expect(isRefinement("В2", "В25 W6")).toBe(false);
    expect(isRefinement("EI60", "EI60, EI30")).toBe(false);
    expect(isRefinement("С1", "С1, С2, К0")).toBe(false);
    expect(isRefinement("В25", "В25(В30)")).toBe(false);
  });
  it("методика: у стадии без методики — сопоставимо; равнозначность ищется в любой группе", () => {
    const g = { ...GATES, methods: { "M-009": { PD: "МСК" } }, equivalent_methods: [["БС", "БС-77"], ["МСК", "МСК-2"]] };
    expect(verifyL8(cand(), ctx({ param_code: "M-009", gates: g })).status).toBe("CANDIDATE");
    const g2 = { ...g, methods: { "M-009": { RD: "МСК" } } };
    expect(verifyL8(cand(), ctx({ param_code: "M-009", gates: g2 })).status).toBe("CANDIDATE");
    const g3 = { ...g, methods: { "M-009": { PD: "МСК", RD: "МСК-2" } } };
    expect(verifyL8(cand(), ctx({ param_code: "M-009", gates: g3 })).status).toBe("CANDIDATE");
  });
  it("единица записана только у фактического — сверять не с чем", () => {
    expect(verifyL8(cand(), ctx({ facts: (f) => ({ ...facts0, unit: f.stage === "RD" ? "мм" : null }) })).status).toBe("CANDIDATE");
  });
  it("единицы: регистр не важен, буквы вокруг — не единица", () => {
    for (const [raw, u] of [["3300 ММ", "мм"], ["25 СМ", "см"], ["2 КМ", "км"], ["12 М3/Ч", "м³/ч"], ["40 М³/СУТ", "м³/сут"], ["1200 М2", "м²"], ["35000 М3", "м³"], ["1200 КВ. М", "м²"], ["35000 КУБ. М", "м³"], ["150 КВТ", "кВт"], ["1 МВТ", "МВт"], ["0,8 ГКАЛ/Ч", "Гкал/ч"]] as const) expect(unitOf(raw)).toBe(u);
    expect(unitOf("кмм")).toBeNull();
    expect(unitOf("Смм3")).toBeNull();
    expect(unitOf("м2х")).toBe("м²");
    expect(unitOf("3 км/ч")).toBe("км");
  });
  it("свёртка двойников — все латинские буквы", () => {
    expect(fold("ABCEHKMOPTXY")).toBe("АВСЕНКМОРТХУ");
  });
  it("подмена редакции: своя запись не первая в списке; номер у соседа при буквенной своей — не сравнивается; своей записи нет", () => {
    const own: RevisionInfo = { file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "А", role: "CURRENT", approval_status: "APPROVED", stamp_change: 1 };
    const other: RevisionInfo = { ...own, file_id: "f-RD2", revision: "Б", role: "SUPERSEDED", stamp_change: 2 };
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { revision: "А" })] });
    expect(verifyL8(ev, ctx({ revisions: [other, own] })).l8.flags).toContain("STALE_REVISION");
    expect(verifyL8(ev, ctx({ revisions: [own, { ...other, revision: "2", stamp_change: null }] })).status).toBe("CANDIDATE");
    expect(verifyL8(ev, ctx({ revisions: [other] })).status).toBe("CANDIDATE");
    // своя редакция в реестре новее соседа по номеру — не устаревшая, хотя у соседа изменение в штампе больше
    const ev2 = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { revision: "3" })] });
    expect(verifyL8(ev2, ctx({ revisions: [{ ...own, revision: "3" }, { ...other, revision: "2", stamp_change: 5 }] })).status).toBe("CANDIDATE");
  });
  it("CMP-29: номер строки штампа с реестром не спорит; два облака — достаточно одного совпадения; штамп равен редакции — не конфликт", () => {
    const basis = change({ basis_file_id: "b" });
    // строка штампа — изменение листа, но не у значения: утверждения не подтверждает (OWASP T-177 SEC-04)
    expect(verifyL8(cand(), ctx({ marks: [mark({ kind: "stamp_row", number: "3", bbox: null })], changes: [basis] })).l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
    expect(verifyL8(cand(), ctx({ marks: [mark({ number: "3" }), mark({ number: "4" })], changes: [basis] })).status).toBe("NEGATIVE_VERIFIED");
    const revs: RevisionInfo[] = [
      { file_id: "f-PD", stage: "PD", document_code: "001-PD", revision: "1", role: "CURRENT", approval_status: "APPROVED", stamp_change: 9 },
      { file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "1", role: "CURRENT", approval_status: "APPROVED", stamp_change: 1 },
    ];
    expect(verifyL8(cand(), ctx({ marks: [mark({ kind: "stamp_row", number: "1", bbox: null })], revisions: revs })).l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
    // ссылки и причины: конфликт перечисляет отметки и номера реестра
    const c = verifyL8(cand(), ctx({ marks: [mark({ number: "4" })], changes: [basis] }));
    expect(c.l8.approved_change_ref).toBe("облако изм. 4 (стр. 3); № 3");
    expect(c.l8.reason_code).toBe("WRONG_REVISION");
    const st = verifyL8(cand(), ctx({ marks: [mark({ kind: "stamp_row", number: "2", bbox: null })], revisions: [{ ...revs[1], stamp_change: 2 }] }));
    expect(st.l8.approved_change_ref).toBe("таблица изменений штампа изм. 2 (стр. 3)");
    expect(verifyL8(cand(), ctx({ marks: [mark({ kind: "callout" })] })).l8.approved_change_ref).toMatch(/^выноска изм\. 3/);
    expect(verifyL8(cand(), ctx({ marks: [mark({ number: null })] })).l8.approved_change_ref).toBe("облако (стр. 3)");
  });
  it("изменение не найдено — флагов нет; причины понижений с кодами", () => {
    expect(verifyL8(cand(), ctx()).l8.flags).toEqual([]);
    const v1 = verifyL8(cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { role: "CONFLICT" })] }), ctx());
    expect(v1.l8.reason_code).toBe("WRONG_REVISION");
    expect(v1.reason).toMatch(/^Не определена актуальная редакция источника: 001-RD ред\. 1/);
    const v2 = verifyL8(cand({ fragments: [frag("PD", "expected", "100")] }), ctx());
    expect(v2.l8.reason_code).toBe("NOT_COMPARABLE");
    expect(v2.reason).toMatch(/^У кандидата нет фрагмента фактического значения/);
    expect(verifyL8(cand({ fragments: [frag("RD", "actual", "90")] }), ctx()).reason).toMatch(/^У кандидата нет фрагмента ожидаемого значения/);
    const z = verifyL8(cand({ actual: "—", fragments: [frag("PD", "expected", "В2.7"), frag("RD", "actual", "—", { bbox: null })] }), ctx());
    expect(z.reason).toMatch(/^Отсутствие не показано зоной на листе/);
    const m = verifyL8({ ...cand({ actual: "—", fragments: [frag("PD", "expected", "В2.7"), frag("RD", "actual", "—")] }), absence: true } as any, ctx({ searched: [sheet({ stage: "PD" })] }));
    expect(m.reason).toMatch(/^Отсутствие не доказано: листов стадии нет в пакете/);
    const h = verifyL8({ ...cand({ actual: "—", fragments: [frag("PD", "expected", "В2.7"), frag("RD", "actual", "—")] }), absence: true } as any, ctx({ searched: [sheet({ parsed: false })] }));
    expect(h.reason).toMatch(/^Отсутствие не доказано: не просмотрены полностью 001-RD/);
    const d = verifyL8(cand({ expected: "B25", actual: "В25 W6", fragments: [frag("PD", "expected", "B25"), frag("RD", "actual", "В25 W6")] }), ctx());
    expect(d.reason).toMatch(/^Различие — детализация: «В25 W6» уточняет «B25»/);
    const a = verifyL8(cand(), ctx({ marks: [mark()], changes: [change({ basis_file_id: "b" })] }));
    expect(a.reason).toMatch(/^Согласованное изменение: изменение № 3 отмечено на листе и согласовано документом-основанием/);
    const u = verifyL8(cand(), ctx({ marks: [mark()] }));
    expect(u.l8.steps).toEqual([{ op: "VER-08", from: "CANDIDATE", to: "CANDIDATE", reason_code: null, why: "изменение найдено (облако изм. 3 (стр. 3)), утверждение не подтверждено документом" }]);
    const x = verifyL8(cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "80")] }), ctx());
    expect(x.l8.steps).toEqual([{ op: "VER-11", from: "CANDIDATE", to: "CANDIDATE", reason_code: null, why: "Кандидат объединяет 2 факта: RD — 90; ID — 80" }]);
    const k = verifyL8(cand(), ctx({ op: "CMP-12", facts: () => ({ ...facts0, doc_kind: "specification" }) }));
    expect(k.reason).toMatch(/^Несопоставимо: вид документа «specification» не годится для CMP-12 \(001-PD, стр\. 3\)/);
    const un = verifyL8(cand(), ctx({ facts: (f) => ({ ...facts0, unit: f.stage === "PD" ? "м" : "мм" }) }));
    expect(un.reason).toMatch(/^Несопоставимо: единицы не приведены: PD — м, RD — мм/);
    const sv = verifyL8(cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90", { role: "SUPERSEDED" })] }), ctx());
    expect(sv.reason).toMatch(/^Источник — устаревшая редакция: 001-RD ред\. 1 — APPROVED/);
    const nr = verifyL8(cand(), ctx({ revisions: [{ file_id: "f-RD2", stage: "RD", document_code: "001-RD", revision: "2", role: "SUPERSEDED", approval_status: "APPROVED", stamp_change: null }] }));
    expect(nr.reason).toMatch(/001-RD: взята ред\. 1, в пакете есть более поздняя ред\. 2 \(VER-03\)/);
  });
  it("атаки на снятие кандидата: основание — сам проверяемый файл; номер на листе есть в реестре, но без основания, основание — у другого номера", () => {
    const self = verifyL8(cand(), ctx({ marks: [mark()], changes: [change({ basis_file_id: "f-RD" })] }));
    expect(self.status).toBe("CANDIDATE");
    const other = verifyL8(cand(), ctx({ marks: [mark({ number: "5" })], changes: [change({ id: 1, number: "5" }), change({ id: 2, number: "7", basis_file_id: "b" })] }));
    expect(other.status).toBe("CANDIDATE");
    expect(other.l8.change).toBe("CHANGE_APPROVAL_UNVERIFIED");
    expect(other.l8.approved_change_ref).toBe("№ 7 от 01.05.2026; № 5 от 01.05.2026 (без документа-основания); облако изм. 5 (стр. 3)");
  });
  it("не кандидат: атомы, флаги устаревшей редакции и отсутствия не ставятся; отсутствие по флагу оператора", () => {
    const nv = cand({ status: "NEGATIVE_VERIFIED", fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "80")] });
    const r = verifyL8(nv, ctx());
    expect(r.l8.atoms).toEqual([]);
    expect(r.l8.flags).toEqual([]);
    const me = verifyL8(cand({ status: "MISSING_EVIDENCE", fragments: [frag("PD", "expected", "100", { role: "SUPERSEDED" })] }), ctx());
    expect(me.l8.flags).toEqual([]);
    // флаг отсутствия от оператора — даже при непустом значении; пустое значение у одного из фактических — тоже отсутствие
    const flagged = verifyL8({ ...cand(), absence: true } as any, ctx({ searched: [sheet({ parsed: false })] }));
    expect(flagged.status).toBe("NOT_COMPARABLE");
    const oneEmpty = verifyL8(cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("ID", "actual", "  ")] }), ctx({ searched: [sheet({ stage: "ID", parsed: false })] }));
    expect(oneEmpty.l8.searched?.length).toBe(1);
    expect(verifyL8(cand({ actual: "отсутствует", fragments: [frag("PD", "expected", "В2"), frag("RD", "actual", "Отсутствует", { bbox: null })] }), ctx()).status).toBe("NOT_COMPARABLE");
    expect(verifyL8(cand({ actual: "x", fragments: [frag("PD", "expected", "В2"), frag("RD", "actual", "x отсутствует", { bbox: null })] }), ctx()).status).toBe("CANDIDATE");
  });
  it("пороговое правило: отрицательный результат при одном плохом фактическом из двух не понижается", () => {
    const nv = cand({ status: "NEGATIVE_VERIFIED", fragments: [frag("RD", "actual", "1"), frag("ID", "actual", "1")] });
    const r = verifyL8(nv, ctx({ threshold_rule: true, facts: (f) => ({ ...facts0, quality: f.stage === "ID" ? "LOW_QUALITY" : "OK" }) }));
    expect(r.status).toBe("NEGATIVE_VERIFIED");
  });
  it("атомы: две записи одной стадии — один факт", () => {
    const ev = cand({ fragments: [frag("PD", "expected", "100"), frag("RD", "actual", "90"), frag("RD", "actual", "80", { file_id: "f-RD-b" })] });
    expect(atomsOf(ev, false)).toHaveLength(1);
  });
  it("каскад: не-кандидат выше по цепочке в корни не попадает; корни упорядочены", () => {
    const st = new Map<string, FindingStatus>([["A", "NEGATIVE_VERIFIED"], ["B", "CANDIDATE"], ["C", "CANDIDATE"]]);
    expect(cascadeRoots(st, { edges: [["A", "B"], ["B", "C"]] }).get("C")).toEqual(["B"]);
    const st2 = new Map<string, FindingStatus>([["M-005", "CANDIDATE"], ["M-006", "CANDIDATE"], ["M-004", "CANDIDATE"]]);
    expect(cascadeRoots(st2, { edges: [["M-005", "M-004"], ["M-006", "M-004"]] }).get("M-004")).toEqual(["M-005", "M-006"]);
  });
  it("схема данных сохраняет методики стадий", () => {
    const g = GateConfigSchema.parse({ min_confidence: {}, methods: { "M-2": { PD: "ТЭП", ID: "БТИ" } }, equivalent_methods: [], sheet_kinds: {} });
    expect(g.methods["M-2"]).toEqual({ PD: "ТЭП", ID: "БТИ" });
  });
});

// ─────────────────────────────── L5: свойство «только понижает» на всём пространстве статусов

const STATUSES: FindingStatus[] = ["CANDIDATE", "NEGATIVE_VERIFIED", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"];
const arbFrag = fc.record({
  stage: fc.constantFrom<Stage>("PD", "RD", "ID"),
  kind: fc.constantFrom<Fragment["kind"]>("expected", "actual"),
  value: fc.constantFrom("100", "90", "—", "B25", "В25 W6", "200…250", "220", "С1, С2"),
  role: fc.constantFrom<RevisionRole>("CURRENT", "CURRENT", "SUPERSEDED", "CONFLICT", "UNRESOLVED"),
  revision: fc.constantFrom("1", "2"),
  page: fc.constantFrom(1, 3),
  hasBox: fc.boolean(),
}).map((x) => frag(x.stage, x.kind, x.value, { role: x.role, revision: x.revision, page: x.page, bbox: x.hasBox ? [0.4, 0.4, 0.5, 0.45] : null, file_id: `f-${x.stage}` }));
const arbEv = fc.record({
  status: fc.constantFrom(...STATUSES),
  expected: fc.option(fc.constantFrom("100", "B25", "200…250"), { nil: null }),
  actual: fc.option(fc.constantFrom("90", "В25 W6", "220", "—"), { nil: null }),
  fragments: fc.array(arbFrag, { maxLength: 4 }),
  absence: fc.boolean(),
}).map((x) => ({ ...cand({ status: x.status, expected: x.expected, actual: x.actual, fragments: x.fragments }), absence: x.absence }));
const arbCtx = fc.record({
  op: fc.constantFrom("CMP-01", "CMP-04", "CMP-12"),
  threshold: fc.boolean(),
  units: fc.boolean(),
  conf: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  quality: fc.constantFrom<FragmentFacts["quality"]>("OK", "LOW_QUALITY", "ABSTAIN", null),
  kind: fc.constantFrom(null, "drawing", "specification"),
  unit: fc.constantFrom(null, "м", "мм"),
  marks: fc.array(fc.record({ page: fc.constantFrom(1, 3), kind: fc.constantFrom<ChangeMark["kind"]>("cloud", "callout", "stamp_row"), number: fc.constantFrom("3", "4", null) }), { maxLength: 2 }),
  changes: fc.array(fc.record({ number: fc.constantFrom("3", "5"), basis: fc.boolean() }), { maxLength: 2 }),
  searched: fc.array(fc.record({ stage: fc.constantFrom<Stage>("PD", "RD", "ID"), parsed: fc.boolean(), low: fc.boolean() }), { maxLength: 3 }),
  stamp: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
}).map((x): L8Context => ctx({
  op: x.op, threshold_rule: x.threshold, units_normalized: x.units, param_code: "M-002",
  facts: (f) => ({ confidence: x.conf, quality: x.quality, doc_kind: x.kind, unit: f.stage === "PD" ? "м" : x.unit }),
  marks: x.marks.map((m) => mark(m)),
  changes: x.changes.map((c, i) => change({ id: i, number: c.number, basis_file_id: c.basis ? "b" : null })),
  searched: x.searched.map((s) => sheet({ stage: s.stage, parsed: s.parsed, low_quality_pages: s.low ? [1] : [] })),
  revisions: [{ file_id: "f-RD", stage: "RD", document_code: "001-RD", revision: "1", role: "CURRENT", approval_status: "APPROVED", stamp_change: x.stamp }],
}));

describe("L5 · слой L8 только понижает", () => {
  it("на любом входе статус либо тот же, либо допустимое понижение; CANDIDATE не появляется из другого статуса", () => {
    fc.assert(fc.property(arbEv, arbCtx, (ev, c) => {
      const r = verifyL8(ev, c);
      const same = r.status === ev.status;
      if (!same && !canLower(ev.status, r.status)) return false;
      if (r.status === "CANDIDATE" && ev.status !== "CANDIDATE") return false;
      // след согласован со статусом: каждый шаг — допустимое понижение, последний шаг приводит к итогу
      const moves = r.l8.steps.filter((s) => s.from !== s.to);
      if (!moves.every((s) => canLower(s.from, s.to))) return false;
      return same ? moves.length === 0 : moves[moves.length - 1].to === r.status && moves[0].from === ev.status;
    }), { numRuns: 3000 });
  });
  it("воздержания и NOT_APPLICABLE слой не трогает", () => {
    fc.assert(fc.property(arbEv, arbCtx, (ev, c) => {
      if (LOWER_TO[ev.status].length) return true;
      return verifyL8(ev, c).status === ev.status;
    }), { numRuns: 1000 });
  });
  it("таблица понижений: ни один переход не ведёт в CANDIDATE и не повторяет статус", () => {
    for (const s of STATUSES) for (const t of LOWER_TO[s]) {
      expect(t).not.toBe("CANDIDATE");
      expect(t).not.toBe(s);
    }
    expect(canLower("NEGATIVE_VERIFIED", "CANDIDATE")).toBe(false);
    expect(canLower("CANDIDATE", "NEGATIVE_VERIFIED")).toBe(true);
  });
});

it("норма серверного оператора заменяет ожидаемый фрагмент, но не фактическое доказательство", () => {
  const base = cand();
  const ev = { ...base, fragments: base.fragments.filter((f) => f.kind === "actual"),
    expected_basis: { kind: "norm" as const, reference: "Синтетический паспорт: правило N1" } };
  expect(verifyL8(ev, ctx()).status).toBe("CANDIDATE");
  expect(verifyL8({ ...ev, fragments: [] }, ctx()).status).toBe("NOT_COMPARABLE");
  expect(verifyL8({ ...ev, expected_basis: { kind: "norm", reference: " " } }, ctx()).status).toBe("NOT_COMPARABLE");
});
