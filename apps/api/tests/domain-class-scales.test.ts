// Эшелоны: L1 (правила T-172: шкалы, частичный порядок, поэлементное сравнение, CMP-26), L3 (границы шкал: гомоглифы,
// тире, запятая, неизвестная шкала), L5 (fast-check: CANDIDATE ⇔ хуже по шкале; справочник — линейное продолжение порядка),
// L6 (ловушки CMP-04: «не ниже» по общему минимуму, разные элементы — не противоречие, ИД против РД).
// Тираж CMP-04 ORD-RANK на 12 параметров W1: OS-INSP-2.2.40, 3.1.30–3.1.36. Название теста — ссылка трассы.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classComparable, classWorse, decompose, evaluateClassParam, foldClass, type ClassPassport, type Mention } from "../src/domain/class-param.ts";
import { classPassport, elementOf, extractorSpec, resolveScaleRef, ScalesFile } from "../src/domain/passport.ts";
import { passportFor, passports } from "../src/services/passports.ts";
import type { Param, Stage } from "../src/domain/types.ts";

// корень репозитория — вверх по дереву: в песочнице Stryker путь «../../..» ведёт мимо (память mutation-sandbox-paths)
let ROOT = import.meta.dirname;
while (!existsSync(join(ROOT, "data/seed/scales.json")) && dirname(ROOT) !== ROOT) ROOT = dirname(ROOT);
const SCALES = ScalesFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/scales.json"), "utf8")));
const W1 = ["M-015", "M-021", "M-022", "M-050", "M-055", "M-056", "M-057", "M-069", "M-103", "M-107", "M-109", "M-124"];

const pass = (code: string): ClassPassport => classPassport(passportFor(code)!)!;
const PARAM = (code: string): Param => ({
  code, section: "КР", parameter_name: code, unit: "класс", source_pd: "КР", source_rd: "КЖ", source_id: "Паспорт БСГ", trigger_logic: "Понижение класса",
  review_priority: "HIGH", data_type: "enum", compare: { kind: "decrease" }, anchors: [], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
});
let seq = 0;
const M = (stage: Stage, value: string, over: Partial<Mention> = {}): Mention => ({
  stage, file_id: `f-${stage}-${++seq}`, sha256: "b".repeat(64), document_code: `П-2099-01-001-${stage === "PD" ? "КР" : "КЖ"}`, revision: "0",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: "CURRENT", discipline: stage === "PD" ? "КР" : "КЖ", base: "2099-01-001",
  value, qualifier: null, excluded: null, excluded_why: null, page: 2, bbox: [0.1, 0.1, 0.2, 0.12], quote: value, confidence: 1, ...over,
});
const run = (code: string, mentions: Mention[], p: ClassPassport = pass(code)) =>
  evaluateClassParam({ param: PARAM(code), passport: p, mentions, loadedStages: ["PD", "RD", "ID"], profile: {} });

it.each(["M-021", "M-124"])("%s: incompatible scale cannot disappear behind matching selected values", (code) => {
  const p = { ...pass(code), sources: { PD: [{ discipline: "*" }], RD: [{ discipline: "*" }], ID: [{ discipline: "*" }] } };
  const matching = [M("PD", "C"), M("RD", "C")];
  const other = M("RD", "C", { excluded: "ALT_SYSTEM", excluded_why: "C normal under SP50" });
  const e = run(code, [...matching, other], p);
  expect(e.status).toBe("NOT_COMPARABLE");
  expect(e.fragments.some((f) => f.file_id === other.file_id)).toBe(true);
  expect(run(code, [...matching, { ...other, role: "SUPERSEDED" }], p).status).toBe("NEGATIVE_VERIFIED");
});

