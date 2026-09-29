// CMP-30 INTERNAL-CONS и CMP-31 CROSS-DISC (T-194) на синтетических фикстурах tests/fixtures/xdisc (не корпус).
// OS-INSP-3.1.133–3.1.139. L1 — функциональные, L2 — независимый пересчёт геометрии, L3 — границы допусков,
// L5 — свойства (fast-check), L6 — битый вход: громкий отказ.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import {
  agrees, crossing, fireWallsWithoutDamper, keyOf, ovRoomsMissingInAr, scheduleVsGeometry, specVsCount, tepVsExplication, toBld, unregistered, xdisc,
  XdiscGatesSchema, XInputSchema, type XInput, type XSheet,
} from "../src/domain/xdisc.ts";

const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/xdisc", f), "utf8"));
const GATES_RAW = JSON.parse(readFileSync(join(config.root, "data/seed/geom-gates.json"), "utf8")).xdisc;
const GATES = XdiscGatesSchema.parse(GATES_RAW);
const input = (f: string): XInput => XInputSchema.parse(fx(f));

describe("CMP-30 внутри стадии (OS-INSP-3.1.133–3.1.135)", () => {
  // прогон — внутри тестов, а не при сборе describe: иначе мутанты Stryker считаются статическими и не активируются
  const run = () => xdisc(fx("internal-cons.json"), GATES_RAW);
  const by = (check: string) => run().suspicions.filter((s) => s.check === check);

  it("спецификация против счёта знаков: ИП-1 — 4 шт и 3 знака; знак ВПВ-1 без позиции спецификации (MUT-14); ОП-1 согласован", () => {
    expect(by("spec_count").map((s) => s.key).sort()).toEqual(["ВПВ-1", "ИП-1"]);
    const ip = by("spec_count").find((s) => s.key === "ИП-1")!;
    expect(ip).toMatchObject({ op: "CMP-30", stage: "RD", status: "CLARIFICATION_REQUIRED", suspicion: true });
    expect(ip.description).toBe("Внутреннее противоречие: ИП-1 — в спецификации 4 шт (РД-ПС-С, стр. 2), на планах 3 знаков (РД-ПС-1, стр. 3)");
    expect(ip.sides).toEqual([
      { document_code: "РД-ПС-С", page: 2, bbox: [0.1, 0.5, 0.9, 0.52], value: "4 шт" },
      { document_code: "РД-ПС-1", page: 3, bbox: null, value: "3 знаков" },
    ]);
    expect(by("spec_count").find((s) => s.key === "ВПВ-1")!.description).toContain("в спецификации позиции нет, на планах 1 знаков");
    expect(by("spec_count").find((s) => s.key === "ВПВ-1")!.sides).toEqual([{ document_code: "РД-ПС-1", page: 3, bbox: null, value: "1 знаков" }]);
  });

  it("ТЭП против суммы экспликаций и экспликация против своего итога", () => {
    expect(by("tep_explication")).toHaveLength(1);
    expect(by("tep_explication")[0].description).toBe("Внутреннее противоречие: общая площадь по ТЭП 120,5 м² (РД-АР-ТЭП, стр. 1), по экспликациям 118 м² (РД-АР-1, стр. 5; РД-АР-2, стр. 6)");
    expect(by("explication_total").map((s) => s.description)).toEqual(["Внутреннее противоречие: сумма строк экспликации 58 м² не равна итогу 60 м² (РД-АР-2, стр. 6)"]);
  });

  it("ведомость проёмов против ширины по геометрии плана: Д2 — 1000 и 1200 мм; лист другой стадии не участвует", () => {
    expect(by("opening_width").map((s) => s.description)).toEqual(["Внутреннее противоречие: Д2 — по ведомости 1000 мм (РД-АР-ВП, стр. 12), по плану 1200 мм (РД-АР-1, стр. 4)"]);
  });

  it("каждая гипотеза атомарна и с устойчивым ключом дедупликации: повторный прогон даёт те же ключи", () => {
    const r = run();
    const again = run();
    expect(again.suspicions.map((s) => s.dedup_key)).toEqual(r.suspicions.map((s) => s.dedup_key));
    expect(new Set(r.suspicions.map((s) => s.dedup_key)).size).toBe(r.suspicions.length);
  });

  it("нет спецификации, ТЭП или ведомости — проверка пропущена с причиной, а не «расхождений нет»", () => {
    const empty = xdisc({ ...fx("internal-cons.json"), tables: { spec: [], tep: [], explications: [], schedule: [] } }, GATES_RAW);
    expect(empty.suspicions).toEqual([]);
    expect(empty.skipped).toEqual([
      { op: "CMP-30", check: "spec_count", why: "в стадии нет спецификации" },
      { op: "CMP-30", check: "tep_explication", why: "в стадии нет ТЭП с общей площадью" },
      { op: "CMP-30", check: "opening_width", why: "в стадии нет ведомости проёмов" },
    ]);
    const i = input("internal-cons.json");
    expect(specVsCount("RD", [i.sheets[1]], i.tables.spec, GATES.tol).skipped).toEqual([{ op: "CMP-30", check: "spec_count", why: "в стадии нет планов со знаками" }]); // план АР без знаков — не план со знаками
    expect(tepVsExplication("RD", { tep: i.tables.tep, explications: [] }, GATES.tol).skipped[0].why).toBe("в стадии нет экспликации помещений");
  });

  it("L3 · допуск площади ТЭП max(0,1 м²; 0,5 %): 118 и 118,59 согласны, 118 и 118,6 — нет", () => {
    const i = input("internal-cons.json");
    const tep = (value: number) => tepVsExplication("RD", { tep: [{ ...i.tables.tep[0], value }], explications: i.tables.explications.slice(0, 1).map((e) => ({ ...e, rows: [{ number: "1", area: 118 }], total: null })) }, GATES.tol);
    expect(tep(118.59).suspicions).toEqual([]);
    expect(tep(118.6).suspicions).toHaveLength(1);
    expect(agrees(0, 0, GATES.tol.spec_count)).toBe(true);
    expect(agrees(1, 0, GATES.tol.spec_count)).toBe(false);
  });

  it("L3 · ширина проёма, допуск max(20 мм, 2 %): 1000 и 1020 мм согласны, 1000 и 1021 — нет", () => {
    const i = input("internal-cons.json");
    const sh = (w: number): XSheet[] => [{ ...i.sheets[1], openings: [{ mark: "Д2", width_mm: w, bbox: null }] }];
    expect(scheduleVsGeometry("RD", sh(1020), [i.tables.schedule[1]], GATES.tol).suspicions).toEqual([]);
    expect(scheduleVsGeometry("RD", sh(1021), [i.tables.schedule[1]], GATES.tol).suspicions).toHaveLength(1);
  });

  it("марки сводятся: латиница-двойник и пробелы («B 2.7» = «В2.7»)", () => {
    expect(keyOf("B 2.7")).toBe(keyOf("В2.7"));
    expect(keyOf("ип-1")).toBe("ИП-1");
  });
});

