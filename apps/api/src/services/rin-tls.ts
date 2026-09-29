// NFR-MTLS · TZA-9.6.2-03 «Аутентификация клиентскими сертификатами (УКЭП)»: транспорт в ИАИС «РиН» с взаимной TLS-аутентификацией.
//
// Сертификат УКЭП — ГОСТ Р 34.10-2012, а OpenSSL в Node ГОСТ-шифронаборов не знает. Поэтому режим выбирается окружением
// INSPECTOR_RIN_TLS, и каждый режим либо работает, либо громко падает при построении транспорта — тихих дефолтов нет:
//
//  direct     — mTLS средствами Node (node:https): клиентский сертификат INSPECTOR_RIN_CLIENT_CERT + INSPECTOR_RIN_CLIENT_KEY
//               или контейнер INSPECTOR_RIN_CLIENT_PFX + INSPECTOR_RIN_CLIENT_PFX_PASS; корень «РиН» — INSPECTOR_RIN_CA;
//               сертификат сервера проверяется всегда (rejectUnauthorized: true); нижняя версия протокола —
//               INSPECTOR_RIN_TLS_MIN (TLSv1.2 по умолчанию, допустимы TLSv1.2 и TLSv1.3). Годится для RSA/ECDSA и для
//               проверки контура; УКЭП на ГОСТ-ключе так не предъявить.
//  gost-proxy — эксплуатационный путь для УКЭП: обычный HTTP на локальный ГОСТ-TLS-шлюз сертифицированного СКЗИ
//               (КриптоПро stunnel / NGate рядом с сервисом). Шлюз держит ключ УКЭП и делает mTLS с «РиН». Открытым текстом
//               можно говорить только с loopback: INSPECTOR_RIN_URL обязан указывать на 127.0.0.1 / ::1 / localhost.
//  off        — прежний fetch без клиентского сертификата. Только для заглушки (INSPECTOR_RIN_MOCK=1) или профиля dev;
//               профиль gpu с настоящей «РиН» и off — ошибка.
//
// Пароль PFX и ключи не попадают ни в сообщения об ошибках, ни в логи: в ошибках — только имена переменных и пути.
//
// NFR-UKEP · TZA-12.10-01: каждый запрос к «РиН» во всех режимах проходит через signedHeaders — подпись канонической
// строки запроса (domain/request-signing.ts) подписантом УКЭП (services/request-signer.ts), заголовки X-Signature,
// X-Signature-Timestamp, X-Signature-Nonce. Отказ подписанта — исключение до открытия соединения: запрос не уходит,
// отправка протокола остаётся в PENDING_SYNC с повтором (OS-INSP-5.2.2). Архитектурный тест (ukep-signing.test.ts)
// не пускает исходящие HTTP-вызовы вне этого модуля и белого списка инфраструктуры контура.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createSecureContext } from "node:tls";
import { canonicalRequest, pathWithQueryOf, resolveUkep, signatureHeaders, unixTimestamp } from "../domain/request-signing.ts";
import { newNonce, signerFromConfig, type Signer } from "./request-signer.ts";

export type RinTls =
  | { mode: "off"; url: string }
  | { mode: "gost-proxy"; url: string }
  | {
      mode: "direct";
      url: string;
      caPath: string;
      minVersion: "TLSv1.2" | "TLSv1.3";
      client: { kind: "pem"; certPath: string; keyPath: string } | { kind: "pfx"; pfxPath: string; passphrase: string };
    };

export type RinSend = (url: string, payload: unknown) => Promise<{ status: number }>;
/** GET к «РиН» для автозабора (OS-INSP-1.2.15): статус и тело не длиннее maxBytes + 1; редиректы не выполняются. */
export type RinGet = (url: string, maxBytes: number) => Promise<{ status: number; body: Buffer }>;

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const DEFAULT_URL = "http://127.0.0.1:8810/mock-rin";
export const RIN_TIMEOUT_MS = 30_000;