describe("свёртка написания класса (OS-INSP-2.2.40)", () => {
  it("свёртка: кириллица и латиница, пробелы, тире, запятая и буква О дают один ключ", () => {
    expect(foldClass("В 22,5")).toBe(foldClass("B22.5"));
    expect(foldClass("А500С")).toBe("A500C");
    expect(foldClass("ЕІ – 60")).toBe("EI60");
    expect(foldClass("EI-60")).toBe(foldClass("EI 60"));
    expect(foldClass("С355-1")).toBe("C355-1");
    expect(foldClass("нг(А)-LS")).toBe("HГ(A)-LS");
    expect(foldClass("КМО")).toBe(foldClass("KM0"));
    expect(foldClass("нг(А)-FRLS")).toBe(foldClass("НГ (A) — FRLS"));
    expect(foldClass(" с0 ")).toBe("C0");
  });
  it("контрольные пары свёртки data/seed/class-fold-vectors.json — те же, что у ML", () => {
    const vec = JSON.parse(readFileSync(join(ROOT, "data/seed/class-fold-vectors.json"), "utf8")).cases as Array<[string, string]>;
    expect(vec.length).toBeGreaterThanOrEqual(15);
    for (const [raw, want] of vec) expect(foldClass(raw), raw).toBe(want);
  });
  it("буква O в словах и токенах шкал остаётся буквой: ноль — только рядом с цифрой или в конце префикса класса", () => {
    expect(foldClass("ОСОБАЯ")).toBe("OCOБAЯ");
    expect(foldClass("LO")).toBe("L0"); // короткий префикс без цифры — опечатка номера
    expect(foldClass("FRLSO")).toBe("FRLSO");
    for (const [name, sc] of Object.entries(SCALES.scales))
      for (const d of sc.dims ?? [])
        if (d.kind !== "number") {
          const keys = d.tokens.map(foldClass);
          expect(new Set(keys).size, `${name}/${d.name}`).toBe(keys.length);
          // токен не рождает ноль из буквы и не совпадает свёрткой с другим токеном
          d.tokens.forEach((t, i) => expect(keys[i].includes("0") && !/[0О]/.test(t), `${name}: ${t}`).toBe(false));
        }
  });
  it("каждая шкала справочника различима после свёртки, написания ведут в канон шкалы", () => {
    for (const [name, sc] of Object.entries(SCALES.scales)) {
      const keys = sc.values.map(foldClass);
      expect(new Set(keys).size, name).toBe(keys.length);
      for (const [raw, canon] of Object.entries(sc.aliases ?? {})) {
        expect(sc.values, `${name}: ${raw}`).toContain(canon);
        const hit = sc.values.find((v) => foldClass(v) === foldClass(raw));
        expect(hit === undefined || hit === canon, `${name}: ${raw} совпал с другим значением`).toBe(true);
      }
    }
  });
});

describe("шкалы классов W1 (OS-INSP-3.1.30)", () => {
  it("паспорт со ссылкой на шкалу получает значения, написания и измерения справочника", () => {
    for (const code of W1) {
      const pp = passportFor(code)!;
      expect(pp.value.kind, code).toBe("ordinal");
      if (pp.value.kind !== "ordinal") continue;
      const sc = SCALES.scales[pp.value.scale_ref!];
      expect(pp.value.scale, code).toEqual(sc.values);
      expect(pp.value.order_note).toBe(sc.order_note);
      expect(pp.value.dims ?? null).toEqual(sc.dims ?? null);
      expect(extractorSpec(pp)).toMatchObject({ kind: "class_mentions", scale: sc.values });
    }
    expect(passports().byCode.size).toBeGreaterThanOrEqual(18);
  });
  it("неизвестная шкала в паспорте — громкий отказ, собственная шкала паспорта сильнее справочника", () => {
    expect(() => resolveScaleRef({ code: "M-999", value: { kind: "ordinal", scale_ref: "nope" } }, SCALES)).toThrow(/шкалы nope нет/);
    const own = resolveScaleRef({ code: "M-999", value: { kind: "ordinal", scale_ref: "kpo", scale: ["x", "y"], aliases: { z: "y" } } }, SCALES);
    expect(own.value.scale).toEqual(["x", "y"]);
    expect(own.value.aliases).toEqual({ z: "y" });
    expect(own.value.order_note).toBe(SCALES.scales.kpo.order_note);
    expect(resolveScaleRef({ code: "M-023", value: { kind: "ordinal" } }, SCALES)).toEqual({ code: "M-023", value: { kind: "ordinal" } });
  });
  it("поэлементный параметр и CMP-26 — из паспорта: бетон и арматура поэлементно, энергокласс и степень — целиком", () => {
    expect(pass("M-055")).toMatchObject({ per_element: true, cert_match: true });
    expect(pass("M-057")).toMatchObject({ per_element: true, cert_match: true });
    expect(pass("M-022")).toMatchObject({ per_element: false, cert_match: false });
    expect(pass("M-124")).toMatchObject({ per_element: false, cert_match: false });
    expect(extractorSpec(passportFor("M-015")!)).toMatchObject({ before: 60, aliases: expect.objectContaining({ "1-й": "I" }) });
  });
});

