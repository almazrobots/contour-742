// Понижающий слой геометрии (T-194, ADR-0010 п. 5): VER-04 регистрация и масштаб, VER-06 второе свидетельство,
// VER-10 калибровка уверенности, VER-09 вердикт VLM. OS-INSP-2.4.53–2.4.59, OS-INSP-3.1.125–3.1.129, 3.1.131.
// L1 — функциональные, L2 — независимый пересчёт, L3 — границы допусков (±ε), L5 — свойства (fast-check),
// L6 — битые данные: громкий отказ.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import {
  agrees, applyVlm, calibrate, CLAIM_TOKEN, claimCrops, claimQuestion, ClaimSpecError, MAX_CLAIM_MARKS, noteVlm, CalibrationSchema, fitCalibration, GEOM_LOWER_TO, GeomGatesSchema, GeomMentionSchema, inUnit, isotonic,
  registrationIssue, secondSourceIssue, thresholdFor, verifyGeom, VlmVerdictSchema,
  type Calibration, type GeomContext, type GeomMention, type Scored, type Witness,
} from "../src/domain/verify-geom.ts";
import type { Evaluation, FindingStatus, Fragment } from "../src/domain/types.ts";

const seed = (f: string) => JSON.parse(readFileSync(join(config.root, "data/seed", f), "utf8"));
const GATES = GeomGatesSchema.parse(seed("geom-gates.json"));
const CAL = CalibrationSchema.parse(seed("geom-calibration.json"));

const mention = (over: Partial<GeomMention> = {}): GeomMention => ({
  entity: "ENT-10", measure: "length", value: 900, unit: "мм", by: "geometry", label_value: null, measured_value: 900, key: "Д1",
  at: [10, 20], polygon: null, graph: null, frame: "sheet", scale_n: 100, scale_spread_pct: 0.5, residual_mm: null, page: 3, bbox: [0.1, 0.1, 0.2, 0.2], quote: "Д1",
  ...over,
});
const frag = (kind: Fragment["kind"], value: string, stage: Fragment["stage"] = kind === "expected" ? "PD" : "RD"): Fragment => ({
  file_id: `F-${stage}`, sha256: "0".repeat(64), stage, document_code: `${stage}-АР`, revision: "1", approval_status: null, page: 3, bbox: [0.1, 0.1, 0.2, 0.2], role: "CURRENT", value, kind,
});
const ev = (status: FindingStatus = "CANDIDATE"): Evaluation => ({
  status, expected: "1000", actual: "900", delta: "-100", reason: "ширина уменьшена", fragments: [frag("expected", "1000"), frag("actual", "900")], stage_notes: {},
});
const ctx = (m: Partial<GeomMention> | null = {}, over: Partial<GeomContext> = {}): GeomContext => ({
  op: "CMP-12", gates: GATES, calibration: CAL, geom: (f) => (m === null ? null : mention({ ...m, value: Number(f.value), measured_value: m.measured_value === undefined ? Number(f.value) : m.measured_value })), score: 0.9, ...over,
});

