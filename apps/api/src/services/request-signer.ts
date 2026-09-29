// NFR-UKEP · TZA-12.10-01 «Все запросы к внешним системам подписываются УКЭП»: подписанты запросов к ИАИС «РиН».
//
// Подписант получает каноническую строку запроса (domain/request-signing.ts) и возвращает откреплённую CMS SignedData
// в DER. Провайдеры:
//   pem          — RSA (PKCS#1 v1.5) и ECDSA P-256 средствами node:crypto, CMS собирается pkijs. Не УКЭП: стенд и тесты.
//   openssl-gost — `openssl cms -sign` с gost-engine (или провайдером OpenSSL 3), ГОСТ Р 34.10-2012 / 34.11-2012.
//   cryptopro    — `cryptcp -sign -detached -der` КриптоПро CSP, ключ в контейнере СКЗИ по отпечатку сертификата.
// Ключ и сертификаты — только файлами; ни путь к ключу, ни его содержимое не попадают в текст ошибок.
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { GostLoad, UkepConfig } from "../domain/request-signing.ts";

export interface Signer {
  /** Откреплённая CMS SignedData (DER) над data. Отказ — исключение: запрос без подписи не уходит. */
  sign(data: Buffer): Promise<Buffer>;
  /** Кто подписывает — для логов и ошибок, без секретов. */
  describe(): string;
}

/** nonce подписи запроса: 128 случайных бит. */
export const newNonce = (): string => randomBytes(16).toString("hex");

export const SIGN_TIMEOUT_MS = 15_000;

// ─────────────────────────────── pem: RSA / ECDSA P-256 на node:crypto + pkijs

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
};

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const pemCerts = (pem: string): Buffer[] => [...pem.matchAll(PEM_CERT)].map((m) => Buffer.from(m[0].replace(/-----[^-]+-----|\s+/g, ""), "base64"));
const toPkijs = (der: Buffer) => new pkijs.Certificate({ schema: asn1js.fromBER(new Uint8Array(der)).result });
const derOf = (x: { toSchema(): asn1js.BaseBlock }) => Buffer.from(x.toSchema().toBER(false));

/** Алгоритм подписи по ключу: RSA → sha256WithRSAEncryption, EC P-256 → ecdsa-with-SHA256; прочее не поддерживается. */
function sigAlgorithm(key: KeyObject): string {
  if (key.asymmetricKeyType === "rsa") return OID.sha256WithRSA;
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return OID.ecdsaWithSHA256;
  throw new Error(`pem: ключ ${key.asymmetricKeyType}${key.asymmetricKeyDetails?.namedCurve ? ` ${key.asymmetricKeyDetails.namedCurve}` : ""} не поддерживается — ждём RSA или ECDSA P-256`);
}

/**
 * CMS SignedData detached (RFC 5652): signedAttrs contentType = id-data, messageDigest = SHA-256(data), signingTime;
 * сертификат подписанта (и цепочка) — внутри. Подписывается DER атрибутов с тегом SET, атрибуты упорядочены по DER.
 */
export function pemSigner(o: { certPem: string; keyPem: string; chainPem?: string | null; now?: () => Date }): Signer {
  const [leafDer] = pemCerts(o.certPem);
  if (!leafDer) throw new Error("pem: в сертификате подписанта нет блока CERTIFICATE");
  const x = new X509Certificate(leafDer);
  let key: KeyObject;
  try {
    key = createPrivateKey(o.keyPem);
  } catch {
    throw new Error("pem: закрытый ключ подписанта не читается");
  }
  if (!x.checkPrivateKey(key)) throw new Error("pem: закрытый ключ не от сертификата подписанта");
  const sigAlg = sigAlgorithm(key);
  const leaf = toPkijs(leafDer);
  const chain = pemCerts(o.chainPem ?? "").map(toPkijs);
  const now = o.now ?? (() => new Date());
  const who = `pem ${x.subject.split("\n").join(", ")} (${key.asymmetricKeyType === "rsa" ? "RSA" : "ECDSA P-256"})`;

  return {
    describe: () => who,
    async sign(data) {
      const attrs = [
        new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
        new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: new Uint8Array(createHash("sha256").update(data).digest()) })] }),
        new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: now() })] }),
      ].sort((a, b) => Buffer.compare(derOf(a), derOf(b))); // SET OF в DER — по возрастанию кодировок
      const signedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs });
      const tbs = Buffer.from(signedAttrs.toSchema().toBER(false));
      tbs[0] = 0x31; // RFC 5652 п. 5.4: подписывается SET OF, а не [0] IMPLICIT
      const signature = cryptoSign("sha256", tbs, key); // EC — DER-кодировка (r, s), как требует CMS
      const si = new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: leaf.issuer, serialNumber: leaf.serialNumber }),
        digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
        signedAttrs,
        signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: sigAlg, ...(sigAlg === OID.sha256WithRSA ? { algorithmParams: new asn1js.Null() } : {}) }),
        signature: new asn1js.OctetString({ valueHex: new Uint8Array(signature) }),
      });
      const sd = new pkijs.SignedData({
        version: 1,
        digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new asn1js.Null() })],
        encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }), // без eContent — откреплённая
        certificates: [leaf, ...chain],
        signerInfos: [si],
      });
      const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) });
      return Buffer.from(ci.toSchema().toBER(false));
    },
  };
}