describe("CMP-31 между разделами (OS-INSP-3.1.136–3.1.138)", () => {
  it("помещение 104 обслуживается в ОВ1, а на планах АР его нет; 101 есть в обоих — не гипотеза", () => {
    const r = xdisc(fx("cross-disc.json"), GATES_RAW);
    const rooms = r.suspicions.filter((s) => s.check === "room_missing_in_ar");
    expect(rooms.map((s) => s.key)).toEqual(["104"]);
    expect(rooms[0]).toMatchObject({ op: "CMP-31", status: "CLARIFICATION_REQUIRED", suspicion: true });
    expect(rooms[0].description).toBe("Между разделами: помещение 104 обслуживается в ОВ1 (РД-ОВ1-1, стр. 2), а на планах АР его нет (РД-АР-1, стр. 4)");
  });

  it("трасса П1 пересекает противопожарную стену без клапана; у В1 клапан в 200 мм; обычная стена не проверяется", () => {
    const r = xdisc(fx("cross-disc.json"), GATES_RAW);
    const walls = r.suspicions.filter((s) => s.check === "fire_wall_no_damper");
    expect(walls.map((s) => s.key)).toEqual(["П1 × стена 1 (2000; 5000)"]);
    expect(walls[0].description).toBe("Между разделами: трасса П1 (РД-ОВ1-1, стр. 2) пересекает противопожарную стену (РД-АР-1, стр. 4) в точке 2000; 5000 мм осей, клапана ближе 1000 мм нет");
    expect(walls[0].sides.map((s) => s.value)).toEqual(["трасса П1", "противопожарная стена"]);
    expect(r.skipped.filter((x) => x.op === "CMP-31")).toEqual([]);
  });

  it("L3 · клапан ровно на радиусе поиска снимает гипотезу, на 1 мм дальше — нет", () => {
    const i = input("cross-disc.json");
    const at = (dy_mm: number) => {
      const ov = structuredClone(i.sheets[1]);
      ov.routes = [{ ...ov.routes[0], nodes: [{ id: "d", kind: "fire_damper", mark: null, at: [20, 50 + dy_mm / 100] }] }];
      return fireWallsWithoutDamper("RD", [i.sheets[0], ov], GATES).suspicions.length;
    };
    expect(at(1000)).toBe(0);
    expect(at(1001)).toBe(1);
  });

  it("клапан — и знаком на листе ОВ, не только узлом трассы", () => {
    const i = input("cross-disc.json");
    const ov = structuredClone(i.sheets[1]);
    ov.symbols = [{ kind: "fire_damper", mark: "КПУ-2", at: [21, 50], bbox: null }];
    expect(fireWallsWithoutDamper("RD", [i.sheets[0], ov], GATES).suspicions).toEqual([]);
  });

  it("не зарегистрированный лист или лист без этажа — наложение не делается, проверка пропущена с причиной", () => {
    const r = xdisc(fx("unregistered.json"), GATES_RAW);
    expect(r.suspicions.filter((s) => s.check === "fire_wall_no_damper")).toEqual([]);
    expect(r.skipped.filter((s) => s.op === "CMP-31").map((s) => s.why)).toEqual(["РД-ОВ1-1, стр. 2: лист не зарегистрирован в осях здания", "РД-ОВ1-2, стр. 3: этаж листа не определён"]);
    expect(r.suspicions.map((s) => s.key)).toEqual(["104"]); // сравнение номеров помещений регистрации не требует
  });

  it("L3 · остаток регистрации ровно на допуске — наложение делается, на ε больше — пропуск", () => {
    const s = input("cross-disc.json").sheets[0];
    expect(unregistered({ ...s, frame: { ...s.frame, residual_mm: 50 } }, GATES)).toBeNull();
    expect(unregistered({ ...s, frame: { ...s.frame, residual_mm: 50.01 } }, GATES)).toContain("больше допуска 50 мм");
  });

  it("нет планов АР с помещениями — отсутствие помещения не доказать: пропуск, а не гипотеза", () => {
    const i = input("cross-disc.json");
    const r = ovRoomsMissingInAr("RD", [i.sheets[1]]);
    expect(r.suspicions).toEqual([]);
    expect(r.skipped[0].why).toContain("отсутствие не доказать");
    expect(fireWallsWithoutDamper("RD", [i.sheets[1]], GATES).skipped[0].why).toContain("нет планов АР с противопожарными стенами");
    expect(ovRoomsMissingInAr("RD", [i.sheets[0]])).toEqual({ suspicions: [], skipped: [] }); // нет ОВ — нечего проверять
  });

  it("L2 · пересечение и перевод в оси: независимый пересчёт на осевых отрезках", () => {
    expect(crossing([0, 0], [10, 0], [5, -5], [5, 5])).toEqual([5, 0]);
    expect(crossing([0, 0], [10, 0], [0, 1], [10, 1])).toBeNull(); // параллельны
    expect(crossing([0, 0], [4, 0], [5, -5], [5, 5])).toBeNull(); // не доходит
    expect(crossing([0, 0], [5, 0], [5, -5], [5, 5])).toEqual([5, 0]); // касание концом
    expect(toBld([100, 0, 0, 100, 0, 0], [20, 50])).toEqual([2000, 5000]);
    expect(toBld([0, 1, -1, 0, 10, 20], [3, 4])).toEqual([6, 23]); // поворот на 90° и сдвиг: x' = −y + 10, y' = x + 20
  });

  it("L5 · точка пересечения лежит на обоих отрезках", () => {
    const P = fc.tuple(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }));
    fc.assert(
      fc.property(P, P, P, P, (a, b, c, d) => {
        const x = crossing(a, b, c, d);
        if (!x) return;
        const on = (p: number[], q: number[]) => Math.abs(Math.hypot(x[0] - p[0], x[1] - p[1]) + Math.hypot(x[0] - q[0], x[1] - q[1]) - Math.hypot(q[0] - p[0], q[1] - p[1])) < 1e-6;
        expect(on(a, b) && on(c, d)).toBe(true);
      }),
    );
  });

  it("L5 · перестановка листов не меняет набор гипотез", () => {
    const raw = fx("cross-disc.json");
    const keys = (x: unknown) => xdisc(x, GATES_RAW).suspicions.map((s) => s.dedup_key).sort();
    expect(keys({ ...raw, sheets: [...raw.sheets].reverse() })).toEqual(keys(raw));
  });
});