describe("частичный порядок (OS-INSP-3.1.31)", () => {
  const rebar = pass("M-057");
  const door = pass("M-103");
  const cable = pass("M-109");
  it("арматура: потеря индекса «С» — понижение, рост класса с потерей «С» — тоже понижение", () => {
    expect(classWorse(rebar, "А500С", "А500")).toBe(true);
    expect(classWorse(rebar, "А500С", "А600")).toBe(true);
    expect(classWorse(rebar, "А500", "А500С")).toBe(false);
    expect(classWorse(rebar, "А500С", "Ан500С")).toBe(false);
    expect(classWorse(rebar, "А500С", "А400С")).toBe(true);
  });
  it("предел огнестойкости: меньше минут или потеряна буква — понижение; I покрывает W", () => {
    expect(classWorse(door, "EI 60", "EI 30")).toBe(true);
    expect(classWorse(door, "EI 60", "E 60")).toBe(true);
    expect(classWorse(door, "EIS 60", "EI 60")).toBe(true);
    expect(classWorse(door, "EI 60", "EIW 60")).toBe(false);
    expect(classWorse(door, "EIW 60", "EI 60")).toBe(false);
    expect(classWorse(door, "EI 30", "EIS 60")).toBe(false);
  });
  it("кабель: потеря FR, LS, HF, LTx или ниже категория нераспространения горения — понижение", () => {
    expect(classWorse(cable, "нг(А)-FRLS", "нг(А)-LS")).toBe(true);
    expect(classWorse(cable, "нг(А)-LSLTx", "нг(А)-LS")).toBe(true);
    expect(classWorse(cable, "нг(А)-LS", "нг(В)-LS")).toBe(true);
    expect(classWorse(cable, "нг(А)-LS", "нг(А)-HF")).toBe(true);
    expect(classWorse(cable, "нг(А)-LS", "нг(А)-FRLS")).toBe(false);
    expect(classWorse(cable, "нг(А)-FRLS", "нг(А F/R)-FRLS")).toBe(false);
  });
  it("сталь: буквы К, П и «-1» порядок не меняют — только предел текучести", () => {
    const steel = pass("M-056");
    expect(classWorse(steel, "С355П", "С355К")).toBe(false);
    expect(classWorse(steel, "С345", "С245")).toBe(true);
    expect(decompose(steel.dims!, "С390-1")).toEqual([390]);
  });
  it("справочник — линейное продолжение порядка: не хуже по всем измерениям — не левее (fast-check)", () => {
    for (const [name, sc] of Object.entries(SCALES.scales)) {
      const p = { scale: sc.values, dims: sc.dims ?? null };
      fc.assert(
        fc.property(fc.integer({ min: 0, max: sc.values.length - 1 }), fc.integer({ min: 0, max: sc.values.length - 1 }), (i, j) => {
          const [a, b] = [sc.values[i], sc.values[j]];
          // b строго лучше a (a хуже b, b не хуже a) ⇒ b правее a
          if (classWorse(p, b, a) && !classWorse(p, a, b)) expect(j, `${name}: ${a} / ${b}`).toBeGreaterThan(i);
        }),
        { numRuns: 300 },
      );
    }
  });
});

