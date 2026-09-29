// OS-INSP-5.2 (ТЗ 9.6): очередь отправки протокола в ИАИС «РиН» — поведение, которое мутационный прогон T-158 нашёл
// непроверенным (reports/mutation/src_services_rin_ts.json): полезная нагрузка, транспорт по умолчанию (ленивый, по
// окружению), лестница повторов 1/5/15 мин, исчерпание попыток → FAILED и уведомление администратора, отмена
// нефинализированной проверки, граница «успешного» HTTP-кода, порядок запуска пачки, захват «в полёте», метрики и лог.
// L1 — функциональные, L3 — границы (коды 199/200/299/300, номер попытки), L4 — интеграция с БД и настоящим HTTP,
// L6 — отказы. Без ML и без настоящей «РиН»: заглушка — HTTP-сервер на 127.0.0.1 или подменённый транспорт.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let db: any;
let rin: typeof import("../src/services/rin.ts");
let config: typeof import("../src/config.ts")["config"];
let slo: typeof import("../src/services/slo-metrics.ts")["slo"];

// заглушка «РиН» по умолчанию — HTTP на loopback: транспорт по умолчанию (профиль dev, INSPECTOR_RIN_MOCK=1) шлёт на неё fetch'ем
const received: Array<{ url: string; body: any }> = [];
let server: http.Server;

const body = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ process_id: id, object: {}, protocol_version: 1, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: null, ...extra });