describe("VER-04 регистрация и масштаб (OS-INSP-2.4.53–2.4.56)", () => {
  it("разброс масштаба больше допуска — кандидат → NOT_COMPARABLE с причиной и следом шага", () => {
    const r = verifyGeom(ev(), ctx({ scale_spread_pct: 3.5 }));
    expect(r.status).toBe("NOT_COMPARABLE");
    expect(r.geom.steps).toEqual([{ op: "VER-04", from: "CANDIDATE", to: "NOT_COMPARABLE", reason_code: "NOT_COMPARABLE", why: expect.stringContaining("разброс масштаба 3.5 % больше допуска 2 %") }]);
    expect(r.reason).toMatch(/\(VER-04\)\. Оператор: ширина уменьшена$/);
  });

  it("отрицательный результат по ненадёжной геометрии тоже снимается: NEGATIVE_VERIFIED → NOT_COMPARABLE", () => {
    expect(verifyGeom(ev("NEGATIVE_VERIFIED"), ctx({ scale_n: null })).status).toBe("NOT_COMPARABLE");
  });

  it("масштаб не определён, значение измерено по геометрии — NOT_COMPARABLE; значение только из надписи — масштаб не нужен", () => {
    expect(verifyGeom(ev(), ctx({ scale_n: null })).status).toBe("NOT_COMPARABLE");
    expect(verifyGeom(ev(), ctx({ scale_n: null, by: "dimension" })).status).toBe("CANDIDATE");
  });

  it("GEO-POS (CMP-14): лист не зарегистрирован в осях здания или остаток больше допуска — NOT_COMPARABLE", () => {
    expect(verifyGeom(ev(), ctx({ frame: "sheet" }, { op: "CMP-14" })).status).toBe("NOT_COMPARABLE");
    expect(verifyGeom(ev(), ctx({ frame: "bld", residual_mm: null }, { op: "CMP-14" })).status).toBe("NOT_COMPARABLE");
    const r = verifyGeom(ev(), ctx({ frame: "bld", residual_mm: 80 }, { op: "CMP-14" }));
    expect(r.geom.steps[0].why).toContain("остаток регистрации 80 мм больше допуска 50 мм");
    expect(verifyGeom(ev(), ctx({ frame: "bld", residual_mm: 12 }, { op: "CMP-14" })).status).toBe("CANDIDATE");
  });

  it("GEO-DIM (CMP-12): длине система осей не нужна — лист без регистрации проходит", () => {
    expect(registrationIssue(mention({ frame: "sheet", residual_mm: null }), GATES, "CMP-12")).toBeNull();
  });

  it("оператор без строки в допусках — допуск default", () => {
    expect(registrationIssue(mention({ scale_spread_pct: 2.5 }), GATES, "CMP-99")).toContain("допуска 2 %");
  });

  it("L3 · разброс ровно на допуске проходит, на ε выше — нет; остаток так же", () => {
    expect(registrationIssue(mention({ scale_spread_pct: 2 }), GATES, "CMP-12")).toBeNull();
    expect(registrationIssue(mention({ scale_spread_pct: 2.0001 }), GATES, "CMP-12")).not.toBeNull();
    expect(registrationIssue(mention({ frame: "bld", residual_mm: 50 }), GATES, "CMP-14")).toBeNull();
    expect(registrationIssue(mention({ frame: "bld", residual_mm: 50.001 }), GATES, "CMP-14")).not.toBeNull();
  });

  it("фрагменты без геометрии (текст, таблица) слой не трогает", () => {
    const r = verifyGeom(ev(), ctx(null));
    expect(r.status).toBe("CANDIDATE");
    expect(r.geom.ops).toEqual(["VER-04", "VER-06", "VER-10"]);
    expect(r.geom.steps).toEqual([]);
  });

  it("L6 · допуски — данные: файл без вида измерения или с лишним полем отвергается при загрузке", () => {
    const broken = structuredClone(seed("geom-gates.json"));
    delete broken.ver06.count;
    expect(() => GeomGatesSchema.parse(broken)).toThrow();
    const extra = structuredClone(seed("geom-gates.json"));
    extra.ver04.default.scale_spread = 2;
    expect(() => GeomGatesSchema.parse(extra)).toThrow();
    const neg = structuredClone(seed("geom-gates.json"));
    neg.ver04.ops["CMP-14"].residual_mm = -1;
    expect(() => GeomGatesSchema.parse(neg)).toThrow();
  });

  it("L6 · упоминание геометрии не по контракту ADR-0010 — громкий отказ", () => {
    expect(GeomMentionSchema.parse(mention())).toEqual(mention());
    expect(() => GeomMentionSchema.parse({ ...mention(), scale_spread_pct: Number.NaN })).toThrow();
    expect(() => GeomMentionSchema.parse({ ...mention(), unit: "см" })).toThrow();
    expect(() => GeomMentionSchema.parse({ ...mention(), frame: "page" })).toThrow();
    expect(() => GeomMentionSchema.parse({ ...mention(), entity: "Д1" })).toThrow();
  });
});

