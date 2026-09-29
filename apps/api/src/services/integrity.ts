// Целостность хранилища (ТЗ 12.7, 13.8): ежедневная сверка SHA-256 каждого файла с записанным при приёме.
// Хеширование потоковое и асинхронное — проверка не блокирует обработку запросов.
// Отказ закрытый: нечитаемый файл считается повреждённым, сбой самой проверки уходит администратору.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { blobStore, FsBlobStore } from "./blobstore.ts";
import { shaFromFilePath } from "../domain/blob-crypto.ts";
import { join } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { log, notify } from "./audit.ts";

export interface IntegrityReport {
  checked: number;
  missing: string[];
  corrupted: string[];
  unreadable: string[];
  at: string;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

let running = false;

/** userId — кто запустил проверку; null — плановый запуск («system»). */
export async function verifyBlobs(db: DB, blobDir = config.blobDir, userId: string | null = null): Promise<IntegrityReport> {
  if (running) throw new Error("Проверка целостности уже идёт");
  running = true;
  try {
    return await run(db, blobDir, userId);
  } catch (e) {
    await notify(db, "admin", null, "ERROR", `Проверка целостности хранилища не выполнена: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    running = false;
  }
}

async function run(db: DB, blobDir: string, userId: string | null): Promise<IntegrityReport> {
  // ТЗ §10 Files.file_path (T-234): обход по пути файла в хранилище; путь не по схеме blobs/<sha256> — «не читается»
  const rows = await db.all<{ file_path: string }>("select distinct file_path from files order by file_path");
  const missing: string[] = [];
  const corrupted: string[] = [];
  const unreadable: string[] = [];
  const store = blobStore();
  for (const { file_path } of rows) {
    const sha256 = shaFromFilePath(file_path);
    if (!sha256) {
      unreadable.push(file_path);
      continue;
    }
    // S3 (ADR-0006): источник истины — объект в бакете; кэш — лишь копия. Нет объекта — «отсутствует», объект есть,
    // но метаданные или локальная копия не сходятся — «повреждён», хранилище не ответило — «не читается»
    if (store.kind === "s3") {
      try {
        if (!(await store.exists(sha256))) missing.push(sha256);
        else if (!(await store.verify(sha256))) corrupted.push(sha256);
      } catch {
        unreadable.push(sha256);
      }
      continue;
    }
    const p = join(blobDir, sha256);
    if (!existsSync(p)) {
      missing.push(sha256);
      continue;
    }
    try {
      // NFR-CRYPTO: файл на диске может быть IBE1 — сверка по SHA-256 открытого текста после расшифровки
      const ok = store instanceof FsBlobStore && store.dir === blobDir ? await store.intact(sha256) : (await hashFile(p)) === sha256;
      if (!ok) corrupted.push(sha256);
    } catch {
      unreadable.push(sha256);
    }
  }
  const at = new Date().toISOString();
  await db.run("insert into audit_log (user_id, action, object_id, details, timestamp) values ($1,$2,$3,$4,$5)", [
    userId ?? "system", "INTEGRITY_CHECK", null, JSON.stringify({ checked: rows.length, missing: missing.length, corrupted: corrupted.length, unreadable: unreadable.length }), at,
  ]);
  const bad = missing.length + corrupted.length + unreadable.length;
  if (bad) await notify(db, "admin", null, "ERROR", `Целостность хранилища нарушена: повреждено ${corrupted.length}, отсутствует ${missing.length}, не читается ${unreadable.length}`);
  else log("INFO", "integrity ok", { checked: rows.length });
  return { checked: rows.length, missing, corrupted, unreadable, at };
}