function v(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function need(env: Env, name: string, mode: string): string {
  const x = v(env, name);
  if (!x) throw new Error(`INSPECTOR_RIN_TLS=${mode} требует ${name}`);
  return x;
}

/** Подписант и источники метки/nonce транспорта. signer: null — без подписи (режим INSPECTOR_UKEP_MODE=off: заглушка, dev). */
export interface RinTransportOpts {
  timeoutMs?: number;
  signer?: Signer | null;
  now?: () => Date;
  nonce?: () => string;
}

/**
 * Заголовки подписи УКЭП запроса: единственная точка, через которую проходит каждый запрос к «РиН». Подписывается
 * ровно то тело, что уходит в сеть. Отказ подписанта — ошибка «запрос не подписан — не отправлен».
 */
async function signedHeaders(o: RinTransportOpts, method: string, url: string, body: Buffer): Promise<Record<string, string>> {
  const signer = o.signer ?? null;
  if (!signer) return {};
  const timestamp = unixTimestamp((o.now ?? (() => new Date()))());
  const nonce = (o.nonce ?? newNonce)();
  const canon = canonicalRequest({ method, pathWithQuery: pathWithQueryOf(url), timestamp, nonce, bodySha256Hex: createHash("sha256").update(body).digest("hex") });
  let der: Buffer;
  try {
    der = await signer.sign(Buffer.from(canon, "utf8"));
  } catch (e) {
    throw new Error(`УКЭП: запрос к ИАИС «РиН» не подписан — не отправлен (${signer.describe()}: ${e instanceof Error ? e.message : String(e)})`);
  }
  return signatureHeaders({ signatureDer: der, timestamp, nonce });
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Чистая функция: окружение + профиль → описание режима транспорта. Любая неполнота — ошибка с именем переменной. */
export function resolveRinTls(env: Env, ctx: { profile: string; mock: boolean }): RinTls {
  const url = v(env, "INSPECTOR_RIN_URL") ?? DEFAULT_URL;
  const relaxed = ctx.mock || ctx.profile === "dev";
  const mode = v(env, "INSPECTOR_RIN_TLS") ?? (relaxed ? "off" : "direct");

  if (mode === "off") {
    if (!relaxed) throw new Error("INSPECTOR_RIN_TLS=off недопустим в профиле gpu с настоящей ИАИС «РиН» (INSPECTOR_RIN_MOCK=0): нужен direct или gost-proxy (NFR-MTLS)");
    return { mode, url };
  }

  if (mode === "gost-proxy") {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`INSPECTOR_RIN_URL=${url}: не URL`);
    }
    if (u.protocol !== "http:") throw new Error(`INSPECTOR_RIN_TLS=gost-proxy: INSPECTOR_RIN_URL обязан быть http:// на локальный ГОСТ-TLS-шлюз СКЗИ, получено ${u.protocol}`);
    if (!LOOPBACK.has(u.hostname)) throw new Error(`INSPECTOR_RIN_TLS=gost-proxy: INSPECTOR_RIN_URL=${url} не loopback — открытым текстом в сеть слать нельзя, шлюз СКЗИ должен слушать 127.0.0.1/::1/localhost`);
    return { mode, url };
  }

  if (mode === "direct") {
    if (!url.startsWith("https://")) throw new Error(`INSPECTOR_RIN_TLS=direct: INSPECTOR_RIN_URL обязан быть https://, получено ${url}`);
    const minVersion = v(env, "INSPECTOR_RIN_TLS_MIN") ?? "TLSv1.2";
    if (minVersion !== "TLSv1.2" && minVersion !== "TLSv1.3") throw new Error(`INSPECTOR_RIN_TLS_MIN=${minVersion}: допустимы только TLSv1.2 и TLSv1.3`);
    const caPath = need(env, "INSPECTOR_RIN_CA", mode);
    const pfxPath = v(env, "INSPECTOR_RIN_CLIENT_PFX");
    const pem = v(env, "INSPECTOR_RIN_CLIENT_CERT") || v(env, "INSPECTOR_RIN_CLIENT_KEY");
    if (pfxPath && pem) throw new Error("INSPECTOR_RIN_TLS=direct: задайте либо INSPECTOR_RIN_CLIENT_PFX, либо INSPECTOR_RIN_CLIENT_CERT + INSPECTOR_RIN_CLIENT_KEY, не оба");
    const client: Extract<RinTls, { mode: "direct" }>["client"] = pfxPath
      ? { kind: "pfx", pfxPath, passphrase: need(env, "INSPECTOR_RIN_CLIENT_PFX_PASS", mode) }
      : { kind: "pem", certPath: need(env, "INSPECTOR_RIN_CLIENT_CERT", mode), keyPath: need(env, "INSPECTOR_RIN_CLIENT_KEY", mode) };
    return { mode, url, caPath, minVersion, client };
  }

  throw new Error(`INSPECTOR_RIN_TLS=${mode}: ждём direct, gost-proxy или off`);
}