describe("ворота сопоставимости шкалы (OS-INSP-3.1.37)", () => {
  const door = pass("M-103");
  const cable = pass("M-109");
  it("значение, которое не раскладывается по измерениям шкалы, — NOT_COMPARABLE, а не тихий NEGATIVE_VERIFIED", () => {
    expect(classComparable(door, "EI 60")).toBe(true);
    expect(classComparable(door, "EI")).toBe(false); // минут нет — NaN
    expect(classComparable(cable, "FRLS")).toBe(false); // ступени нг нет — −1
    expect(classComparable(pass("M-022"), "VI")).toBe(false);
    const p = { ...door, scale: [...door.scale, "EI"] }; // значение прошло шкалу, но не измерения (ошибка справочника)
    const e = run("M-103", [M("PD", "EI 60"), M("RD", "EI")], p);
    expect(e.status).toBe("NOT_COMPARABLE");
    expect(e.reason).toMatch(/^Класс не раскладывается по шкале: EI 60 → EI/);
    expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
  });
  it("понижение среди сопоставимых элементов — CANDIDATE, даже если другой элемент не раскладывается; без понижения — NOT_COMPARABLE", () => {
    const p = { ...door, scale: [...door.scale, "EI"] };
    const bad = run("M-103", [M("PD", "EI 60", { element: "1-й тип" }), M("RD", "EI 30", { element: "1-й тип" }), M("PD", "EI 30", { element: "2-й тип" }), M("RD", "EI", { element: "2-й тип" })], p);
    expect(bad).toMatchObject({ status: "CANDIDATE", delta: "1-й тип: EI 60 → EI 30" });
    const unk = run("M-103", [M("PD", "EI 60", { element: "1-й тип" }), M("RD", "EI 60", { element: "1-й тип" }), M("PD", "EI 30", { element: "2-й тип" }), M("RD", "EI", { element: "2-й тип" })], p);
    expect(unk.status).toBe("NOT_COMPARABLE");
    expect(unk.reason).toMatch(/^Понижения среди сопоставимых элементов нет.*2-й тип: EI 30 → EI/);
  });
});

describe("сравнение CMP-04 по параметрам W1 (OS-INSP-3.1.30)", () => {
  it("понижение по любой шкале W1 — CANDIDATE, равный или лучший класс — NEGATIVE_VERIFIED (fast-check)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...W1), fc.nat(), fc.nat(), (code, i, j) => {
        const p = pass(code);
        const a = p.scale[i % p.scale.length];
        const b = p.scale[j % p.scale.length];
        const e = run(code, [M("PD", a), M("RD", b)]);
        expect(e.status).toBe(classWorse(p, a, b) ? "CANDIDATE" : "NEGATIVE_VERIFIED");
        expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
      }),
      { numRuns: 400 },
    );
  });
  it("причина отказа называет порядок шкалы: у частичного порядка — текст справочника", () => {
    expect(run("M-022", [M("PD", "II"), M("RD", "I")]).reason).toBe("Класс не понижен по шкале V < IV < III < II < I");
    expect(run("M-103", [M("PD", "EI 30"), M("RD", "EI 60")]).reason).toContain("I покрывает W");
  });
});

