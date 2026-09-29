// NFR-UKEP · TZA-12.10-01 «Все запросы к внешним системам подписываются УКЭП»: чистые функции подписи запроса.
// Эшелоны: L1 (каноническая строка, заголовки), L3 (граница свежести ровно 300 с), L6 (битые входы), L7 (окружение).
import { describe, expect, it } from "vitest";
import {
  canonicalRequest,
  checkFreshness,
  FRESHNESS_SEC,
  isNonce,
  pathWithQueryOf,
  readSignatureHeaders,
  resolveUkep,
  signatureHeaders,
  unixTimestamp,
} from "../src/domain/request-signing.ts";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NONCE = "0123456789abcdef0123456789abcdef";

describe("каноническая строка запроса (NFR-UKEP)", () => {
  it("каноническая строка — METHOD, путь с запросом, метка, nonce и SHA-256 тела через перевод строки", () => {
    expect(canonicalRequest({ method: "post", pathWithQuery: "/api/v1/inspection/P-1?x=1", timestamp: "1790000000", nonce: NONCE, bodySha256Hex: EMPTY_SHA })).toBe(
      `POST\n/api/v1/inspection/P-1?x=1\n1790000000\n${NONCE}\n${EMPTY_SHA}`,
    );
  });
  it("путь с запросом берётся из адреса без хоста и фрагмента; пустой путь — «/»", () => {
    expect(pathWithQueryOf("https://rin.test:8443/api/v1/packages?since=a%20b#frag")).toBe("/api/v1/packages?since=a%20b");
    expect(pathWithQueryOf("http://127.0.0.1:9")).toBe("/");
  });
  it("битые части канонической строки отклоняются: перевод строки в пути, не hex-хеш, чужой nonce, нечисловая метка, пустой метод", () => {
    const ok = { method: "GET", pathWithQuery: "/a", timestamp: "1", nonce: NONCE, bodySha256Hex: EMPTY_SHA };
    expect(() => canonicalRequest({ ...ok, pathWithQuery: "/a\nX" })).toThrow(/путь/);
    expect(() => canonicalRequest({ ...ok, pathWithQuery: "a" })).toThrow(/путь/);
    expect(() => canonicalRequest({ ...ok, bodySha256Hex: "zz" })).toThrow(/SHA-256/);
    expect(() => canonicalRequest({ ...ok, nonce: "abc" })).toThrow(/nonce/);
    expect(() => canonicalRequest({ ...ok, timestamp: "2026-09-27" })).toThrow(/метка/);
    expect(() => canonicalRequest({ ...ok, method: "" })).toThrow(/метод/);
    expect(() => canonicalRequest({ ...ok, method: "GE T" })).toThrow(/метод/);
  });
});

describe("nonce и метка времени", () => {
  it("nonce — ровно 128 бит в нижнем hex (32 символа)", () => {
    expect(isNonce(NONCE)).toBe(true);
    expect(isNonce(NONCE.toUpperCase())).toBe(false);
    expect(isNonce(NONCE.slice(1))).toBe(false);
    expect(isNonce(NONCE + "0")).toBe(false);
    expect(isNonce("g".repeat(32))).toBe(false);
  });
  it("метка — целые секунды unix", () => {
    expect(unixTimestamp(new Date(1_790_000_000_999))).toBe("1790000000");
  });
  it("свежесть: расхождение ровно 300 с в обе стороны принимается, 300 с + 1 мс — отказ (граница включительно)", () => {
    const ts = "1790000000";
    const at = (ms: number) => new Date(1_790_000_000_000 + ms);
    expect(FRESHNESS_SEC).toBe(300);
    expect(checkFreshness(ts, at(300_000))).toEqual({ ok: true });
    expect(checkFreshness(ts, at(-300_000))).toEqual({ ok: true });
    expect(checkFreshness(ts, at(300_001)).ok).toBe(false);
    expect(checkFreshness(ts, at(-300_001)).ok).toBe(false);
    expect(checkFreshness(ts, at(0))).toEqual({ ok: true });
  });
  it("свежесть: окно задаётся явно, нечисловая метка — отказ с причиной", () => {
    expect(checkFreshness("100", new Date(110_000), 10)).toEqual({ ok: true });
    expect(checkFreshness("100", new Date(110_001), 10).ok).toBe(false);
    expect(checkFreshness("abc", new Date(0))).toEqual({ ok: false, reason: "метка времени подписи не число секунд" });
    expect(checkFreshness("", new Date(0)).ok).toBe(false);
  });
});

