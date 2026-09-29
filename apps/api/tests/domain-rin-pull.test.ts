// OS-INSP-1.2.15–1.2.19: чистые решения автозабора из ИАИС «РиН» — все ветви и границы.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { advanceCursor, BENIGN_CODES, checkDownloaded, classifyHttp, FINAL_STATUSES, packageOutcome, pickNew, planPackage, RETRYABLE_CODES, type Plan } from "../src/domain/rin-pull.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("pickNew — пакет забирается один раз (OS-INSP-1.2.16)", () => {
  it("OS-INSP-1.2.16: завершённые и повторы внутри ответа отбрасываются, порядок сохраняется", () => {
    const listed = [{ package_id: "A" }, { package_id: "B" }, { package_id: "A" }, { package_id: "C" }, { package_id: "B" }];
    expect(pickNew(listed, new Set(["C"])).map((p) => p.package_id)).toEqual(["A", "B"]);
  });
  it("пустой ответ и всё уже забрано — пусто; первый из повторов побеждает", () => {
    expect(pickNew([], new Set())).toEqual([]);
    expect(pickNew([{ package_id: "A" }], new Set(["A"]))).toEqual([]);
    const first = { package_id: "X", n: 1 };
    expect(pickNew([first, { package_id: "X", n: 2 }], new Set())).toEqual([first]);
  });
  it("завершённые статусы — FETCHED, NOTIFIED_ONLY, REJECTED; PENDING не завершён", () => {
    expect([...FINAL_STATUSES].sort()).toEqual(["FETCHED", "NOTIFIED_ONLY", "REJECTED"]);
    expect(FINAL_STATUSES).not.toContain("PENDING");
  });
});

describe("planPackage — что делать по статусу проверки объекта", () => {
  it("OS-INSP-1.2.15: проверки по объекту нет — новая проверка", () => {
    expect(planPackage(null)).toEqual({ action: "CREATE" });
  });
  it("OS-INSP-1.2.17: протокол финализирован — только уведомление", () => {
    expect(planPackage({ id: "P-1", status: "FINALIZED" })).toEqual({ action: "NOTIFY_ONLY", inspection_id: "P-1" });
  });
  it("открытая проверка в любом статусе приёма — дозагрузка; в разборе — отложить", () => {
    for (const status of ["PENDING", "READY", "VERIFYING", "COMPLETED"] as const) expect(planPackage({ id: "P-2", status })).toEqual({ action: "APPEND", inspection_id: "P-2" });
    const d = planPackage({ id: "P-3", status: "PARSING" });
    expect(d.action).toBe("DEFER");
    expect(d).toMatchObject({ inspection_id: "P-3" });
    expect((d as any).reason).toContain("в разборе");
  });
});

