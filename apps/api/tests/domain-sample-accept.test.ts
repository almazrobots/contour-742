// OS-INSP-4.1.8–4.1.11 (кандидаты T-110, карта сценариев SC-04, ноу-хау Н2): совпадения выборкой.
// Системные «расхождения нет» принимаются партией после случайной выборки; признание расхождения партией — никогда.
import { describe, expect, it } from "vitest";
import { acceptOutcome, drawSample, samplePool, upperBound, type PoolCheck } from "../src/domain/sample-accept.ts";

const chk = (id: string, o: Partial<PoolCheck> = {}): PoolCheck => ({
  id, param_code: `M-${id}`, finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", review_priority: "MEDIUM", file_id: `f${Number(id) % 3}`, ...o,
});

describe("партия: только то, что система и так вправе поставить сама", () => {
  it("берёт системные «расхождения нет» без решения человека", () => {
    const pool = samplePool([chk("1"), chk("2")]);
    expect(pool.map((c) => c.id)).toEqual(["1", "2"]);
  });
  it("не берёт кандидатов, признанное и уже решённое человеком", () => {
    const pool = samplePool([
      chk("1", { finding_status: "CANDIDATE" }),
      chk("2", { finding_status: "CONFIRMED_VIOLATION" }),
      chk("3", { verification_status: "NEGATIVE_VERIFIED" }),
      chk("4"),
    ]);
    expect(pool.map((c) => c.id)).toEqual(["4"]);
  });
  it("не берёт критичные параметры — их инспектор смотрит по одному", () => {
    expect(samplePool([chk("1", { review_priority: "HIGH" }), chk("2")]).map((c) => c.id)).toEqual(["2"]);
  });
  it("не берёт значения, распознанные с уверенностью ниже 0,7 — их смотрят по одному", () => {
    expect(samplePool([chk("1", { min_confidence: 0.55 }), chk("2", { min_confidence: 0.92 }), chk("3", { min_confidence: null })]).map((c) => c.id)).toEqual(["2", "3"]);
  });
  it("порог 0,7 включительно", () => {
    expect(samplePool([chk("1", { min_confidence: 0.7 })]).map((c) => c.id)).toEqual(["1"]);
  });
  it("не берёт неприменимое и несопоставимое — это не «расхождения нет»", () => {
    expect(samplePool([chk("1", { finding_status: "NOT_APPLICABLE" }), chk("2", { finding_status: "NOT_COMPARABLE" })])).toEqual([]);
  });
});

describe("выборка: случайная, воспроизводимая по seed, по файлам вперемешку", () => {
  const pool = Array.from({ length: 60 }, (_, i) => chk(String(i + 1)));
  it("один seed — одна и та же выборка", () => {
    expect(drawSample(pool, 30, 7319).map((c) => c.id)).toEqual(drawSample(pool, 30, 7319).map((c) => c.id));
  });
  it("другой seed — другая выборка", () => {
    expect(drawSample(pool, 30, 1).map((c) => c.id)).not.toEqual(drawSample(pool, 30, 2).map((c) => c.id));
  });
  it("без повторов и ровно k", () => {
    const s = drawSample(pool, 30, 5);
    expect(s).toHaveLength(30);
    expect(new Set(s.map((c) => c.id)).size).toBe(30);
  });
  it("страты по файлу: каждый файл партии представлен", () => {
    const s = drawSample(pool, 6, 11);
    expect(new Set(s.map((c) => c.file_id))).toEqual(new Set(["f0", "f1", "f2"]));
  });
  it("k меньше числа файлов — ровно k, не больше", () => {
    expect(drawSample(pool, 2, 9)).toHaveLength(2);
    expect(drawSample(pool, 4, 9)).toHaveLength(4);
  });
  it("порядок записей на входе не влияет на выборку", () => {
    expect(drawSample([...pool].reverse(), 10, 42).map((c) => c.id)).toEqual(drawSample(pool, 10, 42).map((c) => c.id));
  });
  it("выборка из одного элемента и из пустой партии", () => {
    expect(drawSample(pool.slice(0, 1), 30, 1).map((c) => c.id)).toEqual(["1"]);
    expect(drawSample([], 30, 1)).toEqual([]);
  });
  it("перетасовка честная: из двух записей первой выпадает любая, в зависимости от seed", () => {
    const two = [chk("1", { file_id: "f" }), chk("2", { file_id: "f" })];
    const first = new Set(Array.from({ length: 40 }, (_, s) => drawSample(two, 1, s + 1)[0].id));
    expect(first).toEqual(new Set(["1", "2"]));
  });
  it("k равно числу файлов — по одной записи из каждого файла при любом seed", () => {
    for (let s = 1; s <= 8; s++) expect(new Set(drawSample(pool, 3, s).map((c) => c.file_id)).size).toBe(3);
  });
  it("партия меньше k — смотреть всю партию", () => {
    expect(drawSample(pool.slice(0, 8), 30, 3)).toHaveLength(8);
  });
});

describe("граница доли ошибок (правило трёх, точная формула при 0 ошибок)", () => {
  it("30 чистых карточек — не больше 10 % с уверенностью 95 %", () => {
    expect(upperBound(30)).toBeCloseTo(0.0950, 4);
  });
  it("5 чистых карточек — граница 45 %: это не гарантия", () => {
    expect(upperBound(5)).toBeCloseTo(0.4507, 3);
  });
  it("больше карточек — граница строже", () => {
    expect(upperBound(60)).toBeLessThan(upperBound(30));
  });
  it("ноль просмотренных — границы нет", () => {
    expect(upperBound(0)).toBe(1);
    expect(upperBound(-1)).toBe(1);
  });
});

describe("исход приёмки", () => {
  const sample = ["1", "2", "3"];
  it("все просмотрены, ошибок нет — партия принимается с границей", () => {
    const o = acceptOutcome({ poolSize: 50, sample, reviewed: sample, errors: [] });
    expect(o).toEqual({ kind: "ACCEPTED", accepted: 50, bound: upperBound(3) });
  });
  it("хоть одна ошибка — партия распадается в очередь, ничего не принимается", () => {
    expect(acceptOutcome({ poolSize: 50, sample, reviewed: sample, errors: ["2"] })).toEqual({ kind: "BROKEN", errors: ["2"] });
  });
  it("не вся выборка просмотрена — принять нельзя, называем сколько осталось", () => {
    expect(acceptOutcome({ poolSize: 50, sample, reviewed: ["1"], errors: [] })).toEqual({ kind: "INCOMPLETE", left: 2 });
  });
  it("просмотр карточки не из выборки не засчитывается", () => {
    expect(acceptOutcome({ poolSize: 50, sample, reviewed: ["1", "2", "99"], errors: [] })).toEqual({ kind: "INCOMPLETE", left: 1 });
  });
  it("ошибка в карточке не из выборки — отказ, а не тихий пропуск", () => {
    expect(acceptOutcome({ poolSize: 50, sample, reviewed: sample, errors: ["99"] })).toEqual({ kind: "INVALID", reason: "Ошибка отмечена в записи вне выборки: 99" });
  });
});
