// OS-INSP-1.2.11–1.2.13 Проверка откреплённой подписи CMS (RFC 5652) по содержимому документа.
// Разбор структуры — pkijs + asn1js; математика и сертификаты — node:crypto (синхронно; в ingest идёт одна и та же
// проверка для ручной загрузки и автозабора из «РиН», запись в базу — асинхронно). Решение — domain/signature.ts.
// ГОСТ Р 34.10-2012 здесь не проверяется: нужно сертифицированное СКЗИ (OS-INSP-1.2.13).
import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { blobStore } from "./blobstore.ts";
import { extname, join } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import {
  combineVerdicts, isGostOid, isSignatureFile, pairSignature, signatureVerdict, type SignatureFacts, type SignatureVerdict,
} from "../domain/signature.ts";
import { audit } from "./audit.ts";
import type { Ctx, UploadItem, UploadResult } from "./inspections.ts";

// ─────────────────────────────── доверенные корни

export interface TrustStore {
  anchors: X509Certificate[];
  /** fingerprint256 корней аккредитованных УЦ. */
  qualified: Set<string>;
  configured: boolean;
}

const CERT_EXT = new Set([".pem", ".crt", ".cer", ".der"]);

/** Сертификаты из файла: PEM (один или несколько блоков) или DER. Нечитаемый файл — громкая ошибка. */
export function readCerts(file: string): X509Certificate[] {
  const buf = readFileSync(file);
  const text = buf.toString("latin1");
  try {
    if (text.includes("-----BEGIN CERTIFICATE-----")) {
      return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => new X509Certificate(m[0]));
    }
    return [new X509Certificate(buf)];
  } catch (e) {
    throw new Error(`${file}: не сертификат X.509 (${e instanceof Error ? e.message : String(e)})`);
  }
}