describe("VER-06 второе свидетельство (OS-INSP-2.4.57–2.4.59)", () => {
  it("надпись размера расходится с измерением — CLARIFICATION_REQUIRED с пометкой SUSPICION", () => {
    const r = verifyGeom(ev(), ctx({ by: "both", label_value: 1200, measured_value: 900 }));
    expect(r.status).toBe("CLARIFICATION_REQUIRED");
    expect(r.geom.steps[0]).toMatchObject({ op: "VER-06", from: "CANDIDATE", to: "CLARIFICATION_REQUIRED", reason_code: "SECOND_SOURCE_CONFLICT", suspicion: true });
    expect(r.geom.steps[0].why).toContain("надпись 1200 мм расходится с измерением по чертежу 900 мм");
    expect(r.geom.flags).toEqual(["SUSPICION"]);
  });

  it("ведомость проёмов против ширины по дуге: 1000 мм по ведомости, 900 по плану — противоречие; 910 — согласие", () => {
    const w = (value: number, unit: Witness["unit"] = "мм"): Witness => ({ source: "schedule", value, unit, quote: "Д1 — 1000", document_code: "АР-ВП", page: 12 });
    const r = verifyGeom(ev(), ctx({}, { witnesses: (f) => (f.kind === "actual" ? [w(1000)] : []) }));
    expect(r.status).toBe("CLARIFICATION_REQUIRED");
    expect(r.geom.steps[0].why).toContain("ведомость проёмов АР-ВП, стр. 12 — 1000 мм, по чертежу 900 мм");
    expect(verifyGeom(ev(), ctx({}, { witnesses: (f) => (f.kind === "actual" ? [w(0.91, "м")] : []) })).status).toBe("CANDIDATE");
  });

  it("спецификация против счёта знаков: 12 шт по спецификации, 11 знаков — противоречие (счёт — без допуска)", () => {
    const m = { entity: "ENT-08", measure: "count" as const, unit: "шт" as const, key: "ИП-1" };
    const spec: Witness = { source: "specification", value: 12, unit: "шт", quote: "ИП 212-64 — 12", document_code: "ПС-С", page: 2 };
    const e = { ...ev(), expected: "12", actual: "11", fragments: [frag("expected", "12"), frag("actual", "11")] };
    expect(verifyGeom(e, ctx(m, { op: "CMP-07", witnesses: (f) => (f.kind === "actual" ? [spec] : []) })).status).toBe("CLARIFICATION_REQUIRED");
    expect(secondSourceIssue(mention({ ...m, value: 12, measured_value: 12 }), [spec], GATES)).toBeNull();
  });

  it("согласие источников уверенность не поднимает: статус и след без изменений, NEGATIVE_VERIFIED остаётся", () => {
    const r = verifyGeom(ev("NEGATIVE_VERIFIED"), ctx({ by: "both", label_value: 905, measured_value: 900 }));
    expect(r.status).toBe("NEGATIVE_VERIFIED");
    expect(r.geom.steps).toEqual([]);
  });

  it("единицы свидетеля несопоставимы (м² против мм) — NOT_COMPARABLE, а не противоречие", () => {
    const r = verifyGeom(ev(), ctx({}, { witnesses: () => [{ source: "table", value: 3, unit: "м²", quote: "", document_code: null, page: null }] }));
    expect(r.status).toBe("NOT_COMPARABLE");
    expect(r.geom.steps[0].why).toContain("единица «м²» несопоставима с «мм»");
  });

  it("L3 · допуск длины max(20 мм, 2 %): 1000 и 1020 согласны, 1000 и 1020,5 — нет; 100 и 120 согласны по abs", () => {
    const t = GATES.ver06.length;
    expect(agrees(1000, 1020, t)).toBe(true);
    expect(agrees(1000, 1020.5, t)).toBe(false);
    expect(agrees(100, 120, t)).toBe(true);
    expect(agrees(100, 120.01, t)).toBe(false);
  });

  it("L2 · перевод единиц: 0,9 м = 900 мм, 900 мм = 0,9 м; м² и шт с длиной не сводятся", () => {
    expect(inUnit(0.9, "м", "мм")).toBeCloseTo(900, 9);
    expect(inUnit(900, "мм", "м")).toBeCloseTo(0.9, 9);
    expect(inUnit(1, "м²", "мм")).toBeNull();
    expect(inUnit(1, "шт", "м²")).toBeNull();
  });
});

