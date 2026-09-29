// NFR-UKEP · TZA-12.10-01 «Все запросы к внешним системам подписываются УКЭП»: чистые функции подписи запроса к ИАИС «РиН».
//
// Подписывается каноническая строка запроса (UTF-8), подпись — откреплённая CMS SignedData (DER) в заголовке X-Signature:
//
//   METHOD \n path?query \n timestamp \n nonce \n sha256hex(тело)
//
// METHOD — заглавными; path?query — как в строке запроса HTTP, без схемы, хоста и фрагмента; timestamp — целые секунды
// unix (UTC); nonce — 128 случайных бит в нижнем hex; тело — ровно те байты, что уходят в сеть (у GET — пустое).
// Получатель пересобирает строку сам из метода, пути и тела, проверяет подпись, свежесть (±300 с) и уникальность nonce.
// Формат и требования к «РиН» — docs/integration/UKEP-REQUEST-SIGNING.md. Здесь нет IO: nonce и подпись — в services.

export const FRESHNESS_SEC = 300;

export const SIGNATURE_HEADER = "x-signature";
export const TIMESTAMP_HEADER = "x-signature-timestamp";
export const NONCE_HEADER = "x-signature-nonce";

export interface CanonicalParts {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}

const NONCE_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TS_RE = /^\d{1,12}$/;
const METHOD_RE = /^[A-Z]+$/;

/** nonce — 128 бит в нижнем hex, ровно 32 символа. */
export const isNonce = (s: string): boolean => NONCE_RE.test(s);

/** Метка времени подписи — целые секунды unix. */
export const unixTimestamp = (at: Date): string => String(Math.floor(at.getTime() / 1000));

/** Путь с запросом из адреса: то, что стоит в строке запроса HTTP (без хоста и фрагмента). */
export function pathWithQueryOf(url: string): string {
  const u = new URL(url);
  return (u.pathname || "/") + u.search;
}

/** Каноническая строка запроса. Любая часть не своего вида — ошибка: подписывать неоднозначное нельзя. */
export function canonicalRequest(p: CanonicalParts): string {
  const method = p.method.toUpperCase();
  if (!METHOD_RE.test(method)) throw new Error(`подпись запроса: метод «${p.method}» не метод HTTP`);
  if (!p.pathWithQuery.startsWith("/") || /[\r\n]/.test(p.pathWithQuery)) throw new Error("подпись запроса: путь обязан начинаться с «/» и не содержать перевода строки");
  if (!TS_RE.test(p.timestamp)) throw new Error("подпись запроса: метка времени — целые секунды unix");
  if (!isNonce(p.nonce)) throw new Error("подпись запроса: nonce — 128 бит в нижнем hex");
  if (!SHA256_RE.test(p.bodySha256Hex)) throw new Error("подпись запроса: SHA-256 тела — 64 символа нижнего hex");
  return [method, p.pathWithQuery, p.timestamp, p.nonce, p.bodySha256Hex].join("\n");
}

export type Freshness = { ok: true } | { ok: false; reason: string };

/** Свежесть метки: |now − ts| ≤ окна (включительно, в миллисекундах — без округления в пользу отправителя). */
export function checkFreshness(ts: string, now: Date, windowSec = FRESHNESS_SEC): Freshness {
  if (!TS_RE.test(ts)) return { ok: false, reason: "метка времени подписи не число секунд" };
  const skewMs = Math.abs(now.getTime() - Number(ts) * 1000);
  return skewMs <= windowSec * 1000 ? { ok: true } : { ok: false, reason: `метка времени подписи расходится с часами получателя больше чем на ${windowSec} с` };
}

/** Заголовки подписанного запроса. */
export function signatureHeaders(s: { signatureDer: Uint8Array; timestamp: string; nonce: string }): Record<string, string> {
  return {
    [SIGNATURE_HEADER]: Buffer.from(s.signatureDer).toString("base64"),
    [TIMESTAMP_HEADER]: s.timestamp,
    [NONCE_HEADER]: s.nonce,
  };
}

type Headers = Record<string, string | string[] | undefined>;
export type SignatureHeaders = { ok: true; signature: Buffer; timestamp: string; nonce: string } | { ok: false; reason: string };

