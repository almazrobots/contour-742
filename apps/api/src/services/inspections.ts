// Оркестрация проверки: приём пакета → выбор редакций → разбор (ML) → сопоставление → протокол → верификация.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { blobStore, BlobStoreUnavailable } from "./blobstore.ts";
import { conflictAnchor, evaluateClassParam, fireSubjectTrace, inPassportSources, mentionTrace, type Mention } from "../domain/class-param.ts";
import { classPassport, disciplineKey, elementOf, extractorSpec, quantityPassport, sourceDocTypes } from "../domain/passport.ts";
import { evaluateQuantityParam, quantityMeta, type QuantityMention, type QuantitySuspicion } from "../domain/quantity-param.ts";
import { kindMentions, kindOf, kindSlice, suspicionRecord, type KindSuspicion, type ParamKind } from "../domain/param-kinds.ts";
import { parseDocName } from "../domain/cipher.ts";
import { passportFor, passportNormRefs } from "./passports.ts";
import { meta, type DB } from "../db.ts";
import { evaluate } from "../domain/compare.ts";
import { opFor, verifyL8 } from "../domain/verify-l8.ts";
import { contextFor, loadPackageL8, saveChangeMarks, writeCascades } from "./l8.ts";
import { documentCounts, loadCodes, scenario } from "../domain/completeness.ts";
import { applyDecision, canFinalize, canUnfinalize, criticalUnresolved, canUpload, canVerify, statusAfterDecision, type Decision } from "../domain/lifecycle.ts";
import { buildProtocol, type CheckRow, type FragmentRow } from "../domain/protocol.ts";
import { selectRevisions } from "../domain/revisions.ts";
import { boundedDedupKey, dedupe, logical, normative, semantic, type Fact, type LogicalRule, type NormEntry, type Room } from "../domain/suspicions.ts";
import type { ApprovalStatus, Param, ProcessStatus, Role, Scenario, Stage, StageValue } from "../domain/types.ts";
import { STAGES } from "../domain/types.ts";
import { asApproval, checkFile, checkPackage, indexManifest, type FileVerdict, type Manifest } from "../domain/upload.ts";
import type { IntakeSource } from "../domain/server-import.ts";
import { labelShas } from "../domain/hidden-seal.ts";
import { audit, log, notify } from "./audit.ts";
import { attachApprovedChanges } from "./changes.ts";
import { saveParseExtras, writeHiddenWorks } from "./hidden-works.ts";
import { saveRequisites, writeRequisites } from "./requisites.ts";
import { attachSignatures } from "./signature.ts";
import { isSignatureFile } from "../domain/signature.ts";
import { disputeEntry, rejectionEntry } from "../domain/feedback-logs.ts";
import { normRecordFromRow, paramsForNorm } from "../domain/norm-base.ts";
import type { NormRecord } from "../domain/geom-ops.ts";
import { isSourceFor } from "../domain/doctype.ts";
import { pickStageSources } from "../domain/discipline-fit.ts";
import { recomputeAllParams, RULES_VERSION } from "../domain/rules-version.ts";
import { assignPageOffsets } from "./parts.ts";
import { duplicateOf, integrityReport, isExcluded, pagesMismatch, type IntegrityReport, type Rejection } from "../domain/integrity-report.ts";
import { analyzePipeline, preparePipelineRun, publishPipelineRun } from "./pipeline-runs.ts";
import { preserveFileResult } from "./file-result-snapshots.ts";
import { analyze, mlHealth, parseInParts, type MlResponse, type MlRequest } from "./ml-client.ts";
import { withPipelineSourceLock } from "./pipeline-source-pins.ts";
import { slo } from "./slo-metrics.ts";
import { ocrQuality } from "../domain/ocr-quality.ts";
import { autoSheetDiff } from "./sheetdiff.ts";
import { SHEET_DIFF_CODE, SHEET_DIFF_PARAM } from "../domain/sheetdiff.ts";
import { carryDecision, evidenceFingerprint } from "../domain/evidence-fingerprint.ts";
import { inProcessQueue, type Job, type JobQueue } from "./queue.ts";
import { amqpQueue, connectAmqp, type AmqpChannel } from "./amqp-queue.ts";
import { runAdvisorLater } from "./advisor.ts";
import { patternSuspicions } from "./patterns.ts";
import { attachNormsLater } from "./norms.ts";
import { writeAiScores } from "./retrain.ts";

const now = () => new Date().toISOString();
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export interface User {
  id: string;
  login: string;
  name: string;
  role: Role;
}

export interface Ctx {
  db: DB;
  user: User;
  ip?: string;
  ua?: string;
}

// ─────────────────────────────── справочники

export async function loadParams(db: DB, activeOnly = true): Promise<Param[]> {
  const rows = await db.all<Record<string, any>>(`select * from params ${activeOnly ? "where is_active" : ""} order by id`);
  return rows.map((r) => ({
    code: r.code,
    section: r.section,
    parameter_name: r.parameter_name,
    unit: r.unit ?? "",
    source_pd: r.source_pd,
    source_rd: r.source_rd,
    source_id: r.source_id,
    trigger_logic: r.trigger_logic ?? "",
    review_priority: r.review_priority ?? "MEDIUM",
    data_type: r.data_type,
    compare: JSON.parse(r.compare_json),
    anchors: JSON.parse(r.anchors_json),
    regex_pattern: r.regex_pattern,
    value_scale: r.value_scale_json ? JSON.parse(r.value_scale_json) : null,
    applicability: r.applicability,
    sp_reference: r.sp_reference,
    is_active: Boolean(r.is_active),
  }));
}

async function logicalRules(db: DB): Promise<Array<LogicalRule & { fact_anchors: Array<{ code: string; anchors: string[]; data_type: string }> }>> {
  return (await db.all<Record<string, any>>("select * from logical_rules order by id")).map((r) => ({
    id: r.id,
    rule_name: r.rule_name,
    condition: JSON.parse(r.condition_json),
    expected: JSON.parse(r.expected_json),
    normative_base: r.normative_base,
    is_active: Boolean(r.is_active),
    fact_anchors: JSON.parse(r.fact_anchors_json),
  }));
}

export async function getInspection(db: DB, id: string): Promise<Record<string, any>> {
  const r = await db.get<Record<string, any>>("select * from inspections where id = $1", [id]);
  if (!r) throw new HttpError(404, `Проверка ${id} не найдена`);
  return r;
}

/**
 * Прочитать проверку с блокировкой строки до конца транзакции (только внутри tx). Все изменения протокола одной
 * проверки — пересчёт, решение, разделение, финализация, приём файлов — сначала берут эту блокировку: при синхронном
 * SQLite их атомарность давал единственный поток, в PostgreSQL её даёт очередь на строке inspections.
 */
export async function lockInspection(t: DB, id: string): Promise<Record<string, any>> {
  const r = await t.get<Record<string, any>>("select * from inspections where id = $1 for update", [id]);
  if (!r) throw new HttpError(404, `Проверка ${id} не найдена`);
  return r;
}

async function setStatus(db: DB, id: string, status: ProcessStatus): Promise<void> {
  await db.run("update inspections set status = $1, updated_at = $2 where id = $3", [status, now(), id]);
}

/** Статусы записей для статуса проверки после решения (разделённые составные — не в счёт). */
async function liveChecks(db: DB, inspectionId: string): Promise<Array<{ param_code: string; finding_status: string; verification_status: string; review_priority: string | null }>> {
  return db.all("select param_code, finding_status, verification_status, review_priority from checks where inspection_id = $1 and verification_status != 'SPLIT'", [inspectionId]);
}

// ─────────────────────────────── OS-INSP-1.1 объект и проверка