describe("VER-10 калибровка уверенности (OS-INSP-3.1.127–3.1.129)", () => {
  const pts = (spec: Array<[number, 0 | 1]>): Scored[] => spec.map(([score, label]) => ({ score, label }));

  it("PAV сливает нарушителей монотонности: 0,1→1, 0,2→0 сливаются в 0,5", () => {
    expect(isotonic(pts([[0.1, 1], [0.2, 0], [0.3, 1]]))).toEqual({ x: [0.1, 0.2, 0.3], y: [0.5, 0.5, 1] });
    expect(isotonic(pts([[0.3, 0], [0.2, 1], [0.1, 1], [0.4, 1]]))).toEqual({ x: [0.1, 0.2, 0.3, 0.4], y: [2 / 3, 2 / 3, 2 / 3, 1] });
  });

  it("одинаковые score — один узел со средним", () => {
    expect(isotonic(pts([[0.5, 1], [0.5, 0], [0.5, 1], [0.9, 1]]))).toEqual({ x: [0.5, 0.9], y: [2 / 3, 1] });
  });

  it("L2 · независимая проверка PAV: кривая неубывающая, а сдвиг любого узла с сохранением монотонности не уменьшает сумму квадратов", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.constantFrom<0 | 1>(0, 1)), { minLength: 1, maxLength: 7 }), (raw) => {
        const p = raw.map(([s, l]) => ({ score: s / 5, label: l }));
        const { x, y } = isotonic(p);
        expect(y.every((v, j) => j === 0 || v >= y[j - 1])).toBe(true);
        const sse = (ys: number[]) => p.reduce((s, q) => s + (q.label - ys[x.indexOf(q.score)]) ** 2, 0);
        const best = sse(y);
        // изотоническая задача выпуклая: решение PAV — глобальный минимум, любая допустимая кривая не лучше
        for (let i = 0; i < y.length; i++) {
          for (const d of [-0.05, 0.05]) {
            const z = [...y];
            z[i] = Math.min(1, Math.max(0, z[i] + d));
            if (z.every((v, j) => j === 0 || v >= z[j - 1])) expect(sse(z)).toBeGreaterThanOrEqual(best - 1e-9);
          }
        }
      }),
    );
  });

  it("калиброванная вероятность: линейно между узлами, за краями — крайние значения", () => {
    const c = { x: [0.2, 0.6], y: [0.1, 0.9] };
    expect(calibrate(c, 0.4)).toBeCloseTo(0.5, 12);
    expect(calibrate(c, 0)).toBe(0.1);
    expect(calibrate(c, 1)).toBe(0.9);
  });

  it("порог: наименьший, при котором Precision ≥ 0,90 + запас 0,02; недостижимо — null", () => {
    const p = pts([[0.1, 0], [0.2, 0], [0.3, 1], [0.4, 0], [0.5, 1], [0.6, 1], [0.7, 1], [0.8, 1], [0.9, 1]]);
    const c = fitCalibration(p);
    expect(c.threshold).toBe(1); // ступень 1,0 начинается с 0,5: выше неё все подтверждены
    expect(calibrate(c, 0.5)).toBe(1);
    expect(thresholdFor(pts([[0.1, 0], [0.9, 0]]), isotonic(pts([[0.1, 0], [0.9, 0]])), 0.9, 0.02)).toBeNull();
    expect(thresholdFor([], { x: [0], y: [0] }, 0.9, 0.02)).toBeNull();
  });

  it("L3 · запас: Precision ровно 0,92 проходит порог с запасом 0,02, 0,91 — нет", () => {
    const mk = (pos: number, n: number) => Array.from({ length: n }, (_, i) => ({ score: 0.5, label: (i < pos ? 1 : 0) as 0 | 1 }));
    expect(thresholdFor(mk(92, 100), { x: [0.5], y: [0.92] }, 0.9, 0.02)).toBe(0.92);
    expect(thresholdFor(mk(91, 100), { x: [0.5], y: [0.91] }, 0.9, 0.02)).toBeNull();
  });

  it("ниже порога — CLARIFICATION_REQUIRED с пометкой SUSPICION; выше — без изменений; нет кривой оператора — тождественно", () => {
    const cal: Calibration = { ops: { "CMP-12": { x: [0.2, 0.8], y: [0.3, 0.97], threshold: 0.9, target_precision: 0.9, margin: 0.02, n: 40, fitted_on: "validation" } } };
    const lo = verifyGeom(ev(), ctx({}, { calibration: cal, score: 0.4 }));
    expect(lo.status).toBe("CLARIFICATION_REQUIRED");
    expect(lo.geom.steps[0]).toMatchObject({ op: "VER-10", reason_code: "LOW_CONFIDENCE", suspicion: true });
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: 0.8 })).status).toBe("CANDIDATE");
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: 0.1, op: "CMP-13" })).status).toBe("CANDIDATE");
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: null })).status).toBe("CLARIFICATION_REQUIRED");
    const unreachable: Calibration = { ops: { "CMP-12": { ...cal.ops["CMP-12"], threshold: null } } };
    expect(verifyGeom(ev(), ctx({}, { calibration: unreachable, score: 0.99 })).status).toBe("CLARIFICATION_REQUIRED");
  });

  it("VER-10 касается только кандидата: NEGATIVE_VERIFIED с низкой уверенностью не меняется", () => {
    const cal: Calibration = { ops: { "CMP-12": { x: [0, 1], y: [0, 1], threshold: 0.9, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" } } };
    expect(verifyGeom(ev("NEGATIVE_VERIFIED"), ctx({}, { calibration: cal, score: 0.1 })).status).toBe("NEGATIVE_VERIFIED");
  });

  it("таблица калибровки по умолчанию пуста: ни один оператор не калибруется до замера на validation", () => {
    expect(CAL.ops).toEqual({});
  });

  it("L6 · битая кривая отвергается: убывающая, разной длины, пустая, вероятность больше 1", () => {
    const e = { x: [0.1, 0.5], y: [0.2, 0.8], threshold: 0.9, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" };
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": e } })).not.toThrow();
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.8, 0.2] } } })).toThrow(/убывает/);
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, x: [0.5, 0.1] } } })).toThrow(/не строго возрастает/);
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.2] } } })).toThrow(/одной длины/);
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, x: [], y: [] } } })).toThrow();
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.2, 1.2] } } })).toThrow();
    expect(() => fitCalibration([])).toThrow(/пустой выборке/);
    expect(() => isotonic([{ score: Number.NaN, label: 1 }])).toThrow(/не число/);
  });
});