function readDir(dir: string): X509Certificate[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir}: каталог доверенных сертификатов не найден`);
  return readdirSync(dir)
    .filter((f) => CERT_EXT.has(extname(f).toLowerCase()))
    .sort()
    .flatMap((f) => readCerts(join(dir, f)));
}

/**
 * Хранилище доверия: все доверенные корни (trustDir) и аккредитованные УЦ (qualifiedDir — тоже доверенные).
 * Ни одного каталога — configured=false: VALID недостижим, вердикт UNVERIFIED «нет доверенного корня».
 */
export function loadTrustStore(trustDir: string | null, qualifiedDir: string | null): TrustStore {
  const trusted = trustDir ? readDir(trustDir) : [];
  const qualified = qualifiedDir ? readDir(qualifiedDir) : [];
  const byFp = new Map<string, X509Certificate>();
  for (const c of [...trusted, ...qualified]) byFp.set(c.fingerprint256, c);
  return { anchors: [...byFp.values()], qualified: new Set(qualified.map((c) => c.fingerprint256)), configured: byFp.size > 0 };
}

let cachedTrust: TrustStore | null = null;
/** Хранилище из окружения (config.ts), читается один раз за процесс. */
export function trustFromConfig(): TrustStore {
  cachedTrust ??= loadTrustStore(config.trustDir, config.qualifiedRootsDir);
  return cachedTrust;
}

// ─────────────────────────────── разбор CMS

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_SKI = "2.5.29.14";

const DIGEST: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};
/** Алгоритм подписи → хеш подписи (null — хеш берётся из digestAlgorithm: rsaEncryption, ecPublicKey). Прочие — не поддерживаются. */
const SIG_HASH: Record<string, string | null> = {
  "1.2.840.113549.1.1.1": null, // rsaEncryption
  "1.2.840.113549.1.1.5": "sha1",
  "1.2.840.113549.1.1.14": "sha224",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.2.1": null, // ecPublicKey
  "1.2.840.10045.4.1": "sha1",
  "1.2.840.10045.4.3.1": "sha224",
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};

/** КриптоАРМ сохраняет подпись и в DER, и в Base64 (с заголовком PEM или без). */
export function cmsDer(sig: Buffer): Buffer {
  if (sig[0] === 0x30) return sig;
  const text = sig.toString("latin1").replace(/-----(BEGIN|END) [A-Z0-9 ]+-----/g, "").replace(/\s+/g, "");
  if (text && /^[A-Za-z0-9+/]+=*$/.test(text)) return Buffer.from(text, "base64");
  return sig;
}

const hex = (v: ArrayBuffer | Uint8Array) => Buffer.from(v instanceof Uint8Array ? v : new Uint8Array(v)).toString("hex");
const subjectLine = (c: X509Certificate) => c.subject.split("\n").join(", ");
const validAt = (c: X509Certificate, at: Date) => new Date(c.validFrom).getTime() <= at.getTime() && at.getTime() <= new Date(c.validTo).getTime();

function safeIssued(child: X509Certificate, issuer: X509Certificate): boolean {
  // издатель обязан быть УЦ (basicConstraints CA:TRUE, RFC 5280 §4.2.1.9): OpenSSL checkIssued смотрит keyUsage, но не
  // basicConstraints — без этой проверки владелец конечного сертификата без keyUsage выпускает себе «подписанта УКЭП»
  if (!issuer.ca) return false;
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/**
 * Цепочка от сертификата подписанта к доверенному корню. Промежуточные — из CMS; каждый звено обязано действовать
 * в момент подписания. Возвращает найденный корень или null.
 */
export function chainToAnchor(leaf: X509Certificate, pool: X509Certificate[], trust: TrustStore, at: Date): X509Certificate | null {
  const anchorFp = new Set(trust.anchors.map((a) => a.fingerprint256));
  const seen = new Set<string>();
  const walk = (cur: X509Certificate, depth: number): X509Certificate | null => {
    if (anchorFp.has(cur.fingerprint256)) return cur;
    if (depth > 8 || seen.has(cur.fingerprint256)) return null;
    seen.add(cur.fingerprint256);
    for (const cand of [...trust.anchors, ...pool]) {
      if (cand.fingerprint256 === cur.fingerprint256 || !validAt(cand, at) || !safeIssued(cur, cand)) continue;
      const root = walk(cand, depth + 1);
      if (root) return root;
    }
    return null;
  };
  return walk(leaf, 0);
}

interface Parsed {
  signed: pkijs.SignedData;
  certs: Array<{ pk: pkijs.Certificate; x: X509Certificate }>;
}

function parseCms(sig: Buffer): Parsed | null {
  try {
    const der = cmsDer(sig);
    const asn = asn1js.fromBER(new Uint8Array(der));
    if (asn.offset === -1) return null;
    const ci = new pkijs.ContentInfo({ schema: asn.result });
    if (ci.contentType !== OID_SIGNED_DATA) return null;
    const signed = new pkijs.SignedData({ schema: ci.content });
    const certs = (signed.certificates ?? [])
      .filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate)
      .map((pk) => ({ pk, x: new X509Certificate(Buffer.from(pk.toSchema().toBER(false))) }));
    return { signed, certs };
  } catch {
    return null;
  }
}

function findSigner(si: pkijs.SignerInfo, certs: Parsed["certs"]): Parsed["certs"][number] | null {
  if (si.sid instanceof pkijs.IssuerAndSerialNumber) {
    const sid = si.sid;
    return certs.find((c) => c.pk.issuer.isEqual(sid.issuer) && c.pk.serialNumber.isEqual(sid.serialNumber)) ?? null;
  }
  // [0] SubjectKeyIdentifier
  const block = (si.sid as asn1js.BaseBlock & { valueBlock: { valueHexView?: Uint8Array; value?: Array<{ valueBlock: { valueHexView: Uint8Array } }> } }).valueBlock;
  const ski = block.valueHexView?.length ? block.valueHexView : block.value?.[0]?.valueBlock.valueHexView;
  if (!ski) return null;
  return certs.find((c) => {
    const ext = c.pk.extensions?.find((e) => e.extnID === OID_SKI);
    const v = (ext?.parsedValue as asn1js.OctetString | undefined)?.valueBlock.valueHexView;
    return v && hex(v) === hex(ski);
  }) ?? null;
}

function attr(si: pkijs.SignerInfo, oid: string): unknown {
  return si.signedAttrs?.attributes.find((a) => a.type === oid)?.values[0];
}

/** Математика одной подписи: messageDigest = хеш документа и подпись над signedAttrs (или над документом) верна. */
function mathOf(doc: Buffer, si: pkijs.SignerInfo, x: X509Certificate): boolean | "unsupported" {
  const digestAlg = DIGEST[si.digestAlgorithm.algorithmId];
  const sigAlg = si.signatureAlgorithm.algorithmId;
  if (!digestAlg || !(sigAlg in SIG_HASH)) return "unsupported";
  const sigHash = SIG_HASH[sigAlg] ?? digestAlg;
  let data: Buffer;
  if (si.signedAttrs) {
    const md = attr(si, OID_MESSAGE_DIGEST) as asn1js.OctetString | undefined;
    if (!md || hex(md.valueBlock.valueHexView) !== createHash(digestAlg).update(doc).digest("hex")) return false;
    // RFC 5652 п. 5.4: подписывается DER атрибутов с тегом SET (0x31), а не [0] IMPLICIT
    data = Buffer.from(si.signedAttrs.encodedValue.byteLength ? new Uint8Array(si.signedAttrs.encodedValue) : new Uint8Array(si.signedAttrs.toSchema().toBER(false)));
    data[0] = 0x31;
  } else data = doc;
  try {
    return cryptoVerify(sigHash, data, x.publicKey, Buffer.from(si.signature.valueBlock.valueHexView));
  } catch {
    return false;
  }
}

function signingTime(si: pkijs.SignerInfo): Date | null {
  const v = attr(si, OID_SIGNING_TIME) as (asn1js.UTCTime | asn1js.GeneralizedTime) | undefined;
  try {
    return v && typeof v.toDate === "function" ? v.toDate() : null;
  } catch {
    return null;
  }
}

/** Факты по каждому подписанту CMS (КриптоАРМ кладёт соподписи в один файл). Не CMS — один факт cms=false. */
export function signatureFacts(doc: Buffer, sig: Buffer, trust: TrustStore, checkedAt: Date): SignatureFacts[] {
  const noCms: SignatureFacts = { cms: false, algorithms: [], signer: null, math: false, signing_time: null, trust_configured: trust.configured, chain_trusted: false, qualified_root: false };
  const p = parseCms(sig);
  if (!p) return [noCms];
  // Подписантов нет — пустой список: combineVerdicts даёт INVALID «ни одного подписанта» (а не «нет сертификата»)
  const pool = p.certs.map((c) => c.x);
  return p.signed.signerInfos.map((si): SignatureFacts => {
    const cert = findSigner(si, p.certs);
    const algorithms = [si.digestAlgorithm.algorithmId, si.signatureAlgorithm.algorithmId];
    if (cert) algorithms.push(cert.pk.subjectPublicKeyInfo.algorithm.algorithmId, cert.pk.signatureAlgorithm.algorithmId);
    const st = signingTime(si);
    // ГОСТ не считаем вовсе: без СКЗИ результата «верна/неверна» нет (OS-INSP-1.2.13)
    const gost = algorithms.some(isGostOid);
    const root = cert && !gost ? chainToAnchor(cert.x, pool, trust, st ?? checkedAt) : null;
    return {
      cms: true,
      algorithms: [...new Set(algorithms)],
      signer: cert ? { subject: subjectLine(cert.x), not_before: new Date(cert.x.validFrom), not_after: new Date(cert.x.validTo) } : null,
      math: cert && !gost ? mathOf(doc, si, cert.x) : false,
      signing_time: st,
      trust_configured: trust.configured,
      chain_trusted: Boolean(root),
      qualified_root: Boolean(root && trust.qualified.has(root.fingerprint256)),
    };
  });
}

/** Проверить откреплённую подпись документа: итоговый вердикт по всем подписантам. */
export function checkDetached(doc: Buffer, sig: Buffer, trust: TrustStore, checkedAt = new Date()): SignatureVerdict {
  return combineVerdicts(signatureFacts(doc, sig, trust, checkedAt).map((f) => signatureVerdict(f, checkedAt)));
}

// ─────────────────────────────── приём подписей пакета (OS-INSP-1.2.11)

/** Запись в реестре у файла документа (files.signature_check_json). */
export interface SignatureCheck extends SignatureVerdict {
  sig_file_name: string;
  sig_sha256: string;
  checked_at: string;
}

/**
 * Подписи пакета: вызывается из ingest после приёма документов, в той же точке (и транзакции) — поэтому подпись
 * проверяется и при ручной загрузке, и при автозаборе из «РиН». Документ ищется среди файлов проверки (этого пакета
 * и принятых раньше), проверяется по сохранённому содержимому. Файл подписи в files не попадает и в ML не уходит.
 */
export async function attachSignatures(ctx: Ctx, inspectionId: string, sigItems: UploadItem[], trust: TrustStore = trustFromConfig()): Promise<Pick<UploadResult, "signatures" | "rejected">> {
  const signatures: UploadResult["signatures"] = [];
  const rejected: UploadResult["rejected"] = [];
  if (!sigItems.length) return { signatures, rejected };
  const { db } = ctx;
  const docs = await db.all<{ id: string; file_name: string; sha256: string }>("select id, file_name, sha256 from files where inspection_id = $1", [inspectionId]);
  for (const it of sigItems) {
    if (!isSignatureFile(it.name)) continue;
    const pair = pairSignature(it.name, docs.map((d) => d.file_name));
    if (!pair.ok) {
      rejected.push({ file_name: it.name, code: pair.code, message: pair.message });
      continue;
    }
    const d = docs.find((x) => x.file_name === pair.document)!;
    const sigHash = createHash("sha256").update(it.buf).digest("hex");
    // подпись — доказательство и уже лежит в хранилище рядом с документом: ingest кладёт все файлы пакета до транзакции
    const checkedAt = new Date();
    const verdict = checkDetached(await blobStore().get(d.sha256), it.buf, trust, checkedAt);
    const check: SignatureCheck = { ...verdict, sig_file_name: it.name, sig_sha256: sigHash, checked_at: checkedAt.toISOString() };
    await saveSignatureCheck(db, d.id, check);
    await audit(ctx, "SIGNATURE_CHECKED", inspectionId, { file_id: d.id, file_name: d.file_name, sig_file_name: it.name, status: check.status, kind: check.kind, reason: check.reason, signer: check.signer });
    signatures.push({ file_id: d.id, file_name: it.name, document: d.file_name, status: check.status, kind: check.kind, reason: check.reason });
  }
  return { signatures, rejected };
}

export async function saveSignatureCheck(db: DB, fileId: string, check: SignatureCheck): Promise<void> {
  await db.run("update files set signature_check_json = $1 where id = $2", [JSON.stringify(check), fileId]);
}