describe("поэлементное сравнение (OS-INSP-3.1.32)", () => {
  it("класс бетона сравнивается поэлементно: понижение в колоннах при равных плитах — CANDIDATE по колоннам", () => {
    const e = run("M-055", [
      M("PD", "B40", { element: "колонны" }), M("PD", "B30", { element: "перекрытия" }),
      M("RD", "B35", { element: "колонны" }), M("RD", "B30", { element: "перекрытия" }),
    ]);
    expect(e).toMatchObject({ status: "CANDIDATE", expected: "B40", actual: "B35", delta: "колонны: B40 → B35" });
    expect(e.fragments).toHaveLength(4);
    expect(e.suspicions).toEqual([]);
  });
  it("ограничение ПД «не ниже B30» без элемента покрывает все элементы РД: B35 и B30 — не понижение, B25 — понижение", () => {
    const ok = run("M-055", [M("PD", "B30", { qualifier: "min" }), M("RD", "B35", { element: "колонны" }), M("RD", "B30", { element: "перекрытия" })]);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.reason).toContain("элементов сравнено: 2");
    const bad = run("M-055", [M("PD", "B30", { qualifier: "min" }), M("RD", "B35", { element: "колонны" }), M("RD", "B25", { element: "перекрытия" })]);
    expect(bad).toMatchObject({ status: "CANDIDATE", expected: "не ниже B30", delta: "перекрытия: не ниже B30 → B25" });
  });
  it("общий минимум не сравнивается с чужим элементом: ПД только колонны, РД только перекрытия — NOT_COMPARABLE", () => {
    const e = run("M-055", [M("PD", "B40", { element: "колонны" }), M("RD", "B25", { element: "перекрытия" })]);
    expect(e.status).toBe("NOT_COMPARABLE");
    expect(e.reason).toMatch(/не сопоставлены.*PD колонны B40.*RD перекрытия B25/);
    expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
  });
  it("разные классы разных элементов одной стадии — не противоречие; один элемент с двумя классами — гипотеза по элементу", () => {
    const e = run("M-055", [
      M("RD", "B40", { element: "колонны" }), M("RD", "B30", { element: "перекрытия" }), M("RD", "B25", {}), M("RD", "B20", {}),
      M("PD", "B30", { element: "колонны", page: 3 }), M("PD", "B35", { element: "колонны", page: 4, file_id: "f-pd-x" }),
    ]);
    expect(e.suspicions).toHaveLength(1);
    expect(e.suspicions[0].description).toMatch(/^Внутреннее противоречие ПД \(колонны\)/);
    expect(e.suspicions[0].dedup_key).toMatch(/^class-conflict:PD:колонны:/);
    expect(e.provenance.mentions.find((m) => m.value === "B25")).toMatchObject({ element: null });
  });
  it("параметр без элементов в паспорте (M-022) ведёт себя как М-023: элемент упоминания игнорируется", () => {
    const e = run("M-022", [M("PD", "I", { element: "x" }), M("RD", "II", { element: "y" })]);
    expect(e).toMatchObject({ status: "CANDIDATE", delta: "I → II" });
    expect(e.provenance.mentions[0]).not.toHaveProperty("element");
  });
});

describe("класс конструкции из ответа ML (OS-INSP-2.2.43)", () => {
  it("элемент из ответа ML принимается, только если он объявлен в паспорте", () => {
    expect(elementOf(passportFor("M-055")!, "колонны")).toBe("колонны");
    expect(elementOf(passportFor("M-055")!, "<img src=x onerror=alert(1)>")).toBeNull();
    expect(elementOf(passportFor("M-055")!, 42)).toBeNull();
    expect(elementOf(passportFor("M-022")!, "колонны")).toBeNull();
    expect(elementOf(passportFor("M-001")!, "колонны")).toBeNull();
  });
});