export async function createInspection(ctx: Ctx, card: { object_id: string; name: string; address?: string; customer?: string; contractor?: string; permit_number?: string; profile?: Record<string, boolean> }): Promise<string> {
  return ctx.db.tx(async (t) => {
    const tctx = { ...ctx, db: t };
    // Объект заводится один раз: одновременные карточки одного объекта не падают на первичном ключе
    const created = await t.run(
      "insert into objects (id, name, address, customer, contractor, permit_number, profile_json, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing",
      [card.object_id, card.name, card.address ?? "", card.customer ?? "", card.contractor ?? "", card.permit_number ?? "", JSON.stringify(card.profile ?? {}), now()],
    );
    if (created.rowCount) await audit(tctx, "OBJECT_CREATED", card.object_id, { name: card.name });
    const id = `P-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
    await t.run("insert into inspections (id, object_id, status, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [id, card.object_id, "PENDING", ctx.user.id, now(), now()]);
    await audit(tctx, "INSPECTION_CREATED", id, { object_id: card.object_id });
    return id;
  });
}

// ─────────────────────────────── OS-INSP-1.2 приём файлов

export interface UploadItem {
  name: string;
  buf: Buffer;
}

export interface UploadResult {
  process_id: string;
  accepted: Array<{ file_id: string; file_name: string; sha256: string; doc_stage: string; source?: IntakeSource }>;
  rejected: Array<{ file_name: string; code: string; message: string; duplicate_of?: string }>;
  status: string;
  clarification?: string;
  /** OS-INSP-1.2.11: откреплённые подписи пакета — результат проверки по документу (file_id — документа). */
  signatures: Array<{ file_id: string; file_name: string; document: string; status: string; kind: string | null; reason: string }>;
}

/** OS-INSP-6.1.6 (T-137): SHA-256 файлов меток всех печатей скрытого теста — в конвейер не идут. */
export async function hiddenLabelShas(db: DB): Promise<Set<string>> {
  return labelShas((await db.all<{ files_json: string }>("select files_json from hidden_seals")).map((r) => ({ files: JSON.parse(r.files_json) })));
}

export const hiddenLabelRejection = (name: string) => ({ file_name: name, code: "HIDDEN_TEST_LABELS", message: `${name}: файл меток скрытого теста — в конвейер не принимается` });

/**
 * Приём пакета — одной транзакцией под блокировкой проверки: проверка статуса, слияние реестра (чтение → запись)
 * и проверка дубликатов file_id не перемежаются с параллельной дозагрузкой или финализацией той же проверки.
 */
export async function ingest(ctx: Ctx, inspectionId: string, items: UploadItem[], manifest: Manifest | null): Promise<UploadResult> {
  // OS-INSP-6.1.6 (T-137): файл меток скрытого теста (SHA-256 совпал с файлом «метки» любой печати) в конвейер не идёт —
  // ни в хранилище, ни в files; отказ HIDDEN_TEST_LABELS. Проверка до формата: метки бывают и не PDF (annotations.jsonl).
  const hiddenLabels = await hiddenLabelShas(ctx.db);
  const labelHits = items.filter((it) => hiddenLabels.has(sha256(it.buf)));
  items = items.filter((it) => !labelHits.includes(it));
  // OS-INSP-1.2.28–1.2.30: файл кладётся в хранилище (S3 — зашифрованным) до транзакции: сетевой вызов не держит
  // блокировку проверки. Хранилище недоступно — 503 и ни одной записи о файле. Объект адресуется хешем и неизменяем,
  // поэтому блоб, оставшийся после отказа приёма, безвреден и переиспользуется.
  // по 4 параллельно: канал до облака с задержкой (VPN, стенд T-129) — последовательная отправка упиралась в тайм-ауты
  const toStore = items.filter((it) => isSignatureFile(it.name) || checkFile(it.name, it.buf).ok);
  let next = 0;
  const worker = async () => {
    while (next < toStore.length) {
      const it = toStore[next++];
      await blobStore().put(sha256(it.buf), it.buf);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, toStore.length) }, worker));
  } catch (e) {
    if (e instanceof BlobStoreUnavailable) throw new HttpError(503, `Хранилище файлов недоступно, пакет не принят: ${e.message}`);
    throw e;
  }
  const docs = items.filter((x) => !isSignatureFile(x.name)).map((it) => ({ name: it.name, sha256: sha256(it.buf), size: it.buf.length, verdict: checkFile(it.name, it.buf) }));
  return admit(ctx, inspectionId, {
    docs,
    sigItems: items.filter((it) => isSignatureFile(it.name)),
    manifest,
    early: labelHits.map((it) => hiddenLabelRejection(it.name)),
    packageBytes: items.map((i) => i.buf.length),
    source: "upload",
  });
}

/** Документ, уже лежащий в хранилище, с вердиктом формата: общий вход приёма для загрузки и серверного импорта. */
export interface AdmitDoc {
  name: string;
  sha256: string;
  size: number;
  verdict: FileVerdict;
}

export interface AdmitInput {
  docs: AdmitDoc[];
  sigItems: UploadItem[];
  manifest: Manifest | null;
  /** Отказы до транзакции (метки скрытого теста, серверный импорт) — первыми в ответе и в журнале отказов. */
  early: UploadResult["rejected"];
  /** Размеры для предела пакета 200 МБ (OS-INSP-1.2.3); null — предел интерактивной загрузки не применяется (серверный импорт). */
  packageBytes: number[] | null;
  source: IntakeSource;
}

/** Регистрация принятых в хранилище файлов под блокировкой проверки (OS-INSP-1.2.5–1.2.8, 1.2.31–1.2.33, 1.2.36). */
export async function admit(ctx: Ctx, inspectionId: string, a: AdmitInput): Promise<UploadResult> {
  const { manifest } = a;
  return ctx.db.tx(async (t) => {
    const tctx = { ...ctx, db: t };
    const insp = await lockInspection(t, inspectionId);
    if (!canUpload(insp.status)) {
      throw new HttpError(409, insp.status === "FINALIZED" ? "Протокол финализирован: дозагрузка невозможна. Создайте новую проверку." : `Дозагрузка невозможна в статусе ${insp.status}`);
    }
    if (a.packageBytes) {
      const pkg = checkPackage(a.packageBytes);
      if (!pkg.ok) throw new HttpError(413, pkg.message, { limit_mb: 200 });
    }

    // Реестр пакета: объединяется с ранее принятым (дозагрузка может принести свой реестр)
    const prev: Manifest | null = insp.manifest_json ? JSON.parse(insp.manifest_json) : null;
    const merged: Manifest | null = manifest || prev ? { object: manifest?.object ?? prev?.object, files: mergeFiles(prev?.files ?? [], manifest?.files ?? []) } : null;
    const index = indexManifest(merged);
    const accepted: UploadResult["accepted"] = [];
    const rejected: UploadResult["rejected"] = [...a.early];
    mkdirSync(config.blobDir, { recursive: true });

    // OS-INSP-1.2.11: .sig/.p7s — не документ: мимо правила форматов 1.2.1 и мимо ML, проверяются после документов
    for (const it of a.docs) {
      const v = it.verdict;
      if (!v.ok) {
        rejected.push({ file_name: it.name, code: v.code, message: v.message });
        continue;
      }
      const hash = it.sha256;
      const m = index.byName.get(it.name);
      const clientId = m?.file_id ?? it.name;
      const dup = await t.get<{ sha256: string }>("select sha256 from files where inspection_id = $1 and client_file_id = $2", [inspectionId, clientId]);
      if (dup) {
        // Перезапись под тем же file_id запрещена (Перечень ИД): новая редакция — новый file_id
        rejected.push({ file_name: it.name, code: dup.sha256 === hash ? "DUPLICATE" : "FILE_ID_EXISTS", message: dup.sha256 === hash ? `${it.name}: файл уже принят` : `${it.name}: file_id ${clientId} уже занят другим файлом — перезапись запрещена` });
        continue;
      }
      if (m?.sha256 && m.sha256 !== hash) {
        rejected.push({ file_name: it.name, code: "HASH_MISMATCH", message: `${it.name}: SHA-256 ${hash} не совпадает с реестром (${m.sha256})` });
        continue;
      }
      // OS-INSP-1.2.32: реестр исключил файл из проверки — в сверку не идёт, причина — в отчёт о целостности
      if (m && isExcluded(m)) {
        rejected.push({ file_name: it.name, code: "EXCLUDED", message: `${it.name}: исключён реестром — ${m.exclusion_reason!.trim()}` });
        continue;
      }
      // OS-INSP-1.2.33: то же содержимое уже принято под другим file_id — второй раз в сверку не идёт
      const same = duplicateOf(await t.all<{ client_file_id: string; sha256: string }>("select client_file_id, sha256 from files where inspection_id = $1 and sha256 = $2", [inspectionId, hash]), clientId, hash);
      if (same) {
        rejected.push({ file_name: it.name, code: "DUPLICATE_CONTENT", message: `${it.name}: то же содержимое уже принято как ${same}`, duplicate_of: same });
        continue;
      }
      const id = randomUUID();
      await t.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision,
        approval_status, approval_date, predecessor_id, successor_id, signature_status, sheet_page_range, uploaded_at, part_of, part_index, intake_source)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [
        id, inspectionId, insp.object_id, clientId, it.name, hash, it.size, v.kind,
        m?.doc_stage ?? guessStage(it.name), m?.discipline ?? null, m?.document_code ?? it.name, m?.revision ?? "?",
        asApproval(m?.approval_status) ?? null, m?.approval_date ?? null, m?.predecessor_id ?? null, m?.successor_id ?? null, m?.signature_status ?? null, m?.sheet_page_range ?? null, now(),
        m?.part_of ?? null, m?.part_index ?? null, a.source,
      ]);
      accepted.push({ file_id: id, file_name: it.name, sha256: hash, doc_stage: m?.doc_stage ?? guessStage(it.name), source: a.source });
    }

    // Подпись сверяется с документом этого пакета или принятым раньше. Проверка — node:crypto, поэтому
    // одинакова для ручной загрузки и автозабора из «РиН» — оба канала идут через ingest.
    const sigs = await attachSignatures(tctx, inspectionId, a.sigItems);
    rejected.push(...sigs.rejected);
    // OS-INSP-1.2.35: отказ остаётся в журнале — отчёт о целостности называет его и после ответа на загрузку
    for (const r of rejected) {
      await t.run("insert into file_rejections (inspection_id, file_name, code, message, duplicate_of, created_at) values ($1,$2,$3,$4,$5,$6)", [
        inspectionId, r.file_name, r.code, r.message, r.duplicate_of ?? null, now(),
      ]);
    }

    await t.run("update inspections set manifest_json = $1, manifest_hash = $2, updated_at = $3 where id = $4", [merged ? JSON.stringify(merged) : null, merged ? sha256(JSON.stringify(merged)) : null, now(), inspectionId]);
    await refreshPackage(t, inspectionId);
    await audit(tctx, a.source === "server_import" ? "FILES_IMPORTED" : "FILES_UPLOADED", inspectionId, { accepted: accepted.map((x) => x.file_name), rejected: rejected.map((r) => `${r.file_name}: ${r.code}`), source: a.source });
    return {
      process_id: inspectionId,
      accepted,
      rejected,
      status: (await getInspection(t, inspectionId)).status,
      signatures: sigs.signatures,
      clarification: merged ? undefined : "Пакет принят без реестра файлов: актуальные редакции не определены — CLARIFICATION_REQUIRED",
    };
  });
}

function mergeFiles<T extends { file_id: string }>(a: T[], b: T[]): T[] {
  const m = new Map(a.map((f) => [f.file_id, f]));
  for (const f of b) m.set(f.file_id, f);
  return [...m.values()];
}

function guessStage(name: string): Stage {
  const n = name.toUpperCase();
  if (/(^|[-_ ])ИД|(^|[-_])ID[-_]/.test(n)) return "ID";
  if (/(^|[-_ ])РД|(^|[-_])RD[-_]/.test(n)) return "RD";
  return "PD";
}

/**
 * Пересчитать роли редакций, статусы загрузки и сценарий (OS-INSP-1.3, 1.4). Возвращает файлы со сменившейся ролью.
 * Чтение файлов → запись ролей: вызывать внутри транзакции под lockInspection (ingest).
 */
export async function refreshPackage(db: DB, inspectionId: string): Promise<Set<string>> {
  const insp = await getInspection(db, inspectionId);
  const files = await db.all<Record<string, any>>("select * from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  const roles = selectRevisions(
    files.map((f) => ({ file_id: f.id, client_file_id: f.client_file_id, doc_stage: f.doc_stage, document_code: f.document_code, revision: f.revision, approval_status: f.approval_status as ApprovalStatus | null, predecessor_id: f.predecessor_id, part_of: f.part_of, part_index: f.part_index })),
    Boolean(insp.manifest_json),
  );
  const changed = new Set<string>();
  for (const f of files) {
    const r = roles.get(f.id)!;
    if (f.revision_role && f.revision_role !== r.role) changed.add(f.id);
    await db.run("update files set revision_role = $1, revision_note = $2 where id = $3", [r.role, r.note, f.id]);
  }
  await refreshLoad(db, inspectionId, insp, files);
  return changed;
}

/**
 * Статусы загрузки стадий и сценарий (OS-INSP-1.4) — без пересчёта ролей редакций. После разбора (OS-INSP-1.2.34:
 * число страниц известно только тогда) зовётся одна она: роли в разборе не меняются.
 */
export async function refreshLoad(db: DB, inspectionId: string, insp?: Record<string, any>, files?: Array<Record<string, any>>): Promise<void> {
  insp ??= await getInspection(db, inspectionId);
  files ??= await db.all<Record<string, any>>("select * from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  const index = indexManifest(insp.manifest_json ? JSON.parse(insp.manifest_json) : null);
  // OS-INSP-1.2.34: число страниц разобранного PDF расходится с реестром — файл неполный, его стадия PARTIAL
  const declaredPages = new Map([...index.byName.values()].map((m) => [m.file_id, m.pdf_pages ?? null]));
  const incomplete = new Set(files.filter((f) => pagesMismatch(declaredPages.get(f.client_file_id), pageCount(f.pages_json))).map((f) => f.client_file_id as string));
  // части большого документа считаются одним документом (OS-INSP-1.2.10)
  const counts = documentCounts([...index.byName.values()], files as Array<{ client_file_id: string; doc_stage: Stage; part_of: string | null }>, incomplete);
  await db.run("update inspections set scenario = $1, load_codes_json = $2, input_manifest_hash = $3, updated_at = $4 where id = $5", [
    scenario(counts), JSON.stringify(loadCodes(counts)), sha256(files.map((f) => `${f.client_file_id}:${f.sha256}`).sort().join("|")), now(), inspectionId,
  ]);
}

// ─────────────────────────────── OS-INSP-2 разбор через ML

type ParseJob = { fileId: string; inspectionId: string };
let queue: JobQueue<ParseJob> | null = null;

/** Обработчик разбора и политика повторов — общие для очереди в процессе и RabbitMQ. */
function parseWork(db: DB) {
  return {
    handler: async (job: Job<ParseJob>) => {
      // атомарный захват файла: задание берёт только ждущий файл. Дубль (восстановление после сбоя в режиме RabbitMQ:
      // брокер сам вернул неподтверждённое задание, а recoverParsing поставил его ещё раз) видит файл занятым или DONE
      // и не разбирает его второй раз — в том числе когда оба экземпляра пришли одновременно
      const claimed = await db.get(`update files set parse_status = 'PARSING' where id = $1 and parse_status in ('PENDING', 'FAILED')
        and not exists (select 1 from pipeline_runs r where r.id=files.pipeline_run_id and r.execution_mode='durable') returning id`, [job.payload.fileId]);
      if (!claimed) {
        log("INFO", "parse job duplicate skipped", { file: job.payload.fileId });
        return;
      }
      try {
        await parseOne(db, job.payload.fileId, job.attempt);
      } catch (e) {
        // вернуть файл в ожидание: повтор брокера должен снова его захватить; после последней попытки onDead ставит FAILED
        await db.run("update files set parse_status = 'PENDING' where id = $1 and parse_status = 'PARSING'", [job.payload.fileId]);
        throw e;
      }
      await maybeFinishParsing(db, job.payload.inspectionId);
    },
    opts: {
      concurrency: config.parseConcurrency, // файлов разбора параллельно (INSPECTOR_PARSE_CONCURRENCY, по умолчанию 2)
      maxRetries: 2, // ТЗ 9.1: тайм-аут — повтор до 2 раз, затем уведомление администратора (OS-INSP-2.1.4)
      onDead: async (job: Job<ParseJob>, err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await db.run("update files set parse_status = 'FAILED', parse_error = $1 where id = $2", [msg, job.payload.fileId]);
        await notify(db, "admin", job.payload.inspectionId, "ERROR", `Разбор файла не удался после 3 попыток: ${msg}`);
        await maybeFinishParsing(db, job.payload.inspectionId).catch((e) => log("ERROR", "finish parsing", { error: String(e?.message ?? e) }));
      },
    },
  };
}

export function parseQueue(db: DB): JobQueue<ParseJob> {
  if (queue) return queue;
  const w = parseWork(db);
  queue = inProcessQueue<ParseJob>(w.handler, w.opts);
  return queue;
}

/** Профиль gpu (ADR-0001, ТЗ 1.5): очередь разбора — RabbitMQ. Вызывается при старте сервера до приёма запросов. */
export async function initParseQueue(db: DB, ch?: AmqpChannel): Promise<void> {
  if (config.queueMode !== "amqp") return;
  const w = parseWork(db);
  const q = amqpQueue<ParseJob>(ch ?? (await connectAmqp(config.amqpUrl!)), "inspector.parse", w.handler, w.opts);
  await q.ready;
  queue = q;
}

/**
 * Восстановление после сбоя (T-129, вопрос владельца о перезапуске и отключении питания): проверки, застрявшие
 * в PARSING, дочищаются — незавершённые файлы (PENDING, PARSING) возвращаются в очередь; если незавершённых нет,
 * проверка сразу пересчитывается. Разбор файла идемпотентен (извлечения файла заменяются целиком), поэтому
 * повтор задания, которое брокер и так вернул бы сам, безвреден. Уже разобранные файлы (DONE) не трогаются.
 */
export async function recoverParsing(db: DB): Promise<{ inspections: number; requeued: number }> {
  const stuck = await db.all<{ id: string }>("select id from inspections where status = 'PARSING' order by id");
  let requeued = 0;
  for (const { id } of stuck) {
    const files = await db.all<{ id: string }>(`select id from files where inspection_id = $1 and parse_status in ('PENDING', 'PARSING')
      and not exists (select 1 from pipeline_runs r where r.id=files.pipeline_run_id and r.execution_mode='durable') order by uploaded_at, id`, [id]);
    if (files.length) await db.run("update files set parse_status = 'PENDING' where id in (select jsonb_array_elements_text($1::jsonb))", [files.map((f) => f.id)]);
    const q = parseQueue(db);
    for (const f of files) q.push(f.id, { fileId: f.id, inspectionId: id });
    requeued += files.length;
    if (!files.length) await maybeFinishParsing(db, id);
    log("INFO", "recover parsing", { inspection: id, requeued: files.length });
  }
  return { inspections: stuck.length, requeued };
}

export function resetQueueForTests(): void {
  queue = null;
}

/** Ждать готовности ML (health) до limitMs, опрос раз в 5 с. Не дождались — вернуть управление: сработает повтор. */
export async function waitMlReady(limitMs: number, pollMs = 5_000): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if ((await mlHealth().catch(() => ({ ok: false }))).ok) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

async function buildParseRequest(db: DB, sha: string): Promise<MlRequest> {
  const params = await loadParams(db);
  const facts = (await logicalRules(db)).flatMap((r) => r.fact_anchors);
  return {
    sha256: sha,
    params: params.map((p) => {
      const pp = passportFor(p.code);
      return { code: p.code, anchors: p.anchors, data_type: p.data_type, regex_pattern: p.regex_pattern,
        compare_kind: p.compare.kind, unit: p.unit || null, ...(pp ? { extractor: extractorSpec(pp) } : {}) };
    }),
    facts: facts.map((x) => ({ code: x.code, anchors: x.anchors, data_type: x.data_type, regex_pattern: null })),
  };
}

async function parseOne(db: DB, fileId: string, attempt: number): Promise<void> {
  const f = (await db.get<Record<string, any>>("select * from files where id = $1", [fileId]))!;
  await db.run("update files set parse_status = 'PARSING', parse_attempts = $1 where id = $2", [attempt + 1, fileId]);
  const request = await buildParseRequest(db, f.sha256);
  // ML читает файл с общего кэш-тома: при промахе кэша блоб поднимается из S3 и проверяется по SHA-256 (ADR-0006)
  await blobStore().localPath(f.sha256);
  let res: Awaited<ReturnType<typeof analyze>>;
  try {
    if (f.pipeline_run_id) {
      res = await analyzePipeline(db, fileId, f.pipeline_run_id, request);
    } else {
      const parts = await parseInParts(f.sha256, config.parseChunkPages, config.parsePartConcurrency);
      if (parts) log("INFO", "parse in parts", { file: fileId, parts });
      res = await analyze(request);
    }
  } catch (e: any) {
    if (e?.status === 415 || e?.status === 422 || (f.pipeline_run_id && e?.status === 409)) {
      // Файл нечитаем — повтор бессмысленен (ТЗ: NOT_COMPARABLE, запросить замену)
      await db.run("update files set parse_status = 'FAILED', parse_error = $1 where id = $2", [String(e.message), fileId]);
      return;
    }
    // ML недоступен (перезапуск контейнера, OOM): дождаться его готовности, а не сжечь попытки за секунды —
    // на стенде «Алтуфьево» 27 файлов ушли в FAILED за время одного перезапуска ML (T-129)
    if (e?.status === 0) await waitMlReady(config.mlWaitMs);
    throw e;
  }
  observeParamTimes(res); // NFR-PERF-RUNTIME: время ML-анализа параметров — в гистограмму /metrics
  // Ответ ML — вне транзакции (сеть); запись результата — одной транзакцией
  await db.tx((t) => publishParsedFile(t, fileId, f.pipeline_run_id ?? null, res));
}

/** Shared by the inline parser and durable aggregate commit. Caller owns the transaction. */
export async function publishParsedFile(t: DB, fileId: string, runId: string | null,
  res: Awaited<ReturnType<typeof analyze>>): Promise<void> {
  await preserveFileResult(t, fileId);
  const ins = `insert into extractions (file_id, param_code, kind, raw, value_num, value_text, page, bbox_json, anchor_bbox_json, line_text, confidence, meta_json)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
  await t.run("delete from extractions where file_id = $1", [fileId]);
  await t.run("delete from rooms where file_id = $1", [fileId]);
  for (const [kind, list] of [["param", res.extractions], ["fact", res.facts]] as const) {
    for (const e of list) await t.run(ins, [fileId, e.code, kind, e.raw, e.value_num, e.value_text, e.page, e.bbox ? JSON.stringify(e.bbox) : null, e.anchor_bbox ? JSON.stringify(e.anchor_bbox) : null, e.line_text, e.confidence, e.meta ? JSON.stringify(e.meta) : null]);
  }
  for (const r of res.rooms) await t.run("insert into rooms (file_id, number, name, page, bbox_json) values ($1,$2,$3,$4,$5)", [fileId, r.number, r.name, r.page, r.bbox ? JSON.stringify(r.bbox) : null]);
  await t.run("update files set parse_status = 'DONE', parse_error = null, pages_json = $1, engine = $2, ml_revision = $3 where id = $4", [JSON.stringify(res.pages), res.engine, res.ml_revision ?? null, fileId]);
  await publishPipelineRun(t, fileId, runId);
  await saveParseExtras(t, fileId, res); // OS-INSP-1.4.4: перечень скрытых работ и заголовок документа
  await saveRequisites(t, fileId, res); // OS-INSP-2.3.1: печати, подписи, штампы
  await saveChangeMarks(t, fileId, res); // T-177 (CMP-29): облака, «Изм. N», таблица изменений штампа
}

/**
 * Запустить разбор всех ещё не разобранных файлов (PENDING → PARSING). Проверка статуса и перевод в PARSING —
 * одной транзакцией под блокировкой: два одновременных «старта» не ставят файлы в очередь дважды.
 */
export async function startProcessing(ctx: Ctx, inspectionId: string, roleChanges = new Set<string>()): Promise<{ queued: number }> {
  const { db } = ctx;
  // OS-INSP-2.1.12: версия интеллектуальной части сменилась — файлы, разобранные прежней версией, разбираются заново.
  // ML недоступен или версию не сообщает — только ждущие и упавшие, как раньше
  const current = (await mlHealth().catch(() => ({ ok: false }) as { ok: boolean; ml_revision?: string | null })).ml_revision ?? null;
  const { files } = await withPipelineSourceLock(() => db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    if (insp.status === "FINALIZED") throw new HttpError(409, "Протокол финализирован");
    if (insp.status === "PARSING") throw new HttpError(409, "Разбор уже идёт");
    const files = await t.all<{ id: string; sha256: string; kind: string }>(
      `select id,sha256,kind from files where inspection_id = $1 and (parse_status in ('PENDING', 'FAILED')
         or ($2::text is not null and parse_status = 'DONE' and ml_revision is distinct from $2::text)) order by uploaded_at, id`,
      [inspectionId, current],
    );
    // Commit recovery context with the start: a restart must retain changed sources and verification state.
    await t.run(`update inspections set status = 'PARSING', updated_at = $1,
      processing_resume_status = $3, processing_changed_files_json = $4 where id = $2`,
      [now(), inspectionId, insp.status, JSON.stringify([...new Set([...roleChanges, ...files.map((f) => f.id)])])]);
    if (files.length) await t.run("update files set parse_status = 'PENDING' where id in (select jsonb_array_elements_text($1::jsonb))", [files.map((f) => f.id)]);
    const prepared: Array<{ id: string; durable: boolean }> = [];
    for (const file of files) {
      const request = config.pipelineExecution === "durable" && ["pdf", "docx", "xml"].includes(file.kind)
        ? await buildParseRequest(t, file.sha256) : undefined;
      prepared.push({ id: file.id, durable: await preparePipelineRun(t, file.id, request) });
    }
    await audit({ ...ctx, db: t }, "PROCESSING_STARTED", inspectionId, { files: files.length, previous_status: insp.status });
    return { previous: insp.status as ProcessStatus, files: prepared };
  }));
  if (!files.length) {
    // новых файлов нет — новых пар редакций для диффа листов тоже: пересчёт сразу, как раньше
    await recompute(db, inspectionId, new Set());
    return { queued: 0 };
  }
  const q = parseQueue(db);
  for (const f of files) if (!f.durable) q.push(f.id, { fileId: f.id, inspectionId });
  return { queued: files.length };
}