describe("вход и настройки (OS-INSP-3.1.139)", () => {
  it("L6 · битый вход извлечения — громкий отказ, а не «расхождений нет»", () => {
    const raw = fx("cross-disc.json");
    expect(() => xdisc({ ...raw, stage: "XX" }, GATES_RAW)).toThrow();
    const noPts = structuredClone(raw);
    noPts.sheets[1].routes[0].points = [[20, 20]];
    expect(() => xdisc(noPts, GATES_RAW)).toThrow();
    const nan = structuredClone(raw);
    nan.sheets[0].walls[0].a = [Number.NaN, 0];
    expect(() => xdisc(nan, GATES_RAW)).toThrow();
    const noFire = structuredClone(raw);
    delete noFire.sheets[0].walls[0].fire;
    expect(() => xdisc(noFire, GATES_RAW)).toThrow();
    expect(() => xdisc({ stage: "RD", sheets: [] }, GATES_RAW)).toThrow();
  });

  it("L6 · настройки — данные: пропущенный допуск или лишнее поле отвергаются", () => {
    expect(() => xdisc(fx("cross-disc.json"), { ...GATES_RAW, damper_radius_mm: 0 })).toThrow();
    expect(() => xdisc(fx("cross-disc.json"), { ...GATES_RAW, radius: 1 })).toThrow();
    const { spec_count: _, ...tol } = GATES_RAW.tol;
    expect(() => xdisc(fx("cross-disc.json"), { ...GATES_RAW, tol })).toThrow();
  });

  it("листы другой стадии в сравнение не попадают", () => {
    const raw = fx("cross-disc.json");
    const r = xdisc({ ...raw, stage: "PD" }, GATES_RAW);
    expect(r.suspicions).toEqual([]);
    expect(r.skipped.filter((s) => s.op === "CMP-31")).toEqual([]); // в ПД нет ни ОВ, ни АР — нечего сверять
  });
});

