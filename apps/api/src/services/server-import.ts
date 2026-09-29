// OS-INSP-1.2.36…1.2.39 (T-169): серверный импорт файла больше предела интерактивной загрузки — IO.
// Файл уже лежит в каталоге хранилища под именем SHA-256 (загрузчик положил его вне интерактивного запроса). Здесь он
// читается потоком: SHA-256, голова и хвост для формата, антивирус (закрыто при сбое), копия в S3 (у tiered) — и
// регистрируется общим шагом приёма admit с источником server_import. Целиком в память файл не попадает.
import { createHash } from "node:crypto";
import { atRestVerdict, HeadTail, IMPORT_MAX_FILE_BYTES, ImportSlots, importVerdict, preflight, type ImportRequest } from "../domain/server-import.ts";
import { canUpload } from "../domain/lifecycle.ts";
import { ObjectCard } from "../domain/upload.ts";
import { screenStream } from "./antivirus.ts";
import { BlobIntegrityError, BlobNotFound, BlobStoreUnavailable, blobStore, hashTap, type PlainStream } from "./blobstore.ts";
import { admit, createInspection, getInspection, hiddenLabelRejection, hiddenLabelShas, HttpError, startProcessing, type AdmitDoc, type Ctx, type UploadResult } from "./inspections.ts";

type Rejection = UploadResult["rejected"][number];

/** Один проход потока: SHA-256, голова, хвост и длина. Сбой расшифровки или чтения — исключение наружу. */
async function probe(s: PlainStream) {
  const h = createHash("sha256");
  const ht = new HeadTail();
  for await (const c of s.chunks()) {
    h.update(c);
    ht.push(c);
  }
  return { size: ht.size, sha256: h.digest("hex"), head: ht.head, tail: ht.tail };
}

/**
 * Чужое содержимое под именем хеша — в карантин, если на этот хеш не ссылается ни один принятый файл: иначе честная
 * загрузка того же документа наткнулась бы на него (put не перезаписывает). Принятый — не трогается: его порчу должна
 * увидеть проверка целостности (ТЗ 12.7).
 */
async function quarantineUnregistered(ctx: Ctx, sha: string): Promise<void> {
  if (await ctx.db.get("select 1 from files where sha256 = $1 limit 1", [sha])) return;
  await blobStore().quarantine(sha);
}

/** Проверка одного файла каталога: документ для admit или отказ с причиной. Хранилище недоступно — 503 наружу. */
async function screenStaged(ctx: Ctx, processId: string, f: { sha256: string; file_name: string }): Promise<AdmitDoc | Rejection> {
  const name = f.file_name;
  const reject = (code: string, message: string): Rejection => ({ file_name: name, code, message });
  const store = blobStore();
  try {
    const staged = await store.staged(f.sha256);
    // OWASP M-004: при шифровании ML разбирает открытый текст из рабочего каталога (tmpfs) — файл больше него не разобрать
    const pre = preflight(name, f.sha256, staged?.size ?? null, Math.min(IMPORT_MAX_FILE_BYTES, staged?.workLimit ?? Infinity));
    if (pre && !pre.ok) return reject(pre.code, pre.message);
    const enc = atRestVerdict(name, staged!.plainWhileKeyed);
    if (enc && !enc.ok) return reject(enc.code, enc.message);
    const p = await probe(staged!);
    const v = importVerdict(name, f.sha256, p);
    if (v.ok === false && v.code === "IMPORT_HASH_MISMATCH") await quarantineUnregistered(ctx, f.sha256);
    if (!v.ok) return reject(v.code, v.message);
    // OWASP L-005: антивирус читает файл ещё раз — сверка хеша на лету: подменённое между проходами содержимое
    // обрывает проверку (SCAN_UNAVAILABLE), а не проходит её чистым двойником
    const av = await screenStream(ctx, processId, name, () => hashTap(f.sha256, staged!.chunks()));
    if (!av.ok) return reject(av.code, av.message);
    await store.adopt(f.sha256);
    return { name, sha256: f.sha256, size: p.size, verdict: { ok: true, kind: v.kind } };
  } catch (e) {
    if (e instanceof BlobStoreUnavailable) throw new HttpError(503, `Хранилище файлов недоступно, импорт не выполнен: ${e.message}`);
    if (e instanceof BlobNotFound) return reject("IMPORT_NOT_FOUND", `${name}: файла с SHA-256 ${f.sha256} в хранилище нет`);
    // не расшифровался, тег GCM не сошёлся или файл подменили между проверкой и копией в S3
    if (e instanceof BlobIntegrityError) return reject("IMPORT_HASH_MISMATCH", `${name}: ${e.message}`);
    throw e;
  }
}

const slots = new ImportSlots(Number(process.env.INSPECTOR_IMPORT_SLOTS ?? 2) || 2);

/** OWASP M-003: не больше одного импорта на пользователя и слотов на процесс — сверх 429. */
export async function importFiles(ctx: Ctx, req: ImportRequest): Promise<UploadResult> {
  if (!slots.tryAcquire(ctx.user.id)) throw new HttpError(429, "Серверный импорт уже идёт — дождитесь окончания предыдущего и повторите");
  try {
    return await importLocked(ctx, req);
  } finally {
    slots.release(ctx.user.id);
  }
}

async function importLocked(ctx: Ctx, req: ImportRequest): Promise<UploadResult> {
  let processId = req.process_id;
  if (processId) {
    // проверки нет — 404, финализирована — 409: до чтения гигабайтов, а не после
    const insp = await getInspection(ctx.db, processId);
    if (!canUpload(insp.status)) throw new HttpError(409, insp.status === "FINALIZED" ? "Протокол финализирован: дозагрузка невозможна. Создайте новую проверку." : `Дозагрузка невозможна в статусе ${insp.status}`);
  } else processId = await createInspection(ctx, ObjectCard.parse(req.object ?? req.manifest?.object));

  const labels = await hiddenLabelShas(ctx.db);
  const early: Rejection[] = [];
  const docs: AdmitDoc[] = [];
  for (const f of req.files) {
    if (labels.has(f.sha256)) {
      early.push(hiddenLabelRejection(f.file_name)); // OS-INSP-6.1.6: метки скрытого теста — не в конвейер
      continue;
    }
    // OWASP M-003: уже принятое в эту проверку содержимое не читается с диска заново — отказ сразу
    const same = await ctx.db.get<{ client_file_id: string; file_name: string }>("select client_file_id, file_name from files where inspection_id = $1 and sha256 = $2 limit 1", [processId, f.sha256]);
    if (same) {
      early.push(same.file_name === f.file_name
        ? { file_name: f.file_name, code: "DUPLICATE", message: `${f.file_name}: файл уже принят` }
        : { file_name: f.file_name, code: "DUPLICATE_CONTENT", message: `${f.file_name}: то же содержимое уже принято как ${same.client_file_id}`, duplicate_of: same.client_file_id });
      continue;
    }
    const r = await screenStaged(ctx, processId, f);
    if ("verdict" in r) docs.push(r);
    else early.push(r);
  }
  const res = await admit(ctx, processId, { docs, sigItems: [], manifest: req.manifest ?? null, early, packageBytes: null, source: "server_import" });
  if (req.start && res.accepted.length) await startProcessing(ctx, processId);
  return res;
}
