// Эшелоны: L6 (синтетические мутации с известной истиной — MUT-17, MUT-18, отрицательные контроли NEG-01…03),
// L5 (свойство на случайных входах: контроли не дают кандидатов). Строка качества слоя L8 (T-177, каталог §15):
// по каждой категории ≥ 100 положительных и ≥ 100 отрицательных примеров, P, R, FPR и доля воздержаний.
// Уровень — результат оператора (Evaluation) и контекст пакета, как их собирает пересчёт; PDF-уровень отметок
// изменений меряет ml/tests/test_change_marks.py, сквозной прогон через ML-сервис — стенд T-179.
import { describe, expect, it } from "vitest";
import type { ApprovedChange } from "../src/domain/changes.ts";
import type { Evaluation, FindingStatus, Fragment, Stage } from "../src/domain/types.ts";
import { verifyL8, type ChangeMark, type FragmentFacts, type GateConfig, type L8Context, type RevisionInfo } from "../src/domain/verify-l8.ts";

/** Детерминированный генератор (mulberry32): набор воспроизводим, как seed стенда мутаций. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], range: (lo: number, hi: number) => lo + next() * (hi - lo) };
}

const GATES: GateConfig = { min_confidence: { default: 0.4 }, methods: {}, equivalent_methods: [], sheet_kinds: {} };
const facts: FragmentFacts = { confidence: 0.95, quality: "OK", doc_kind: "drawing", unit: null };

function frag(stage: Stage, kind: Fragment["kind"], value: string, o: Partial<Fragment> = {}): Fragment {
  return { file_id: `f-${stage}`, sha256: "a".repeat(64), stage, document_code: `SYN-${stage}`, revision: "1", approval_status: "APPROVED", page: 2, bbox: [0.4, 0.4, 0.5, 0.42], role: "CURRENT", value, kind, ...o };
}
const ev = (status: FindingStatus, expected: string, actual: string, fragments: Fragment[]): Evaluation => ({ status, expected, actual, delta: null, reason: "оператор", stage_notes: {}, fragments });
const ctx = (o: Partial<L8Context> = {}): L8Context => ({ param_code: "M-SYN", op: "CMP-01", threshold_rule: false, units_normalized: true, gates: GATES, facts: () => facts, revisions: [], changes: [], marks: [], searched: [], ...o });
const change = (number: string, basis: boolean): ApprovedChange => ({ id: 1, inspection_id: "i", object_id: "o", number, date: "2026-05-01", param_codes: ["M-SYN"], basis_file_id: basis ? "f-basis" : null, basis_file_name: basis ? "Письмо.pdf" : null, description: "", created_by: "u", created_at: "" });

interface Row { cat: string; npos: number; nneg: number; tp: number; fp: number; fn: number; tn: number; abst: number }
const row = (cat: string): Row => ({ cat, npos: 0, nneg: 0, tp: 0, fp: 0, fn: 0, tn: 0, abst: 0 });
const ABST: FindingStatus[] = ["MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"];
function score(r: Row, positive: boolean, predicted: boolean, status: FindingStatus) {
  if (positive) r.npos++;
  else r.nneg++;
  if (positive && predicted) r.tp++;
  else if (positive) r.fn++;
  else if (predicted) r.fp++;
  else r.tn++;
  if (ABST.includes(status)) r.abst++;
}
const P = (r: Row) => (r.tp + r.fp ? r.tp / (r.tp + r.fp) : 1);
const R = (r: Row) => (r.npos ? r.tp / r.npos : 1);
const FPR = (r: Row) => (r.nneg ? r.fp / r.nneg : 0);
const table: Row[] = [];
const show = (r: Row) => `${r.cat.padEnd(34)} n+=${r.npos} n−=${r.nneg} P=${P(r).toFixed(3)} R=${R(r).toFixed(3)} FPR=${FPR(r).toFixed(3)} воздержания=${(r.abst / (r.npos + r.nneg)).toFixed(3)}`;

/** Кандидат оператора: значение РД изменено (MUT-05/06), рамка фактического — случайная точка листа. */
function mutation(g: ReturnType<typeof rng>) {
  const x = g.range(0.1, 0.8);
  const y = g.range(0.1, 0.85);
  const box: [number, number, number, number] = [x, y, x + g.range(0.02, 0.08), y + 0.012];
  return { box, ev: ev("CANDIDATE", "100", "90", [frag("PD", "expected", "100"), frag("RD", "actual", "90", { bbox: box })]) };
}