describe("точные гипотезы, границы и крайние входы (добивка мутаций T-194)", () => {
  const sheet = (over: Partial<XSheet> = {}): XSheet => ({
    file_id: "F", document_code: "Л", stage: "RD", discipline: "АР", floor: "1", page: 1, frame: { to_bld: [100, 0, 0, 100, 0, 0], residual_mm: 10 },
    rooms: [], walls: [], routes: [], symbols: [], openings: [], ...over,
  });
  const src = (document_code: string, page: number) => ({ document_code, page, bbox: null });

  it("L1 · CMP-30 спецификация: стороны, ключ дедупликации, позиция без знаков, знак без марки, несколько строк и листов", () => {
    const ps1 = sheet({ document_code: "ПС-1", page: 3, symbols: [{ kind: "d", mark: "В2.7", at: [0, 0], bbox: null }, { kind: "d", mark: null, at: [1, 1], bbox: null }] });
    const ps2 = sheet({ document_code: "ПС-2", page: 4, symbols: [{ kind: "d", mark: "B2.7", at: [0, 0], bbox: null }] });
    const spec = [{ key: "B2.7", qty: 1, ...src("С", 2) }, { key: "В2.7", qty: 2, ...src("С", 5) }, { key: "ОП-2", qty: 1, ...src("С", 2) }];
    const r = specVsCount("RD", [ps1, ps2], spec, GATES.tol);
    expect(r.skipped).toEqual([]);
    expect(r.suspicions).toEqual([
      {
        op: "CMP-30", check: "spec_count", stage: "RD", key: "B2.7", status: "CLARIFICATION_REQUIRED", suspicion: true,
        description: "Внутреннее противоречие: B2.7 — в спецификации 3 шт (С, стр. 2; С, стр. 5), на планах 2 знаков (ПС-1, стр. 3; ПС-2, стр. 4)",
        sides: [
          { document_code: "С", page: 2, bbox: null, value: "1 шт" }, { document_code: "С", page: 5, bbox: null, value: "2 шт" },
          { document_code: "ПС-1", page: 3, bbox: null, value: "1 знаков" }, { document_code: "ПС-2", page: 4, bbox: null, value: "1 знаков" },
        ],
        dedup_key: "CMP-30:spec_count:RD:В2.7:ПС-1@3:1 знаков|ПС-2@4:1 знаков|С@2:1 шт|С@5:2 шт",
      },
      {
        op: "CMP-30", check: "spec_count", stage: "RD", key: "ОП-2", status: "CLARIFICATION_REQUIRED", suspicion: true,
        description: "Внутреннее противоречие: ОП-2 — в спецификации 1 шт (С, стр. 2), на планах знаков нет",
        sides: [{ document_code: "С", page: 2, bbox: null, value: "1 шт" }],
        dedup_key: "CMP-30:spec_count:RD:ОП-2:С@2:1 шт",
      },
    ]);
  });

  it("L1 · CMP-30 экспликация и ТЭП: стороны каждой экспликации, ключ без этажа", () => {
    const e1 = { floor: null, rows: [{ number: "1", area: 10 }, { number: "2", area: 5.5 }], total: 16, ...src("Э-1", 5) };
    const e2 = { floor: "2", rows: [{ number: "3", area: 4 }], total: 4, ...src("Э-2", 6) };
    const r = tepVsExplication("RD", { tep: [{ kind: "total_area", value: 30, ...src("ТЭП", 1) }], explications: [e1, e2] }, GATES.tol);
    expect(r.skipped).toEqual([]);
    expect(r.suspicions.map((x) => [x.key, x.sides])).toEqual([
      ["экспликация", [{ document_code: "Э-1", page: 5, bbox: null, value: "15,5 / 16 м²" }]],
      ["общая площадь", [{ document_code: "ТЭП", page: 1, bbox: null, value: "30 м²" }, { document_code: "Э-1", page: 5, bbox: null, value: "15,5 м²" }, { document_code: "Э-2", page: 6, bbox: null, value: "4 м²" }]],
    ]);
    expect(r.suspicions[0].description).toBe("Внутреннее противоречие: сумма строк экспликации 15,5 м² не равна итогу 16 м² (Э-1, стр. 5)");
    expect(r.suspicions.map((x) => `${x.op}:${x.check}`)).toEqual(["CMP-30:explication_total", "CMP-30:tep_explication"]);
    expect(tepVsExplication("RD", { tep: [], explications: [e2] }, GATES.tol).skipped).toEqual([{ op: "CMP-30", check: "tep_explication", why: "в стадии нет ТЭП с общей площадью" }]);
    expect(tepVsExplication("RD", { tep: [{ kind: "total_area", value: 4, ...src("ТЭП", 1) }], explications: [] }, GATES.tol).skipped).toEqual([{ op: "CMP-30", check: "tep_explication", why: "в стадии нет экспликации помещений" }]);
  });

  it("L1 · CMP-30 проёмы: стороны ведомости и листов; проём без измеренной ширины и чужая марка не сверяются", () => {
    const a = sheet({ document_code: "АР-1", page: 4, openings: [{ mark: "Д2", width_mm: 1200, bbox: [0.1, 0.1, 0.2, 0.2] }, { mark: "Д2", width_mm: null, bbox: null }, { mark: "Д3", width_mm: 500, bbox: null }] });
    const b = sheet({ document_code: "АР-2", page: 5, openings: [{ mark: "д2", width_mm: 1300, bbox: null }] });
    const r = scheduleVsGeometry("RD", [a, b], [{ mark: "Д2", width_mm: 1000, ...src("ВП", 12) }], GATES.tol);
    expect(r.suspicions).toHaveLength(1);
    expect(r.suspicions[0]).toMatchObject({ op: "CMP-30", check: "opening_width", key: "Д2", status: "CLARIFICATION_REQUIRED", suspicion: true });
    expect(r.suspicions[0].description).toBe("Внутреннее противоречие: Д2 — по ведомости 1000 мм (ВП, стр. 12), по плану 1200 мм (АР-1, стр. 4); 1300 мм (АР-2, стр. 5)");
    expect(r.suspicions[0].sides).toEqual([
      { document_code: "ВП", page: 12, bbox: null, value: "1000 мм" },
      { document_code: "АР-1", page: 4, bbox: [0.1, 0.1, 0.2, 0.2], value: "1200 мм" },
      { document_code: "АР-2", page: 5, bbox: null, value: "1300 мм" },
    ]);
    expect(scheduleVsGeometry("RD", [sheet({ openings: [{ mark: "Д2", width_mm: null, bbox: null }] })], [{ mark: "Д2", width_mm: 1000, ...src("ВП", 12) }], GATES.tol).suspicions).toEqual([]);
  });

  it("L1 · CMP-31 помещения: стороны, повтор помещения на двух листах ОВ — одна гипотеза, несколько листов АР", () => {
    const ar1 = sheet({ document_code: "АР-1", page: 1, rooms: [{ number: "101", bbox: null }] });
    const ar2 = sheet({ document_code: "АР-2", page: 2, rooms: [] });
    const ov1 = sheet({ document_code: "ОВ-1", page: 3, discipline: "ОВ2", rooms: [{ number: "101", bbox: null }, { number: "105", bbox: [0.1, 0.1, 0.2, 0.2] }] });
    const ov2 = sheet({ document_code: "ОВ-2", page: 4, discipline: "ОВ2", rooms: [{ number: "105", bbox: null }] });
    const r = ovRoomsMissingInAr("RD", [ar1, ar2, ov1, ov2]);
    expect(r.suspicions).toHaveLength(1);
    expect(r.suspicions[0].description).toBe("Между разделами: помещение 105 обслуживается в ОВ2 (ОВ-1, стр. 3; ОВ-2, стр. 4), а на планах АР его нет (АР-1, стр. 1; АР-2, стр. 2)");
    expect(r.suspicions[0].sides).toEqual([{ document_code: "ОВ-1", page: 3, bbox: [0.1, 0.1, 0.2, 0.2], value: "пом. 105" }, { document_code: "ОВ-2", page: 4, bbox: null, value: "пом. 105" }]);
    // АР есть, но без помещений — отсутствие не доказать
    expect(ovRoomsMissingInAr("RD", [ar2, ov1]).skipped).toEqual([{ op: "CMP-31", check: "room_missing_in_ar", why: "в стадии нет планов АР с помещениями — отсутствие не доказать" }]);
    expect(ovRoomsMissingInAr("RD", [ov1]).skipped).toHaveLength(1);
  });

  it("L1 · CMP-31 стены: другой этаж, не зарегистрированный АР, не-ОВ трасса, узел не-клапан, трасса мимо стены", () => {
    const fire = { a: [0, 50] as [number, number], b: [100, 50] as [number, number], fire: true, bbox: null };
    const ar = sheet({ document_code: "АР-1", page: 1, walls: [fire] });
    const route = (system: string, x: number, nodes: XSheet["routes"][number]["nodes"] = []) => ({ system, points: [[x, 20], [x, 80]] as [number, number][], nodes, bbox: null });
    const ov = (over: Partial<XSheet> = {}) => sheet({ document_code: "ОВ-1", page: 2, discipline: "ОВ1", routes: [route("П1", 20)], ...over });
    const n = (o: XSheet, a: XSheet = ar) => fireWallsWithoutDamper("RD", [a, o], GATES);
    expect(n(ov()).suspicions).toEqual([expect.objectContaining({ op: "CMP-31", check: "fire_wall_no_damper", stage: "RD", status: "CLARIFICATION_REQUIRED", suspicion: true })]);
    expect(n(ov({ floor: "2" })).suspicions).toEqual([]);
    const arBad = sheet({ ...ar, frame: { to_bld: null, residual_mm: null } });
    expect(n(ov(), arBad)).toEqual({ suspicions: [], skipped: [{ op: "CMP-31", check: "fire_wall_no_damper", why: "АР-1, стр. 1: лист не зарегистрирован в осях здания" }] });
    expect(n(ov({ discipline: "ВК" }))).toEqual({ suspicions: [], skipped: [] });
    expect(n(ov({ routes: [route("П1", 20, [{ id: "f", kind: "fan", mark: null, at: [20, 50] }])] })).suspicions).toHaveLength(1);
    expect(n(ov({ routes: [{ system: "П3", points: [[20, 60], [20, 80], [40, 80]], nodes: [], bbox: null }] })).suspicions).toEqual([]);
    // АР только с обычными стенами — проверка пропущена; ОВ без трасс — проверять нечего
    const plain = sheet({ ...ar, walls: [{ ...fire, fire: false }] });
    expect(n(ov(), plain).skipped).toEqual([{ op: "CMP-31", check: "fire_wall_no_damper", why: "в стадии нет планов АР с противопожарными стенами" }]);
    expect(fireWallsWithoutDamper("RD", [sheet({ discipline: "ОВ1" })], GATES)).toEqual({ suspicions: [], skipped: [] });
  });

  it("L3 · регистрация листа: нет матрицы при известном остатке, нет остатка при матрице, остаток ровно «допуск + 1e-9»", () => {
    const s = sheet({ document_code: "Л", page: 1 });
    expect(unregistered({ ...s, frame: { to_bld: null, residual_mm: 5 } }, GATES)).toBe("Л, стр. 1: лист не зарегистрирован в осях здания");
    expect(unregistered({ ...s, frame: { to_bld: [1, 0, 0, 1, 0, 0], residual_mm: null } }, GATES)).toBe("Л, стр. 1: лист не зарегистрирован в осях здания");
    expect(unregistered({ ...s, frame: { to_bld: [1, 0, 0, 1, 0, 0], residual_mm: 50 + 1e-9 } }, GATES)).toBeNull();
    expect(unregistered({ ...s, frame: { to_bld: [1, 0, 0, 1, 0, 0], residual_mm: 60.25 } }, GATES)).toBe("Л, стр. 1: остаток регистрации 60,25 мм больше допуска 50 мм");
  });

  it("L3 · пересечение на концах обоих отрезков и чуть за концом; наложенные коллинеарные — не пересечение", () => {
    expect(crossing([5, 0], [10, 0], [5, -5], [5, 5])).toEqual([5, 0]); // t = 0
    expect(crossing([0, 0], [10, 0], [5, 0], [5, 5])).toEqual([5, 0]); // u = 0
    expect(crossing([0, 0], [10, 0], [5, -5], [5, 0])).toEqual([5, 0]); // u = 1
    expect(crossing([0, 0], [10, 0], [5, 1e-6], [5, 5])).toBeNull(); // u чуть < 0
    expect(crossing([0, 0], [10, 0], [5, -5], [5, -1e-6])).toBeNull(); // u чуть > 1
    expect(crossing([5 + 1e-6, 0], [10, 0], [5, -5], [5, 5])).toBeNull(); // t чуть < 0
    expect(crossing([0, 0], [10, 0], [2, 0], [8, 0])).toBeNull(); // коллинеарны: 0/0 не превращается в точку
  });
});
