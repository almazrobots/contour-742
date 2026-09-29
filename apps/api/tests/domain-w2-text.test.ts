// Эшелоны: L1 (правила паспортов W2 текстового пути), L3 (граница 5 % и абсолютного допуска), L5 (fast-check: CMP-02
// против независимого пересчёта), L6 (испорченные данные: отсеянное упоминание, нет стадии, профиль без демонтажа).
// T-191: паспорта количества М-024, 045, 086, 088, 093, 094, 126, 127 на движке quantity-param.ts; реестр видов
// data/seed/w2-text-kinds.json. Название теста — ссылка трассы (model.yaml → impl → tests). Значения синтетические.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "../src/config.ts";
import { extractorSpec, mergeStages, ParamPassport, quantityPassport } from "../src/domain/passport.ts";
import { evaluateQuantityParam, type QuantityMention } from "../src/domain/quantity-param.ts";
import type { Param, Stage } from "../src/domain/types.ts";
import { passports } from "../src/services/passports.ts";

const seed = (f: string) => JSON.parse(readFileSync(join(config.root, "data/seed", f), "utf8"));
const MATRIX = seed("matrix.json") as Array<Record<string, any>>;
const KINDS = seed("w2-text-kinds.json") as { params: Array<{ param: string; ready_ops: string[]; pending_ops: string[]; pending_owner: Record<string, string>; passport: boolean | "pending" | "draft"; passport_file: string | null; passport_kind: string | null }> };
const WAVE = seed("w2-wave.json") as { params: Array<{ id: string; ops: string[]; path: string }> };
// CMP-06 по норме (ширины дверей) — у T-193, не в реестре T-191
const T193 = new Set(["M-041", "M-105", "M-117"]);
const QUANTITY = KINDS.params.filter((k) => k.passport === "draft").map((k) => k.param);
// паспорта количества W2 — в data/seed/passports/draft/ до цифр отложенного набора (P ≥ 0,90, FPR ≤ 0,10): загрузчик их не
// читает, поэтому тест читает черновик напрямую той же схемой, что и загрузчик
// (T-233: в интеграционной ветке замера паспорта T-191 лежат в data/seed/passports/ — 5d26c9ad; читается активный, нет его — черновик)
const passportPath = (code: string) => [`data/seed/passports/${code}.json`, `data/seed/passports/draft/${code}.json`].map((f) => join(config.root, f)).find((f) => existsSync(f))!;
const draft = (code: string) => ParamPassport.parse(JSON.parse(readFileSync(passportPath(code), "utf8")));

const paramOf = (code: string): Param => {
  const m = MATRIX.find((x) => x.code === code)!;
  return { ...(m as unknown as Param), value_scale: null };
};
const qp = (code: string) => quantityPassport(draft(code))!;

let seq = 0;
const Q = (stage: Stage, num: number, over: Partial<QuantityMention> = {}): QuantityMention => ({
  stage,
  file_id: `w2f${++seq}`,
  sha256: "b".repeat(64),
  document_code: `${stage === "PD" ? "П" : "Р"}-200-${over.discipline ?? "ПОС"}`,
  revision: "1",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
  role: "CURRENT",
  discipline: "ПОС",
  base: "200",
  num,
  excluded: null,
  excluded_why: null,
  page: 4,
  bbox: [0.1, 0.2, 0.3, 0.22],
  quote: `значение ${num}`,
  confidence: 1,
  source: "pdf-text",
  ...over,
});
const ALL: Stage[] = ["PD", "RD", "ID"];
const run = (code: string, mentions: QuantityMention[], profile: Record<string, boolean> = { demolition: true }) =>
  evaluateQuantityParam({ param: paramOf(code), passport: qp(code), mentions, loadedStages: ALL, profile, kitBases: new Set(["200"]) });
const pair = (code: string, pd: number, rd: number) => run(code, [Q("PD", pd), Q("RD", rd)]).status;