async function finalized(id: string, o: { status?: string; attempts?: number; queuedAt?: Date; due?: Date; body?: string } = {}): Promise<number> {
  const now = (o.queuedAt ?? new Date()).toISOString();
  await db.run("insert into objects (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing", ["RQ-OBJ", "Объект", now]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1, 'RQ-OBJ', $2, 1, $3, $3)", [id, o.status ?? "FINALIZED", now]);
  await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1, 1, 'FINALIZED', $2, $3)", [id, o.body ?? body(id), now]);
  const r = await db.run("insert into sync_jobs (inspection_id, protocol_version, status, attempts, next_attempt_at, created_at, updated_at) values ($1, 1, 'PENDING_SYNC', $2, $3, $4, $4) returning id", [
    id,
    o.attempts ?? 0,
    (o.due ?? new Date(now)).toISOString(),
    now,
  ]);
  return r.rows[0].id;
}
const job = (id: number) => db.get("select * from sync_jobs where id = $1", [id]);
const syncStatus = async (id: string) => (await db.get("select sync_status from inspections where id = $1", [id])).sync_status;
const soon = () => new Date(Date.now() + 1000);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body: JSON.parse(b) });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // адрес «РиН» читается конфигурацией при импорте — до первого import модулей API
  Object.assign(process.env, {
    INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_ML_URL: "http://127.0.0.1:9",
    INSPECTOR_RIN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rin`,
  });
  delete process.env.INSPECTOR_RIN_TLS;
  const { openDb } = await import("../src/db.ts");
  rin = await import("../src/services/rin.ts");
  config = (await import("../src/config.ts")).config;
  slo = (await import("../src/services/slo-metrics.ts")).slo;
  db = await openDb("memory");
});
afterAll(async () => {
  await db.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  await db.run("delete from sync_jobs");
  received.length = 0;
});

describe("полезная нагрузка «РиН» (ТЗ 9.3 п.4, NFR-PDN)", () => {
  it("реестр входных файлов — ровно пять полей на файл, лишнее не уходит", () => {
    const p = rin.rinPayload(JSON.parse(body("P-1", { input_files: [{ file_id: "F1", file_name: "a.pdf", sha256: "ab", document_code: "ПЗ", revision: 2, local_path: "/var/x", size: 10 }] })));
    expect(p.input_files).toEqual([{ file_id: "F1", file_name: "a.pdf", sha256: "ab", document_code: "ПЗ", revision: 2 }]);
  });

  it("решение уходит без ФИО инспектора; запись без решения и пустой элемент — как есть", () => {
    const decided = { id: "V1", decision: { user_id: "u-7", user_name: "Иванов И. И.", verdict: "CONFIRMED" } };
    const plain = { id: "V2" };
    const p = rin.rinPayload(JSON.parse(body("P-2", { sections: { confirmed_violations: [decided, plain, null] } })));
    expect(p.confirmed_violations).toEqual([{ id: "V1", decision: { user_id: "u-7", verdict: "CONFIRMED" } }, { id: "V2" }, null]);
    expect(decided.decision.user_name).toBe("Иванов И. И."); // снимок протокола не меняется — только копия
  });
});

// Идёт первым: транспорт строится лениво при первой отправке, а setRinTransport ниже подменяет его до конца файла.
describe("транспорт по умолчанию — по окружению, при первой отправке (NFR-MTLS)", () => {
  it("без подмены протокол уходит POST'ом на INSPECTOR_RIN_URL (демо: без TLS), задание SYNCED; второй тик — тем же транспортом", async () => {
    const decided = { id: "V1", decision: { user_id: "u-7", user_name: "Петров П. П." } };
    const a = await finalized("RQ-DEF-1", { body: body("RQ-DEF-1", { sections: { confirmed_violations: [decided] } }) });
    expect(await rin.runDueSyncJobs(db, soon())).toBe(1);
    expect(await job(a)).toMatchObject({ status: "SYNCED", last_error: null });
    expect(received.map((r) => r.url)).toEqual(["/rin/api/v1/inspection/RQ-DEF-1"]);
    expect(received[0].body.confirmed_violations).toEqual([{ id: "V1", decision: { user_id: "u-7" } }]);
    const b = await finalized("RQ-DEF-2");
    await rin.runDueSyncJobs(db, soon());
    expect(await job(b)).toMatchObject({ status: "SYNCED" });
    expect(received).toHaveLength(2);
  });

  it("демо-заглушка в процессе API по умолчанию принимает: не «уронена», журнал приёма пуст", () => {
    expect(rin.rinMock).toEqual({ down: false, received: [] });
  });
});

describe("очередь «РиН» с подменённым транспортом", () => {
  let reply: (url: string) => Promise<{ status: number }>;
  const sent: string[] = [];
  beforeAll(() => {
    rin.setRinTransport(async (url) => {
      sent.push(url.split("/").pop()!);
      return reply(url);
    });
  });
  beforeEach(() => {
    sent.length = 0;
    reply = async () => ({ status: 200 });
  });

  describe("лестница повторов 1 / 5 / 15 минут", () => {
    it("L3 · задержка перед повтором №1, №2, №3 и отсутствие четвёртого", () => {
      expect([1, 2, 3, 4].map((n) => rin.backoffMs(n))).toEqual([60_000, 300_000, 900_000, null]);
    });

    it("масштаб задержек (INSPECTOR_RIN_BACKOFF_SCALE) — множитель: 0,5 вдвое короче, лестница не сдвигается", () => {
      const was = config.rinBackoffScale;
      config.rinBackoffScale = 0.5;
      try {
        expect([1, 3, 4].map((n) => rin.backoffMs(n))).toEqual([30_000, 450_000, null]);
      } finally {
        config.rinBackoffScale = was;
      }
    });

    it("L6 · сбой первой попытки — PENDING_SYNC с повтором ровно через минуту, второй — через пять", async () => {
      reply = async () => ({ status: 503 });
      const a = await finalized("RQ-B1");
      const b = await finalized("RQ-B2", { attempts: 1 });
      const at = soon();
      await rin.runDueSyncJobs(db, at);
      expect(await job(a)).toMatchObject({ status: "PENDING_SYNC", attempts: 1, last_error: "HTTP 503" });
      expect(new Date((await job(a)).next_attempt_at).getTime()).toBe(at.getTime() + 60_000);
      expect(new Date((await job(b)).next_attempt_at).getTime()).toBe(at.getTime() + 300_000);
      expect(await syncStatus("RQ-B1")).toBe("PENDING_SYNC");
      // до срока повтора задание не берётся
      expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + 59_000))).toBe(0);
    });
  });

  describe("исчерпание попыток (ТЗ 9.6)", () => {
    it("L6 · четвёртая неудача — FAILED, проверка SYNC_FAILED, уведомление ERROR только администратору с причиной", async () => {
      reply = async () => ({ status: 503 });
      const id = await finalized("RQ-FAIL", { attempts: 3 });
      await rin.runDueSyncJobs(db, soon());
      const j = await job(id);
      expect(j).toMatchObject({ status: "FAILED", attempts: 4, last_error: "HTTP 503" });
      expect(j.last_attempt_ms).toBeGreaterThanOrEqual(0);
      expect(await syncStatus("RQ-FAIL")).toBe("SYNC_FAILED");
      const notes = await db.all("select user_role, level, message from notifications where inspection_id = 'RQ-FAIL'");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ user_role: "admin", level: "ERROR" });
      expect(notes[0].message).toContain("HTTP 503"); // причина — в тексте
      expect(notes[0].message).toContain("4"); // число попыток
      // FAILED — конечное: следующий тик задание не берёт
      expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 3_600_000))).toBe(0);
    });

    it("L6 · причина отказа сети (исключение транспорта) попадает в уведомление", async () => {
      reply = async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:8810");
      };
      await finalized("RQ-FAIL-NET", { attempts: 3 });
      await rin.runDueSyncJobs(db, soon());
      const n = await db.get("select user_role, message from notifications where inspection_id = 'RQ-FAIL-NET'");
      expect(n.user_role).toBe("admin");
      expect(n.message).toContain("ECONNREFUSED");
    });
  });

  it("проверка не финализирована — задание CANCELLED без отправки, статус проверки не трогается", async () => {
    const id = await finalized("RQ-READY", { status: "READY" });
    expect(await rin.runDueSyncJobs(db, soon())).toBe(1);
    expect(sent).toEqual([]);
    expect(await job(id)).toMatchObject({ status: "CANCELLED", attempts: 0 });
    expect(await syncStatus("RQ-READY")).not.toBe("SYNCED");
  });

  it("L3 · успех — только 2xx: 199 и 300 — повтор, 200 и 299 — доставлено", async () => {
    const codes: Record<string, number> = { "RQ-199": 199, "RQ-200": 200, "RQ-299": 299, "RQ-300": 300 };
    const ids: Record<string, number> = {};
    for (const k of Object.keys(codes)) ids[k] = await finalized(k);
    reply = async (url) => ({ status: codes[url.split("/").pop()!] });
    await rin.runDueSyncJobs(db, soon());
    expect(await job(ids["RQ-199"])).toMatchObject({ status: "PENDING_SYNC", last_error: "HTTP 199" });
    expect(await job(ids["RQ-300"])).toMatchObject({ status: "PENDING_SYNC", last_error: "HTTP 300" });
    expect(await job(ids["RQ-200"])).toMatchObject({ status: "SYNCED", last_error: null });
    expect(await job(ids["RQ-299"])).toMatchObject({ status: "SYNCED", last_error: null });
  });

  it("L3 · пачка больше SYNC_CONCURRENCY — старшие задания (меньший id) уходят первыми, даже если их срок позже", async () => {
    const at = soon();
    // самое старое задание созрело позже остальных и изменено последним — в выборке из базы оно было бы последним
    const oldest = await finalized("RQ-ORD-0", { due: new Date(at.getTime() - 1000) });
    for (let i = 1; i <= 4; i++) await finalized(`RQ-ORD-${i}`, { due: new Date(at.getTime() - 60_000) });
    await db.run("update sync_jobs set updated_at = updated_at where id = $1", [oldest]);
    reply = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: 200 };
    };
    expect(await rin.runDueSyncJobs(db, at)).toBe(5);
    // четыре первых запуска — четыре старших; пятый ждёт, пока освободится место
    expect(sent.slice(0, 4).sort()).toEqual(["RQ-ORD-0", "RQ-ORD-1", "RQ-ORD-2", "RQ-ORD-3"]);
    expect(sent[4]).toBe("RQ-ORD-4");
  });

  it("задание «в полёте» не забирается, пока захват свежий; после SYNC_LEASE_MS — забирается снова", async () => {
    const id = await finalized("RQ-LEASE");
    const at = soon();
    await db.run("update sync_jobs set status = 'IN_FLIGHT', updated_at = $1 where id = $2", [at.toISOString(), id]);
    expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + 1000))).toBe(0);
    expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + rin.SYNC_LEASE_MS - 1000))).toBe(0);
    expect(sent).toEqual([]);
    expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + rin.SYNC_LEASE_MS + 1))).toBe(1);
    expect(await job(id)).toMatchObject({ status: "SYNCED" });
  });

  it("гистограммы /metrics — в секундах: попытка ≈ 0,05 с, доставка ≈ 2 с", async () => {
    await finalized("RQ-SLO", { queuedAt: new Date(Date.now() - 2000) });
    reply = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { status: 200 };
    };
    const a0 = slo.rinAttempt.sum;
    const d0 = slo.rinDelivery.sum;
    await rin.runDueSyncJobs(db, new Date());
    const attempt = slo.rinAttempt.sum - a0;
    const delivery = slo.rinDelivery.sum - d0;
    expect(attempt).toBeGreaterThanOrEqual(0.04);
    expect(attempt).toBeLessThan(1);
    expect(delivery).toBeGreaterThanOrEqual(2);
    expect(delivery).toBeLessThan(5);
  });

  it("успешная доставка пишет в JSON-лог (ТЗ 13.1) событие с проверкой и временем попытки и доставки", async () => {
    await finalized("RQ-LOG");
    const lines: string[] = [];
    const vitest = process.env.VITEST;
    delete process.env.VITEST; // log() молчит под Vitest — на один тик включаем
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => (lines.push(String(s)), true));
    try {
      await rin.runDueSyncJobs(db, soon());
    } finally {
      spy.mockRestore();
      process.env.VITEST = vitest;
    }
    const ev = lines.map((l) => JSON.parse(l)).find((e) => e.inspection_id === "RQ-LOG");
    expect(ev).toMatchObject({ level: "INFO", message: "rin sync ok", inspection_id: "RQ-LOG" });
    expect(typeof ev.attempt_ms).toBe("number");
    expect(typeof ev.delivered_ms).toBe("number");
  });
});
