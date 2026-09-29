// NFR-UKEP · TZA-12.10-01 «Все запросы к внешним системам подписываются УКЭП»: подписанты, транспорт «РиН» и границы.
// Эшелоны: L1 (подписанты, аргументы программ), L4 (отказ подписанта → PENDING_SYNC через очередь sync_jobs),
// L6 (подменённое тело, повтор nonce, чужой УЦ, просроченная метка — тестовый сервер «РиН» отклоняет),
// L7 (архитектура: исходящий HTTP только в транспорте с подписью; окружение — fail-closed в профиле gpu).
// PKI — синтетика fixtures/ukep/gen.sh во временном каталоге (закрытых ключей в git нет). ГОСТ — в docker-образе
// с gost-engine; без docker или без загруженного образа тест пропускается с причиной.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalRequest, checkFreshness, readSignatureHeaders } from "../src/domain/request-signing.ts";
import { cryptcpArgs, cryptoproSigner, maskStderr, opensslGostArgs, opensslGostSigner, pemSigner, signerFromConfig, type Signer } from "../src/services/request-signer.ts";
import { rinGetTransport, rinTransport, type RinTls } from "../src/services/rin-tls.ts";

Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: process.env.INSPECTOR_DEMO_PASSWORD || "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });

const API = resolve(import.meta.dirname, "..");
const UKEP = join(import.meta.dirname, "fixtures/ukep");
const MTLS = join(import.meta.dirname, "fixtures/mtls");
const PKI = mkdtempSync(join(tmpdir(), "inspector-ukep-pki-"));
const TMP = mkdtempSync(join(tmpdir(), "inspector-ukep-test-"));
const pki = (n: string) => join(PKI, n);
const text = (p: string) => readFileSync(p, "utf8");

let S: typeof import("../src/services/signature.ts");
let trust: import("../src/services/signature.ts").TrustStore;
let rsa: Signer;
let ec: Signer;

