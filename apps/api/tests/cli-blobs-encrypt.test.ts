// NFR-CRYPTO (ТЗ 12.3-01): pnpm blobs:encrypt — перешифрование наследия в каталоге блобов.
// Эшелоны qa-standard: L1 наследие → IBE1, сверка SHA-256 до и после, идемпотентность, --dry-run, --rotate ·
// L4 повреждённый и нерасшифровываемый файлы не трогаются, код выхода 2 · L6 «наследие» с магией IBE1, посторонние файлы.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptBlobDir, summary } from "../src/cli/blobs-encrypt.ts";
import { decryptAtRest, encryptAtRest, isEncryptedBlob, keyId, makeKeyring } from "../src/domain/at-rest.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t137-cli-"));
  dir = join(root, "blobs");
  mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (b: Buffer, data: Buffer = b) => {
  writeFileSync(join(dir, sha(b)), data, { mode: 0o640 });
  return sha(b);
};
const a = Buffer.from("%PDF-1.7 лист наследия А");
const b = Buffer.from("<?xml version='1.0'?><акт/>");

describe("L1 · наследие → IBE1", () => {
  it("шифрует файлы без магии, SHA-256 открытого текста сходится, права сохранены; уже зашифрованное не трогает", () => {
    const ha = put(a);
    const hb = put(b, encryptAtRest(K1, b));
    const before = readFileSync(join(dir, hb));
    const r = encryptBlobDir({ dir, keyring: makeKeyring(K1) });
    expect(r).toMatchObject({ scanned: 2, encrypted: [ha], rotated: [], already: 1, bad: [], dryRun: false });
    const raw = readFileSync(join(dir, ha));
    expect(isEncryptedBlob(raw)).toBe(true);
    expect(decryptAtRest(makeKeyring(K1), raw).plain).toEqual(a);
    expect(statSync(join(dir, ha)).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(dir, hb))).toEqual(before);
    expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
  });
  it("идемпотентен: второй запуск ничего не меняет", () => {
    put(a);
    encryptBlobDir({ dir, keyring: makeKeyring(K1) });
    const once = readFileSync(join(dir, sha(a)));
    const r = encryptBlobDir({ dir, keyring: makeKeyring(K1) });
    expect(r).toMatchObject({ encrypted: [], already: 1 });
    expect(readFileSync(join(dir, sha(a)))).toEqual(once);
  });
  it("--dry-run: сводка «будет зашифровано», файлы не меняются", () => {
    const ha = put(a);
    const r = encryptBlobDir({ dir, keyring: makeKeyring(K1), dryRun: true });
    expect(r.encrypted).toEqual([ha]);
    expect(readFileSync(join(dir, ha))).toEqual(a);
    expect(summary(r)).toContain("будет зашифровано наследия: 1");
  });
  it("--rotate: файлы старого ключа — под текущий; без флага — остаются как есть", () => {
    const ha = put(a, encryptAtRest(K1, a));
    const ring = makeKeyring(K2, [K1]);
    expect(encryptBlobDir({ dir, keyring: ring })).toMatchObject({ rotated: [], already: 1 });
    expect(encryptBlobDir({ dir, keyring: ring, rotate: true }).rotated).toEqual([ha]);
    expect(readFileSync(join(dir, ha)).subarray(4, 12)).toEqual(keyId(K2));
  });
});

describe("L4/L6 · не трогает то, что не может проверить", () => {
  it("повреждённое наследие, файл под неизвестным ключом и подменённый тег — в ошибках, байты не изменены", () => {
    const damaged = Buffer.from("повреждённое наследие");
    writeFileSync(join(dir, sha(a)), damaged); // имя от a, содержимое другое
    const hb = put(b, encryptAtRest(K2, b)); // ключа K2 в связке нет
    const c = Buffer.from("третий");
    const tampered = encryptAtRest(K1, c);
    tampered[tampered.length - 1] ^= 1;
    const hc = put(c, tampered);
    const r = encryptBlobDir({ dir, keyring: makeKeyring(K1) });
    expect(r.bad.map((x) => x.name).sort()).toEqual([sha(a), hb, hc].sort());
    expect(r.bad.find((x) => x.name === hb)!.why).toContain(keyId(K2).toString("hex"));
    expect(readFileSync(join(dir, sha(a)))).toEqual(damaged);
    expect(readFileSync(join(dir, hc))).toEqual(tampered);
  });
  it("открытый текст, начинающийся с IBE1, шифруется как наследие; посторонние и временные файлы пропускаются", () => {
    const odd = Buffer.from("IBE1 и дальше обычный текст наследия");
    const h = put(odd);
    writeFileSync(join(dir, `.${h}.tmp-1-abcd`), "временный");
    writeFileSync(join(dir, "README"), "посторонний");
    const r = encryptBlobDir({ dir, keyring: makeKeyring(K1) });
    expect(r).toMatchObject({ scanned: 1, encrypted: [h], bad: [] });
    expect(decryptAtRest(makeKeyring(K1), readFileSync(join(dir, h))).plain).toEqual(odd);
    expect(readFileSync(join(dir, "README"), "utf8")).toBe("посторонний");
  });
});

describe("L7 · запуск голым node (pnpm blobs:encrypt)", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["src/cli/blobs-encrypt.ts", ...args], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, INSPECTOR_BLOB_DIR: "", INSPECTOR_BLOB_KEY_FILE: "", INSPECTOR_BLOB_OLD_KEYS_FILE: "", ...env }, encoding: "utf8" });
  it("сводка и код 0; ошибки — код 2; без ключа — код 1 с подсказкой; ключ в вывод не попадает", () => {
    const keyFile = join(root, "k");
    writeFileSync(keyFile, K1.toString("hex"));
    put(a);
    const dry = run(["--dir", dir, "--key-file", keyFile, "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("будет зашифровано наследия: 1");
    expect(readFileSync(join(dir, sha(a)))).toEqual(a);
    const ok = run([], { INSPECTOR_BLOB_DIR: dir, INSPECTOR_BLOB_KEY_FILE: keyFile });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("зашифровано наследия: 1");
    expect(ok.stdout + ok.stderr).not.toContain(K1.toString("hex"));
    writeFileSync(join(dir, sha(b)), "подмена");
    expect(run(["--dir", dir, "--key-file", keyFile]).status).toBe(2);
    const noKey = run(["--dir", dir]);
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toContain("INSPECTOR_BLOB_KEY_FILE");
  });
});