describe("реестр видов W2 текстового пути (OS-INSP-3.1.103)", () => {
  it("реестр: каждый параметр текстового пути T-191 — готовые и ожидающие операторы делят операторы Матрицы", () => {
    const text = WAVE.params.filter((p) => p.path === "text" && !T193.has(p.id));
    expect(KINDS.params.map((k) => k.param).sort()).toEqual(text.map((p) => p.id).sort());
    expect(KINDS.params).toHaveLength(16);
    for (const k of KINDS.params) {
      const ops = text.find((p) => p.id === k.param)!.ops;
      expect([...k.ready_ops, ...k.pending_ops].sort(), k.param).toEqual([...ops].sort());
      expect(k.ready_ops.filter((o) => k.pending_ops.includes(o)), k.param).toEqual([]);
      // у каждого ожидающего оператора — задача-владелец вида
      for (const o of k.pending_ops) expect(k.pending_owner[o], `${k.param} ${o}`).toMatch(/^(T-\d{3}|не назначен)$/);
    }
  });
  it("реестр: паспорт количества — в draft/ до цифр отложенного набора, ровно у параметров с готовым оператором, и сравнивает он только готовыми", () => {
    const { byCode } = passports();
    for (const k of KINDS.params) {
      // загрузчик паспорт из draft/ не читает: параметр идёт лексическим путём
      expect(byCode.has(k.param), k.param).toBe(existsSync(join(config.root, `data/seed/passports/${k.param}.json`)));
      expect(k.ready_ops.length > 0, k.param).toBe(k.passport === "draft");
      if (k.passport !== "draft") continue;
      expect(k.passport_file).toBe(`data/seed/passports/draft/${k.param}.json`);
      const pp = draft(k.param);
      expect(pp.value.kind).toBe("quantity");
      const cmp = pp.steps.CMP.ops.filter((o) => /^CMP-/.test(o) && o !== "CMP-30");
      // CMP-18 по тексту — уклон тем же движком количества, что CMP-03 «только уменьшение»
      for (const o of cmp) expect([...k.ready_ops, ...(k.ready_ops.includes("CMP-18") ? ["CMP-03"] : [])], `${k.param} ${o}`).toContain(o);
      for (const o of k.pending_ops) expect(pp.steps.CMP.ops, `${k.param} ${o}`).not.toContain(o);
    }
  });
  it("реестр: паспорта W2 читаются схемой, операции шагов есть в каталоге, экстрактор — упоминания количества", () => {
    const { common, catalog } = passports();
    expect(QUANTITY.sort()).toEqual(["M-024", "M-045", "M-086", "M-088", "M-093", "M-094", "M-126", "M-127"]);
    for (const c of QUANTITY) {
      const pp = draft(c);
      expect(() => mergeStages(common, pp, catalog)).not.toThrow();
      expect(extractorSpec(pp)).toMatchObject({ kind: "quantity_mentions" });
      expect(pp.title, c).toBe(MATRIX.find((m) => m.code === c)!.parameter_name);
    }
  });
});

describe("CMP-02: объём выемки и объём демонтажа, порог 5 % (OS-INSP-3.1.100)", () => {
  it("М-024: отклонение ровно 5 % — NEGATIVE_VERIFIED, на 1 м³ больше — CANDIDATE, в обе стороны", () => {
    expect(pair("M-024", 10_000, 10_500)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-024", 10_000, 10_501)).toBe("CANDIDATE");
    expect(pair("M-024", 10_000, 9_500)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-024", 10_000, 9_499)).toBe("CANDIDATE");
  });
  it("М-093: расхождение объёма демонтажа больше 5 % — CANDIDATE с разницей в процентах", () => {
    const ev = run("M-093", [Q("PD", 2350, { discipline: "ПОД" }), Q("ID", 2600, { discipline: "ИД" })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.delta).toBe("+250 м³ (+10,6 %)");
    expect(ev.reason).toContain("допуск ±117,5 м³");
    expect(pair("M-093", 2350, 2410)).toBe("NEGATIVE_VERIFIED");
  });
  it("М-093, М-094: объект без сноса и демонтажа — NOT_APPLICABLE даже при расхождении", () => {
    for (const c of ["M-093", "M-094"]) {
      const ev = run(c, [Q("PD", 100), Q("RD", 900)], { demolition: false });
      expect(ev.status, c).toBe("NOT_APPLICABLE");
      expect(ev.reason).toBe("Неприменим к объекту: demolition");
    }
  });
  it("свойство: CMP-02 — кандидат тогда и только тогда, когда |РД − ПД| больше 5 % ПД (независимый пересчёт)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 200_000 }), fc.integer({ min: -300, max: 300 }), (pd, permille) => {
        const rd = Math.round(pd * (1 + permille / 1000));
        const want = Math.abs(rd - pd) * 100 > 5 * pd + 1e-6 && Math.abs(rd - pd) > 0.5 ? "CANDIDATE" : "NEGATIVE_VERIFIED";
        expect(pair("M-024", pd, rd)).toBe(want);
      }),
      { numRuns: 300 },
    );
  });
});

