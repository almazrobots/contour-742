// OS-INSP-6.1.4–6.1.9 (ТЗ 14.2-04, 9.4.2-03; T-137): печать скрытого теста. Чистые функции: IO — services/hidden-seal.ts.
// Печать хранит только SHA-256 файлов и их роль («вход» / «метки»), без путей: опись скрытого теста не публикуется (T-096).
//
// КАНОН ОТПЕЧАТКА (версия hidden-seal/1; ml/eval/hidden_seal.py считает его байт в байт, паритет — тестами обеих сторон):
//   digest = sha256_hex(utf8(
//     "hidden-seal/1\n" + <name> + "\n" + строки "<role>:<sha256>\n", отсортированные побайтово (все символы — ASCII)
//   ))
//   role ∈ {input, labels}; sha256 — 64 символа [0-9a-f] (строчные); name — [A-Za-z0-9._-]{1,100}, не «.»/«..».
//   Пустая печать и повтор одного SHA-256 в печати (в любой роли) — ошибка.
import { createHash } from "node:crypto";

export const SEAL_CANON_VERSION = "hidden-seal/1";
export const SEAL_ROLES = ["input", "labels"] as const;
export type SealRole = (typeof SEAL_ROLES)[number];

export interface SealFile {
  sha256: string;
  role: SealRole;
}

export interface Seal {
  name: string;
  files: SealFile[]; // в каноническом порядке
  digest: string;
  sealed_at: string;
}

export class SealError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function validateSealName(name: string): string {
  if (typeof name !== "string" || !NAME.test(name) || name === "." || name === "..") {
    throw new SealError(`Имя печати ${JSON.stringify(name)}: допустимы латиница, цифры, «.», «_», «-», от 1 до 100 символов`);
  }
  return name;
}

/** Строгая проверка хеша печати: только строчный hex из 64 символов. */
function strictSha(sha: string): string {
  if (typeof sha !== "string" || !HEX64.test(sha)) throw new SealError(`SHA-256 ${JSON.stringify(sha)}: нужно 64 строчных шестнадцатеричных символа`);
  return sha;
}

/** Хеш снаружи печати (файл каталога, ответ, загрузка): регистр не важен, остальное — как у печати. */
function looseSha(sha: string): string {
  return strictSha(typeof sha === "string" ? sha.toLowerCase() : sha);
}

const line = (f: SealFile) => `${f.role}:${f.sha256}\n`;
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Проверенные файлы печати в каноническом порядке. */
export function normalizeFiles(files: SealFile[]): SealFile[] {
  if (!Array.isArray(files) || files.length === 0) throw new SealError("Пустая печать: в скрытом тесте нет ни одного файла");
  const seen = new Set<string>();
  const out = files.map((f) => {
    if (!SEAL_ROLES.includes(f?.role)) throw new SealError(`Роль ${JSON.stringify(f?.role)}: допустимы input и labels`);
    const sha = strictSha(f.sha256);
    if (seen.has(sha)) throw new SealError(`SHA-256 ${sha} повторяется в печати`);
    seen.add(sha);
    return { sha256: sha, role: f.role };
  });
  return out.sort((a, b) => byteOrder(line(a), line(b)));
}

export function sealCanon(name: string, files: SealFile[]): string {
  return `${SEAL_CANON_VERSION}\n${validateSealName(name)}\n${normalizeFiles(files).map(line).join("")}`;
}

/** OS-INSP-6.1.4: общий отпечаток печати. */
export function sealDigest(name: string, files: SealFile[]): string {
  return createHash("sha256").update(sealCanon(name, files), "utf8").digest("hex");
}

export function makeSeal(name: string, files: SealFile[], sealedAt: string): Seal {
  return { name: validateSealName(name), files: normalizeFiles(files), digest: sealDigest(name, files), sealed_at: sealedAt };
}

export function sealCounts(s: Pick<Seal, "files">): { n_files: number; n_labels: number } {
  return { n_files: s.files.length, n_labels: s.files.filter((f) => f.role === "labels").length };
}

/**
 * OS-INSP-6.1.4: печать только добавляется. Новое имя — запись; то же имя и тот же отпечаток — повтор без новой
 * записи (same); то же имя и другой отпечаток — отказ.
 */
export function checkReseal(existing: Pick<Seal, "name" | "digest"> | null, next: Pick<Seal, "name" | "digest">): { ok: true; same: boolean } | { ok: false; reason: string } {
  if (!existing) return { ok: true, same: false };
  if (existing.digest === next.digest) return { ok: true, same: true };
  return { ok: false, reason: `Печать «${next.name}» уже есть с другим составом (отпечаток ${existing.digest.slice(0, 12)}…, новый ${next.digest.slice(0, 12)}…): печать только добавляется — возьмите новое имя` };
}

/**
 * OS-INSP-6.1.5: сверка файлов прогона с печатью. added — файлы, которых нет в печати (и повторные копии одного файла),
 * missing — файлы печати, которых нет в прогоне. Изменённый файл = пропал старый хеш + появился новый.
 */