function readVar(name: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new Error(`${name}=${path}: файл не читается`);
  }
}

const noAnswer = (timeoutMs: number) => new Error(`ИАИС «РиН»: нет ответа за ${timeoutMs} мс`);

/**
 * OS-INSP-5.2.5 (ТЗ §11, TZA-11-06): срок попытки — целиком, от начала: соединение, передача, заголовки и тело ответа.
 * req.setTimeout — это простой сокета: сервер, отдающий ответ по байту, сбрасывал его каждым байтом и держал попытку
 * сколько угодно. Общий таймер рвёт и запрос, и ответ; обещание завершается один раз. Заголовки подписи УКЭП — T-137.
 */
function post(mod: typeof http | typeof https, url: string, body: Buffer, sig: Record<string, string>, opts: https.RequestOptions, timeoutMs: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let res: http.IncomingMessage | undefined;
    const deadline = setTimeout(() => {
      const err = noAnswer(timeoutMs);
      reject(err);
      res?.destroy(err);
      req.destroy(err);
    }, timeoutMs);
    const settle = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    const req = mod.request(url, { ...opts, method: "POST", headers: { "content-type": "application/json", "content-length": body.length, ...sig } }, (r) => {
      res = r;
      r.resume(); // тело ответа не нужно, но его надо дочитать
      r.on("end", () => settle(resolve)({ status: r.statusCode ?? 0 }));
      r.on("error", settle(reject));
    });
    req.on("error", settle(reject));
    req.end(body);
  });
}

/** Агент mTLS режима direct: файлы сертификатов читаются один раз, битый ключ или пароль — ошибка сразу. */
function directAgent(tls: Extract<RinTls, { mode: "direct" }>): https.Agent {
  const ca = readVar("INSPECTOR_RIN_CA", tls.caPath);
  const creds =
    tls.client.kind === "pfx"
      ? { pfx: readVar("INSPECTOR_RIN_CLIENT_PFX", tls.client.pfxPath), passphrase: tls.client.passphrase }
      : { cert: readVar("INSPECTOR_RIN_CLIENT_CERT", tls.client.certPath), key: readVar("INSPECTOR_RIN_CLIENT_KEY", tls.client.keyPath) };
  // https.Agent не проверяет ключ до соединения — собираем контекст сразу: битый PFX, неверный пароль или ключ
  // не от сертификата дают ошибку при построении транспорта, а не при первой отправке. Текст OpenSSL не пробрасываем.
  try {
    createSecureContext({ ...creds, ca, minVersion: tls.minVersion });
  } catch {
    throw new Error(`INSPECTOR_RIN_TLS=direct: клиентский сертификат/ключ или CA не загружаются (${tls.client.kind === "pfx" ? "INSPECTOR_RIN_CLIENT_PFX / INSPECTOR_RIN_CLIENT_PFX_PASS" : "INSPECTOR_RIN_CLIENT_CERT / INSPECTOR_RIN_CLIENT_KEY"}, INSPECTOR_RIN_CA)`);
  }
  return new https.Agent({ ...creds, ca, rejectUnauthorized: true, minVersion: tls.minVersion, keepAlive: false });
}

/** Транспорт той же формы, что send в rin.ts. Файлы сертификатов читаются здесь, один раз. */
export function rinTransport(tls: RinTls, opts: RinTransportOpts = {}): RinSend {
  const timeoutMs = opts.timeoutMs ?? RIN_TIMEOUT_MS;
  const bodyOf = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8");

  if (tls.mode === "off") {
    return async (url, payload) => {
      const body = bodyOf(payload);
      const sig = await signedHeaders(opts, "POST", url, body);
      // AbortSignal.timeout — срок всей попытки; тело ответа дочитывается под тем же сигналом (OS-INSP-5.2.5)
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...sig }, body, signal: AbortSignal.timeout(timeoutMs) });
        await r.arrayBuffer();
        return { status: r.status };
      } catch (e) {
        throw e instanceof DOMException && e.name === "TimeoutError" ? noAnswer(timeoutMs) : e;
      }
    };
  }

  if (tls.mode === "gost-proxy") {
    return async (url, payload) => {
      // защита в глубину: адрес собирается из конфигурации, но открытым текстом уходить может только на loopback
      if (!isLoopbackUrl(url) || !url.startsWith("http://")) throw new Error("gost-proxy: запрос не на loopback-шлюз СКЗИ отклонён");
      const body = bodyOf(payload);
      return post(http, url, body, await signedHeaders(opts, "POST", url, body), {}, timeoutMs);
    };
  }

  const agent = directAgent(tls);
  return async (url, payload) => {
    if (!url.startsWith("https://")) throw new Error("direct: запрос не по https отклонён");
    const body = bodyOf(payload);
    return post(https, url, body, await signedHeaders(opts, "POST", url, body), { agent }, timeoutMs);
  };
}