beforeAll(async () => {
  execFileSync("bash", [join(UKEP, "gen.sh"), PKI], { stdio: "ignore" });
  S = await import("../src/services/signature.ts");
  trust = S.loadTrustStore(pki("trust"), null);
  rsa = pemSigner({ certPem: text(pki("signer-rsa.crt")), keyPem: text(pki("signer-rsa.key")), chainPem: text(pki("ica.crt")) });
  ec = pemSigner({ certPem: text(pki("signer-ec.crt")), keyPem: text(pki("signer-ec.key")) });
});
afterAll(() => {
  rmSync(PKI, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

const DATA = Buffer.from(canonicalRequest({ method: "POST", pathWithQuery: "/api/v1/inspection/P-1", timestamp: "1790000000", nonce: "0".repeat(32), bodySha256Hex: "a".repeat(64) }));

/** Независимая проверка подписи openssl (не нашим кодом): код выхода 0 — подпись верна и цепочка до корня строится. */
function opensslVerify(data: Buffer, sig: Buffer, ca: string): boolean {
  const d = mkdtempSync(join(TMP, "v-"));
  writeFileSync(join(d, "data"), data);
  writeFileSync(join(d, "sig"), sig);
  return spawnSync("openssl", ["cms", "-verify", "-binary", "-inform", "DER", "-in", join(d, "sig"), "-content", join(d, "data"), "-CAfile", ca, "-purpose", "any", "-out", "/dev/null"], { stdio: "ignore" }).status === 0;
}

describe("подписант pem: круг «подписал → проверил» своим services/signature.ts (NFR-UKEP)", () => {
  it("подпись RSA с цепочкой через промежуточный УЦ проверяется checkDetached как верная и openssl cms -verify", async () => {
    const sig = await rsa.sign(DATA);
    expect(S.checkDetached(DATA, sig, trust)).toMatchObject({ status: "VALID", signer: expect.stringContaining("Инспектор ИИ (тест\\, RSA)") });
    expect(opensslVerify(DATA, sig, pki("root.crt"))).toBe(true);
    expect(rsa.describe()).toContain("RSA");
  });
  it("подпись ECDSA P-256 проверяется checkDetached как верная и openssl cms -verify", async () => {
    const sig = await ec.sign(DATA);
    expect(S.checkDetached(DATA, sig, trust)).toMatchObject({ status: "VALID", signer: expect.stringContaining("ECDSA P-256") });
    expect(opensslVerify(DATA, sig, pki("root.crt"))).toBe(true);
  });
  it("подпись над одной строкой не подходит к подменённой — INVALID", async () => {
    const sig = await ec.sign(DATA);
    expect(S.checkDetached(Buffer.concat([DATA, Buffer.from("x")]), sig, trust).status).toBe("INVALID");
  });
  it("CMS откреплённая: contentType, messageDigest SHA-256, signingTime в подписываемых атрибутах, сертификаты внутри", async () => {
    const at = new Date("2026-09-27T10:00:00Z");
    const s = pemSigner({ certPem: text(pki("signer-rsa.crt")), keyPem: text(pki("signer-rsa.key")), chainPem: text(pki("ica.crt")), now: () => at });
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(new Uint8Array(await s.sign(DATA))).result });
    const sd = new pkijs.SignedData({ schema: ci.content });
    expect(sd.encapContentInfo.eContent).toBeUndefined();
    expect(sd.certificates).toHaveLength(2);
    const attrs = sd.signerInfos[0]!.signedAttrs!.attributes;
    expect(attrs.map((a) => a.type).sort()).toEqual(["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4", "1.2.840.113549.1.9.5"]);
    const md = attrs.find((a) => a.type === "1.2.840.113549.1.9.4")!.values[0] as asn1js.OctetString;
    expect(Buffer.from(md.valueBlock.valueHexView).toString("hex")).toBe(createHash("sha256").update(DATA).digest("hex"));
    expect((attrs.find((a) => a.type === "1.2.840.113549.1.9.5")!.values[0] as asn1js.UTCTime).toDate().toISOString()).toBe(at.toISOString());
  });
  it("подпись чужим УЦ не доверена получателем — не VALID", async () => {
    const foreign = pemSigner({ certPem: text(pki("signer-foreign.crt")), keyPem: text(pki("signer-foreign.key")) });
    expect(S.checkDetached(DATA, await foreign.sign(DATA), trust).status).not.toBe("VALID");
  });
  it("ключ не от сертификата, битый ключ и ключ Ed25519 — ошибка при построении подписанта", () => {
    expect(() => pemSigner({ certPem: text(pki("signer-rsa.crt")), keyPem: text(pki("signer-ec.key")) })).toThrow("pem: закрытый ключ не от сертификата подписанта");
    expect(() => pemSigner({ certPem: text(pki("signer-rsa.crt")), keyPem: "мусор" })).toThrow("pem: закрытый ключ подписанта не читается");
    expect(() => pemSigner({ certPem: "мусор", keyPem: text(pki("signer-rsa.key")) })).toThrow(/нет блока CERTIFICATE/);
    const d = mkdtempSync(join(TMP, "ed-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", join(d, "k"), "-out", join(d, "c"), "-subj", "/CN=ed", "-days", "1"], { stdio: "ignore" });
    expect(() => pemSigner({ certPem: text(join(d, "c")), keyPem: text(join(d, "k")) })).toThrow(/ed25519 не поддерживается/);
  });
  it("signerFromConfig: off — без подписанта; pem — файлы читаются сразу, нечитаемый — ошибка с именем переменной", () => {
    expect(signerFromConfig({ mode: "off" })).toBeNull();
    expect(signerFromConfig({ mode: "pem", certFile: pki("signer-ec.crt"), keyFile: pki("signer-ec.key"), chainFile: null })!.describe()).toContain("ECDSA");
    expect(() => signerFromConfig({ mode: "pem", certFile: pki("нет.crt"), keyFile: pki("signer-ec.key"), chainFile: null })).toThrow(`INSPECTOR_UKEP_CERT_FILE=${pki("нет.crt")}: файл не читается`);
    expect(() => signerFromConfig({ mode: "openssl-gost", certFile: pki("signer-ec.crt"), keyFile: pki("нет.key"), opensslBin: "openssl", gost: { kind: "engine", name: "gost" } })).toThrow("INSPECTOR_UKEP_KEY_FILE");
    expect(signerFromConfig({ mode: "cryptopro", cryptcpBin: "cryptcp", thumbprint: "ab".repeat(20) })!.describe()).toBe("cryptopro (отпечаток abababab…)");
  });
});

// ─────────────────────────────── тестовый сервер «РиН»: проверяет подпись каждого входящего запроса

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer; ok: boolean; reason: string };
type Rin = { base: string; seen: Seen[]; close: () => Promise<void> };
const servers: Rin[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/**
 * Проверка на стороне «РиН» (требование к ней — docs/integration/UKEP-REQUEST-SIGNING.md): каноническая строка
 * пересобирается из метода, пути и тела запроса; подпись верна и доверена; метка свежая (±300 с); nonce не встречался.
 */
function verifyAtRin(req: http.IncomingMessage, body: Buffer, nonces: Set<string>): { ok: boolean; reason: string } {
  const h = readSignatureHeaders(req.headers);
  if (!h.ok) return { ok: false, reason: h.reason };
  const canon = canonicalRequest({ method: req.method!, pathWithQuery: req.url!, timestamp: h.timestamp, nonce: h.nonce, bodySha256Hex: createHash("sha256").update(body).digest("hex") });
  const v = S.checkDetached(Buffer.from(canon, "utf8"), h.signature, trust);
  if (v.status !== "VALID") return { ok: false, reason: `подпись: ${v.reason}` };
  const fresh = checkFreshness(h.timestamp, new Date());
  if (!fresh.ok) return { ok: false, reason: fresh.reason };
  if (nonces.has(h.nonce)) return { ok: false, reason: "повтор nonce" };
  nonces.add(h.nonce);
  return { ok: true, reason: "" };
}

async function rinServer(kind: "http" | "https" = "http"): Promise<Rin> {
  const seen: Seen[] = [];
  const nonces = new Set<string>();
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const v = verifyAtRin(req, body, nonces);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body, ...v });
      if (!v.ok) return void res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end(v.reason);
      res.writeHead(req.method === "GET" ? 200 : 202, { "content-type": "application/json" }).end("[]");
    });
  };
  const m = (n: string) => readFileSync(join(MTLS, n));
  const server = kind === "https" ? https.createServer({ requestCert: true, rejectUnauthorized: true, ca: m("ca.crt"), cert: m("server.crt"), key: m("server.key") }, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s: Rin = {
    base: `${kind}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  servers.push(s);
  return s;
}

/** Повтор запроса «злоумышленником» с теми же заголовками подписи и произвольным телом/путём. */
function replay(base: string, s: Seen, over: { url?: string; body?: Buffer } = {}): Promise<{ status: number; text: string }> {
  const body = over.body ?? s.body;
  const headers: http.OutgoingHttpHeaders = { ...s.headers, "content-length": body.length };
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${over.url ?? s.url}`, { method: s.method, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const payload = { process_id: "P-1", confirmed_violations: [{ id: "v1", norm: "СП 70.13330" }] };
const direct = (): RinTls => ({ mode: "direct", url: "https://127.0.0.1", caPath: join(MTLS, "ca.crt"), minVersion: "TLSv1.2", client: { kind: "pem", certPath: join(MTLS, "client.crt"), keyPath: join(MTLS, "client.key") } });
const failing: Signer = { describe: () => "тестовый отказ", sign: async () => { throw new Error("СКЗИ недоступно"); } };

describe("транспорт «РиН» подписывает каждый запрос (NFR-UKEP)", () => {
  it("POST протокола в режиме off несёт X-Signature, X-Signature-Timestamp, X-Signature-Nonce — сервер «РиН» подпись принимает", async () => {
    const s = await rinServer();
    expect(await rinTransport({ mode: "off", url: s.base }, { signer: rsa })(`${s.base}/api/v1/inspection/P-1`, payload)).toEqual({ status: 202 });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toMatchObject({ ok: true, method: "POST", url: "/api/v1/inspection/P-1" });
    expect(Object.keys(s.seen[0]!.headers)).toEqual(expect.arrayContaining(["x-signature", "x-signature-timestamp", "x-signature-nonce"]));
    expect(JSON.parse(s.seen[0]!.body.toString())).toEqual(payload);
  });
  it("GET автозабора с запросом в адресе подписан: путь с ?since входит в каноническую строку, тело пустое", async () => {
    const s = await rinServer();
    const r = await rinGetTransport({ mode: "off", url: s.base }, { signer: ec })(`${s.base}/api/v1/packages?since=2026-09-27T00%3A00%3A00Z`, 1000);
    expect(r.status).toBe(200);
    expect(s.seen[0]).toMatchObject({ ok: true, method: "GET", url: "/api/v1/packages?since=2026-09-27T00%3A00%3A00Z" });
  });
  it("режим gost-proxy (шлюз СКЗИ на loopback): POST и GET подписаны", async () => {
    const s = await rinServer();
    const tls: RinTls = { mode: "gost-proxy", url: s.base };
    expect(await rinTransport(tls, { signer: ec })(`${s.base}/api/v1/inspection/P-2`, payload)).toEqual({ status: 202 });
    expect((await rinGetTransport(tls, { signer: ec })(`${s.base}/api/v1/packages`, 1000)).status).toBe(200);
    expect(s.seen.map((x) => [x.method, x.ok])).toEqual([["POST", true], ["GET", true]]);
  });
  it("режим direct (mTLS клиентским сертификатом): POST и GET подписаны поверх взаимного TLS", async () => {
    const s = await rinServer("https");
    expect(await rinTransport(direct(), { signer: rsa })(`${s.base}/api/v1/inspection/P-3`, payload)).toEqual({ status: 202 });
    expect((await rinGetTransport(direct(), { signer: rsa })(`${s.base}/api/v1/packages`, 1000)).status).toBe(200);
    expect(s.seen.every((x) => x.ok)).toBe(true);
    expect(s.seen).toHaveLength(2);
  });
  it("каждый запрос получает новый nonce: два одинаковых POST принимаются оба", async () => {
    const s = await rinServer();
    const send = rinTransport({ mode: "off", url: s.base }, { signer: ec });
    await send(`${s.base}/api/v1/inspection/P-1`, payload);
    await send(`${s.base}/api/v1/inspection/P-1`, payload);
    expect(s.seen.map((x) => x.ok)).toEqual([true, true]);
    expect(s.seen[0]!.headers["x-signature-nonce"]).not.toBe(s.seen[1]!.headers["x-signature-nonce"]);
  });
  it("подменённое тело с подлинными заголовками подписи — сервер «РиН» отклоняет (L6)", async () => {
    const s = await rinServer();
    await rinTransport({ mode: "off", url: s.base }, { signer: rsa })(`${s.base}/api/v1/inspection/P-1`, payload);
    const forged = Buffer.from(JSON.stringify({ ...payload, confirmed_violations: [] }));
    const r = await replay(s.base, s.seen[0]!, { body: forged });
    expect(r.status).toBe(401);
    expect(r.text).toMatch(/^подпись:/);
  });
  it("подменённый путь с подлинными заголовками подписи — сервер «РиН» отклоняет (L6)", async () => {
    const s = await rinServer();
    await rinTransport({ mode: "off", url: s.base }, { signer: rsa })(`${s.base}/api/v1/inspection/P-1`, payload);
    expect((await replay(s.base, s.seen[0]!, { url: "/api/v1/inspection/P-666" })).status).toBe(401);
  });
  it("повтор запроса с тем же nonce — сервер «РиН» отклоняет как повтор (L6)", async () => {
    const s = await rinServer();
    await rinTransport({ mode: "off", url: s.base }, { signer: rsa })(`${s.base}/api/v1/inspection/P-1`, payload);
    const r = await replay(s.base, s.seen[0]!);
    expect(r).toEqual({ status: 401, text: "повтор nonce" });
  });
  it("метка времени старше 300 с — сервер «РиН» отклоняет (L6)", async () => {
    const s = await rinServer();
    const stale = rinTransport({ mode: "off", url: s.base }, { signer: ec, now: () => new Date(Date.now() - 301_000) });
    expect(await stale(`${s.base}/api/v1/inspection/P-1`, payload)).toEqual({ status: 401 });
    expect(s.seen[0]!.reason).toMatch(/метка времени/);
  });
  it("запрос без подписи и подпись чужим УЦ — сервер «РиН» отклоняет (L6)", async () => {
    const s = await rinServer();
    expect(await rinTransport({ mode: "off", url: s.base }, { signer: null })(`${s.base}/x`, payload)).toEqual({ status: 401 });
    const foreign = pemSigner({ certPem: text(pki("signer-foreign.crt")), keyPem: text(pki("signer-foreign.key")) });
    expect(await rinTransport({ mode: "off", url: s.base }, { signer: foreign })(`${s.base}/x`, payload)).toEqual({ status: 401 });
    expect(s.seen.map((x) => x.reason)).toEqual(["нет заголовка X-Signature", expect.stringMatching(/^подпись:/)]);
  });
  it("отказ подписанта: запрос не уходит ни в одном режиме, ошибка «не подписан — не отправлен»", async () => {
    const s = await rinServer();
    const msg = /УКЭП: запрос к ИАИС «РиН» не подписан — не отправлен \(тестовый отказ: СКЗИ недоступно\)/;
    for (const tls of [{ mode: "off", url: s.base }, { mode: "gost-proxy", url: s.base }] as RinTls[]) {
      await expect(rinTransport(tls, { signer: failing })(`${s.base}/api/v1/inspection/P-1`, payload)).rejects.toThrow(msg);
      await expect(rinGetTransport(tls, { signer: failing })(`${s.base}/api/v1/packages`, 1000)).rejects.toThrow(msg);
    }
    expect(s.seen).toHaveLength(0);
  });
});

// ─────────────────────────────── L4: отказ подписанта → задание остаётся PENDING_SYNC (OS-INSP-5.2.2)

describe("отказ подписанта при отправке протокола — повтор по очереди sync_jobs (L4)", () => {
  let db: any;
  let rin: typeof import("../src/services/rin.ts");
  beforeEach(async () => {
    const { openDb } = await import("../src/db.ts");
    rin = await import("../src/services/rin.ts");
    db = await openDb("memory");
  });
  afterEach(async () => {
    await db.close();
  });

  it("подписант отказал — протокол не ушёл, задание PENDING_SYNC с причиной УКЭП; подписант вернулся — SYNCED с подписью", async () => {
    const s = await rinServer();
    const now = new Date().toISOString();
    const body = JSON.stringify({ process_id: "P-UKEP-1", object: {}, protocol_version: 1, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: null });
    await db.run("insert into objects (id, name, created_at) values ('UKEP-OBJ', 'Объект', $1)", [now]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('P-UKEP-1', 'UKEP-OBJ', 'FINALIZED', 1, $1, $1)", [now]);
    await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ('P-UKEP-1', 1, 'FINALIZED', $1, $2)", [body, now]);
    await db.run("insert into sync_jobs (inspection_id, protocol_version, status, next_attempt_at, created_at, updated_at) values ('P-UKEP-1', 1, 'PENDING_SYNC', $1, $1, $1)", [now]);
    const toBase = (fn: ReturnType<typeof rinTransport>) => (url: string, p: unknown) => fn(s.base + new URL(url).pathname, p);

    rin.setRinTransport(toBase(rinTransport({ mode: "off", url: s.base }, { signer: failing })));
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 1000))).toBe(1);
    const j1 = await db.get("select status, attempts, last_error from sync_jobs where inspection_id = 'P-UKEP-1'");
    expect(j1).toMatchObject({ status: "PENDING_SYNC", attempts: 1 });
    expect(j1.last_error).toMatch(/УКЭП: запрос к ИАИС «РиН» не подписан — не отправлен/);
    expect((await db.get("select sync_status from inspections where id = 'P-UKEP-1'")).sync_status).toBe("PENDING_SYNC");
    expect(s.seen).toHaveLength(0);

    rin.setRinTransport(toBase(rinTransport({ mode: "off", url: s.base }, { signer: ec })));
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 3_600_000))).toBe(1);
    expect(await db.get("select status, attempts from sync_jobs where inspection_id = 'P-UKEP-1'")).toMatchObject({ status: "SYNCED", attempts: 2 });
    expect(s.seen.map((x) => [x.url, x.ok])).toEqual([["/mock-rin/api/v1/inspection/P-UKEP-1", true]]);
  });
});