/**
 * T-177 (OS-INSP-1.5.2): пересчитать параметры после регистрации согласованного изменения — CMP-29 видит реестр.
 * Только у выпущенного протокола вне разбора и финализации (проверка — под блокировкой в recompute); статус
 * верификации сохраняется, общий статус возврата разбора не трогается.
 */
export async function recomputeParams(db: DB, inspectionId: string, codes: string[]): Promise<boolean> {
  const r = await recompute(db, inspectionId, new Set(), new Set(codes), ["READY", "VERIFYING", "COMPLETED"]);
  return r.version > 0;
}

const finishing = new Set<string>();

export async function maybeFinishParsing(db: DB, inspectionId: string): Promise<void> {
  const left = (await db.get<{ n: number }>("select count(*) n from files where inspection_id = $1 and parse_status in ('PENDING', 'PARSING')", [inspectionId]))!;
  if (left.n > 0 || finishing.has(inspectionId)) return;
  // Флаг — до следующего await: второй завершившийся файл не запускает пересчёт повторно. Статус читается уже
  // после флага: если первый успел пересчитать и снять флаг, второй увидит READY, а не устаревший PARSING.
  finishing.add(inspectionId);
  try {
    const insp = await getInspection(db, inspectionId);
    if (insp.status !== "PARSING") return;
    await autoSheetDiff(db, inspectionId); // OS-INSP-3.4: дифф листов пар редакций — до выпуска протокола
    await recompute(db, inspectionId, new Set());
    await runAdvisorLater(db, inspectionId); // OS-INSP-3.2.4: LLM-советник после разбора (если провайдер доступен)
  } finally {
    finishing.delete(inspectionId);
  }
}