const one = (h: Headers, name: string): string | null => {
  const v = h[name];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** Разбор заголовков подписи на стороне получателя («РиН», тестовый сервер). Подпись здесь не проверяется. */
export function readSignatureHeaders(h: Headers): SignatureHeaders {
  const sig = one(h, SIGNATURE_HEADER);
  if (!sig) return { ok: false, reason: "нет заголовка X-Signature" };
  const timestamp = one(h, TIMESTAMP_HEADER);
  if (!timestamp) return { ok: false, reason: "нет заголовка X-Signature-Timestamp" };
  const nonce = one(h, NONCE_HEADER);
  if (!nonce) return { ok: false, reason: "нет заголовка X-Signature-Nonce" };
  if (!isNonce(nonce)) return { ok: false, reason: "X-Signature-Nonce не 128 бит hex" };
  const der = /^[A-Za-z0-9+/]+={0,2}$/.test(sig) ? Buffer.from(sig, "base64") : null;
  if (!der || der.length < 2 || der[0] !== 0x30) return { ok: false, reason: "X-Signature не base64 DER" };
  return { ok: true, signature: der, timestamp, nonce };
}

// ─────────────────────────────── режим подписанта по окружению

/** Способ подключить ГОСТ к OpenSSL: движок (OpenSSL 1.1/3, gost-engine) или провайдер OpenSSL 3. */
export type GostLoad = { kind: "engine"; name: string } | { kind: "provider"; name: string };

export type UkepConfig =
  | { mode: "off" }
  | { mode: "pem"; certFile: string; keyFile: string; chainFile: string | null; qualified?: false }
  | { mode: "openssl-gost"; certFile: string; keyFile: string; opensslBin: string; gost: GostLoad }
  | { mode: "cryptopro"; cryptcpBin: string; thumbprint: string };

type Env = Record<string, string | undefined>;
const val = (env: Env, name: string) => env[name]?.trim() || undefined;

/**
 * Окружение + профиль → режим подписанта. Ключи и сертификаты — только путями к файлам (*_FILE), значения в окружении
 * не принимаются. Fail-closed: профиль gpu с настоящей «РиН» (INSPECTOR_RIN_MOCK=0) без подписи УКЭП не стартует,
 * а RSA/ECDSA (pem) там не годится — это не квалифицированная подпись.
 */
export function resolveUkep(env: Env, ctx: { profile: string; mock: boolean }): UkepConfig {
  const relaxed = ctx.mock || ctx.profile === "dev";
  const mode = val(env, "INSPECTOR_UKEP_MODE") ?? "off";
  const need = (name: string) => {
    const x = val(env, name);
    if (!x) throw new Error(`INSPECTOR_UKEP_MODE=${mode} требует ${name}`);
    return x;
  };

  if (mode === "off") {
    if (!relaxed) throw new Error("INSPECTOR_UKEP_MODE=off недопустим в профиле gpu с настоящей ИАИС «РиН» (INSPECTOR_RIN_MOCK=0): запросы к внешней системе подписываются УКЭП — нужен openssl-gost или cryptopro (ТЗ 12.10, NFR-UKEP)");
    return { mode };
  }
  if (mode === "pem") {
    // Решение владельца 27.09: сертифицированного СКЗИ и ключей УКЭП проекту не выдают — в gpu допускается коннектор с
    // неквалифицированной подписью (тестовый ключ), но только явным INSPECTOR_UKEP_NONQUALIFIED=1 и с пометкой
    // qualified: false (журнал при старте, /health). Настоящий ключ — сменой режима на cryptopro, без правки кода.
    const nq = val(env, "INSPECTOR_UKEP_NONQUALIFIED");
    if (nq !== undefined && nq !== "1" && nq !== "0") throw new Error(`INSPECTOR_UKEP_NONQUALIFIED=${nq}: ждём 1 или 0`);
    if (!relaxed && nq !== "1") throw new Error("INSPECTOR_UKEP_MODE=pem (RSA/ECDSA) — не УКЭП: в профиле gpu с настоящей ИАИС «РиН» нужен openssl-gost или cryptopro (NFR-UKEP); неквалифицированный коннектор — только явным INSPECTOR_UKEP_NONQUALIFIED=1");
    const pem = { mode, certFile: need("INSPECTOR_UKEP_CERT_FILE"), keyFile: need("INSPECTOR_UKEP_KEY_FILE"), chainFile: val(env, "INSPECTOR_UKEP_CHAIN_FILE") ?? null } as const;
    return relaxed && nq !== "1" ? pem : { ...pem, qualified: false };
  }
  if (mode === "openssl-gost") {
    const certFile = need("INSPECTOR_UKEP_CERT_FILE");
    const keyFile = need("INSPECTOR_UKEP_KEY_FILE");
    const how = val(env, "INSPECTOR_UKEP_GOST") ?? "engine";
    if (how !== "engine" && how !== "provider") throw new Error(`INSPECTOR_UKEP_GOST=${how}: ждём engine или provider`);
    const name = val(env, "INSPECTOR_UKEP_GOST_NAME") ?? (how === "engine" ? "gost" : "gostprov");
    return { mode, certFile, keyFile, opensslBin: val(env, "INSPECTOR_UKEP_OPENSSL_BIN") ?? "openssl", gost: { kind: how, name } };
  }
  if (mode === "cryptopro") {
    const thumbprint = need("INSPECTOR_UKEP_THUMBPRINT");
    if (!/^[0-9a-fA-F]{40}$/.test(thumbprint)) throw new Error("INSPECTOR_UKEP_THUMBPRINT: отпечаток сертификата — 40 hex (SHA-1)");
    return { mode, cryptcpBin: val(env, "INSPECTOR_UKEP_CRYPTCP_BIN") ?? "/opt/cprocsp/bin/amd64/cryptcp", thumbprint: thumbprint.toLowerCase() };
  }
  throw new Error(`INSPECTOR_UKEP_MODE=${mode}: ждём off, pem, openssl-gost или cryptopro`);
}
