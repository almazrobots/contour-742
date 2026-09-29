// T-231, откат варианта А (OWASP-0191): обратное к apps/api/src/cli/blobs-encrypt.ts — файлы IBE1 каталога блобов снова
// становятся открытым текстом. Нужен только для отката: API без ключа хранения файлы IBE1 не читает.
// Каждый файл: расшифровка, сверка SHA-256 открытого текста с именем, атомарная замена (временный файл рядом и rename),
// повторное чтение и сверка. Не расшифровалось или не сошлось — файл не трогается и попадает в сводку (код 2).
// Идемпотентен: открытый текст (наследие) пропускается.
//
//   node deploy/gpu-stand/blobs-decrypt.mjs --dir каталог --key-file ключ [--old-keys-file старые] [--dry-run]
// На сервере — из scripts/pdn-at-rest-a.sh rollback (контейнер образа API, исходники /opt/stand-gpu/src смонтированы в /app).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// из репозитория и из контейнера (/app/deploy/gpu-stand → /app/apps/api/src) путь один и тот же
const { decryptAtRest, makeKeyring, parseKeyList } = await import(new URL("../../apps/api/src/domain/at-rest.ts", import.meta.url).href);
const { parseEncryptionKey } = await import(new URL("../../apps/api/src/domain/blob-crypto.ts", import.meta.url).href);

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 ** 31 - 1; // readFileSync: больше — не буфером; таких блобов на стенде нет (28.09 самый большой — 956 МБ)
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

export function decryptBlobDir({ dir, keyring, dryRun = false }) {
  const res = { scanned: 0, decrypted: [], already: 0, bad: [], dryRun };
  for (const name of readdirSync(dir).filter((n) => SHA_RE.test(n)).sort()) {
    const path = join(dir, name);
    let st;
    let raw;
    try {
      st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) {
        res.bad.push({ name, why: `больше ${MAX_BYTES} байт — расшифровать буфером нельзя` });
        continue;
      }
      raw = readFileSync(path);
    } catch (e) {
      res.bad.push({ name, why: `не читается: ${e.code ?? e.message}` });
      continue;
    }
    res.scanned++;
    let opened;
    try {
      opened = decryptAtRest(keyring, raw);
    } catch (e) {
      res.bad.push({ name, why: e.message });
      continue;
    }
    if (sha256hex(opened.plain) !== name) {
      res.bad.push({ name, why: "SHA-256 открытого текста не совпал с именем файла — не трогаю" });
      continue;
    }
    if (opened.legacy) {
      res.already++;
      continue;
    }
    if (!dryRun) {
      const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
      try {
        writeFileSync(tmp, opened.plain, { mode: st.mode & 0o777 });
        chmodSync(tmp, st.mode & 0o777);
        renameSync(tmp, path);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      if (sha256hex(readFileSync(path)) !== name) throw new Error(`${name}: после записи файл не сошёлся — остановка`);
    }
    res.decrypted.push(name);
  }
  return res;
}

export function summary(r) {
  return [
    `${r.dryRun ? "проверка без записи (--dry-run)" : "расшифровка"}: просмотрено ${r.scanned}`,
    `  ${r.dryRun ? "будет расшифровано" : "расшифровано"}: ${r.decrypted.length}`,
    `  уже открытым текстом: ${r.already}`,
    `  не тронуто (ошибки): ${r.bad.length}`,
    ...r.bad.map((b) => `    ${b.name}: ${b.why}`),
  ].join("\n");
}

const { values } = parseArgs({
  options: { dir: { type: "string" }, "key-file": { type: "string" }, "old-keys-file": { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
try {
  if (!values.dir || !values["key-file"]) throw new Error("нужны --dir и --key-file");
  const current = parseEncryptionKey(readFileSync(values["key-file"], "utf8"));
  const old = values["old-keys-file"] ? parseKeyList(readFileSync(values["old-keys-file"], "utf8")) : [];
  const r = decryptBlobDir({ dir: resolve(values.dir), keyring: makeKeyring(current, old), dryRun: values["dry-run"] });
  process.stdout.write(summary(r) + "\n");
  process.exit(r.bad.length ? 2 : 0);
} catch (e) {
  process.stderr.write(`blobs-decrypt: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