describe("L6 · строка качества слоя L8 на синтетике", () => {
  it("MUT-17: облако изменения у мутации — изменение распознано (ref ≠ NONE); облако далеко, на другой странице или в другом файле — не распознано", () => {
    const g = rng(17);
    const r = row("MUT-17 · CMP-29 распознаёт изменение");
    const s = row("MUT-17 · статус: APPROVED_CHANGE при основании");
    for (let i = 0; i < 640; i++) {
      const { box, ev: e } = mutation(g);
      const positive = i % 2 === 0;
      const n = String(1 + Math.floor(g.next() * 9));
      let mark: ChangeMark;
      if (positive) {
        const pad = g.range(0, 0.035); // облако обводит значение с отступом, номер — рядом
        mark = { file_id: "f-RD", page: 2, kind: g.next() < 0.8 ? "cloud" : "callout", number: n, bbox: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], text: "" };
      } else {
        const where = g.pick(["far", "page", "file"] as const);
        const dx = where === "far" ? g.range(0.07, 0.3) * (box[0] > 0.5 ? -1 : 1) : 0;
        mark = { file_id: where === "file" ? "f-PD" : "f-RD", page: where === "page" ? 3 : 2, kind: "cloud", number: n, bbox: [box[0] + dx - (dx < 0 ? 0.05 : -0.1), box[1], box[2] + dx + (dx < 0 ? -0.1 : 0.05), box[3]], text: "" };
      }
      const basis = g.next() < 0.5; // и у отрицательных: изменение зарегистрировано, но облако не у этого значения
      const registered = g.next() < 0.8;
      const out = verifyL8(e, ctx({ marks: [mark], changes: registered ? [change(n, basis)] : [] }));
      const onSheet = out.l8.change === "APPROVED_CHANGE" || /облако|выноска/.test(out.l8.approved_change_ref ?? "");
      score(r, positive, onSheet, out.status);
      // статус: снимает кандидата только отметка у значения + зарегистрированное основание; без отметки — кандидат
      score(s, positive && registered && basis, out.status === "NEGATIVE_VERIFIED", out.status);
    }
    table.push(r, s);
    expect(r.npos).toBeGreaterThanOrEqual(100);
    expect(r.nneg).toBeGreaterThanOrEqual(100);
    expect(P(r)).toBeGreaterThanOrEqual(0.95);
    expect(R(r)).toBeGreaterThanOrEqual(0.95);
    expect(s.npos).toBeGreaterThanOrEqual(100);
    expect(FPR(s)).toBe(0); // настоящее нарушение без отметки у значения CMP-29 не снимает никогда
    expect(R(s)).toBeGreaterThanOrEqual(0.95);
  });

  it("MUT-18: подмена редакции и устаревший источник — CLARIFICATION_REQUIRED; единственная или более поздняя редакция — без флага", () => {
    const g = rng(18);
    const r = row("MUT-18 · VER-03 устаревшая редакция");
    for (let i = 0; i < 240; i++) {
      const positive = i % 2 === 0;
      const kind = g.pick(["swap", "superseded", "cancelled", "stamp"] as const);
      const negKind = g.pick(["single", "older-sibling", "other-doc", "other-stage"] as const);
      const revs: RevisionInfo[] = [{ file_id: "f-RD", stage: "RD", document_code: "SYN-RD", revision: "1", role: "CURRENT", approval_status: "FOR_CONSTRUCTION", stamp_change: null }];
      let actual = frag("RD", "actual", "90");
      if (positive) {
        if (kind === "swap") revs.push({ ...revs[0], file_id: "f-RD2", revision: String(2 + Math.floor(g.next() * 3)), role: "SUPERSEDED" });
        if (kind === "superseded") actual = { ...actual, role: "SUPERSEDED" };
        if (kind === "cancelled") actual = { ...actual, approval_status: "CANCELLED" };
        if (kind === "stamp") {
          revs[0] = { ...revs[0], revision: "А", stamp_change: 1 };
          revs.push({ ...revs[0], file_id: "f-RD2", revision: "Б", role: "SUPERSEDED", stamp_change: 2 + Math.floor(g.next() * 3) });
          actual = { ...actual, revision: "А" };
        }
      } else {
        if (negKind === "older-sibling") {
          revs[0] = { ...revs[0], revision: "3" };
          revs.push({ ...revs[0], file_id: "f-RD0", revision: String(Math.floor(g.next() * 3)), role: "SUPERSEDED" });
          actual = { ...actual, revision: "3" };
        }
        if (negKind === "other-doc") revs.push({ ...revs[0], file_id: "f-RDX", document_code: "SYN-RD-X", revision: "7", role: "CURRENT" });
        if (negKind === "other-stage") revs.push({ ...revs[0], file_id: "f-PDX", stage: "PD", document_code: "SYN-RD", revision: "7" });
      }
      const status = g.next() < 0.5 ? "CANDIDATE" : "NEGATIVE_VERIFIED";
      const out = verifyL8(ev(status, "100", status === "CANDIDATE" ? "90" : "100", [frag("PD", "expected", "100"), actual]), ctx({ revisions: revs }));
      score(r, positive, out.l8.flags.includes("STALE_REVISION") && out.status === "CLARIFICATION_REQUIRED", out.status);
    }
    table.push(r);
    expect(r.npos).toBeGreaterThanOrEqual(100);
    expect(r.nneg).toBeGreaterThanOrEqual(100);
    expect(P(r)).toBeGreaterThanOrEqual(0.95);
    expect(R(r)).toBeGreaterThanOrEqual(0.95);
    expect(FPR(r)).toBeLessThanOrEqual(0.05);
  });

  it("NEG-01, NEG-02: объект сам с собой и редакции «только штамп» — слой не даёт ни одного кандидата и не воздерживается без причины", () => {
    const g = rng(1);
    const r = row("NEG-01/02 · контроли без изменений");
    for (let i = 0; i < 200; i++) {
      const v = String(Math.round(g.range(10, 50000)));
      const stampOnly = i % 2 === 1;
      const revs: RevisionInfo[] = stampOnly
        ? [
            { file_id: "f-RD", stage: "RD", document_code: "SYN-RD", revision: "2", role: "CURRENT", approval_status: "FOR_CONSTRUCTION", stamp_change: 2 },
            { file_id: "f-RD1", stage: "RD", document_code: "SYN-RD", revision: "1", role: "SUPERSEDED", approval_status: "FOR_CONSTRUCTION", stamp_change: 1 },
          ]
        : [];
      const marks: ChangeMark[] = stampOnly ? [{ file_id: "f-RD", page: 2, kind: "stamp_row", number: "2", bbox: null, text: "2 - Зам. 17.05.2026" }] : [];
      const out = verifyL8(ev("NEGATIVE_VERIFIED", v, v, [frag("PD", "expected", v), frag("RD", "actual", v, { revision: stampOnly ? "2" : "1" })]), ctx({ revisions: revs, marks }));
      score(r, false, out.status === "CANDIDATE", out.status);
    }
    table.push(r);
    expect(r.nneg).toBeGreaterThanOrEqual(200);
    expect(r.fp).toBe(0);
    expect(r.abst).toBe(0);
  });

  it("NEG-03: чистая детализация РД — NEGATIVE_VERIFIED (DETAIL_REFINEMENT); замена марки, понижение класса, второй класс — кандидат остаётся", () => {
    const g = rng(3);
    const refine: Array<[string, string]> = [
      ["B25", "В25 W6 F150"], ["ВВГнг(А)-LS", "ВВГнг(А)-LS 5х10"], ["А500С", "A500C (ГОСТ 34028)"], ["EI60", "EI60 (ГОСТ 30247)"],
      ["200…250", "220"], ["не менее 150", "150"], ["не менее 150", "180 мм"], ["не более 35", "30"], ["К0", "К0 (ГОСТ 30403)"], ["С0", "С0, класс по ФЗ-123"],
      ["ППС20", "ППС20 толщ. 100"], ["PE100", "PE100 SDR17"],
    ];
    const replace: Array<[string, string]> = [
      ["ВВГнг(А)-FRLS", "ВВГнг(А)-LS"], ["B25", "B20"], ["С1", "С1, С2"], ["EI60", "EI30"], ["А500С", "А400"], ["200…250", "180"],
      ["не менее 150", "120"], ["К0", "К1"], ["B25", "B25/B30"], ["PE100", "PE80"], ["В2", "В25"], ["не более 35", "40"],
    ];
    const r = row("NEG-03 · VER-07 детализация");
    for (let i = 0; i < 240; i++) {
      const positive = i % 2 === 0;
      const [e, a] = g.pick(positive ? refine : replace);
      const out = verifyL8(ev("CANDIDATE", e, a, [frag("PD", "expected", e), frag("RD", "actual", a)]), ctx({ op: "CMP-05" }));
      score(r, positive, out.status === "NEGATIVE_VERIFIED" && out.l8.reason_code === "DETAIL_REFINEMENT", out.status);
    }
    table.push(r);
    expect(r.npos).toBeGreaterThanOrEqual(100);
    expect(r.nneg).toBeGreaterThanOrEqual(100);
    expect(P(r)).toBe(1);
    expect(R(r)).toBe(1);
    // сводка для QA-отчёта T-177
    console.log(`\nСтрока качества L8 (синтетика, seed 17/18/1/3):\n${table.map(show).join("\n")}`);
  });
});