// ─────────────────────────────── cryptopro: поддельный cryptcp

describe("подписант cryptopro (cryptcp КриптоПро, поддельный бинарник)", () => {
  const FAKE = join(UKEP, "fake-cryptcp.sh");
  const T = "0123456789abcdef0123456789abcdef01234567";
  let root: string;
  let log: string;
  beforeEach(() => {
    root = mkdtempSync(join(TMP, "cp-"));
    log = join(TMP, `cryptcp-${Date.now()}.log`);
    Object.assign(process.env, { FAKE_CRYPTCP_LOG: log, FAKE_CRYPTCP_CERT: pki("signer-ec.crt"), FAKE_CRYPTCP_KEY: pki("signer-ec.key"), FAKE_CRYPTCP_FAIL: "0" });
  });

  it("cryptcp вызывается как -sign -detached -der -thumbprint <T> <вход> <выход> из каталога 0700; каталог удалён; подпись верна", async () => {
    const sig = await cryptoproSigner({ cryptcpBin: FAKE, thumbprint: T, tmpRoot: root }).sign(DATA);
    const lines = text(log).trim().split("\n");
    const [inFile, outFile] = lines.slice(5, 7);
    expect(lines.slice(0, 5)).toEqual(["-sign", "-detached", "-der", "-thumbprint", T]);
    expect(lines.slice(0, 7)).toEqual(cryptcpArgs(T, inFile!, outFile!));
    expect(relative(root, inFile!)).toMatch(/^inspector-ukep-[^/]+\/request\.bin$/);
    expect(lines[7]).toBe("700");
    expect(readdirSync(root)).toEqual([]);
    expect(S.checkDetached(DATA, sig, trust).status).toBe("VALID");
  });
  it("cryptcp завершился с ошибкой — ошибка с кодом, путь временного файла скрыт, каталог удалён", async () => {
    process.env.FAKE_CRYPTCP_FAIL = "1";
    const e = await cryptoproSigner({ cryptcpBin: FAKE, thumbprint: T, tmpRoot: root }).sign(DATA).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/^cryptopro: подпись не создана \(код 2\): Error: Certificate not found: <скрыто>/);
    expect((e as Error).message).not.toContain(root);
    expect(readdirSync(root)).toEqual([]);
  });
  it("cryptcp не найден — ошибка запуска; завис — таймаут; каталог удалён в обоих случаях", async () => {
    await expect(cryptoproSigner({ cryptcpBin: join(TMP, "нет-cryptcp"), thumbprint: T, tmpRoot: root }).sign(DATA)).rejects.toThrow("cryptopro: программа подписи не запускается (ENOENT)");
    const slow = join(TMP, "slow-cryptcp.sh");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(slow, 0o755);
    await expect(cryptoproSigner({ cryptcpBin: slow, thumbprint: T, tmpRoot: root, timeoutMs: 200 }).sign(DATA)).rejects.toThrow("cryptopro: подпись не получена за 200 мс");
    expect(readdirSync(root)).toEqual([]);
  });
  it("cryptcp вернул не DER или не создал файл — ошибка, а не пустая подпись", async () => {
    const junk = join(TMP, "junk-cryptcp.sh");
    writeFileSync(junk, '#!/bin/sh\nfor a; do out="$a"; done\necho junk > "$out"\n');
    chmodSync(junk, 0o755);
    await expect(cryptoproSigner({ cryptcpBin: junk, thumbprint: T, tmpRoot: root }).sign(DATA)).rejects.toThrow("cryptopro: программа вернула не DER CMS");
    const none = join(TMP, "none-cryptcp.sh");
    writeFileSync(none, "#!/bin/sh\nexit 0\n");
    chmodSync(none, 0o755);
    await expect(cryptoproSigner({ cryptcpBin: none, thumbprint: T, tmpRoot: root }).sign(DATA)).rejects.toThrow("cryptopro: cryptcp завершился без файла подписи");
    expect(readdirSync(root)).toEqual([]);
  });
});