describe("VER-09 вердикт VLM (OS-INSP-3.1.131)", () => {
  it("no → CLARIFICATION_REQUIRED с пометкой SUSPICION (не NEGATIVE_VERIFIED); unreadable → NOT_COMPARABLE; yes → без изменений", () => {
    const no = applyVlm(ev(), { claim_supported: "no", quote: "В2.7 в коридоре" });
    expect(no.status).toBe("CLARIFICATION_REQUIRED");
    expect(no.geom.steps[0]).toMatchObject({ op: "VER-09", reason_code: "VLM_NOT_SUPPORTED", suspicion: true });
    expect(no.reason).toContain("«В2.7 в коридоре»");
    expect(applyVlm(ev(), { claim_supported: "unreadable", quote: "" }).status).toBe("NOT_COMPARABLE");
    const yes = applyVlm(ev(), { claim_supported: "yes", quote: "В2.7" });
    expect(yes.status).toBe("CANDIDATE");
    expect(yes.geom.steps).toEqual([]);
  });

  it("вердикт касается только кандидата", () => {
    expect(applyVlm(ev("NEGATIVE_VERIFIED"), { claim_supported: "no", quote: "" }).status).toBe("NEGATIVE_VERIFIED");
  });

  it("след накапливается: VER-09 после verifyGeom дописывает шаги к прежним", () => {
    const g = verifyGeom(ev(), ctx());
    const r = applyVlm(g, { claim_supported: "unreadable", quote: "" });
    expect(r.geom.ops).toEqual(["VER-04", "VER-06", "VER-10", "VER-09"]);
    expect(g.geom.ops).toHaveLength(3); // вход не меняется
  });

  it("L6 · схема ответа строгая: лишнее поле, чужое значение, длинная цитата — отказ", () => {
    expect(() => VlmVerdictSchema.parse({ claim_supported: "maybe", quote: "" })).toThrow();
    expect(() => VlmVerdictSchema.parse({ claim_supported: "yes", quote: "", confidence: 1 })).toThrow();
    expect(() => VlmVerdictSchema.parse({ claim_supported: "yes", quote: "x".repeat(501) })).toThrow();
  });
});

describe("слой только понижает (OS-INSP-3.1.125, 3.1.126)", () => {
  const STATUSES: FindingStatus[] = ["CANDIDATE", "NEGATIVE_VERIFIED", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "MISSING_EVIDENCE", "NOT_APPLICABLE"];
  const arbMention = fc.record({
    by: fc.constantFrom<GeomMention["by"]>("dimension", "geometry", "both"),
    scale_n: fc.option(fc.constantFrom(50, 100, 200), { nil: null }),
    scale_spread_pct: fc.double({ min: 0, max: 5, noNaN: true }),
    frame: fc.constantFrom<GeomMention["frame"]>("bld", "sheet"),
    residual_mm: fc.option(fc.double({ min: 0, max: 200, noNaN: true }), { nil: null }),
    label_value: fc.option(fc.integer({ min: 500, max: 1500 }), { nil: null }),
    measured_value: fc.option(fc.integer({ min: 500, max: 1500 }), { nil: null }),
  });

  it("L5 · при любых статусе, геометрии, свидетелях, калибровке и вердикте VLM статус на выходе не выше входа", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATUSES), arbMention, fc.constantFrom("CMP-12", "CMP-13", "CMP-14", "CMP-16"),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }), fc.boolean(),
        fc.array(fc.integer({ min: 0, max: 2000 }), { maxLength: 2 }), fc.constantFrom<"yes" | "no" | "unreadable">("yes", "no", "unreadable"),
        (status, m, op, score, calibrated, wv, vlm) => {
          const cal: Calibration = calibrated ? { ops: { [op]: { x: [0, 1], y: [0, 1], threshold: 0.5, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" } } } : CAL;
          const witnesses = () => wv.map((value): Witness => ({ source: "schedule", value, unit: "мм", quote: "", document_code: null, page: null }));
          const g = verifyGeom(ev(status), { op, gates: GATES, calibration: cal, geom: () => mention(m), witnesses, score });
          const r = applyVlm(g, { claim_supported: vlm, quote: "" });
          expect(r.status === status || GEOM_LOWER_TO[status].includes(r.status)).toBe(true);
          expect(r.status === "CANDIDATE" ? status === "CANDIDATE" : true).toBe(true);
          // каждый шаг — разрешённое понижение, цепочка шагов связная, последний шаг — итог
          let cur = status;
          for (const s of r.geom.steps) {
            expect(s.from).toBe(cur);
            expect(GEOM_LOWER_TO[s.from]).toContain(s.to);
            cur = s.to;
          }
          expect(cur).toBe(r.status);
        },
      ),
    );
  });

  it("шаги того же вида, что L8Step verify-l8.ts (T-177): op, from, to, reason_code, why (+ suspicion)", () => {
    const r = verifyGeom(ev(), ctx({ by: "both", label_value: 1500, measured_value: 900 }));
    for (const s of r.geom.steps) expect(Object.keys(s).sort()).toEqual(["from", "op", "reason_code", "suspicion", "to", "why"]);
  });
});