const ACCEPT = "application/json, application/octet-stream";

function getReq(mod: typeof http | typeof https, url: string, maxBytes: number, sig: Record<string, string>, opts: https.RequestOptions, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // node:http редиректы не выполняет: 3xx приходит статусом и отклоняет пакет (classifyHttp)
    const req = mod.request(url, { ...opts, method: "GET", headers: { accept: ACCEPT, ...sig } }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        n += c.length;
        if (n > maxBytes) {
          res.destroy(); // больше предела не читаем
          done();
        }
      });
      res.on("end", done);
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`ИАИС «РиН»: нет ответа за ${timeoutMs} мс`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET-транспорт автозабора (OS-INSP-1.2.15) в тех же режимах, что отправка протокола: direct — mTLS клиентским
 * сертификатом, gost-proxy — только loopback-шлюз СКЗИ, off — fetch без сертификата (заглушка или dev).
 */
export function rinGetTransport(tls: RinTls, opts: RinTransportOpts = {}): RinGet {
  const timeoutMs = opts.timeoutMs ?? RIN_TIMEOUT_MS;
  const EMPTY = Buffer.alloc(0); // у GET тела нет: в канонической строке — SHA-256 пустой строки

  if (tls.mode === "off") {
    return async (url, maxBytes) => {
      const sig = await signedHeaders(opts, "GET", url, EMPTY);
      // redirect: "manual" — 3xx приходит статусом; с "error" fetch бросал исключение, неотличимое от сбоя сети
      const r = await fetch(url, { redirect: "manual", headers: { accept: ACCEPT, ...sig }, signal: AbortSignal.timeout(timeoutMs) });
      const chunks: Buffer[] = [];
      let n = 0;
      if (r.body) {
        for await (const c of r.body) {
          chunks.push(Buffer.from(c));
          n += c.length;
          if (n > maxBytes) break; // выход из цикла отменяет поток: больше предела не читаем
        }
      }
      return { status: r.status, body: Buffer.concat(chunks) };
    };
  }

  if (tls.mode === "gost-proxy") {
    return async (url, maxBytes) => {
      if (!isLoopbackUrl(url) || !url.startsWith("http://")) throw new Error("gost-proxy: запрос не на loopback-шлюз СКЗИ отклонён");
      return getReq(http, url, maxBytes, await signedHeaders(opts, "GET", url, EMPTY), {}, timeoutMs);
    };
  }

  const agent = directAgent(tls);
  return async (url, maxBytes) => {
    if (!url.startsWith("https://")) throw new Error("direct: запрос не по https отклонён");
    return getReq(https, url, maxBytes, await signedHeaders(opts, "GET", url, EMPTY), { agent }, timeoutMs);
  };
}

/** Подписант УКЭП по окружению процесса (INSPECTOR_UKEP_MODE): в gpu с настоящей «РиН» без подписи — ошибка. */
export function rinSignerFromEnv(ctx: { profile: string; mock: boolean }): Signer | null {
  return signerFromConfig(resolveUkep(process.env, ctx));
}

/** Транспорт по окружению процесса — то, что rin.ts берёт лениво при первой отправке. Подпись УКЭП — всегда по окружению. */
export function rinTransportFromEnv(ctx: { profile: string; mock: boolean }): RinSend {
  return rinTransport(resolveRinTls(process.env, ctx), { signer: rinSignerFromEnv(ctx) });
}

/** GET-транспорт автозабора по окружению процесса (rin-pull.ts): режим TLS и подпись УКЭП — как у отправки. */
export function rinGetTransportFromEnv(ctx: { profile: string; mock: boolean }, opts: { timeoutMs?: number } = {}): RinGet {
  return rinGetTransport(resolveRinTls(process.env, ctx), { ...opts, signer: rinSignerFromEnv(ctx) });
}