describe("advanceCursor — курсор не сдвигается через незавершённый пакет (OS-INSP-1.2.18)", () => {
  const t = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00.000Z`;
  it("OS-INSP-1.2.18: сбой пакета держит курсор на последнем завершённом перед ним", () => {
    expect(advanceCursor(null, [{ created_at: t(3), settled: true }, { created_at: t(1), settled: true }, { created_at: t(2), settled: false }])).toBe(t(1));
  });
  it("все завершены — курсор на самом позднем; первый же незавершён — курсор на месте", () => {
    expect(advanceCursor(t(0), [{ created_at: t(2), settled: true }, { created_at: t(5), settled: true }])).toBe(t(5));
    expect(advanceCursor(t(0), [{ created_at: t(1), settled: false }, { created_at: t(5), settled: true }])).toBe(t(0));
    expect(advanceCursor(null, [{ created_at: t(1), settled: false }])).toBeNull();
    expect(advanceCursor(null, [])).toBeNull();
    expect(advanceCursor(t(4), [])).toBe(t(4));
  });
  it("назад курсор не уходит; равное время не мешает", () => {
    expect(advanceCursor(t(9), [{ created_at: t(2), settled: true }])).toBe(t(9));
    expect(advanceCursor(t(2), [{ created_at: t(2), settled: true }, { created_at: t(2), settled: true }])).toBe(t(2));
    expect(advanceCursor(null, [{ created_at: t(2), settled: true }, { created_at: t(2), settled: false }, { created_at: t(3), settled: true }])).toBe(t(2));
  });
});

describe("classifyHttp — недоступность «РиН» против отказа по пакету", () => {
  it("2xx — успех; 5xx, 408, 429 — повтор в следующем цикле; прочие 4xx и 1xx/3xx — отказ", () => {
    expect([200, 204, 299].map(classifyHttp)).toEqual(["ok", "ok", "ok"]);
    expect([500, 503, 599, 408, 429].map(classifyHttp)).toEqual(["retry", "retry", "retry", "retry", "retry"]);
    expect([199, 300, 302, 400, 401, 403, 404, 499].map(classifyHttp)).toEqual(["fail", "fail", "fail", "fail", "fail", "fail", "fail", "fail"]);
  });
});

describe("checkDownloaded — сверка скачанного с заявленным (OS-INSP-1.2.19)", () => {
  const buf = Buffer.from("%PDF-1.4 синтетика %%EOF");
  it("совпадают размер и SHA-256 (регистр hex не важен) — ok", () => {
    expect(checkDownloaded({ file_name: "a.pdf", sha256: sha(buf), size: buf.length }, buf)).toEqual({ ok: true });
    expect(checkDownloaded({ file_name: "a.pdf", sha256: sha(buf).toUpperCase(), size: buf.length }, buf)).toEqual({ ok: true });
  });
  it("OS-INSP-1.2.19: SHA-256 не совпал — HASH_MISMATCH; размер не совпал — SIZE_MISMATCH", () => {
    const h = checkDownloaded({ file_name: "a.pdf", sha256: "0".repeat(64), size: buf.length }, buf);
    expect(h).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect((h as any).message).toContain("a.pdf");
    expect(checkDownloaded({ file_name: "a.pdf", sha256: sha(buf), size: buf.length + 1 }, buf)).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
    expect(checkDownloaded({ file_name: "a.pdf", sha256: sha(buf), size: buf.length - 1 }, buf)).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
  });
});

describe("packageOutcome — итоговый статус пакета", () => {
  const create: Plan = { action: "CREATE" };
  const r = (code: string, file_name = "f.pdf") => ({ file_name, code, message: `${file_name}: ${code}` });
  it("OS-INSP-1.2.19: любой отказ правил приёма — REJECTED с причиной по каждому файлу", () => {
    const o = packageOutcome(create, [r("UNSUPPORTED_FORMAT", "a.txt"), r("DUPLICATE", "b.pdf"), r("HASH_MISMATCH", "c.pdf")]);
    expect(o.status).toBe("REJECTED");
    expect(o.reason).toContain("UNSUPPORTED_FORMAT: a.txt");
    expect(o.reason).toContain("HASH_MISMATCH: c.pdf");
    expect(o.reason).not.toContain("DUPLICATE");
  });
  it("OS-INSP-1.2.17: план «только уведомление» — NOTIFIED_ONLY с номером проверки", () => {
    expect(packageOutcome({ action: "NOTIFY_ONLY", inspection_id: "P-9" }, [r("INFECTED")])).toEqual({ status: "NOTIFIED_ONLY", reason: expect.stringContaining("P-9") });
  });
  it("отложенный план и недоступный сканер — PENDING (повтор); заражение перевешивает недоступность сканера", () => {
    expect(packageOutcome({ action: "DEFER", inspection_id: "P-1", reason: "в разборе" }, [])).toEqual({ status: "PENDING", reason: "в разборе" });
    expect(packageOutcome(create, [r("SCAN_UNAVAILABLE")])).toEqual({ status: "PENDING", reason: "f.pdf: SCAN_UNAVAILABLE" });
    expect(packageOutcome(create, [r("SCAN_UNAVAILABLE"), r("INFECTED", "x.pdf")]).status).toBe("REJECTED");
  });
  it("без отказов или только повторы уже принятого — FETCHED без причины", () => {
    expect(packageOutcome(create, [])).toEqual({ status: "FETCHED", reason: null });
    expect(packageOutcome({ action: "APPEND", inspection_id: "P-2" }, [r("DUPLICATE")])).toEqual({ status: "FETCHED", reason: null });
    expect(BENIGN_CODES.has("DUPLICATE") && RETRYABLE_CODES.has("SCAN_UNAVAILABLE")).toBe(true);
  });
  it("длинная причина обрезается до 1000 символов с многоточием; ровно 1000 — без обрезки", () => {
    const long = packageOutcome(create, Array.from({ length: 100 }, (_, i) => r("CORRUPTED", `file-${i}.pdf`)));
    expect(long.reason!.length).toBe(1000);
    expect(long.reason!.endsWith("…")).toBe(true);
    const exact = { file_name: "x", code: "C", message: "m".repeat(1000 - "C: ".length) };
    expect(packageOutcome(create, [exact]).reason).toBe(`C: ${exact.message}`);
    const over = { ...exact, message: exact.message + "m" };
    expect(packageOutcome(create, [over]).reason!.endsWith("…")).toBe(true);
  });
});

// Контракт «РиН» (services/rin-contract.ts) — чистые функции: схема, маппер, адреса. Допущение до T-067.
describe("контракт «РиН»: схема ответа, маппер, адреса (допущение до T-067)", async () => {
  const { packagesUrl, parsePackages, resolveFileUrl, toWire } = await import("../src/services/rin-contract.ts");
  const BASE = "http://rin.test/rin";
  const H = "a".repeat(64);
  const file = (o: Record<string, unknown> = {}) => ({ file_id: "F1", file_name: "a.pdf", sha256: H, size: 10, url: "files/F1", ...o });
  const wire = (o: Record<string, unknown> = {}) => ({ package_id: "P1", object_id: "O1", object: { name: "Объект" }, created_at: "2026-09-25T13:00:00+03:00", manifest: null, files: [file()], ...o });

  it("адрес списка: база со слешем и без даёт один адрес; since кодируется", () => {
    expect(packagesUrl(BASE, null)).toBe("http://rin.test/rin/api/v1/packages");
    expect(packagesUrl(BASE + "/", null)).toBe("http://rin.test/rin/api/v1/packages");
    expect(packagesUrl(BASE, "2026-09-25T10:00:00.000Z")).toBe("http://rin.test/rin/api/v1/packages?since=2026-09-25T10%3A00%3A00.000Z");
  });

  it("адрес файла: относительный — от базы «РиН» (ведущие слеши срезаются, «//хост» не уводит на чужой хост); чужой origin и битый адрес — null", () => {
    expect(resolveFileUrl("files/F1", BASE)).toBe("http://rin.test/rin/files/F1");
    expect(resolveFileUrl("/files/F1", BASE)).toBe("http://rin.test/rin/files/F1");
    expect(resolveFileUrl("//evil.test/x", BASE)).toBe("http://rin.test/rin/evil.test/x");
    expect(resolveFileUrl("http://rin.test/other/x", BASE)).toBe("http://rin.test/other/x");
    expect(resolveFileUrl("http://evil.test/x", BASE)).toBeNull();
    expect(resolveFileUrl("https://rin.test/rin/x", BASE)).toBeNull(); // другая схема — другой origin
    expect(resolveFileUrl("http://[::1", BASE)).toBeNull();
  });

  it("маппер: время приводится к UTC ISO, SHA-256 — к нижнему регистру, пустые поля карточки — пустые строки, заданные — сохраняются", () => {
    const full = { name: "Объект", address: "Адрес", customer: "Заказчик", contractor: "Подрядчик", permit_number: "77-1", profile: { gas: true } };
    const { packages, invalid } = parsePackages([wire({ files: [file({ sha256: "A".repeat(64), url: "/files/F1" })] }), wire({ package_id: "P2", object: full })], BASE);
    expect(invalid).toEqual([]);
    expect(packages[0]).toMatchObject({ package_id: "P1", object_id: "O1", created_at: "2026-09-25T10:00:00.000Z", manifest: null });
    expect(packages[0].files[0]).toEqual({ file_id: "F1", file_name: "a.pdf", sha256: "a".repeat(64), size: 10, url: "http://rin.test/rin/files/F1" });
    expect(packages[0].card).toEqual({ object_id: "O1", name: "Объект", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
    expect(packages[1].card).toEqual({ object_id: "O1", ...full });
    expect(parsePackages({ packages: [wire()] }, BASE).packages).toHaveLength(1); // и обёртка { packages: [...] }
    expect(parsePackages([toWire(packages[1])], BASE).packages[0].card).toEqual(packages[1].card); // обратный сериализатор — та же форма
  });

  it("ответ не список пакетов — отказ цикла", () => {
    for (const bad of [null, "[]", 5, {}, { packages: "x" }]) expect(() => parsePackages(bad, BASE)).toThrow(/не список пакетов/);
  });

  it("пакет не по схеме — в invalid с причиной по полям; package_id и object_id извлекаются только строками, не длиннее 200", () => {
    const { packages, invalid } = parsePackages(
      [
        wire({ files: [] }),
        wire({ package_id: "P3", object: {}, created_at: "не дата" }),
        wire({ package_id: 123, object_id: 456 }),
        wire({ package_id: "x".repeat(300), object_id: "y".repeat(300), files: "нет" }),
        null,
        "строка",
      ],
      BASE,
    );
    expect(packages).toEqual([]);
    expect(invalid[0]).toMatchObject({ package_id: "P1", object_id: "O1" });
    expect(invalid[0].error).toContain("files: пакет без файлов");
    expect(invalid[1].package_id).toBe("P3");
    expect(invalid[1].error).toMatch(/^object\.name: .+; created_at: created_at не дата ISO 8601$/);
    expect(invalid[2]).toMatchObject({ package_id: null, object_id: null });
    expect(invalid[3].package_id).toBe("x".repeat(200));
    expect(invalid[3].object_id).toBe("y".repeat(200));
    expect(invalid[4]).toMatchObject({ package_id: null, object_id: null });
    expect(invalid[4].error).toMatch(/^пакет: /);
    expect(invalid[5]).toMatchObject({ package_id: null, object_id: null });
    // причина ограничена 500 символами, сколько бы полей ни было сломано (уходит в журнал и уведомление администратору)
    const many = parsePackages([wire({ files: Array.from({ length: 40 }, () => ({})) })], BASE).invalid[0].error;
    expect(many.length).toBe(500);
  });

  it("враждебные поля: «.», «..», слеш, обратный слеш и \\0 в имени файла; SHA-256 не из 64 hex; адрес вне «РиН» — пакет в invalid", () => {
    for (const name of [".", "..", "a/b.pdf", "a\\b.pdf", "a\0.pdf"]) {
      const r = parsePackages([wire({ files: [file({ file_name: name })] })], BASE);
      expect(r.invalid[0]?.error, name).toContain("путь");
    }
    expect(parsePackages([wire({ files: [file({ file_name: "..a.pdf" })] })], BASE).packages).toHaveLength(1); // точки внутри имени допустимы
    for (const h of ["a".repeat(65), "x" + "a".repeat(64), "a".repeat(64) + "x", "g".repeat(64)]) {
      expect(parsePackages([wire({ files: [file({ sha256: h })] })], BASE).invalid, h).toHaveLength(1);
    }
    const foreign = parsePackages([wire({ files: [file({ file_name: "e.pdf", url: "http://evil.test/e" })] })], BASE).invalid[0];
    expect(foreign.error).toBe("files.url: адрес файла e.pdf вне ИАИС «РиН»");
  });
});