describe("точные следы, границы допусков и крайние входы (добивка мутаций T-194)", () => {
  const G = GATES;
  it("L1 · причина VER-04 называет марку, а без марки — сущность", () => {
    expect(registrationIssue(mention({ scale_n: null }), G, "CMP-12")).toBe("масштаб листа не определён (стр. 3, Д1)");
    expect(registrationIssue(mention({ scale_n: null, key: "" }), G, "CMP-12")).toBe("масштаб листа не определён (стр. 3, ENT-10)");
    expect(registrationIssue(mention({ scale_spread_pct: 3 }), G, "CMP-12")).toBe("разброс масштаба 3 % больше допуска 2 % (стр. 3, 1:100)");
    expect(registrationIssue(mention({ frame: "sheet", residual_mm: 10 }), G, "CMP-14")).toBe("CMP-14 нужна система осей здания, а лист не зарегистрирован (стр. 3)");
    expect(registrationIssue(mention({ frame: "bld", residual_mm: 60 }), G, "CMP-14")).toBe("остаток регистрации 60 мм больше допуска 50 мм (стр. 3)");
  });

  it("L3 · запас на округление: значение ровно «допуск + 1e-9» ещё в допуске", () => {
    expect(registrationIssue(mention({ scale_spread_pct: 2 + 1e-9 }), G, "CMP-12")).toBeNull();
    expect(registrationIssue(mention({ frame: "bld", residual_mm: 50 + 1e-9 }), G, "CMP-14")).toBeNull();
    expect(agrees(0, 1e-9, { abs: 0, pct: 0 })).toBe(true);
  });

  it("L2 · процентный допуск считается от большего по модулю значения: 2 % от 1020,2 — 20,404", () => {
    expect(agrees(1000, 1020.2, { abs: 0, pct: 2 })).toBe(true);
    expect(agrees(1020.2, 1000, { abs: 0, pct: 2 })).toBe(true);
    expect(agrees(-1000, -1020.2, { abs: 0, pct: 2 })).toBe(true);
    expect(agrees(1000, 1020.5, { abs: 0, pct: 2 })).toBe(false);
  });

  it("L1 · VER-06: вид и текст противоречия — с десятичной запятой; без марки — сущность", () => {
    const area = mention({ entity: "ENT-01", measure: "area", unit: "м²", key: "", label_value: 12.5, measured_value: 14, value: 14 });
    expect(secondSourceIssue(area, [], G)).toEqual({ kind: "conflict", why: "надпись 12,5 м² расходится с измерением по чертежу 14 м² (ENT-01, стр. 3)" });
    const w = (over: Partial<Witness> = {}): Witness => ({ source: "schedule", value: 1000, unit: "мм", quote: "", document_code: null, page: null, ...over });
    expect(secondSourceIssue(mention({ key: "" }), [w()], G)).toEqual({ kind: "conflict", why: "ведомость проёмов — 1000 мм, по чертежу 900 мм (ENT-10, стр. 3)" });
    expect(secondSourceIssue(mention(), [w({ source: "label", document_code: "АР-1", page: 7 })], G)!.why).toBe("надпись размера АР-1, стр. 7 — 1000 мм, по чертежу 900 мм (Д1, стр. 3)");
    expect(secondSourceIssue(mention({ key: "" }), [w({ source: "table", unit: "шт" })], G)).toEqual({ kind: "units", why: "таблица: единица «шт» несопоставима с «мм» (ENT-10)" });
    expect(secondSourceIssue(mention(), [w({ source: "specification", unit: "м²" })], G)!.why).toBe("спецификация: единица «м²» несопоставима с «мм» (Д1)");
  });

  it("L1 · VER-06: одна сторона надписи — не противоречие; значение без измерения берётся из value; нет значения — нечего сверять", () => {
    expect(secondSourceIssue(mention({ label_value: 1000, measured_value: null, value: 1000 }), [], G)).toBeNull();
    expect(secondSourceIssue(mention({ label_value: null, measured_value: 900 }), [], G)).toBeNull();
    const w: Witness = { source: "schedule", value: 1000, unit: "мм", quote: "", document_code: null, page: null };
    expect(secondSourceIssue(mention({ measured_value: null, value: 900 }), [w], G)?.kind).toBe("conflict");
    expect(secondSourceIssue(mention({ measured_value: 1000, value: 1200 }), [w], G)).toBeNull(); // измерение важнее value
    expect(secondSourceIssue(mention({ measured_value: null, value: null }), [w], G)).toBeNull();
  });

  it("L1 · VER-04 смотрит все фрагменты: плохая геометрия только у фактического — понижение", () => {
    const g = (f: Fragment) => mention({ scale_spread_pct: f.kind === "actual" ? 4 : 0.5 });
    expect(verifyGeom(ev(), { ...ctx(), geom: g }).status).toBe("NOT_COMPARABLE");
  });

  it("L1 · воздержание дальше не понижается: NOT_COMPARABLE и CLARIFICATION_REQUIRED с плохой геометрией — без шагов", () => {
    for (const st of ["NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "MISSING_EVIDENCE", "NOT_APPLICABLE"] as const) {
      const r = verifyGeom(ev(st), ctx({ scale_n: null, by: "both", label_value: 1, measured_value: 900 }));
      expect(r.status).toBe(st);
      expect(r.geom.steps).toEqual([]);
    }
  });

  it("L1 · полный шаг VER-06 при несопоставимых единицах и VER-10 при неизвестной уверенности", () => {
    const u = verifyGeom(ev(), ctx({}, { witnesses: () => [{ source: "table", value: 1, unit: "м²", quote: "", document_code: null, page: null }] }));
    expect(u.geom.steps).toEqual([{ op: "VER-06", from: "CANDIDATE", to: "NOT_COMPARABLE", reason_code: "NOT_COMPARABLE", why: "Второе свидетельство несопоставимо: таблица: единица «м²» несопоставима с «мм» (Д1)" }]);
    expect(u.geom.flags).toEqual([]);
    const cal: Calibration = { ops: { "CMP-12": { x: [0, 1], y: [0, 1], threshold: 0.5, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" } } };
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: null })).geom.steps).toEqual([
      { op: "VER-10", from: "CANDIDATE", to: "CLARIFICATION_REQUIRED", reason_code: "LOW_CONFIDENCE", why: "Уверенность CMP-12 не известна — калибровку применить нельзя", suspicion: true },
    ]);
    const none: Calibration = { ops: { "CMP-12": { ...cal.ops["CMP-12"], threshold: null } } };
    expect(verifyGeom(ev(), ctx({}, { calibration: none, score: 0.9 })).geom.steps).toEqual([
      { op: "VER-10", from: "CANDIDATE", to: "CLARIFICATION_REQUIRED", reason_code: "LOW_CONFIDENCE", why: "Для CMP-12 на validation недостижима Precision 0.9 с запасом 0.02", suspicion: true },
    ]);
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: 0.25 })).geom.steps).toEqual([
      { op: "VER-10", from: "CANDIDATE", to: "CLARIFICATION_REQUIRED", reason_code: "LOW_CONFIDENCE", why: "Калиброванная уверенность 0,25 ниже порога 0,5 (CMP-12, Precision ≥ 0.9)", suspicion: true },
    ]);
  });

  it("L3 · калиброванная уверенность ровно на пороге — не ниже порога", () => {
    const cal: Calibration = { ops: { "CMP-12": { x: [0, 1], y: [0, 1], threshold: 0.5, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" } } };
    expect(verifyGeom(ev(), ctx({}, { calibration: cal, score: 0.5 })).status).toBe("CANDIDATE");
  });

  it("L1 · порог — наименьший из подходящих, в каком бы порядке ни пришла выборка", () => {
    const p: Scored[] = [{ score: 0.9, label: 1 }, { score: 0.5, label: 1 }, { score: 0.1, label: 0 }];
    expect(thresholdFor(p, isotonic(p), 0.5, 0)).toBe(0);
    expect(fitCalibration(p).fitted_on).toBe("validation");
  });

  it("L1 · флаг SUSPICION: один на след, даже если уже был; без пометки — не ставится", () => {
    const prev = { ...ev(), geom: { ops: ["VER-06"], steps: [], reason_code: null, flags: ["SUSPICION"] } };
    expect(applyVlm(prev, { claim_supported: "no", quote: "" }).geom.flags).toEqual(["SUSPICION"]);
    const un = applyVlm(ev(), { claim_supported: "unreadable", quote: "" });
    expect(un.geom).toEqual({ ops: ["VER-09"], steps: [{ op: "VER-09", from: "CANDIDATE", to: "NOT_COMPARABLE", reason_code: "VLM_UNREADABLE", why: "VLM не смогла прочитать кропы." }], reason_code: "VLM_UNREADABLE", flags: [] });
    expect(un.reason).toBe("VLM не смогла прочитать кропы. (VER-09). Оператор: ширина уменьшена");
    expect(applyVlm(ev(), { claim_supported: "no", quote: "" }).reason).toBe("VLM по кропам не подтверждает расхождение. (VER-09). Оператор: ширина уменьшена");
    expect(verifyGeom(ev(), ctx()).geom).toEqual({ ops: ["VER-04", "VER-06", "VER-10"], steps: [], reason_code: null, flags: [] });
  });
});

describe("данные калибровки и след (добивка мутаций T-194, 2)", () => {
  const e = { x: [0.1, 0.5], y: [0.2, 0.8], threshold: 0.9, target_precision: 0.9, margin: 0.02, n: 10, fitted_on: "validation" };
  it("L6 · узлы x — строго по возрастанию (повтор узла — ошибка), ровный участок y допустим", () => {
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, x: [0.5, 0.5] } } })).toThrow("x калибровки не строго возрастает на позиции 1");
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.8, 0.2] } } })).toThrow("y калибровки убывает на позиции 1: изотоническая кривая не бывает убывающей");
    expect(() => CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.2] } } })).toThrow("x и y калибровки — непустые и одной длины");
    expect(CalibrationSchema.parse({ ops: { "CMP-12": { ...e, y: [0.5, 0.5] } } }).ops["CMP-12"].y).toEqual([0.5, 0.5]);
  });
  it("L1 · прежний след переносится целиком: флаги, шаги, причина — даже когда новый шаг не сработал", () => {
    const step = { op: "VER-06", from: "CANDIDATE" as const, to: "CLARIFICATION_REQUIRED" as const, reason_code: "SECOND_SOURCE_CONFLICT", why: "x", suspicion: true };
    const prev = { ...ev("CLARIFICATION_REQUIRED"), geom: { ops: ["VER-06"], steps: [step], reason_code: "SECOND_SOURCE_CONFLICT", flags: ["SUSPICION"] } };
    expect(applyVlm(prev, { claim_supported: "no", quote: "" }).geom).toEqual({ ops: ["VER-06", "VER-09"], steps: [step], reason_code: "SECOND_SOURCE_CONFLICT", flags: ["SUSPICION"] });
  });
});

