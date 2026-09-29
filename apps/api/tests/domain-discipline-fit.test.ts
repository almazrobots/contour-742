// T-133 (OS-INSP-2.2.21): значение параметра — только из профильного раздела; ложные кандидаты «Алтуфьево» из чужих марок.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts"; // корень репо вверх по дереву: песочница Stryker глубже tests/
import { disciplineFits, normMark, paramMarks, pickStageSources } from "../src/domain/discipline-fit.ts";

const matrix: Array<{ code: string; section: string; source_pd: string | null; source_rd: string | null }> = JSON.parse(
  readFileSync(join(config.root, "data/seed/matrix.json"), "utf8"),
);
const P = (code: string) => matrix.find((p) => p.code === code)!;

describe("марка документа как источник параметра (T-133)", () => {
  it("марка из шифра: номер тома отбрасывается, у ИОС номер подраздела остаётся", () => {
    expect(["АР2", "КЖ01", "КР.Р", "ИОС3.1", "ИОС5.5.1", "вк2", "ПБ", "", null].map(normMark)).toEqual(["АР", "КЖ", "КР", "ИОС3", "ИОС5", "ВК", "ПБ", null, null]);
  });

  it("марки параметра — из раздела и скобок источников; «маркировка» и «ГОСТ 21.101» не марки", () => {
    expect([...paramMarks(P("M-059"))].sort()).toEqual(["КЖ", "КР"]);
    expect([...paramMarks(P("M-023"))].sort()).toEqual(["АР", "КР", "ПЗ"]);
    expect(paramMarks({ section: "АР", source_pd: "Лист (маркировка)", source_rd: "(ГОСТ 21.101)" })).toEqual(new Set(["АР"]));
  });

  it("М-059 толщина плиты на «Алтуфьево»: ЭЭ, ПОС, ИОС3, ПБ, ВК — не источник; КР, КЖ, АР — источник", () => {
    const p = P("M-059");
    expect(["ЭЭ", "ПОС", "ИОС3", "ПБ", "ВК"].map((d) => disciplineFits(p, d))).toEqual([false, false, false, false, false]);
    expect(["КР", "КЖ", "КЖ1", "АР2", "КМ"].map((d) => disciplineFits(p, d))).toEqual([true, true, true, true, true]);
  });

  it("М-058 плита фундамента из ВК2 и ИОС3.1 и М-029 МАФ из ТХ и КЖ — не источник", () => {
    expect(["ВК", "ИОС3"].map((d) => disciplineFits(P("M-058"), d))).toEqual([false, false]);
    expect(["ТХ", "КЖ", "КМ"].map((d) => disciplineFits(P("M-029"), d))).toEqual([false, false, false]);
    expect(["СПЗУ", "ПП", "ГП"].map((d) => disciplineFits(P("M-029"), d))).toEqual([true, true, true]);
  });

  it("верные доказательства «Алтуфьево» сохраняются: М-055 и М-057 из КР.Р и КЖ", () => {
    for (const code of ["M-055", "M-057"]) expect(["КР", "КЖ"].map((d) => disciplineFits(P(code), d))).toEqual([true, true]);
  });

  it("ПЗУ — прежнее имя СПЗУ, ППМ — раздел пожарной безопасности (ПБ): значения М-030, М-032 из ПЗУ сохраняются", () => {
    for (const code of ["M-030", "M-032", "M-024"]) expect([code, disciplineFits(P(code), "ПЗУ")]).toEqual([code, true]);
    expect(disciplineFits(P("M-114"), "ПБ")).toBe(true);
  });

  it("противопожарный параметр принимает ПБ: М-040 ширина эвакуационного коридора; непожарный параметр АР — нет", () => {
    expect(disciplineFits(P("M-040"), "ПБ")).toBe(true);
    expect(disciplineFits(P("M-040"), "ИОС5")).toBe(false);
    expect(disciplineFits(P("M-059"), "ПБ")).toBe(false);
  });

  it("АР — источник для конструктивного параметра, но параметр АР не берёт значения из КР и КЖ (связь в одну сторону)", () => {
    expect(disciplineFits(P("M-059"), "АР")).toBe(true);
    expect(["КР", "КЖ"].map((d) => disciplineFits({ section: "АР", source_pd: "Планы (АР)", source_rd: "Кладочные планы (АР)" }, d))).toEqual([false, false]);
  });

  it("OS-INSP-2.2.4: источник по стадии — ПД из источника ПД Матрицы, РД из источника РД (М-002: ПД — ПЗ, РД — АР)", () => {
    const p = P("M-002");
    expect(["ПЗ", "АР"].map((d) => disciplineFits(p, d, "PD"))).toEqual([true, false]);
    expect(["ПЗ", "АР"].map((d) => disciplineFits(p, d, "RD"))).toEqual([false, true]);
    expect([...paramMarks(p, "PD")].sort()).toEqual(["ПЗ"]);
    expect([...paramMarks(p, "RD")].sort()).toEqual(["АР"]);
  });
  it("OS-INSP-2.2.4: М-059 — ПД из КР (и АР-разрезов), РД из КЖ; семейство КР/КЖ сохраняется на обеих стадиях", () => {
    const p = P("M-059");
    expect(["КР", "КЖ", "АР", "ВК"].map((d) => disciplineFits(p, d, "PD"))).toEqual([true, true, true, false]);
    expect(["КЖ", "КР", "ВК"].map((d) => disciplineFits(p, d, "RD"))).toEqual([true, true, false]);
  });
  it("OS-INSP-2.2.4: ИД без марки в источнике Матрицы (акты, паспорта) — не ограничивается; без стадии — прежнее правило по всем маркам", () => {
    expect(disciplineFits(P("M-059"), "КЖ", "ID")).toBe(true);
    expect(disciplineFits(P("M-059"), "ВК", "ID")).toBe(true);
    expect(disciplineFits(P("M-002"), "АР")).toBe(true);
  });
  it("OS-INSP-2.2.4: противопожарная и энергетическая добавки действуют на любой стадии", () => {
    expect(disciplineFits(P("M-040"), "ПБ", "PD")).toBe(true);
    expect(disciplineFits(P("M-021"), "ЭОМ", "RD")).toBe(true);
  });

  it("OS-INSP-2.2.4: сначала источник своей стадии; нет его — профильные разделы параметра (обкатка: М-008 высота 68,41 из АР, М-014 мощность из ИОС1)", () => {
    const r = (discipline: string) => ({ discipline });
    const d = (x: { discipline: string }) => x.discipline;
    // М-002: ПД есть в ПЗ — значение из АР не берётся
    expect(pickStageSources([r("АР"), r("ПЗ")], P("M-002"), "PD", d)).toEqual([r("ПЗ")]);
    // М-008: в ПЗ значения нет — берётся АР (профильный для параметра: источник РД)
    expect(pickStageSources([r("АР")], P("M-008"), "PD", d)).toEqual([r("АР")]);
    // М-014: ИОС1 — семейство ЭОМ (источник РД)
    expect(pickStageSources([r("ИОС1"), r("ИОС5")], P("M-014"), "PD", d)).toEqual([r("ИОС1")]);
    // М-059: чужие разделы не проходят ни в первом, ни во втором круге
    expect(pickStageSources([r("ЭЭ"), r("ВК")], P("M-059"), "PD", d)).toEqual([]);
  });

  it("марка неизвестна (старый разбор, файл без шифра) — значение не отбрасывается", () => {
    expect([null, undefined, "", "—"].map((d) => disciplineFits(P("M-059"), d))).toEqual([true, true, true, true]);
  });

  it("у каждого параметра Матрицы есть хотя бы одна марка — правило не выключает параметр целиком", () => {
    const empty = matrix.filter((p) => paramMarks(p).size === 0).map((p) => p.code);
    expect(empty).toEqual([]);
  });
});