describe("заголовки подписи", () => {
  it("заголовки X-Signature (base64 DER), X-Signature-Timestamp, X-Signature-Nonce", () => {
    const h = signatureHeaders({ signatureDer: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]), timestamp: "1790000000", nonce: NONCE });
    expect(h).toEqual({ "x-signature": "MAMCAQE=", "x-signature-timestamp": "1790000000", "x-signature-nonce": NONCE });
  });
  it("разбор заголовков на стороне «РиН»: полный набор читается, любой пропуск или мусор — отказ с причиной", () => {
    const h = { "x-signature": "MAMCAQE=", "x-signature-timestamp": "1790000000", "x-signature-nonce": NONCE };
    const r = readSignatureHeaders(h);
    expect(r).toMatchObject({ ok: true, timestamp: "1790000000", nonce: NONCE });
    expect(r.ok && [...r.signature]).toEqual([0x30, 0x03, 0x02, 0x01, 0x01]);
    expect(readSignatureHeaders({ ...h, "x-signature": undefined })).toEqual({ ok: false, reason: "нет заголовка X-Signature" });
    expect(readSignatureHeaders({ ...h, "x-signature-timestamp": undefined })).toEqual({ ok: false, reason: "нет заголовка X-Signature-Timestamp" });
    expect(readSignatureHeaders({ ...h, "x-signature-nonce": ["a", "b"] })).toEqual({ ok: false, reason: "нет заголовка X-Signature-Nonce" });
    expect(readSignatureHeaders({ ...h, "x-signature-nonce": "xyz" })).toEqual({ ok: false, reason: "X-Signature-Nonce не 128 бит hex" });
    expect(readSignatureHeaders({ ...h, "x-signature": "не base64!" })).toEqual({ ok: false, reason: "X-Signature не base64 DER" });
    expect(readSignatureHeaders({ ...h, "x-signature": "AAAA" })).toEqual({ ok: false, reason: "X-Signature не base64 DER" });
  });
});