// ─────────────────────────────── внешние программы: openssl с ГОСТ, cryptcp КриптоПро

/** Текст stderr без путей (в них могут быть имя ключа и контейнера) и не длиннее 500 символов. */
export function maskStderr(s: string, secrets: string[] = []): string {
  let t = s;
  for (const x of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(x).join("<скрыто>");
  return t.replace(/(?:[A-Za-z]:)?[\\/][^\s:'"()]+/g, "<путь>").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Запуск подписывающей программы: stdin → stdout, таймаут, ненулевой код — ошибка с маскированным stderr. */
function run(bin: string, args: string[], input: Buffer | null, o: { label: string; timeoutMs: number; secrets: string[] }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, o.timeoutMs);
    p.stdout!.on("data", (c: Buffer) => out.push(c));
    p.stderr!.on("data", (c: Buffer) => err.push(c));
    p.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`${o.label}: программа подписи не запускается (${e.code ?? "ошибка запуска"})`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${o.label}: подпись не получена за ${o.timeoutMs} мс`));
      if (code !== 0) return reject(new Error(`${o.label}: подпись не создана (код ${code}): ${maskStderr(Buffer.concat(err).toString("utf8"), o.secrets)}`));
      resolve(Buffer.concat(out));
    });
    if (input) {
      p.stdin!.on("error", () => {}); // программа могла закрыть stdin, не дочитав: итог скажет код выхода
      p.stdin!.end(input);
    }
  });
}

const derOrThrow = (label: string, b: Buffer): Buffer => {
  if (b.length < 2 || b[0] !== 0x30) throw new Error(`${label}: программа вернула не DER CMS`);
  return b;
};

/** Аргументы `openssl cms -sign` для ГОСТ Р 34.10-2012 (256): данные — stdin, DER — stdout. */
export function opensslGostArgs(o: { certFile: string; keyFile: string; gost: GostLoad }): string[] {
  const load = o.gost.kind === "engine" ? ["-engine", o.gost.name] : ["-provider", o.gost.name, "-provider", "default"];
  return ["cms", "-sign", "-binary", "-nosmimecap", "-outform", "DER", "-md", "md_gost12_256", ...load, "-signer", o.certFile, "-inkey", o.keyFile];
}

export function opensslGostSigner(o: { opensslBin: string; certFile: string; keyFile: string; gost: GostLoad; timeoutMs?: number }): Signer {
  const args = opensslGostArgs(o);
  const label = "openssl-gost";
  return {
    describe: () => `${label} (${o.gost.kind} ${o.gost.name})`,
    async sign(data) {
      return derOrThrow(label, await run(o.opensslBin, args, data, { label, timeoutMs: o.timeoutMs ?? SIGN_TIMEOUT_MS, secrets: [o.keyFile, o.certFile] }));
    },
  };
}

/** Аргументы cryptcp: откреплённая подпись в DER сертификатом из хранилища КриптоПро по отпечатку. */
export const cryptcpArgs = (thumbprint: string, inFile: string, outFile: string): string[] => ["-sign", "-detached", "-der", "-thumbprint", thumbprint, inFile, outFile];

/**
 * cryptcp работает с файлами: данные и подпись — во временном каталоге с правами 0700, который удаляется в finally
 * при любом исходе (успех, отказ, таймаут).
 */
export function cryptoproSigner(o: { cryptcpBin: string; thumbprint: string; timeoutMs?: number; tmpRoot?: string }): Signer {
  const label = "cryptopro";
  return {
    describe: () => `${label} (отпечаток ${o.thumbprint.slice(0, 8)}…)`,
    async sign(data) {
      const dir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "inspector-ukep-"));
      try {
        chmodSync(dir, 0o700);
        const inFile = join(dir, "request.bin");
        const outFile = join(dir, "request.bin.sig");
        writeFileSync(inFile, data, { mode: 0o600 });
        await run(o.cryptcpBin, cryptcpArgs(o.thumbprint, inFile, outFile), null, { label, timeoutMs: o.timeoutMs ?? SIGN_TIMEOUT_MS, secrets: [dir] });
        let sig: Buffer;
        try {
          sig = readFileSync(outFile);
        } catch {
          throw new Error(`${label}: cryptcp завершился без файла подписи`);
        }
        return derOrThrow(label, sig);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function readVar(name: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${name}=${path}: файл не читается`);
  }
}

/** Подписант по режиму окружения (domain/request-signing.ts resolveUkep); off — null, запросы без подписи (dev/заглушка). */
export function signerFromConfig(c: UkepConfig): Signer | null {
  switch (c.mode) {
    case "off":
      return null;
    case "pem":
      return pemSigner({
        certPem: readVar("INSPECTOR_UKEP_CERT_FILE", c.certFile),
        keyPem: readVar("INSPECTOR_UKEP_KEY_FILE", c.keyFile),
        chainPem: c.chainFile ? readVar("INSPECTOR_UKEP_CHAIN_FILE", c.chainFile) : null,
      });
    case "openssl-gost":
      readVar("INSPECTOR_UKEP_CERT_FILE", c.certFile); // файлы проверяются при построении, а не при первой отправке
      readVar("INSPECTOR_UKEP_KEY_FILE", c.keyFile);
      return opensslGostSigner(c);
    case "cryptopro":
      return cryptoproSigner(c);
  }
}