// ─────────────────────────────── openssl-gost: ГОСТ Р 34.10-2012 через gost-engine

// Образ с OpenSSL 3.5.1 и gost-engine (amd64 + arm64), закреплён по digest. Не скачивается тестом (≈ 2,3 ГБ):
// docker pull seshhekotikhin/openssl-gost@sha256:6b20b178…17e8 — иначе тест пропускается с причиной.
const GOST_IMAGE = "seshhekotikhin/openssl-gost@sha256:6b20b178c41291eb7285c6d1a53e21d8c2faac433b9040e3393cb94e291b17e8";
const gostReady = spawnSync("docker", ["image", "inspect", GOST_IMAGE], { stdio: "ignore" }).status === 0;

describe("подписант openssl-gost (ГОСТ Р 34.10-2012, 256 бит)", () => {
  it("аргументы openssl cms -sign: DER, md_gost12_256, движок gost или провайдер OpenSSL 3", () => {
    expect(opensslGostArgs({ certFile: "/c.pem", keyFile: "/k.pem", gost: { kind: "engine", name: "gost" } })).toEqual([
      "cms", "-sign", "-binary", "-nosmimecap", "-outform", "DER", "-md", "md_gost12_256", "-engine", "gost", "-signer", "/c.pem", "-inkey", "/k.pem",
    ]);
    expect(opensslGostArgs({ certFile: "/c", keyFile: "/k", gost: { kind: "provider", name: "gostprov" } })).toEqual(expect.arrayContaining(["-provider", "gostprov", "-provider", "default"]));
  });
  it("openssl без ГОСТ отказал — ошибка с кодом, путь к ключу в тексте не раскрывается", async () => {
    const key = pki("signer-ec.key");
    const e = await opensslGostSigner({ opensslBin: "openssl", certFile: pki("signer-ec.crt"), keyFile: key, gost: { kind: "engine", name: "нет-такого-движка" } }).sign(DATA).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/^openssl-gost: подпись не создана \(код \d+\)/);
    expect((e as Error).message).not.toContain(key);
    expect(maskStderr(`cannot open ${key}: denied`, [key])).toBe("cannot open <скрыто>: denied");
    expect(maskStderr("load /etc/secret/k.pem failed")).toBe("load <путь> failed");
  });
  it.skipIf(!gostReady)(`ГОСТ: подпись opensslGostSigner проверяется openssl cms -verify с gost-engine; подмена данных — отказ${gostReady ? "" : " — ПРОПУЩЕН: нет docker или образа " + GOST_IMAGE}`, { timeout: 120_000 }, async () => {
    const d = mkdtempSync(join(TMP, "gost-"));
    const dock = (...args: string[]) => execFileSync("docker", ["run", "--rm", "-i", "-v", `${d}:${d}`, "--entrypoint", "openssl", GOST_IMAGE, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    dock("genpkey", "-engine", "gost", "-algorithm", "gost2012_256", "-pkeyopt", "paramset:A", "-out", join(d, "k.pem"));
    dock("req", "-engine", "gost", "-x509", "-new", "-key", join(d, "k.pem"), "-subj", "/CN=Инспектор ИИ (тест ГОСТ)", "-utf8", "-days", "365", "-md_gost12_256", "-out", join(d, "c.pem"));
    // обёртка: подписант запускает «openssl» с нашими аргументами и stdin — это openssl образа с gost-engine
    const wrapper = join(d, "openssl-gost.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec docker run --rm -i -v '${d}:${d}' --entrypoint openssl '${GOST_IMAGE}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const signer = opensslGostSigner({ opensslBin: wrapper, certFile: join(d, "c.pem"), keyFile: join(d, "k.pem"), gost: { kind: "engine", name: "gost" }, timeoutMs: 60_000 });
    const sig = await signer.sign(DATA);
    writeFileSync(join(d, "data"), DATA);
    writeFileSync(join(d, "sig"), sig);
    writeFileSync(join(d, "bad"), Buffer.concat([DATA, Buffer.from("x")]));
    const verify = (content: string) => spawnSync("docker", ["run", "--rm", "-v", `${d}:${d}`, "--entrypoint", "openssl", GOST_IMAGE, "cms", "-verify", "-engine", "gost", "-binary", "-inform", "DER", "-in", join(d, "sig"), "-content", join(d, content), "-CAfile", join(d, "c.pem"), "-purpose", "any", "-out", "/dev/null"]).status;
    expect(verify("data")).toBe(0);
    expect(verify("bad")).not.toBe(0);
    // своя проверка ГОСТ без СКЗИ не считает (OS-INSP-1.2.13): подпись распознана как CMS с алгоритмами ГОСТ — UNVERIFIED
    const facts = S.signatureFacts(DATA, sig, trust, new Date());
    expect(facts[0]!.cms).toBe(true);
    expect(facts[0]!.algorithms).toEqual(expect.arrayContaining(["1.2.643.7.1.1.2.2", "1.2.643.7.1.1.1.1"]));
    expect(S.checkDetached(DATA, sig, trust).status).toBe("UNVERIFIED");
  });
});

// ─────────────────────────────── L7: архитектура — исходящий HTTP только через транспорт с подписью

const SRC = join(API, "src");
/** Модули, которым разрешён исходящий HTTP: «РиН» — только rin-tls.ts (подпись УКЭП); прочее — инфраструктура контура. */
const ALLOWED = new Map([
  ["services/rin-tls.ts", "ИАИС «РиН» — транспорт с подписью УКЭП"],
  ["services/ml-client.ts", "ML-сервис контура"],
  ["services/norms.ts", "ML-сервис контура (нормы)"],
  ["services/export.ts", "ML-сервис контура (рендер протокола)"],
  ["services/blobstore.ts", "S3 контура (SigV4, шифрование на клиенте, ADR-0006)"],
  ["cli/load-package.ts", "CLI-загрузчик — клиент собственного API, не исходящий вызов сервера"],
]);
const OUTGOING = [/(?<![.\w])fetch\s*\(/, /\b(?:http|https|lib|mod)\.(?:request|get)\s*\(/, /\bundici\b/, /\bfrom\s+["']node:(?:http2)["']/, /\bnew\s+(?:WebSocket|XMLHttpRequest)\b/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
/** Места исходящих HTTP-вызовов: «файл:строка». Строки-комментарии пропускаются. */
function outgoingCalls(root: string): string[] {
  return files(root).flatMap((f) =>
    readFileSync(f, "utf8").split("\n").flatMap((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
      return OUTGOING.some((re) => re.test(line)) ? [`${relative(root, f)}:${i + 1}`] : [];
    }),
  );
}

describe("архитектура: исходящий запрос только через транспорт с подписью УКЭП (L7)", () => {
  it("самопроверка сканера на фикстуре: fetch, https.request, undici и http.get найдены, комментарий пропущен", () => {
    const d = mkdtempSync(join(TMP, "arch-"));
    mkdirSync(join(d, "services"));
    writeFileSync(join(d, "services/leak.ts"), ['// fetch("https://x") в комментарии', 'await fetch("https://rin.example/api");', "https.request(u, {}, cb);", 'import { request } from "undici";', "http.get(u);", "this.fetch(sha);"].join("\n"));
    expect(outgoingCalls(d)).toEqual(["services/leak.ts:2", "services/leak.ts:3", "services/leak.ts:4", "services/leak.ts:5"]);
  });
  it("в apps/api/src нет исходящего HTTP вне белого списка — исходящий запрос вне транспорта с подписью УКЭП запрещён", () => {
    const outside = outgoingCalls(SRC).filter((at) => !ALLOWED.has(at.slice(0, at.lastIndexOf(":"))));
    expect(outside, "исходящий запрос вне транспорта с подписью УКЭП (services/rin-tls.ts); инфраструктура контура — в белый список ALLOWED с обоснованием").toEqual([]);
  });
  it("белый список не устарел: каждый модуль из него существует и действительно ходит в сеть", () => {
    const hit = new Set(outgoingCalls(SRC).map((at) => at.slice(0, at.lastIndexOf(":"))));
    expect([...ALLOWED.keys()].filter((f) => !hit.has(f))).toEqual([]);
  });
  it("транспорт «РиН» строится вне rin-tls.ts только функциями *FromEnv — подпись по окружению не обойти", () => {
    const direct = files(SRC).flatMap((f) => (f.endsWith("services/rin-tls.ts") ? [] : readFileSync(f, "utf8").split("\n").flatMap((l, i) => (/\brin(?:Get)?Transport\s*\(/.test(l) ? [`${relative(SRC, f)}:${i + 1}`] : []))));
    expect(direct, "rinTransport/rinGetTransport без подписанта по окружению — используйте rinTransportFromEnv / rinGetTransportFromEnv").toEqual([]);
  });
});

// ─────────────────────────────── L7: окружение — fail-closed

const load = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], {
    cwd: API,
    env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AV: "clamd", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem", INSPECTOR_AMQP_URL: "amqps://rabbit:5671", INSPECTOR_ML_URL: "https://ml:8811", INSPECTOR_UKEP_MODE: "", ...env },
    encoding: "utf8",
  });

describe("конфигурация подписи УКЭП при старте (L7)", () => {
  const gpuReal = { INSPECTOR_PROFILE: "gpu", INSPECTOR_RIN_MOCK: "0" };
  it("профиль gpu с настоящей «РиН» без подписи УКЭП — отказ старта с понятной ошибкой", () => {
    const r = load(gpuReal);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("INSPECTOR_UKEP_MODE=off недопустим в профиле gpu");
    expect(load({ ...gpuReal, INSPECTOR_UKEP_MODE: "pem", INSPECTOR_UKEP_CERT_FILE: pki("signer-ec.crt"), INSPECTOR_UKEP_KEY_FILE: pki("signer-ec.key") }).stderr).toContain("не УКЭП");
  });
  it("профиль gpu с настоящей «РиН»: cryptopro с отпечатком — старт; openssl-gost без файла ключа — отказ с именем переменной", () => {
    expect(load({ ...gpuReal, INSPECTOR_UKEP_MODE: "cryptopro", INSPECTOR_UKEP_THUMBPRINT: "ab".repeat(20) }).status).toBe(0);
    const r = load({ ...gpuReal, INSPECTOR_UKEP_MODE: "openssl-gost", INSPECTOR_UKEP_CERT_FILE: pki("signer-ec.crt"), INSPECTOR_UKEP_KEY_FILE: pki("нет.key") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`INSPECTOR_UKEP_KEY_FILE=${pki("нет.key")}: файл не найден`);
  });
  it("dev и gpu с заглушкой «РиН» стартуют без подписи (off по умолчанию)", () => {
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_ML_URL: "http://127.0.0.1:8811" }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "gpu" }).status).toBe(0);
  });
});