// ─────────────────────────────── OS-INSP-3 сопоставление и протокол

interface ExtractionRow {
  file_id: string;
  param_code: string;
  kind: string;
  raw: string;
  value_num: number | null;
  value_text: string | null;
  page: number;
  bbox_json: string | null;
  anchor_bbox_json?: string | null;
  sha256: string;
  doc_stage: Stage;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  revision_role: "CURRENT" | "SUPERSEDED" | "CONFLICT" | "UNRESOLVED";
  discipline: string | null;
  meta_json: string | null;
  line_text: string | null;
  confidence: number | null;
}

/**
 * Пересчёт доказательных групп. Первый прогон — все параметры; далее — только параметры, по которым
 * появились новые данные, либо чьи источники сменили роль редакции (OS-INSP-3.3.4).
 * Весь пересчёт — одна транзакция под блокировкой проверки: номер версии, записи, статус и снимок протокола
 * согласованы, а решение инспектора, пришедшее во время пересчёта, ждёт его конца и не теряется.
 */
export async function recompute(db: DB, inspectionId: string, roleChanged: Set<string>, forceParams: ReadonlySet<string> = new Set(), onlyIn?: ProcessStatus[]): Promise<{ version: number; recomputed: number }> {
  const out = await db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    // T-177 (OWASP SEC-06): пересчёт по регистрации изменения — только при выпущенном протоколе в допустимом статусе,
    // проверка под блокировкой: финализация или разбор, успевшие между регистрацией и пересчётом, не затираются
    if (onlyIn && (!(insp.protocol_version >= 1) || !onlyIn.includes(insp.status))) return null;
    const changedSources = new Set([...roleChanged, ...(!onlyIn
      ? JSON.parse(insp.processing_changed_files_json ?? "[]") as string[] : [])]);
    const obj = (await t.get<Record<string, any>>("select * from objects where id = $1", [insp.object_id]))!;
    const profile = JSON.parse(obj.profile_json ?? "{}");
    const params = await loadParams(t);
    const version = (insp.protocol_version as number) + 1;
    const first = version === 1;
    await assignPageOffsets(t, inspectionId); // OS-INSP-1.2.10: сквозные страницы документа из частей
    await refreshLoad(t, inspectionId); // OS-INSP-1.2.34: число страниц известно только после разбора

    // OS-INSP-2.2.7: смета и опросный лист — не источник проектного значения; OS-INSP-2.2.54: кроме параметра, чей паспорт
    // называет этот вид документа источником (М-132 — смета)
    const rows = (await t.all<ExtractionRow & { doc_type: string | null }>(`select e.*, f.sha256, f.doc_stage, f.document_code, f.revision, f.approval_status, f.revision_role, f.discipline, f.doc_type
      from extractions e join files f on f.id = e.file_id where f.inspection_id = $1 and f.parse_status = 'DONE' order by e.id`, [inspectionId])).filter((r) => isSourceFor(r.doc_type, sourceDocTypesOf(r.param_code)));
    const newFiles = new Set(
      (await t.all<{ id: string }>(`select id from files where inspection_id = $1
        and uploaded_at > coalesce((select max(created_at) from protocols where inspection_id = $1), '-infinity'::timestamptz)`, [inspectionId])).map((r) => r.id),
    );
    const affected = new Set<string>();
    // OS-INSP-2.1.15: правила сравнения сменились — пересчёт всех параметров без повторного разбора
    if (recomputeAllParams(first, insp.rules_version as string | null)) params.forEach((p) => affected.add(p.code));
    else {
      for (const r of rows) if (newFiles.has(r.file_id) || changedSources.has(r.file_id)) affected.add(r.param_code);
      const frags = await t.all<{ param_code: string; file_id: string }>("select distinct c.param_code, fr.file_id from evidence_fragments fr join checks c on c.id = fr.check_id where c.inspection_id = $1", [inspectionId]);
      for (const f of frags) if (changedSources.has(f.file_id)) affected.add(f.param_code);
      // параметры, у которых раньше не было данных вовсе (MISSING_EVIDENCE), тоже пересматриваются при появлении новых стадий
      const newIds = [...newFiles];
      const loadedBefore = new Set((await t.all<{ doc_stage: string }>("select distinct doc_stage from files where inspection_id = $1 and id not in (select jsonb_array_elements_text($2::jsonb))", [inspectionId, newIds])).map((r) => r.doc_stage));
      const newStages = [...new Set((await t.all<{ doc_stage: string }>("select doc_stage from files where id in (select jsonb_array_elements_text($1::jsonb))", [newIds])).map((r) => r.doc_stage))].filter((s) => !loadedBefore.has(s));
      if (newStages.length) params.forEach((p) => affected.add(p.code));
    }
    for (const c of forceParams) affected.add(c); // T-177: зарегистрировано согласованное изменение — параметр пересчитывается (CMP-29)
    const loadedStages = [...new Set((await t.all<{ doc_stage: Stage }>("select doc_stage from files where inspection_id = $1", [inspectionId])).map((r) => r.doc_stage))];

    const byParam = new Map<string, ExtractionRow[]>();
    for (const r of rows.filter((x) => x.kind === "param" && x.revision_role !== "SUPERSEDED")) byParam.set(r.param_code, [...(byParam.get(r.param_code) ?? []), r]);
    const classSuspicions: Array<{ param: string; s: import("../domain/class-param.ts").ClassSuspicion }> = [];
    const quantitySuspicions: Array<{ param: string; s: QuantitySuspicion }> = [];
    const kindSuspicions: Array<{ param: string; kind: ParamKind; s: KindSuspicion }> = []; // T-186: виды из реестра
    // OS-INSP-3.1.18 (LNK-01, T-132): комплект ПД — по базовому шифру документов РД пакета, даже если показателя в РД нет
    const kitBases = new Set(
      (await t.all<{ file_name: string; document_code: string | null }>("select file_name, document_code from files where inspection_id = $1 and doc_stage = 'RD'", [inspectionId]))
        .map((f) => parseDocName(f.document_code || f.file_name).base)
        .filter((b): b is string => Boolean(b)),
    );
    const pdKitPresent = (await t.all<{ file_name: string; document_code: string | null }>("select file_name, document_code from files where inspection_id = $1 and doc_stage = 'PD'", [inspectionId]))
      .some((f) => kitBases.has(parseDocName(f.document_code || f.file_name).base ?? ""));

    const existing = new Map((await t.all<Record<string, any>>("select * from checks where inspection_id = $1 and parent_id is null", [inspectionId])).map((c) => [c.param_code as string, c]));
    const insCheck = `insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
        review_priority, reason, stage_notes_json, computed_in_version, created_at, updated_at, provenance_json, l8_json, approved_change_ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;
    const updCheck = `update checks set evidence_group_id = $1, finding_status = $2, verification_status = $3, expected_value = $4, actual_value = $5, delta = $6,
        review_priority = $7, reason = $8, stage_notes_json = $9, computed_in_version = $10, updated_at = $11, provenance_json = $13, l8_json = $14, approved_change_ref = $15 where id = $12`;
    const pkg = await loadPackageL8(t, inspectionId); // T-177: редакции, отметки изменений, реестр изменений, покрытие
    const normBase = await loadNormBase(t); // T-234: нормы CMP-06 — из таблицы normative_base (один источник)
    const insFrag = `insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

    let recomputed = 0;
    let carried = 0;
    let reopened = 0;
    for (const p of params) {
      if (!affected.has(p.code)) continue;
      recomputed++;
      const values: StageValue[] = [];
      for (const s of STAGES) {
        // T-133 (OS-INSP-2.2.21) и OS-INSP-2.2.4: сначала источник своей стадии по Матрице, нет его — профильные разделы;
        // М-059 «толщина плиты» не собирается из ЭЭ и ВК ни в одном круге
        const cands = pickStageSources((byParam.get(p.code) ?? []).filter((r) => r.doc_stage === s), p, s, (r) => r.discipline ?? parseDocName(r.document_code).discipline);
        // один источник на стадию: предпочтение актуальной редакции и профильному разделу; спорные редакции видны все
        const disputed = cands.filter((c) => c.revision_role === "CONFLICT" || c.revision_role === "UNRESOLVED");
        const chosen = disputed.length ? disputed : cands.sort((a, b) => score(b, p) - score(a, p)).slice(0, 1);
        for (const r of chosen)
          values.push({
            stage: s,
            num: r.value_num,
            text: r.value_text,
            raw: r.raw,
            source: { file_id: r.file_id, sha256: r.sha256, stage: s, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status, page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, role: r.revision_role },
          });
      }
      // T-129: параметр с паспортом-классом (М-023) — все упоминания, приоритет источников, комплект по шифру, шкала
      const pp = passportFor(p.code);
      // T-233: строгий источник по паспорту — раздел вне списка стадии не даёт значения ни одному виду параметра
      const paramRows = (byParam.get(p.code) ?? []).filter(
        (r) => !pp || inPassportSources(pp.sources, r.doc_stage, disciplineKey(r.discipline) ?? disciplineKey(parseDocName(r.document_code).discipline)),
      );
      const qp = pp ? quantityPassport(pp) : null;
      const cp = pp ? classPassport(pp) : null;
      const kd = pp && !qp && !cp ? kindOf(pp.value.kind, pp.code) : null; // T-186: вид из реестра (OS-INSP-7.1.22)
      let provenance: unknown = null;
      let ev: ReturnType<typeof evaluate>;
      let op = opFor(p, "lexical");
      if (qp) {
        op = opFor(p, "quantity", qp);
        // T-132: количественный параметр с паспортом (М-001) — все упоминания, комплект по шифру РД, допуск паспорта
        const mentions: QuantityMention[] = paramRows.filter((r) => r.value_num !== null).map((r) => {
          const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
          const name = parseDocName(r.document_code);
          return {
            stage: r.doc_stage, file_id: r.file_id, sha256: r.sha256, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status,
            role: r.revision_role, discipline: disciplineKey(r.discipline) ?? disciplineKey(name.discipline), base: name.base, num: r.value_num!,
            excluded: typeof meta.excluded === "string" ? meta.excluded : null, excluded_why: typeof meta.excluded_why === "string" ? meta.excluded_why : null,
            page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, anchor_bbox: r.anchor_bbox_json ? JSON.parse(r.anchor_bbox_json) : null, quote: meta.quote ?? r.line_text ?? "", confidence: r.confidence ?? 0,
            ...quantityMeta(meta),
            ...mentionTrace(meta),
          };
        });
        const qev = evaluateQuantityParam({ param: p, passport: qp, mentions, loadedStages, profile, kitBases, pdKitPresent });
        provenance = qev.provenance;
        for (const x of qev.suspicions) quantitySuspicions.push({ param: p.code, s: x });
        ev = qev;
      } else if (pp && cp) {
        op = opFor(p, "class");
        const mentions: Mention[] = paramRows.filter((r) => r.value_text).map((r) => {
          const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
          const name = parseDocName(r.document_code);
          return {
            stage: r.doc_stage, file_id: r.file_id, sha256: r.sha256, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status,
            role: r.revision_role, discipline: disciplineKey(r.discipline) ?? disciplineKey(name.discipline), base: name.base, value: r.value_text!,
            qualifier: meta.qualifier === "min" ? "min" : null, excluded: meta.excluded ?? null, excluded_why: meta.excluded_why ?? null,
            // T-172 (OS-INSP-2.2.43): класс конструкции — ключ поэлементного сравнения; строка из ML, обрезается
            element: elementOf(pp, meta.element),
            ...(p.code === "M-022" ? fireSubjectTrace(meta) : {}),
            // рамка оборота класса не передаётся: оборот часто переносится на две строки, прицел раздувался бы на весь лист
            page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, quote: meta.quote ?? r.line_text ?? "",
            // уверенность правил до судьи VLM (meta.confidence_rules): судья не двигает порядок выбора (SEC-02)
            confidence: typeof meta.confidence_rules === "number" ? meta.confidence_rules : (r.confidence ?? 0),
            ...mentionTrace(meta),
          };
        });
        const cev = evaluateClassParam({ param: p, passport: cp, mentions, loadedStages, profile });
        provenance = cev.provenance;
        for (const x of cev.suspicions) classSuspicions.push({ param: p.code, s: x });
        ev = cev;
      } else if (pp && kd) {
        const kev = kd.evaluate({ param: p, passport: kindSlice(pp), mentions: kindMentions(kd, paramRows), loadedStages, profile, kitBases, pdKitPresent, norms: normBase });
        provenance = kev.provenance;
        for (const x of kev.suspicions) kindSuspicions.push({ param: p.code, kind: kd, s: x });
        ev = kev;
      } else ev = evaluate({ param: p, profile, values, loadedStages });
      // T-177 (ADR-0008 п. 2): общий понижающий слой L6/L8 и CMP-29 после любого оператора — одна точка для всех путей
      const { l8, ...lowered } = verifyL8(ev, contextFor(pkg, p, op, Boolean(qp || cp), byParam.get(p.code) ?? [], Boolean(kd && (pp!.value as { norm?: unknown }).norm)));
      ev = lowered;
      const group = `${insp.object_id}:${p.code}:${sha256(ev.fragments.map((f) => `${f.file_id}@${f.page}`).join("|")).slice(0, 10)}`;
      const prev = existing.get(p.code);
      let checkId: string;
      if (!prev) {
        checkId = `F-${insp.object_id}-${p.code}`.replace(/[^\w-]/g, "") + "-" + randomUUID().slice(0, 4);
        await t.run(insCheck, [checkId, inspectionId, p.code, group, ev.status, "PENDING", ev.expected, ev.actual, ev.delta, p.review_priority, ev.reason, JSON.stringify(ev.stage_notes), version, now(), now(), provenance ? JSON.stringify(provenance) : null, JSON.stringify(l8), l8.approved_change_ref]);
      } else {
        checkId = prev.id;
        // OS-INSP-3.3.5–3.3.6: решение относится к доказательству — файлу, странице, рамке и значению, а не только к значению
        const prevFrags = await t.all<Record<string, any>>("select sha256, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual from evidence_fragments where check_id = $1", [checkId]);
        const prevFp = evidenceFingerprint(prevFrags.map((x) => ({ sha256: x.sha256, page: x.sheet_page, bbox: x.bbox_polygon_norm ? JSON.parse(x.bbox_polygon_norm) : null, value: x.extracted_value, role: x.role_expected_actual })));
        const nextFp = evidenceFingerprint(ev.fragments.map((x) => ({ sha256: x.sha256, page: x.page, bbox: x.bbox, value: x.value, role: x.kind })));
        let verification = prev.verification_status;
        const carry = carryDecision({ verification, prevFp, nextFp, prevStatus: prev.finding_status, nextStatus: ev.status });
        if (carry === "CARRY") carried++;
        if (carry === "RESET") {
          // доказательство изменилось — прежнее решение остаётся в истории, запись снова на оценке
          await t.run("update decisions set superseded = true where check_id = $1 and not superseded", [checkId]);
          verification = "PENDING";
          reopened++;
        }
        await t.run(updCheck, [group, ev.status, verification, ev.expected, ev.actual, ev.delta, p.review_priority, ev.reason, JSON.stringify(ev.stage_notes), version, now(), checkId, provenance ? JSON.stringify(provenance) : null, JSON.stringify(l8), l8.approved_change_ref]);
        await t.run("delete from evidence_fragments where check_id = $1", [checkId]);
      }
      for (const f of ev.fragments) await t.run(insFrag, [checkId, f.file_id, f.sha256, f.stage, f.document_code, f.revision, f.approval_status, f.page, f.bbox ? JSON.stringify(f.bbox) : null, f.value, f.kind]);
    }
    await writeCascades(t, inspectionId); // T-177 (VER-12): производные кандидаты — к корню каскада
    await writeAiScores(t, inspectionId); // OS-INSP-6.4.9: оценка модели ранжирования кандидатам
    await writeSuspicions(t, inspectionId, insp.object_id, rows);
    // OS-INSP-3.1.12 (CMP-30, FRE-05): внутреннее противоречие класса внутри стадии — гипотеза, не нарушение
    const refOf = (m: Mention) => `${m.document_code}, ред. ${m.revision}, стр. ${m.page}`;
    for (const { param, s: x } of classSuspicions) {
      // опорное упоминание (худший класс с рамкой): по нему гипотеза переводится в кандидаты с листом (T-129)
      const pv = passportFor(param)?.value;
      const a = conflictAnchor(x, pv?.kind === "ordinal" ? pv.scale : []);
      // цитата опоры — сам класс («С1», «не ниже С1»): она становится фактическим значением кандидата на экране
      const anchor = a ? JSON.stringify({ file_id: a.file_id, page: a.page, bbox: a.bbox, quote: a.qualifier === "min" ? `не ниже ${a.value}` : a.value }) : null;
      await t.run(`insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, pd_reference, rd_reference, review_priority, normative_base, dedup_key, advisor_ref_json)
        values ($1,$2,'INTERNAL_CONSISTENCY',$3,$4,$5,$6,'HIGH',$7,$8,$9) on conflict (inspection_id, dedup_key) do update set description = excluded.description, pd_reference = excluded.pd_reference, rd_reference = excluded.rd_reference, advisor_ref_json = excluded.advisor_ref_json`, [
        inspectionId, insp.object_id, Math.min(...x.mentions.map((m) => m.confidence)), `${param}: ${x.description}`,
        x.stage === "PD" ? x.mentions.map(refOf).join("; ") : null, x.stage !== "PD" ? x.mentions.map(refOf).join("; ") : null, passportFor(param)?.basis ?? null, boundedDedupKey(`${param}:${x.dedup_key}`), anchor,
      ]);
    }
    // OS-INSP-3.1.19 (CMP-30, T-132): площадь по-разному в разделах одной стадии — гипотеза; опора — первое упоминание с рамкой
    for (const { param, s: x } of quantitySuspicions) {
      const a = x.mentions.find((m) => m.bbox !== null) ?? null;
      const anchor = a ? JSON.stringify({ file_id: a.file_id, page: a.page, bbox: a.bbox, quote: String(a.num).replace(".", ",") }) : null;
      const ref = (m: QuantityMention) => `${m.document_code}, ред. ${m.revision}, стр. ${m.page}`;
      await t.run(`insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, pd_reference, rd_reference, review_priority, normative_base, dedup_key, advisor_ref_json)
        values ($1,$2,'INTERNAL_CONSISTENCY',$3,$4,$5,$6,'HIGH',$7,$8,$9) on conflict (inspection_id, dedup_key) do update set description = excluded.description, pd_reference = excluded.pd_reference, rd_reference = excluded.rd_reference, advisor_ref_json = excluded.advisor_ref_json`, [
        inspectionId, insp.object_id, Math.min(...x.mentions.map((m) => m.confidence)), `${param}: ${x.description}`,
        x.stage === "PD" ? x.mentions.map(ref).join("; ") : null, x.stage !== "PD" ? x.mentions.map(ref).join("; ") : null, passportFor(param)?.basis ?? null, boundedDedupKey(`${param}:${x.dedup_key}`), anchor,
      ]);
    }
    // T-186 (OS-INSP-7.1.23): гипотезы видов из реестра — общий путь записи, как у количественного параметра
    for (const { param, kind, s: x } of kindSuspicions) {
      const r = suspicionRecord(param, x, passportFor(param)?.basis ?? null, kind.quote);
      await t.run(`insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, pd_reference, rd_reference, review_priority, normative_base, dedup_key, advisor_ref_json)
        values ($1,$2,'INTERNAL_CONSISTENCY',$3,$4,$5,$6,'HIGH',$7,$8,$9) on conflict (inspection_id, dedup_key) do update set description = excluded.description, pd_reference = excluded.pd_reference, rd_reference = excluded.rd_reference, advisor_ref_json = excluded.advisor_ref_json`, [
        inspectionId, insp.object_id, r.confidence, r.description, r.pd_reference, r.rd_reference, r.normative_base, boundedDedupKey(r.dedup_key), r.anchor,
      ]);
    }
    await writeHiddenWorks(t, inspectionId, version); // OS-INSP-1.4.4
    await writeRequisites(t, inspectionId, version); // OS-INSP-2.3.2

    const resume = onlyIn ? (insp.status as ProcessStatus) : (insp.processing_resume_status as ProcessStatus | null);
    const next: ProcessStatus = first || !resume || resume === "PENDING" || resume === "READY" ? "READY" : statusAfterDecision(await liveChecks(t, inspectionId) as any[]);
    await t.run("update inspections set protocol_version = $1, status = $2, updated_at = $3, rules_version = $5 where id = $4", [version, next, now(), inspectionId, RULES_VERSION]);
    if (!onlyIn) await t.run(`update inspections set processing_resume_status = null,
      processing_changed_files_json = '[]' where id = $1`, [inspectionId]);
    await snapshotProtocol(t, inspectionId, "DRAFT");
    await notify(t, "inspector", inspectionId, "INFO", first ? `Протокол v${version} сформирован и ожидает верификации` : `Протокол обновлён до v${version}: пересчитано параметров — ${recomputed}; решений перенесено — ${carried}, снова на оценке — ${reopened}`);
    return { version, recomputed, carried, reopened };
  });
  if (!out) return { version: 0, recomputed: 0 };
  await attachNormsLater(db, inspectionId); // OS-INSP-3.2.6: норма к гипотезам без нормы — после фиксации, вне транзакции
  return out;
}