describe("режим подписи по окружению (INSPECTOR_UKEP_MODE)", () => {
  const gpuReal = { profile: "gpu", mock: false };
  it("dev: по умолчанию подпись выключена явно (off)", () => {
    expect(resolveUkep({}, { profile: "dev", mock: true })).toEqual({ mode: "off" });
    expect(resolveUkep({}, { profile: "gpu", mock: true })).toEqual({ mode: "off" });
  });
  it("профиль gpu: неквалифицированный коннектор (pem, тестовый ключ) — только явным INSPECTOR_UKEP_NONQUALIFIED=1, с пометкой (решение владельца 27.09)", () => {
    const pem = { INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k" };
    expect(() => resolveUkep(pem, gpuReal)).toThrow(/не УКЭП/);
    expect(() => resolveUkep({ ...pem, INSPECTOR_UKEP_NONQUALIFIED: "yes" }, gpuReal)).toThrow(/INSPECTOR_UKEP_NONQUALIFIED/);
    expect(resolveUkep({ ...pem, INSPECTOR_UKEP_NONQUALIFIED: "1" }, gpuReal)).toEqual({ mode: "pem", certFile: "/c", keyFile: "/k", chainFile: null, qualified: false });
    // флаг не открывает режим off: без подписи запросы к «РиН» по-прежнему не уходят
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "off", INSPECTOR_UKEP_NONQUALIFIED: "1" }, gpuReal)).toThrow(/недопустим/);
  });
  it("профиль gpu с настоящей «РиН»: режим off и режим по умолчанию — отказ старта (fail-closed)", () => {
    expect(() => resolveUkep({}, gpuReal)).toThrow(/INSPECTOR_UKEP_MODE=off недопустим в профиле gpu/);
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "off" }, gpuReal)).toThrow(/NFR-UKEP/);
  });
  it("профиль gpu с настоящей «РиН»: pem (RSA/ECDSA) — не УКЭП, отказ; openssl-gost и cryptopro — допустимы", () => {
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k" }, gpuReal)).toThrow(/не УКЭП/);
    expect(resolveUkep({ INSPECTOR_UKEP_MODE: "openssl-gost", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k" }, gpuReal)).toEqual({
      mode: "openssl-gost", certFile: "/c", keyFile: "/k", opensslBin: "openssl", gost: { kind: "engine", name: "gost" },
    });
    expect(resolveUkep({ INSPECTOR_UKEP_MODE: "cryptopro", INSPECTOR_UKEP_THUMBPRINT: "AB".repeat(20) }, gpuReal)).toEqual({
      mode: "cryptopro", cryptcpBin: "/opt/cprocsp/bin/amd64/cryptcp", thumbprint: "ab".repeat(20),
    });
  });
  it("pem: сертификат, ключ и цепочка — только файлами *_FILE; нет файла — ошибка с именем переменной", () => {
    const dev = { profile: "dev", mock: true };
    expect(resolveUkep({ INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k", INSPECTOR_UKEP_CHAIN_FILE: "/ch" }, dev)).toEqual({
      mode: "pem", certFile: "/c", keyFile: "/k", chainFile: "/ch",
    });
    expect(resolveUkep({ INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k" }, dev)).toEqual({ mode: "pem", certFile: "/c", keyFile: "/k", chainFile: null });
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: "/c" }, dev)).toThrow("INSPECTOR_UKEP_MODE=pem требует INSPECTOR_UKEP_KEY_FILE");
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "openssl-gost", INSPECTOR_UKEP_KEY_FILE: "/k" }, dev)).toThrow("INSPECTOR_UKEP_MODE=openssl-gost требует INSPECTOR_UKEP_CERT_FILE");
  });
  it("openssl-gost: провайдер OpenSSL 3 вместо движка и свой бинарник; неизвестный способ загрузки — ошибка", () => {
    const base = { INSPECTOR_UKEP_MODE: "openssl-gost", INSPECTOR_UKEP_CERT_FILE: "/c", INSPECTOR_UKEP_KEY_FILE: "/k" };
    expect(resolveUkep({ ...base, INSPECTOR_UKEP_GOST: "provider", INSPECTOR_UKEP_OPENSSL_BIN: "/usr/local/bin/openssl" }, { profile: "dev", mock: true })).toMatchObject({
      opensslBin: "/usr/local/bin/openssl", gost: { kind: "provider", name: "gostprov" },
    });
    expect(resolveUkep({ ...base, INSPECTOR_UKEP_GOST: "provider", INSPECTOR_UKEP_GOST_NAME: "gost" }, { profile: "dev", mock: true })).toMatchObject({ gost: { kind: "provider", name: "gost" } });
    expect(() => resolveUkep({ ...base, INSPECTOR_UKEP_GOST: "dll" }, { profile: "dev", mock: true })).toThrow("INSPECTOR_UKEP_GOST=dll: ждём engine или provider");
  });
  it("cryptopro: отпечаток — 40 hex (SHA-1), иначе ошибка; режим с опечаткой — ошибка со списком режимов", () => {
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "cryptopro" }, { profile: "dev", mock: true })).toThrow("INSPECTOR_UKEP_MODE=cryptopro требует INSPECTOR_UKEP_THUMBPRINT");
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "cryptopro", INSPECTOR_UKEP_THUMBPRINT: "abc" }, { profile: "dev", mock: true })).toThrow(/40 hex/);
    expect(() => resolveUkep({ INSPECTOR_UKEP_MODE: "gost" }, { profile: "dev", mock: true })).toThrow("INSPECTOR_UKEP_MODE=gost: ждём off, pem, openssl-gost или cryptopro");
  });
});