describe("иная система классификации (OS-INSP-3.1.38)", () => {
  it("КМ в ПД, показатели Г, В, Д, Т в РД — NOT_COMPARABLE «иная система классификации», а не MISSING_EVIDENCE", () => {
    const alt = M("RD", "Г1, В1, Д2, Т2", { excluded: "ALT_SYSTEM", excluded_why: "показатели Г, В, Д, Т" });
    const e = run("M-107", [M("PD", "КМ1"), alt]);
    expect(e.status).toBe("NOT_COMPARABLE");
    expect(e.reason).toMatch(/^Иная система классификации: RD — Г1, В1, Д2, Т2/);
    expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
    expect(run("M-107", [M("PD", "КМ1"), alt, M("RD", "КМ1")]).status).toBe("NEGATIVE_VERIFIED");
    expect(run("M-107", [alt]).status).toBe("MISSING_EVIDENCE");
  });
});

describe("CMP-26: ИД против спецификации РД (OS-INSP-3.1.34)", () => {
  it("ИД сравнивается с РД: РД B35, ИД B30 при ПД B30 — CANDIDATE с пометкой CMP-26", () => {
    const e = run("M-055", [M("PD", "B30"), M("RD", "B35"), M("ID", "B30", { document_code: "ПАСПОРТ-БСГ-17", discipline: null })]);
    expect(e).toMatchObject({ status: "CANDIDATE", expected: "B35", actual: "B30" });
    expect(e.reason).toMatch(/^RD → ID \(ИД против спецификации РД, CMP-26\)/);
    expect(e.provenance.ops).toContain("CMP-26");
    expect(e.fragments.map((f) => [f.stage, f.kind])).toEqual([["PD", "expected"], ["RD", "actual"], ["ID", "actual"]]);
  });
  it("без CMP-26 в паспорте ИД сравнивается с ПД; нет РД — ИД против ПД и у CMP-26", () => {
    const p = { ...pass("M-055"), cert_match: false };
    expect(run("M-055", [M("PD", "B30"), M("RD", "B35"), M("ID", "B30")], p).status).toBe("NEGATIVE_VERIFIED");
    expect(run("M-055", [M("PD", "B35"), M("ID", "B30")]).reason).toMatch(/^PD → ID: класс понижен/);
  });
  it("сертификат на арматуру по элементу сравнивается с тем же элементом РД", () => {
    const e = run("M-057", [M("RD", "А500С", { element: "колонны" }), M("RD", "А240", { element: "лестницы" }), M("ID", "А400", { element: "колонны" })]);
    expect(e).toMatchObject({ status: "CANDIDATE", delta: "колонны: А500С → А400" });
  });
  it("равное падение ранга — выбор худшей пары не зависит от порядка упоминаний (элемент, стадия, файл, страница)", () => {
    const ms = [
      M("PD", "EI 60", { element: "2-й тип", file_id: "a" }), M("RD", "EI 30", { element: "2-й тип", file_id: "b" }),
      M("PD", "EI 60", { element: "1-й тип", file_id: "c" }), M("RD", "EI 30", { element: "1-й тип", file_id: "d" }),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(ms, { minLength: 4, maxLength: 4 }), (xs) => {
        expect(run("M-103", xs).delta).toBe("1-й тип: EI 60 → EI 30");
      }),
      { numRuns: 50 },
    );
    const same = [M("PD", "B40", { file_id: "p" }), M("RD", "B30", { file_id: "r2", page: 9, discipline: "КЖ" }), M("ID", "B30", { file_id: "i1", discipline: null })];
    expect(run("M-055", same, { ...pass("M-055"), cert_match: false }).fragments.find((f) => f.stage === "RD")).toBeTruthy();
    expect(run("M-055", same, { ...pass("M-055"), cert_match: false }).reason).toMatch(/^PD → RD: класс понижен/);
  });
  it("несколько понижений — худшее в карточке, остальные перечислены в причине", () => {
    const e = run("M-055", [
      M("PD", "B40", { element: "колонны" }), M("PD", "B30", { element: "стены" }),
      M("RD", "B35", { element: "колонны" }), M("RD", "B20", { element: "стены" }),
    ]);
    expect(e.delta).toBe("стены: B30 → B20");
    expect(e.reason).toContain("ещё понижено: колонны: B40 → B35");
  });
});