/** Виды документа — источник значения параметра вопреки OS-INSP-2.2.7 (OS-INSP-2.2.54, T-173). */
function sourceDocTypesOf(code: string): string[] {
  const pp = passportFor(code);
  return pp ? sourceDocTypes(pp) : [];
}

// quantityMeta вынесена в domain/quantity-param.ts (T-233): её же читает стенд оценки (scripts/eval-passports.ts)
export { quantityMeta };

function score(r: ExtractionRow, p: Param): number {
  let s = r.revision_role === "CURRENT" ? 10 : 0;
  if (r.discipline && (p.section.startsWith(r.discipline) || r.discipline === p.section)) s += 2;
  return s + (r.value_num !== null || r.value_text ? 1 : 0);
}

/**
 * OS-INSP-7.2.4 (T-234): правка нормы доходит до расчёта сразу — параметры, зависящие от записи (param_code,
 * applies_to, паспорта с value.norm.ref), пересчитываются во всех проверках с выпущенным протоколом вне разбора и
 * финализации (как после регистрации согласованного изменения). Возвращает пересчитанные проверки.
 */
export async function recomputeAfterNormChange(db: DB, norm: { norm_key?: string | null; param_code?: string | null; applies_to_json?: string | null }): Promise<string[]> {
  const codes = paramsForNorm(norm, passportNormRefs());
  if (!codes.length) return [];
  const ids = (await db.all<{ id: string }>(`select distinct c.inspection_id id from checks c join inspections i on i.id = c.inspection_id
      where c.param_code in (select jsonb_array_elements_text($1::jsonb)) and i.protocol_version >= 1 and i.status in ('READY', 'VERIFYING', 'COMPLETED') order by 1`, [JSON.stringify(codes)])).map((r) => r.id);
  const done: string[] = [];
  for (const id of ids) if (await recomputeParams(db, id, codes)) done.push(id);
  return done;
}

