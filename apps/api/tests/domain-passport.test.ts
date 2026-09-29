// Эшелоны: L1 (таблица метрик единого вида, спецификация экстрактора), L3 (границы: пустые стадии, нет проверок, null),
// L8 (дыры, найденные мутациями Stryker, T-129). Правила OS-INSP-7.1.4, 2.2.13, 3.1.11, 6.5.9.
import { describe, expect, it } from "vitest";
import { disciplineKey, extractorSpec, metricRows, sameValue, type MetricInput } from "../src/domain/passport.ts";
import { passports } from "../src/services/passports.ts";

// паспорта — через тот же загрузчик, что и сервис (корень репозитория из config): работает и в песочнице Stryker
const { common } = passports();
const m023 = passports().byCode.get("M-023")!;

const base: MetricInput = {
  checks: 4,
  statuses: { NEGATIVE_VERIFIED: 1, CANDIDATE: 3 },
  decisions: { PENDING: 1, CONFIRMED_VIOLATION: 2, SOMETHING_NEW: 5 },
  coverage: { PD: { used: 3, loaded: 4 }, RD: { used: 2, loaded: 2 }, ID: { used: 0, loaded: 0 } },
  confidence: 0.876,
  verification: { verdict: "MATCH", object_id: "ALT-79B", checked_at: "2026-09-27T03:54:08.234Z" },
};
const byKey = (x: MetricInput) => Object.fromEntries(metricRows(common, x).map((r) => [r.key, r]));

describe("таблица метрик единого вида (OS-INSP-7.1.4)", () => {
  it("строки — ровно метрики общего паспорта и в его порядке; у метрики без разбивки нет rows", () => {
    const rows = metricRows(common, base);
    expect(rows.map((r) => r.key)).toEqual(common.metrics.map((m) => m.key));
    expect(rows[0]).toEqual({ key: "checks", title: common.metrics[0].title, how: common.metrics[0].how, value: "4" });
  });
  it("статусы и решения — по убыванию числа, словами; неизвестный код — как есть", () => {
    const r = byKey(base);
    expect(r.statuses.rows).toEqual([{ label: common.statuses.CANDIDATE, value: "3" }, { label: common.statuses.NEGATIVE_VERIFIED, value: "1" }]);
    expect(r.decisions.rows).toEqual([{ label: "SOMETHING_NEW", value: "5" }, { label: "подтверждено инспектором", value: "2" }, { label: "ждёт решения", value: "1" }]);
    expect([r.statuses.value, r.decisions.value]).toEqual(["", ""]);
  });
  it("нет проверок — прочерк у статусов и решений", () => {
    const r = byKey({ ...base, checks: 0, statuses: {}, decisions: {} });
    expect([r.checks.value, r.statuses.value, r.decisions.value]).toEqual(["0", "—", "—"]);
  });
  it("охват стадий: доля в процентах с числами; незагруженная стадия — словами", () => {
    expect(byKey(base).coverage.rows).toEqual([
      { label: "ПД", value: "75 % (3 из 4)" },
      { label: "РД", value: "100 % (2 из 2)" },
      { label: "ИД", value: "стадия не загружалась" },
    ]);
    expect(byKey({ ...base, coverage: { ...base.coverage, PD: { used: 1, loaded: 3 } } }).coverage.rows![0].value).toBe("33 % (1 из 3)");
  });
  it("уверенность — два знака с запятой; нет — прочерк", () => {
    expect(byKey(base).confidence.value).toBe("0,88");
    expect(byKey({ ...base, confidence: null }).confidence.value).toBe("—");
  });
  it("верификация: итог словами, объект и дата; не было — «не проводилась»", () => {
    expect(byKey(base).verification.value).toBe("совпало · ALT-79B · 2026-09-27");
    expect(byKey({ ...base, verification: { ...base.verification!, verdict: "MISMATCH", object_id: null } }).verification.value).toBe("расхождение · — · 2026-09-27");
    expect(byKey({ ...base, verification: null }).verification.value).toBe("не проводилась");
  });
  it("метрика общего паспорта, которую код не считает, — прочерк без разбивки (а не падение)", () => {
    const extra = { ...common, metrics: [...common.metrics, { key: "future", title: "Будущая", how: "позже" }] };
    const r = metricRows(extra as typeof common, base).at(-1)!;
    expect(r).toEqual({ key: "future", title: "Будущая", how: "позже", value: "—" });
  });
});

describe("экстрактор и раздел документа (OS-INSP-2.2.13, 3.1.11)", () => {
  it("спецификация экстрактора М-023: поля паспорта + шкала и маркеры «не ниже»", () => {
    const spec = extractorSpec(m023);
    expect(m023.value.kind).toBe("ordinal");
    const markers = m023.value.kind === "ordinal" ? m023.value.constraint_markers : [];
    expect(spec).toMatchObject({ ...m023.extractor, scale: ["С3", "С2", "С1", "С0"], constraint_markers: markers });
    expect((spec.constraint_markers as string[]).length).toBeGreaterThan(0);
  });
  it("раздел — буквенная часть марки с начала строки, без пробелов и регистра", () => {
    expect(disciplineKey("  ар1 ")).toBe("АР");
    expect(disciplineKey("ИОС5.4")).toBe("ИОС");
    expect(disciplineKey("1АР")).toBeNull();
    expect(disciplineKey("")).toBeNull();
    expect(disciplineKey(null)).toBeNull();
    expect(disciplineKey(undefined)).toBeNull();
  });
  it("совпадение значений: несколько пробелов подряд — как один", () => {
    expect(sameValue("не  ниже   С0", "не ниже С0")).toBe(true);
  });
});