describe("CMP-03 уменьшение: Ro окон и уклон кровли (OS-INSP-3.1.101)", () => {
  it("М-127: Ro РД меньше ПД больше 0,005 — CANDIDATE, рост Ro — NEGATIVE_VERIFIED", () => {
    expect(pair("M-127", 0.64, 0.54)).toBe("CANDIDATE");
    expect(pair("M-127", 0.64, 0.72)).toBe("NEGATIVE_VERIFIED");
    expect(run("M-127", [Q("PD", 0.64, { discipline: "ЭЭ" }), Q("RD", 0.54, { discipline: "АР" })]).reason).toContain("меньше ПД");
  });
  it("М-127: граница допуска — 0,635 не кандидат, 0,634 — кандидат", () => {
    expect(pair("M-127", 0.64, 0.635)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-127", 0.64, 0.634)).toBe("CANDIDATE");
  });
  it("М-045 (CMP-18 по тексту): уклон кровли уменьшен — CANDIDATE, 2 % → 1,96 % в пределах 0,05 — нет", () => {
    expect(pair("M-045", 2, 1.5)).toBe("CANDIDATE");
    expect(pair("M-045", 2, 1.96)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-045", 2, 3)).toBe("NEGATIVE_VERIFIED");
    expect([qp("M-045").direction, qp("M-127").direction]).toEqual(["decrease", "decrease"]);
  });
});

describe("CMP-03 рост: численность, мощность, масса отходов, λ (OS-INSP-3.1.102)", () => {
  it("рост больше допуска — CANDIDATE: 250 → 310 чел., 385 → 460 кВт, 1250,4 → 1480 т, λ 0,037 → 0,041", () => {
    expect(pair("M-086", 250, 310)).toBe("CANDIDATE");
    expect(pair("M-088", 385, 460)).toBe("CANDIDATE");
    expect(pair("M-094", 1250.4, 1480)).toBe("CANDIDATE");
    expect(pair("M-126", 0.037, 0.041)).toBe("CANDIDATE");
  });
  it("граница абсолютного допуска: λ +0,0005 — не кандидат, +0,0006 — кандидат; численность +0 — не кандидат, +1 — кандидат", () => {
    expect(pair("M-126", 0.037, 0.0375)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-126", 0.037, 0.0376)).toBe("CANDIDATE");
    expect(pair("M-086", 250, 250)).toBe("NEGATIVE_VERIFIED");
    expect(pair("M-086", 250, 251)).toBe("CANDIDATE");
  });
  it("до вида «только рост» (T-173) паспорта считают кандидатом изменение в любую сторону; плохая сторона записана в паспорте", () => {
    for (const c of ["M-086", "M-088", "M-094", "M-126"]) {
      expect(qp(c).direction, c).toBe("both");
      const raw = JSON.parse(readFileSync(passportPath(c), "utf8"));
      expect(raw.value.bad_direction, c).toBe("up");
      expect(draft(c).steps.CMP.how, c).toContain("T-173");
    }
  });
});

describe("испорченные данные: отсеянное упоминание, нет стадии (OS-INSP-3.1.100–3.1.102)", () => {
  it("причина кандидата: «больше» при росте, разница со знаком; совпадение — нулевая разница без знака", () => {
    const up = run("M-086", [Q("PD", 250, { page: 7 }), Q("RD", 310, { discipline: "ППР", page: 2 })]);
    expect(up.reason?.startsWith("РД (ППР, стр. 2) больше ПД (ПОС, стр. 7) на 60 чел. — допуск ±0,5 чел.")).toBe(true);
    expect(up.delta).toBe("+60 чел. (+24,0 %)");
    expect(run("M-086", [Q("PD", 250), Q("RD", 250)]).delta).toBe("0 чел. (0,0 %)");
  });
  it("редакция РД не определена — CLARIFICATION_REQUIRED, сравнение не выполняется", () => {
    for (const role of ["CONFLICT", "UNRESOLVED"] as const) {
      const ev = run("M-127", [Q("PD", 0.64), Q("RD", 0.54, { role, document_code: "Р-200-АР", revision: "3" })]);
      expect(ev.status, role).toBe("CLARIFICATION_REQUIRED");
      expect(ev.reason).toBe("Не определена актуальная редакция: Р-200-АР ред. 3");
    }
  });
  it("отсеянное упоминание РД (объём одного типа) не участвует в сравнении — MISSING_EVIDENCE с объёмом ПД", () => {
    const ev = run("M-093", [Q("PD", 2350, { discipline: "ПОД" }), Q("RD", 820, { discipline: "ППР", excluded: "BY_TYPE", excluded_why: "объём одного типа конструкций" })]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("ПД — 2350 м³");
    expect(ev.reason).toContain("РД: спецификации и ведомости ППР — показателя нет");
    const dropped = (ev.provenance.mentions as Array<{ stage: Stage; use: string }>).filter((m) => m.use === "dropped");
    expect(dropped.map((m) => m.stage)).toEqual(["RD"]);
  });
  it("разные значения разделов одной стадии ПД — гипотеза о внутреннем противоречии, сравнение по приоритетному разделу", () => {
    const ev = run("M-127", [Q("PD", 0.64, { discipline: "ЭЭ" }), Q("PD", 0.56, { discipline: "АР" }), Q("RD", 0.64, { discipline: "АР" })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.suspicions.map((s) => s.stage)).toEqual(["PD"]);
  });
  it("значения нет ни в одной стадии — MISSING_EVIDENCE, а не NEGATIVE_VERIFIED", () => {
    expect(run("M-086", []).status).toBe("MISSING_EVIDENCE");
  });
});

// Схема вида presence — зеркало T-212 (origin/feat/w3-presence @ ed51b72, apps/api/src/domain/passport.ts): паспорта,
// ждущие вида, проверяются ею до влития T-212, чтобы при переносе в data/seed/passports не упасть на загрузке.
const PresenceValue = z.object({
  kind: z.literal("presence"),
  aspects: z.record(z.string(), z.string()).refine((a) => Object.keys(a).length > 0),
  pd_silent: z.enum(["MISSING_EVIDENCE", "NOT_APPLICABLE"]),
  count: z.object({ aspect: z.string(), unit: z.string(), title: z.string() }).nullable(),
  note: z.string(),
});
const PresenceExtractor = z.object({
  kind: z.literal("presence_mentions"),
  anchors: z.array(z.object({ aspect: z.string(), pattern: z.string() })).min(1),
  context: z.string().optional(),
  negation: z.array(z.string()).min(1),
  affirm: z.array(z.string()),
  count: z.array(z.string()),
  exclude: z.array(z.object({ code: z.string(), pattern: z.string(), why: z.string() })),
});

describe("паспорта, ждущие вида presence T-212 (OS-INSP-3.1.103)", () => {
  const pending = KINDS.params.filter((k) => k.passport === "pending");
  it("паспорта presence для CMP-09 лежат вне загрузчика и проходят схему вида T-212", () => {
    expect(pending.map((k) => k.param).sort()).toEqual(["M-110", "M-115", "M-120", "M-123", "M-129"]);
    const { catalog } = passports();
    for (const k of pending) {
      expect(k.pending_owner["CMP-09"], k.param).toBe("T-212");
      expect(k.passport_file).toBe(`data/seed/passports-pending/${k.param}.json`);
      expect(passports().byCode.has(k.param), k.param).toBe(false);
      const raw = JSON.parse(readFileSync(join(config.root, k.passport_file!), "utf8"));
      expect(raw.code).toBe(k.param);
      const v = PresenceValue.parse(raw.value);
      const x = PresenceExtractor.parse(raw.extractor);
      // аспекты оборотов и счёта — из словаря аспектов паспорта
      for (const a of x.anchors) expect(Object.keys(v.aspects), `${k.param} ${a.aspect}`).toContain(a.aspect);
      if (v.count) expect(Object.keys(v.aspects)).toContain(v.count.aspect);
      for (const p of [...x.anchors.map((a) => a.pattern), ...x.negation, ...x.affirm, ...x.count, ...(x.context ? [x.context] : [])]) expect(() => new RegExp(p, "i")).not.toThrow();
      for (const s of Object.values(raw.steps) as Array<{ ops: string[] }>) for (const o of s.ops) expect(catalog[o], `${k.param} ${o}`).toBeTruthy();
    }
  });
});