describe("T-132: группы пожарной безопасности и энергоэффективности (e2e на синтетике)", () => {
  it("противопожарный параметр принимает всю группу ПБ — ППМ и МПБ тоже", () => {
    const p = { section: "АР", source_pd: "Планы этажей; Схемы путей эвакуации (АР)", source_rd: "Кладочные планы (АР)", parameter_name: "Ширина магистральных эвакуационных коридоров" };
    expect(disciplineFits(p, "ППМ")).toBe(true);
    expect(disciplineFits(p, "МПБ")).toBe(true);
    expect(disciplineFits(p, "ВК")).toBe(false);
  });
  it("класс энергоэффективности принимает раздел ЭЭ и ЭОМ, но не КЖ", () => {
    const p = { section: "ПЗ", source_pd: "Раздел ПЗ: Текст \"Энергоэффективность\"", source_rd: "Раздел АР/ОВ: Требования в \"Общих данных\"", parameter_name: "Класс энергетической эффективности" };
    expect(disciplineFits(p, "ЭЭ")).toBe(true);
    expect(disciplineFits(p, "ЭОМ")).toBe(true);
    expect(disciplineFits(p, "КЖ")).toBe(false);
  });
});

describe("правило марки: семейства, разбор источника и граничные случаи (мутационная полнота)", () => {
  const q = (section: string, pd: string | null = null, rd: string | null = null, extra: Record<string, unknown> = {}) => ({ section, source_pd: pd, source_rd: rd, ...extra });
  it("каждое семейство марок связывает ПД и РД в обе стороны", () => {
    const pairs: Array<[string, string]> = [["КР", "КМД"], ["КР", "КЖИ"], ["ИОС1", "ЭОМ"], ["ИОС1", "ЭМ"], ["ИОС1", "ЭС"], ["ИОС1", "ЭН"], ["ИОС1", "ЭО"], ["ИОС2", "ВК"], ["ИОС2", "НВК"], ["ИОС2", "В"],
      ["ИОС3", "К"], ["ИОС4", "ОВ"], ["ИОС4", "ОВК"], ["ИОС4", "ТМ"], ["ИОС4", "ИТП"], ["ИОС5", "СС"], ["ИОС5", "АПС"], ["ИОС5", "СОУЭ"], ["ИОС5", "СКС"], ["ИОС6", "ГСН"], ["ИОС7", "ТХ"],
      ["СПЗУ", "ГП"], ["СПЗУ", "ПП"], ["СПЗУ", "БП"], ["ПЗ", "ПБ"], ["ППМ", "МПБ"]];
    for (const [a, b] of pairs) {
      expect([a, b, disciplineFits(q(a), b)]).toEqual([a, b, true]);
      expect([b, a, disciplineFits(q(b), a)]).toEqual([b, a, true]);
    }
    expect(disciplineFits(q("ИОС2"), "ОВ")).toBe(false);
    expect(disciplineFits(q("ИОС6"), "ТХ")).toBe(false);
  });
  it("разбор марки: Ё как Е, латиница, цифры тома; строчные и пустые — не марки", () => {
    expect(["кж1", "ИОС", "ЁЖ", "AR2", " АР ", "1АР"].map(normMark)).toEqual(["КЖ", "ИОС", "ЕЖ", "AR", "АР", null]);
    expect([...paramMarks(q("АР", "Раздел АР/КР: общие данные", null))].sort()).toEqual(["АР", "КР"]);
    expect([...paramMarks(q("АР", "Планы (АР/ПП)", "раздел ов"))].sort()).toEqual(["АР", "ПП"]);
    expect([...paramMarks(q("ИОС4", "Спецификация (ИОС4.1)", "(ОВ2)"))].sort()).toEqual(["ИОС4", "ОВ"]);
    expect(paramMarks(q("АР", null, "(маркировка)"), "RD").size).toBe(0);
  });
  it("ИД с маркой в источнике Матрицы — ограничивается ею; РД без марки — все марки параметра", () => {
    const p = q("КР", "(КР)", null, { source_id: "Акты (КЖ)" });
    expect([disciplineFits(p, "КЖ", "ID"), disciplineFits(p, "ВК", "ID")]).toEqual([true, false]);
    expect([disciplineFits(p, "КР", "RD"), disciplineFits(p, "ВК", "RD")]).toEqual([true, false]);
    expect(disciplineFits(q("КР", "(КР)"), "ВК", "ID")).toBe(true);
  });
  it("АР — источник для КЖ-параметра (связь КЖ → АР); группа «ИОС» в источнике принимает любой ИОС, но не другое", () => {
    expect(disciplineFits(q("КЖ"), "АР")).toBe(true);
    expect(disciplineFits(q("АР"), "КЖ")).toBe(false);
    const ios = q("ППМ", "Расчёт (ППМ/ИОС)");
    expect([disciplineFits(ios, "ИОС3"), disciplineFits(ios, "ИОС5"), disciplineFits(ios, "АР")]).toEqual([true, true, false]);
  });
  it("противопожарная и энергетическая добавки — только по названию параметра", () => {
    expect(disciplineFits(q("АР", "(АР)", null, { parameter_name: "Ширина коридора" }), "ПБ")).toBe(false);
    expect(disciplineFits(q("АР", "(АР)", null, { parameter_name: "Пути эвакуации" }), "ПБ")).toBe(true);
    expect(disciplineFits(q("АР", "(АР)", null, { parameter_name: "Класс энергоэффективности" }), "ЭОМ")).toBe(true);
    expect(disciplineFits(q("АР", "(АР)"), "ЭОМ")).toBe(false);
  });
});
