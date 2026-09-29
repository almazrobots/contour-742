// NFR-CRYPTO (ТЗ 12.3-01): перешифрование наследия в каталоге блобов — файлы, записанные открытым текстом до включения
// шифрования, становятся IBE1 под текущим ключом (domain/at-rest.ts). С --rotate — ещё и файлы под старыми ключами.
// Каждый файл: сверка SHA-256 открытого текста с именем до записи, атомарная замена (временный файл рядом и rename),
// повторное чтение и сверка после. Повреждённое и нерасшифровываемое не трогается, а попадает в сводку (код выхода 2).
// Идемпотентен: повторный запуск ничего не меняет. API может работать одновременно: он файлы не перезаписывает.
//
//   pnpm blobs:encrypt [--dir каталог] [--key-file ключ] [--old-keys-file старые] [--rotate] [--dry-run]
//   в контейнере: docker compose run --rm api node apps/api/dist/cli/blobs-encrypt.mjs --dry-run
// По умолчанию — INSPECTOR_BLOB_DIR, INSPECTOR_BLOB_KEY_FILE, INSPECTOR_BLOB_OLD_KEYS_FILE (как у API).
// Модуль запускается и голым node (только снятие типов): импортирует лишь чистые domain-модули, не config и не services.
import { randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AtRestError, decryptAtRest, encryptAtRest, isEncryptedBlob, keyId, makeKeyring, parseKeyList, type AtRestKeyring } from "../domain/at-rest.ts";
import { isSha256, parseEncryptionKey, sha256hex } from "../domain/blob-crypto.ts";

export interface EncryptDirOptions {
  dir: string;
  keyring: AtRestKeyring;
  /** Перешифровать и файлы под старыми ключами (после ротации). */
  rotate?: boolean;
  dryRun?: boolean;
}

export interface EncryptDirResult {
  scanned: number;
  /** Наследие, зашифрованное сейчас (в --dry-run — которое было бы зашифровано). */
  encrypted: string[];
  /** Перешифрованы под текущий ключ (--rotate). */
  rotated: string[];
  /** Уже IBE1 под текущим ключом (или под старым без --rotate). */
  already: number;
  /** Не тронуты: SHA-256 не сошёлся, ключа нет в связке, тег не сошёлся, ошибка чтения. */
  bad: Array<{ name: string; why: string }>;
  dryRun: boolean;
}

/** Атомарная замена: временный файл рядом, права исходного, rename. Сбой — временный убран, исходный цел. */
function replaceAtomically(dir: string, name: string, buf: Buffer, mode: number): void {
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, buf, { mode: mode & 0o777 });
    chmodSync(tmp, mode & 0o777);
    renameSync(tmp, join(dir, name));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function encryptBlobDir(o: EncryptDirOptions): EncryptDirResult {
  const res: EncryptDirResult = { scanned: 0, encrypted: [], rotated: [], already: 0, bad: [], dryRun: Boolean(o.dryRun) };
  const currentId = keyId(o.keyring.current).toString("hex");
  // только файлы с именем SHA-256: временные «.<sha>.tmp-…» и посторонние не трогаются
  for (const name of readdirSync(o.dir).filter(isSha256).sort()) {
    const path = join(o.dir, name);
    let st: Stats;
    let raw: Buffer;
    try {
      st = statSync(path);
      if (!st.isFile()) continue;
      raw = readFileSync(path);
    } catch (e) {
      res.bad.push({ name, why: `не читается: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` });
      continue;
    }
    res.scanned++;
    let plain: Buffer;
    let kind: "legacy" | "rotate" | "ok";
    try {
      const opened = decryptAtRest(o.keyring, raw);
      plain = opened.plain;
      kind = opened.legacy ? "legacy" : opened.keyId === currentId || !o.rotate ? "ok" : "rotate";
    } catch (e) {
      // открытый текст наследия, случайно начавшийся с «IBE1», узнаётся по SHA-256
      if (isEncryptedBlob(raw) && sha256hex(raw) === name) {
        plain = raw;
        kind = "legacy";
      } else {
        res.bad.push({ name, why: e instanceof AtRestError ? e.message : String(e) });
        continue;
      }
    }
    if (sha256hex(plain) !== name) {
      res.bad.push({ name, why: "SHA-256 открытого текста не совпал с именем файла — не трогаю" });
      continue;
    }
    if (kind === "ok") {
      res.already++;
      continue;
    }
    const enc = encryptAtRest(o.keyring.current, plain);
    // сверка до записи: то, что ляжет на диск, расшифровывается в тот же открытый текст
    if (sha256hex(decryptAtRest(o.keyring, enc).plain) !== name) throw new Error(`${name}: самопроверка шифрования не прошла`);
    if (!o.dryRun) {
      replaceAtomically(o.dir, name, enc, st.mode);
      // сверка после: файл на диске читается и сходится с именем
      const back = decryptAtRest(o.keyring, readFileSync(path));
      if (back.legacy || sha256hex(back.plain) !== name) throw new Error(`${name}: после записи файл не сошёлся — остановка`);
    }
    (kind === "legacy" ? res.encrypted : res.rotated).push(name);
  }
  return res;
}

export function summary(r: EncryptDirResult): string {
  const lines = [
    `${r.dryRun ? "проверка без записи (--dry-run)" : "перешифрование"}: просмотрено ${r.scanned}`,
    `  ${r.dryRun ? "будет зашифровано" : "зашифровано"} наследия: ${r.encrypted.length}`,
    `  ${r.dryRun ? "будет перешифровано" : "перешифровано"} под текущий ключ: ${r.rotated.length}`,
    `  уже зашифровано: ${r.already}`,
    `  не тронуто (ошибки): ${r.bad.length}`,
    ...r.bad.map((b) => `    ${b.name}: ${b.why}`),
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "key-file": { type: "string" },
      "old-keys-file": { type: "string" },
      rotate: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const dir = values.dir ?? process.env.INSPECTOR_BLOB_DIR?.trim();
  if (!dir) throw new Error("не задан каталог блобов: --dir или INSPECTOR_BLOB_DIR");
  const keyFile = values["key-file"] ?? process.env.INSPECTOR_BLOB_KEY_FILE?.trim();
  if (!keyFile) throw new Error("не задан ключ хранения: --key-file или INSPECTOR_BLOB_KEY_FILE");
  const oldFile = values["old-keys-file"] ?? (process.env.INSPECTOR_BLOB_OLD_KEYS_FILE?.trim() || undefined);
  const read = (name: string, file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`${name} ${file}: ${(e as NodeJS.ErrnoException).code ?? "не читается"}`);
    }
  };
  let current: Buffer;
  try {
    current = parseEncryptionKey(read("ключ", keyFile));
  } catch (e) {
    throw new Error(`ключ ${keyFile}: ${(e as Error).message}`);
  }
  const old = oldFile ? parseKeyList(read("старые ключи", oldFile)) : [];
  const r = encryptBlobDir({ dir: resolve(dir), keyring: makeKeyring(current, old), rotate: values.rotate, dryRun: values["dry-run"] });
  process.stdout.write(summary(r) + "\n");
  return r.bad.length ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`blobs-encrypt: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