export function verifyFiles(seal: Pick<Seal, "files">, actualShas: string[]): { ok: boolean; added: string[]; missing: string[] } {
  const want = new Set(seal.files.map((f) => f.sha256));
  const got = new Set<string>();
  const added: string[] = [];
  for (const raw of actualShas) {
    const sha = looseSha(raw);
    if (!want.has(sha) || got.has(sha)) added.push(sha);
    got.add(sha);
  }
  const missing = [...want].filter((s) => !got.has(s)).sort();
  added.sort();
  return { ok: added.length === 0 && missing.length === 0, added, missing };
}

/** SHA-256 файлов меток всех печатей. */
export function labelShas(seals: Array<Pick<Seal, "files">>): Set<string> {
  return new Set(seals.flatMap((s) => s.files.filter((f) => f.role === "labels").map((f) => f.sha256)));
}

/** SHA-256 всех файлов всех печатей (вход и метки). */
export function sealedShas(seals: Array<Pick<Seal, "files">>): Set<string> {
  return new Set(seals.flatMap((s) => s.files.map((f) => f.sha256)));
}

/** OS-INSP-6.1.6: файл — метки какой-либо печати (в конвейер не принимается). */
export function isLabelsFile(sha: string, seals: Array<Pick<Seal, "files">>): boolean {
  return labelShas(seals).has(typeof sha === "string" ? sha.toLowerCase() : sha);
}

export interface JournalEntry {
  seal_name: string;
  answer_sha256: string;
}

/**
 * OS-INSP-6.1.7: балл по меткам считается только для ответа, заранее записанного в журнал этой печати.
 * labelsSha (если задан) — файл меток, по которому считают: он обязан входить в печать с ролью «метки».
 */
export function canScore(seal: Pick<Seal, "name" | "files">, journal: JournalEntry[], answerSha: string, labelsSha?: string): { ok: true } | { ok: false; reason: string } {
  const a = looseSha(answerSha);
  if (!journal.some((j) => j.seal_name === seal.name && j.answer_sha256 === a)) {
    return { ok: false, reason: `Ответа ${a.slice(0, 12)}… нет в журнале печати «${seal.name}»: сначала запишите ответ (commit), затем считайте балл` };
  }
  if (labelsSha !== undefined) {
    const l = looseSha(labelsSha);
    if (!seal.files.some((f) => f.role === "labels" && f.sha256 === l)) {
      return { ok: false, reason: `Файл меток ${l.slice(0, 12)}… не входит в печать «${seal.name}» с ролью «метки»` };
    }
  }
  return { ok: true };
}

export interface ShaItem {
  finding_id: string;
  file_shas: string[];
  object_id: string;
}

/**
 * OS-INSP-6.1.8: исключить из GOLD решения по файлам скрытого теста. Решение касается скрытого теста, если среди
 * файлов его проверки есть файл любой печати (вход или метки). Объект такого решения исключается целиком:
 * выборки GOLD режутся по object_id (6.1.2), и соседние решения того же объекта несут те же документы.
 */
export function goldExclusion<T extends ShaItem>(items: T[], seals: Array<Pick<Seal, "files">>): { kept: T[]; excluded: T[]; count: number } {
  const sealed = sealedShas(seals);
  const hitObjects = new Set(items.filter((i) => i.file_shas.some((s) => sealed.has(s.toLowerCase()))).map((i) => i.object_id));
  const excluded = items.filter((i) => hitObjects.has(i.object_id));
  const kept = items.filter((i) => !hitObjects.has(i.object_id));
  return { kept, excluded, count: excluded.length };
}

/**
 * OS-INSP-6.1.9: порог подбирается только на validation. Пересечение validation со скрытым тестом по SHA-256 файлов
 * (любая печать) или по object_id (скрытая выборка набора) — отказ с перечнем; иначе null.
 */
export function thresholdGuard(
  validation: Array<Pick<ShaItem, "file_shas" | "object_id">>,
  seals: Array<Pick<Seal, "files">>,
  hiddenObjectIds: Iterable<string>,
): null | { reason: string; shas: string[]; object_ids: string[] } {
  const sealed = sealedShas(seals);
  const hidden = new Set(hiddenObjectIds);
  const shas = [...new Set(validation.flatMap((v) => v.file_shas.map((s) => s.toLowerCase()).filter((s) => sealed.has(s))))].sort();
  const object_ids = [...new Set(validation.map((v) => v.object_id).filter((o) => hidden.has(o)))].sort();
  if (!shas.length && !object_ids.length) return null;
  const parts = [shas.length ? `файлов по SHA-256: ${shas.length}` : "", object_ids.length ? `объектов: ${object_ids.join(", ")}` : ""].filter(Boolean);
  return { reason: `Подбор порога запрещён: validation пересекается со скрытым тестом (${parts.join("; ")})`, shas, object_ids };
}