/**
 * ТЗ §10 Normative_Base — один источник норм (T-234): записи с norm_key (пределы CMP-06 паспортов, сроки действия,
 * флаг активности) для оценщиков видов. Правка администратора в интерфейсе видна следующему пересчёту.
 */
export async function loadNormBase(db: DB): Promise<NormRecord[]> {
  return (await db.all<Record<string, any>>("select * from normative_base where norm_key is not null order by id")).map(normRecordFromRow);
}

async function writeSuspicions(db: DB, inspectionId: string, objectId: string, rows: ExtractionRow[]): Promise<void> {
  const current = rows.filter((r) => r.revision_role !== "SUPERSEDED");
  const facts: Fact[] = current.map((r) => ({ key: r.param_code, num: r.value_num, text: r.value_text, stage: r.doc_stage, ref: `${r.document_code}, ред. ${r.revision}, стр. ${r.page}` }));
  const rooms = await db.all<Record<string, any>>(`select r.*, f.doc_stage, f.document_code, f.revision from rooms r join files f on f.id = r.file_id
      where f.inspection_id = $1 and f.revision_role != 'SUPERSEDED' order by r.id`, [inspectionId]);
  const roomFacts: Room[] = rooms.map((r) => ({ number: r.number, name: r.name, stage: r.doc_stage, ref: `${r.document_code}, ред. ${r.revision}, стр. ${r.page}` }));
  const norms = await db.all<Record<string, any>>("select * from normative_base where param_code is not null order by id");
  const candidates = new Set((await db.all<{ param_code: string }>("select param_code from checks where inspection_id = $1 and finding_status = 'CANDIDATE'", [inspectionId])).map((r) => r.param_code));
  const list = dedupe([
    ...logical(await logicalRules(db), facts),
    ...semantic(roomFacts),
    // T-234: норма действует на дату пересчёта (Normative_Base.effective_from/effective_to)
    ...normative(norms.map((n) => ({ ...n, is_active: Boolean(n.is_active) })) as NormEntry[], facts, candidates, now()),
    ...(await patternSuspicions(db, objectId, facts)), // OS-INSP-3.2.9: ML-паттерн по истории других объектов
  ]);
  const up = `insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, pd_reference, rd_reference, review_priority, normative_base, dedup_key)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (inspection_id, dedup_key) do update set confidence = excluded.confidence, description = excluded.description,
      pd_reference = excluded.pd_reference, rd_reference = excluded.rd_reference`;
  for (const s of list) await db.run(up, [inspectionId, objectId, s.discovery_method, s.confidence, s.description, s.pd_reference, s.rd_reference, s.review_priority, s.normative_base, boundedDedupKey(s.dedup_key)]);
}