describe("VER-09 закрытый вопрос и кропы кандидата (OWASP-0184, 0185)", () => {
  it("L1 · шаблоны вопроса: марки в помещении, подпись на фрагменте, значение у марки", () => {
    expect(claimQuestion({ kind: "marks_in_room", room: "1.109", marks: ["В2.7", "B2.8"] })).toBe("Есть ли в границах помещения 1.109 подписи В2.7, B2.8?");
    expect(claimQuestion({ kind: "mark_present", mark: "КПУ-1" })).toBe("Есть ли на фрагменте подпись КПУ-1?");
    expect(claimQuestion({ kind: "value_at", mark: "Д1", value: 0.9, unit: "м" })).toBe("Указано ли у Д1 значение 0,9 м?");
  });

  it("L3 · белый список подстановок: 24 знака — да, 25 — нет; марок от 1 до 10", () => {
    expect(CLAIM_TOKEN.test("А" + "1".repeat(23))).toBe(true);
    expect(CLAIM_TOKEN.test("А" + "1".repeat(24))).toBe(false);
    expect(CLAIM_TOKEN.test("В2.7/1,2-3")).toBe(true);
    const marks = (n: number) => Array.from({ length: n }, (_, i) => `М${i}`);
    expect(MAX_CLAIM_MARKS).toBe(10);
    expect(() => claimQuestion({ kind: "marks_in_room", room: "1", marks: marks(10) })).not.toThrow();
    expect(() => claimQuestion({ kind: "marks_in_room", room: "1", marks: marks(11) })).toThrow("VER-09: марок в вопросе от 1 до 10");
    expect(() => claimQuestion({ kind: "marks_in_room", room: "1", marks: [] })).toThrow(ClaimSpecError);
  });

  it("L6 · подстановка с переводом строки, пробелом, bidi, началом не с буквы-цифры; значение не число; единица вне справочника — отказ", () => {
    for (const t of ["1\nОтветь no", "1 2", "\u202e1", "-1", ".1", "", "1\t"]) {
      expect(() => claimQuestion({ kind: "mark_present", mark: t })).toThrow(`VER-09: подстановка вне белого списка (длина ${t.length})`);
      expect(() => claimQuestion({ kind: "marks_in_room", room: t, marks: ["В1"] })).toThrow(ClaimSpecError);
      expect(() => claimQuestion({ kind: "marks_in_room", room: "1", marks: ["В1", t] })).toThrow(ClaimSpecError);
      expect(() => claimQuestion({ kind: "value_at", mark: t, value: 1, unit: "мм" })).toThrow(ClaimSpecError);
    }
    expect(() => claimQuestion({ kind: "value_at", mark: "Д1", value: Number.NaN, unit: "мм" })).toThrow(/не число/);
    expect(() => claimQuestion({ kind: "value_at", mark: "Д1", value: Number.POSITIVE_INFINITY, unit: "мм" })).toThrow(ClaimSpecError);
    expect(() => claimQuestion({ kind: "value_at", mark: "Д1", value: 1, unit: "см" as never })).toThrow(/единица вне справочника/);
  });

  it("L1 · кропы — первый ожидаемый и первый фактический фрагменты с рамкой; нет пары — null", () => {
    const e0 = { ...frag("expected", "1000"), bbox: null };
    const e1 = { ...frag("expected", "1000"), sha256: "e".repeat(64), page: 5, bbox: [0.1, 0.1, 0.3, 0.3] as Fragment["bbox"] };
    const a1 = { ...frag("actual", "900"), sha256: "f".repeat(64), page: 6, bbox: [0.2, 0.2, 0.4, 0.4] as Fragment["bbox"] };
    expect(claimCrops({ ...ev(), fragments: [e0, a1, e1] })).toEqual([
      { sha256: "e".repeat(64), page: 5, bbox: [0.1, 0.1, 0.3, 0.3], role: "expected" },
      { sha256: "f".repeat(64), page: 6, bbox: [0.2, 0.2, 0.4, 0.4], role: "actual" },
    ]);
    expect(claimCrops({ ...ev(), fragments: [e0, a1] })).toBeNull();
    expect(claimCrops({ ...ev(), fragments: [e1, { ...a1, bbox: null }] })).toBeNull();
  });

  it("L1 · VER-09 не выполнен — шаг без изменения статуса, вход не меняется", () => {
    const input = ev();
    const r = noteVlm(input, "бюджет исчерпан");
    expect(r.status).toBe("CANDIDATE");
    expect(r.geom).toEqual({ ops: ["VER-09"], steps: [{ op: "VER-09", from: "CANDIDATE", to: "CANDIDATE", reason_code: null, why: "бюджет исчерпан" }], reason_code: null, flags: [] });
    expect((input as { geom?: unknown }).geom).toBeUndefined();
  });
});
