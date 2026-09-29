// ТЗ 1.5, ADR-0001: профиль gpu связывает модули через RabbitMQ; конфиг отказывает громко, а не молча.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const load = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], {
    cwd: resolve(import.meta.dirname, ".."),
    // NFR-TLS: профиль gpu требует и сертификат с ключом (ТЗ 12.3) — здесь проверяется только очередь
    env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AV: "clamd", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem", INSPECTOR_ML_URL: "https://ml:8811", ...env },
    encoding: "utf8",
  });

describe("конфиг очереди", () => {
  it("gpu без RabbitMQ не стартует; amqp без адреса брокера — отказ; dev — очередь в процессе по умолчанию", () => {
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_QUEUE: "inproc" }).stderr).toContain("недопустим в профиле gpu");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_AMQP_URL: "" }).stderr).toContain("требует INSPECTOR_AMQP_URL");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_AMQP_URL: "amqps://rabbit:5671" }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_QUEUE: "" }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_QUEUE: "kafka" }).stderr).toContain("ждём inproc или amqp");
  });
});

describe("initParseQueue на поддельном канале", async () => {
  Object.assign(process.env, { INSPECTOR_QUEUE: "amqp", INSPECTOR_AMQP_URL: "amqp://fake", INSPECTOR_DEMO_PASSWORD: "x" });
  const { openDb } = await import("../src/db.ts");
  const ins = await import("../src/services/inspections.ts");
  it("очередь разбора подменяется на RabbitMQ-адаптер; канал объявляет durable-очередь и prefetch = 2", async () => {
    const calls: string[] = [];
    const ch = {
      async assertQueue(q: string, o: any) { calls.push(`assert ${q} durable=${o?.durable}`); return {}; },
      prefetch(n: number) { calls.push(`prefetch ${n}`); },
      sendToQueue() { return true; },
      async consume(q: string) { calls.push(`consume ${q}`); return {}; },
      ack() {},
    };
    ins.resetQueueForTests();
    const db = await openDb("memory");
    await ins.initParseQueue(db, ch as any);
    expect(calls).toEqual(["assert inspector.parse durable=true", "prefetch 2", "consume inspector.parse"]);
    expect("ready" in ins.parseQueue(db)).toBe(true);
    await db.close();
  });
  it("задания разбора идут через RabbitMQ: каждый принятый файл — persistent-сообщение в inspector.parse", async () => {
    const sent: Array<{ q: string; body: any; persistent?: boolean; attempt: unknown }> = [];
    const ch = {
      async assertQueue() { return {}; },
      prefetch() {},
      sendToQueue(q: string, content: Buffer, o: any) { sent.push({ q, body: JSON.parse(content.toString()), persistent: o?.persistent, attempt: o?.headers?.attempt }); return true; },
      async consume() { return {}; }, // потребитель — другой процесс: сообщения остаются в брокере
      ack() {},
    };
    const db = await openDb("memory");
    const ctx = { db, user: { id: "u-insp", login: "insp", role: "inspector" } } as any;
    ins.resetQueueForTests();
    await ins.initParseQueue(db, ch as any);
    const id = await ins.createInspection(ctx, { object_id: "OBJ-Q", name: "Очередь" });
    const pdf = (n: string) => ({ name: n, buf: Buffer.from(`%PDF-1.7\n% ${n}\n1 0 obj\n%%EOF\n`) });
    const up = await ins.ingest(ctx, id, [pdf("pd.pdf"), pdf("rd.pdf")], null);
    expect(up.accepted).toHaveLength(2);
    expect(await ins.startProcessing(ctx, id)).toEqual({ queued: 2 });
    await new Promise((r) => setImmediate(r)); // push публикует после готовности канала (ready) — микрозадачей
    expect(sent.map((s) => [s.q, s.persistent, s.attempt, s.body.payload.inspectionId])).toEqual([
      ["inspector.parse", true, 0, id],
      ["inspector.parse", true, 0, id],
    ]);
    expect(sent.map((s) => s.body.payload.fileId).sort()).toEqual(up.accepted.map((a) => a.file_id).sort());
    await db.close();
  });
});