// ─────────────────────────────── протокол

export async function checkRows(db: DB, inspectionId: string, deferDetails = false): Promise<CheckRow[]> {
  // Порядок как в SQLite: записи вне Матрицы (p.id is null) — первыми; id — побайтно (collate "C"), независимо от локали сервера
  // about_param — параметр, к которому относится гипотеза, переведённая в кандидаты (ключ гипотезы «M-023:…»):
  // по нему очередь фильтруется по параметру (OS-INSP-4.1.17, T-130)
  const columns = deferDetails
    ? "c.id, c.param_code, c.evidence_group_id, c.finding_status, c.verification_status, c.expected_value, c.actual_value, c.delta, c.review_priority, c.reason, c.parent_id, c.title, c.approved_change_ref, c.derived_from, c.completeness_status, null as provenance_json, null as l8_json, (c.provenance_json is not null) as has_provenance"
    : "c.*";
  const checks = await db.all<Record<string, any>>(`select ${columns}, p.parameter_name, p.section, p.unit, p.id pid, split_part(s.dedup_key, ':', 1) about_param, s.id sid, s.description sdesc
      from checks c left join params p on p.id = c.param_id left join suspicions s on s.promoted_check_id = c.id
      where c.inspection_id = $1 order by p.id nulls first, c.id collate "C"`, [inspectionId]); // T-234: ссылка на Матрицу — Checks.param_id
  const frags = await db.all<FragmentRow & { check_id: string }>(`select fr.*, f.part_index, f.page_offset, f.pipeline_result_run_id pipeline_run_id from evidence_fragments fr join checks c on c.id = fr.check_id left join files f on f.id = fr.file_id
      where c.inspection_id = $1 order by fr.id`, [inspectionId]);
  const decs = await db.all<Record<string, any>>(`select d.*, u.name user_name from decisions d join users u on u.id = d.user_id join checks c on c.id = d.check_id
      where c.inspection_id = $1 and not d.superseded order by d.id`, [inspectionId]);
  const fragBy = new Map<string, FragmentRow[]>();
  for (const f of frags) fragBy.set(f.check_id, [...(fragBy.get(f.check_id) ?? []), f]);
  const decBy = new Map<string, Record<string, any>>();
  for (const d of decs) decBy.set(d.check_id, d);
  // параметры вне Матрицы (дифф листов) — имя и раздел из предметного словаря
  const virt = (code: string) => (code === SHEET_DIFF_CODE ? SHEET_DIFF_PARAM : null);
  return attachApprovedChanges(db, inspectionId, checks.map((c) => ({
    id: c.id,
    param_code: c.param_code,
    // кандидат из гипотезы — с текущим текстом гипотезы: пересчёт уточняет её (все разделы — OS-INSP-3.1.17), а снимок
    // на момент перевода в кандидаты устаревает (T-130: в очереди оставалось «… КР — С1 (стр. 6» без ПОС)
    parameter_name: c.sid ? `Гипотеза #${c.sid}: ${String(c.sdesc ?? "").slice(0, 160)}` : (c.title ?? c.parameter_name ?? virt(c.param_code)?.parameter_name ?? c.param_code),
    section: c.section ?? virt(c.param_code)?.section ?? "",
    unit: c.unit ?? "",
    evidence_group_id: c.evidence_group_id,
    finding_status: c.finding_status,
    verification_status: c.verification_status,
    expected_value: c.expected_value,
    actual_value: c.actual_value,
    delta: c.delta,
    review_priority: c.review_priority,
    reason: c.sid ? `Гипотеза вне Матрицы переведена в кандидаты инспектором: ${c.sdesc ?? ""}` : c.reason,
    parent_id: c.parent_id,
    title: c.title,
    about_param: c.pid ? c.param_code : c.about_param || null,
    // T-130: provenance доказательной группы (все упоминания стадий с источником и вердиктом судьи) — в протокол и
    // карточку; раньше поле не доходило до протокола (provenance: null в выходном наборе T-129)
    provenance_json: c.provenance_json ?? null,
    has_provenance: c.has_provenance ?? Boolean(c.provenance_json),
    // T-177: след слоя L8 — причина понижения, изменение CMP-29, просмотренные листы, корень каскада
    l8_json: c.l8_json == null ? null : typeof c.l8_json === "string" ? c.l8_json : JSON.stringify(c.l8_json),
    approved_change_ref: c.approved_change_ref ?? null,
    derived_from: c.derived_from ?? null,
    completeness_status: c.completeness_status ?? null, // ТЗ §10 Checks.completeness_status (T-234): раздел 1 протокола
    fragments: fragBy.get(c.id) ?? [],
    decision: decBy.has(c.id) ? { user_id: decBy.get(c.id)!.user_id, user_name: decBy.get(c.id)!.user_name, action: decBy.get(c.id)!.action, reason_code: decBy.get(c.id)!.reason_code, comment: decBy.get(c.id)!.comment, created_at: decBy.get(c.id)!.created_at } : null,
  }))); // OS-INSP-3.1.9: согласованные изменения к карточкам
}

export async function currentProtocol(db: DB, inspectionId: string) {
  const insp = await getInspection(db, inspectionId);
  const obj = await db.get<any>("select id, name, address, permit_number from objects where id = $1", [insp.object_id]);
  const files = await db.all<any>(`select id file_id, file_name, sha256, doc_stage, document_code, revision, approval_status, revision_role, engine, parse_status, pipeline_result_run_id pipeline_run_id from files
      where inspection_id = $1 order by doc_stage collate "C", document_code collate "C", revision collate "C"`, [inspectionId]);
  const suspicions = await db.all<any>(`select * from suspicions where inspection_id = $1 order by review_priority collate "C" nulls first, id`, [inspectionId]);
  return buildProtocol({
    inspection: { id: insp.id, object_id: insp.object_id, status: insp.status, scenario: insp.scenario as Scenario | null, load_codes: insp.load_codes_json ? JSON.parse(insp.load_codes_json) : [] },
    object: obj,
    versions: { protocol: insp.protocol_version, matrix: await meta(db, "matrix_version"), model: await meta(db, "model_version"), dataset: await meta(db, "dataset_version"), input_manifest_hash: insp.input_manifest_hash ?? "" },
    files,
    checks: (await checkRows(db, inspectionId)).filter((c) => c.verification_status !== "SPLIT"),
    suspicions,
    generated_at: now(),
    ocr_quality: await inspectionOcrQuality(db, inspectionId),
  });
}

/** OS-INSP-2.1.16: отчёт о качестве распознавания проверки — по сводкам страниц разобранных файлов. */
export async function inspectionOcrQuality(db: DB, inspectionId: string) {
  const rows = await db.all<{ file_id: string; file_name: string; pages_json: unknown }>(
    `select id file_id, file_name, pages_json from files where inspection_id = $1 order by doc_stage collate "C", document_code collate "C", revision collate "C", id collate "C"`, [inspectionId]);
  // pages_json — json: драйвер отдаёт уже разобранным; строкой — как есть
  return ocrQuality(rows.map((r) => ({ file_id: r.file_id, file_name: r.file_name, pages_json: r.pages_json == null ? null : typeof r.pages_json === "string" ? r.pages_json : JSON.stringify(r.pages_json) })));
}

async function snapshotProtocol(db: DB, inspectionId: string, status: "DRAFT" | "FINALIZED"): Promise<number> {
  const insp = await getInspection(db, inspectionId);
  const body = await currentProtocol(db, inspectionId);
  await db.run(`insert into protocols (inspection_id, version, matrix_version, dataset_version, model_version, input_manifest_hash, status, body_json, created_at, finalized_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (inspection_id, version) do update set status = excluded.status, body_json = excluded.body_json, finalized_at = excluded.finalized_at`, [
    inspectionId, insp.protocol_version, body.versions.matrix_version, body.versions.dataset_version, body.versions.model_version, body.versions.input_manifest_hash,
    status, JSON.stringify(body), now(), status === "FINALIZED" ? now() : null,
  ]);
  return insp.protocol_version;
}

// ─────────────────────────────── OS-INSP-4 верификация

/** Запись протокола с блокировкой её проверки (внутри tx): сначала узнаём проверку, затем перечитываем запись под блокировкой. */
async function lockCheck(t: DB, checkId: string): Promise<{ c: Record<string, any>; insp: Record<string, any> }> {
  const ref = await t.get<{ inspection_id: string }>("select inspection_id from checks where id = $1", [checkId]);
  if (!ref) throw new HttpError(404, "Запись не найдена");
  const insp = await lockInspection(t, ref.inspection_id);
  const c = await t.get<Record<string, any>>("select * from checks where id = $1", [checkId]);
  if (!c) throw new HttpError(404, "Запись не найдена"); // удалена пересчётом, пока ждали блокировку
  return { c, insp };
}

/** Решение инспектора — одной транзакцией: снятие прежнего решения, новое решение, журналы и статус проверки. */
export async function decide(ctx: Ctx, checkId: string, d: Decision): Promise<Record<string, any>> {
  return ctx.db.tx(async (t) => await decideIn({ ...ctx, db: t }, checkId, d));
}

/**
 * Решение внутри уже открытой транзакции `ctx.db` (OS-INSP-4.1.24): решение, журналы и аудит — одной транзакцией,
 * сбой любой записи откатывает всё. Групповое снятие зовёт её по кандидатам в одной общей транзакции (4.1.25).
 */
export async function decideIn(ctx: Ctx, checkId: string, d: Decision): Promise<Record<string, any>> {
  const t = ctx.db;
  const { c, insp } = await lockCheck(t, checkId);
  if (!canVerify(insp.status)) throw new HttpError(409, insp.status === "FINALIZED" ? "Протокол финализирован: решения неизменяемы" : `Верификация недоступна в статусе ${insp.status}`);
  if (c.verification_status === "SPLIT") throw new HttpError(409, "Составной кандидат разделён — решайте по атомарным записям");
  const r = applyDecision(d);
  if ("error" in r) throw new HttpError(400, r.error);
  await t.run("update decisions set superseded = true where check_id = $1 and not superseded", [checkId]);
  await t.run("insert into decisions (check_id, user_id, action, status, reason_code, comment, created_at) values ($1,$2,$3,$4,$5,$6,$7)", [
    checkId, ctx.user.id, d.action, r.status, d.action === "reject" ? d.reason_code : null, d.comment ?? null, now(),
  ]);
  await t.run("update checks set verification_status = $1, updated_at = $2 where id = $3", [r.status, now(), checkId]);
  // OS-INSP-4.1.6, 4.1.7: журналы отклонений и спорных случаев (ТЗ §10)
  const fromAdvisor = Boolean(await t.get("select 1 from suspicions where promoted_check_id = $1 limit 1", [checkId]));
  const view = { id: checkId, inspection_id: c.inspection_id, param_code: c.param_code, finding_status: c.finding_status, reason: c.reason ?? null, from_advisor: fromAdvisor };
  const rej = rejectionEntry(view, d as any);
  if (rej) await t.run("insert into rejection_log (check_id, inspection_id, param_code, ai_verdict, reason_code, comment, suggested_fix, user_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    rej.check_id, rej.inspection_id, rej.param_code, rej.ai_verdict, rej.reason_code, rej.comment, rej.suggested_fix, ctx.user.id, now()]);
  const dis = disputeEntry(view, d as any);
  if (dis) await t.run("insert into dispute_log (check_id, inspection_id, param_code, kind, ai_comment, inspector_comment, user_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
    dis.check_id, dis.inspection_id, dis.param_code, dis.kind, dis.ai_comment, dis.inspector_comment, ctx.user.id, now()]);
  await setStatus(t, c.inspection_id, statusAfterDecision(await liveChecks(t, c.inspection_id) as any[]));
  await audit(ctx, `DECISION_${d.action.toUpperCase()}`, checkId, { inspection_id: c.inspection_id, param_code: c.param_code, status: r.status, reason_code: d.action === "reject" ? d.reason_code : null, comment: d.comment ?? null, actions: (d as { actions?: number }).actions ?? null });
  return { check_id: checkId, verification_status: r.status, process_status: (await getInspection(t, c.inspection_id)).status, system_comment: systemComment(r.status, d) };
}

/** Системный комментарий ИИ к решению (ТЗ 9.4, примеры). */
export function systemComment(status: string, d: Decision): string {
  if (status === "NEGATIVE_VERIFIED" && d.action === "reject")
    return `Результат инспектора: NEGATIVE_VERIFIED. Причина: ${d.reason_code}. Запись включена в черновик следующей версии набора данных; её использование для обучения допускается только после проверки куратором данных и выпуска dataset_version.`;
  if (status === "CLARIFICATION_REQUIRED") return "Статус: CLARIFICATION_REQUIRED. Показаны точные страницы и доказательные фрагменты. До повторного решения инспектора запись не включается в GOLD и не передаётся во внешнюю систему.";
  return "Результат инспектора: CONFIRMED_VIOLATION. Положительный GOLD-кандидат; передача во внешнюю систему — только после финализации протокола.";
}

/**
 * OS-INSP-4.2: разделить составной кандидат на атомарные findings — по фрагментам «фактических» источников.
 * Одной транзакцией: часть без доказательств откатывает всё разделение, а не оставляет половину частей.
 */
export async function splitCandidate(ctx: Ctx, checkId: string, parts: Array<{ title: string; fragment_ids: number[] }>): Promise<string[]> {
  return ctx.db.tx(async (t) => {
    const { c, insp } = await lockCheck(t, checkId);
    if (c.finding_status !== "CANDIDATE") throw new HttpError(409, "Разделить можно только кандидата");
    if (c.verification_status === "SPLIT") throw new HttpError(409, "Кандидат уже разделён");
    if (!canVerify(insp.status)) throw new HttpError(409, "Верификация недоступна");
    if (parts.length < 2) throw new HttpError(400, "Нужно не меньше двух атомарных частей");
    const frags = await t.all<Record<string, any>>("select * from evidence_fragments where check_id = $1 order by id", [checkId]);
    const expected = frags.filter((f) => f.role_expected_actual === "expected");
    const ids: string[] = [];
    for (const [i, part] of parts.entries()) {
      const own = frags.filter((f) => part.fragment_ids.includes(f.id as number));
      if (!own.length) throw new HttpError(400, `Часть «${part.title}» без доказательств`);
      const id = `${checkId}.${i + 1}`;
      await t.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
          review_priority, reason, stage_notes_json, parent_id, title, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
        id, c.inspection_id, c.param_code, `${c.evidence_group_id}.${i + 1}`, "CANDIDATE", "PENDING", c.expected_value, own.find((f) => f.role_expected_actual === "actual")?.extracted_value ?? c.actual_value,
        c.delta, c.review_priority, c.reason, c.stage_notes_json, checkId, part.title, c.computed_in_version, now(), now(),
      ]);
      for (const f of [...expected, ...own.filter((x) => x.role_expected_actual !== "expected")]) {
        await t.run(`insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, f.file_id, f.sha256, f.stage, f.document_code, f.revision, f.approval_status, f.sheet_page, f.bbox_polygon_norm, f.extracted_value, f.role_expected_actual]);
      }
      ids.push(id);
    }
    await t.run("update checks set verification_status = 'SPLIT', updated_at = $1 where id = $2", [now(), checkId]);
    await audit({ ...ctx, db: t }, "CANDIDATE_SPLIT", checkId, { parts: ids });
    return ids;
  });
}

/** Финализация — одной транзакцией под блокировкой: проверка готовности и снимок протокола видят одно и то же состояние. */
/** OS-INSP-4.3.5: перечень критических параметров без вердикта — с наименованием и статусом, для окна финализации. */
async function criticalDetails(db: DB, inspectionId: string, codes: string[]): Promise<Array<{ param_code: string; parameter_name: string | null; finding_status: string }>> {
  if (!codes.length) return [];
  return db.all(
    `select distinct c.param_code, p.parameter_name, c.finding_status from checks c left join params p on p.code = c.param_code
     where c.inspection_id = $1 and c.param_code in (${codes.map((_, i) => `$${i + 2}`).join(",")}) and c.verification_status = 'PENDING'
     order by c.param_code, c.finding_status`,
    [inspectionId, ...codes],
  );
}

const pageCount = (pagesJson: string | null): number | null => (pagesJson ? (JSON.parse(pagesJson) as unknown[]).length : null);

/** OS-INSP-1.2.35: отчёт о целостности пакета по реестру — для инспектора и стенда (ml/eval/integrity.py). */
export async function integrityFor(db: DB, inspectionId: string): Promise<IntegrityReport> {
  const insp = await getInspection(db, inspectionId);
  const manifest: Manifest | null = insp.manifest_json ? JSON.parse(insp.manifest_json) : null;
  const files = await db.all<Record<string, any>>("select client_file_id, file_name, sha256, pages_json, part_of from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  // T136-L2: отчёту нужен только последний отказ по каждому файлу — журнал дописывается при каждой загрузке
  const rejections = await db.all<Rejection>(`select distinct on (file_name) file_name, code, message, duplicate_of from file_rejections
    where inspection_id = $1 order by file_name, id desc`, [inspectionId]);
  return integrityReport(
    manifest?.files ?? [],
    files.map((f) => ({ client_file_id: f.client_file_id, file_name: f.file_name, sha256: f.sha256, pages: pageCount(f.pages_json), part_of: f.part_of })),
    rejections,
  );
}

/** OS-INSP-4.3.5: перечень для окна финализации — считает сервер, веб правило не повторяет. */
export async function criticalUnresolvedFor(db: DB, inspectionId: string) {
  await getInspection(db, inspectionId);
  return { critical: await criticalDetails(db, inspectionId, criticalUnresolved((await liveChecks(db, inspectionId)) as any[])) };
}

export async function finalize(ctx: Ctx, inspectionId: string, opts: { criticalReviewed?: boolean } = {}): Promise<{ version: number; critical_reviewed: string[] }> {
  return ctx.db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    const ok = canFinalize(insp.status, (await liveChecks(t, inspectionId)) as any[], opts.criticalReviewed === true);
    if (!ok.ok) throw new HttpError(409, ok.reason!, ok.code ? { code: ok.code, critical: await criticalDetails(t, inspectionId, ok.critical!) } : undefined);
    const critical = ok.critical ?? [];
    if (critical.length) await audit({ ...ctx, db: t }, "CRITICAL_POINTS_REVIEWED", inspectionId, { count: critical.length, params: critical });
    await setStatus(t, inspectionId, "FINALIZED");
    await t.run("update inspections set finalized_at = $1, sync_status = 'PENDING_SYNC' where id = $2", [now(), inspectionId]);
    const v = await snapshotProtocol(t, inspectionId, "FINALIZED");
    await t.run("insert into sync_jobs (inspection_id, protocol_version, status, next_attempt_at, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [inspectionId, v, "PENDING_SYNC", now(), now(), now()]);
    await audit({ ...ctx, db: t }, "PROTOCOL_FINALIZED", inspectionId, { version: v });
    return { version: v, critical_reviewed: critical };
  });
}

export async function unfinalize(ctx: Ctx, inspectionId: string, reason: string): Promise<void> {
  await ctx.db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    const ok = canUnfinalize(insp.status, ctx.user.role, reason);
    if (!ok.ok) throw new HttpError(insp.status === "FINALIZED" ? 403 : 409, ok.reason!);
    await setStatus(t, inspectionId, "COMPLETED");
    // M-7: финализированный снимок неизменяем (триггер 0002) — отмена открывает новую версию-черновик, а следующая
    // финализация фиксирует уже её. Прежняя версия остаётся в истории протоколов как была подписана и отправлена
    const version = (insp.protocol_version as number) + 1;
    await t.run("update inspections set finalized_at = null, protocol_version = $1 where id = $2", [version, inspectionId]);
    await snapshotProtocol(t, inspectionId, "DRAFT");
    await audit({ ...ctx, db: t }, "FINALIZATION_CANCELLED", inspectionId, { reason, finalized_version: insp.protocol_version, draft_version: version });
  });
}

/** OS-INSP-2.2.34, NFR-PERF-RUNTIME: время ML-анализа каждого параметра — в гистограмму; ответ из кэша ML не
 *  учитывается — это время прежнего анализа, повтор исказил бы p95. */
export function observeParamTimes(res: Pick<MlResponse, "cached" | "param_ms">): number {
  if (res.cached || !res.param_ms) return 0;
  const ms = Object.values(res.param_ms);
  for (const v of ms) slo.mlParam.observe(v / 1000);
  return ms.length;
}
