// OS-INSP-1.2.11–1.2.14 Откреплённая электронная подпись документа пакета (ТЗ 5, прим. 1 и 2).
// Здесь только чистые правила: сопоставление подписи с документом по имени и вердикт по фактам проверки.
// Разбор CMS и криптография — services/signature.ts.

export type SignatureStatus = "VALID" | "INVALID" | "UNVERIFIED";
export type SignatureKind = "UKEP" | "UNEP";

/** Результат проверки подписи — то, что пишется в реестр у файла документа (files.signature_check_json). */
export interface SignatureVerdict {
  status: SignatureStatus;
  kind: SignatureKind | null;
  reason: string;
  signer: string | null;
  signed_at: string | null;
}

/** Сертификат подписанта — ровно то, что нужно правилам. */
export interface SignerCert {
  subject: string;
  not_before: Date;
  not_after: Date;
}

/**
 * Факты, установленные проверкой CMS (services/signature.ts). Каждое поле — наблюдение, а не решение:
 * решение принимает signatureVerdict.
 */
export interface SignatureFacts {
  /** Файл разобран как CMS SignedData. */
  cms: boolean;
  /** OID всех алгоритмов подписи: дайджест, подпись, ключ подписанта, подпись сертификата. */
  algorithms: string[];
  /** Сертификат подписанта найден в CMS. */
  signer: SignerCert | null;
  /** Математика: дайджест документа совпал с messageDigest и подпись верна ключом сертификата; "unsupported" — алгоритм не поддерживается. */
  math: boolean | "unsupported";
  /** Время подписания из атрибута signingTime; нет атрибута — null. */
  signing_time: Date | null;
  /** Доверенные корни заданы (INSPECTOR_TRUST_DIR или INSPECTOR_QUALIFIED_ROOTS_DIR). */
  trust_configured: boolean;
  /** Цепочка сертификата подписанта сходится к доверенному корню. */
  chain_trusted: boolean;
  /** Корень цепочки — аккредитованный УЦ (INSPECTOR_QUALIFIED_ROOTS_DIR). */
  qualified_root: boolean;
}

// ─────────────────────────────── сопоставление подписи с документом (OS-INSP-1.2.11)

/** Откреплённая подпись: «Документ.pdf.sig» или «Документ.pdf.p7s» (так именует КриптоАРМ). Регистр расширения не важен. */
const SIG_EXT = /\.(sig|p7s)$/i;

export const isSignatureFile = (name: string): boolean => SIG_EXT.test(name) && name.replace(SIG_EXT, "").trim().length > 0;

/** Имя документа, к которому относится подпись: расширение подписи снято. */
export const signedDocumentName = (sigName: string): string => sigName.replace(SIG_EXT, "");

/** Ключ сравнения имён: регистр и форма Unicode не значимы (macOS отдаёт имена в NFD, Windows — в NFC). */
const nameKey = (s: string) => s.normalize("NFC").toLowerCase();

export type SignaturePairing = { ok: true; document: string } | { ok: false; code: "SIGNATURE_WITHOUT_DOCUMENT"; message: string };

/**
 * Найти документ подписи среди документов пакета. Точное совпадение имени — первым; иначе без учёта регистра
 * и формы Unicode. Подпись без документа отклоняется с понятной причиной.
 */
export function pairSignature(sigName: string, documents: string[]): SignaturePairing {
  const target = signedDocumentName(sigName);
  const exact = documents.find((d) => d === target);
  if (exact) return { ok: true, document: exact };
  const loose = documents.find((d) => nameKey(d) === nameKey(target));
  if (loose) return { ok: true, document: loose };
  return {
    ok: false,
    code: "SIGNATURE_WITHOUT_DOCUMENT",
    message: `${sigName}: откреплённая подпись без документа — в пакете нет файла ${target}. Загрузите документ вместе с подписью (имя подписи = имя документа + .sig или .p7s)`,
  };
}

// ─────────────────────────────── вердикт (OS-INSP-1.2.12, 1.2.13)

/** ГОСТ Р 34.10-2012 / 34.11-2012 (1.2.643.7.1.1.*) и прежние ГОСТ КриптоПро (1.2.643.2.2.*). */
export const isGostOid = (oid: string): boolean => /^1\.2\.643\.(7\.1\.1|2\.2)\./.test(oid);

const unverified = (reason: string, signer: string | null, signed_at: string | null): SignatureVerdict => ({ status: "UNVERIFIED", kind: null, reason, signer, signed_at });
const invalid = (reason: string, signer: string | null, signed_at: string | null): SignatureVerdict => ({ status: "INVALID", kind: null, reason, signer, signed_at });

/**
 * Вердикт по фактам. Порядок значим:
 * не CMS → INVALID; ГОСТ → UNVERIFIED (1.2.13: без сертифицированного СКЗИ математику не проверяем вовсе);
 * нет сертификата подписанта → UNVERIFIED; подпись не сходится с документом → INVALID; сертификат не действовал в момент подписания
 * (signingTime, а без него — момент проверки) → INVALID; нет доверенного корня или цепочка к нему не сходится → UNVERIFIED;
 * иначе VALID: УКЭП от аккредитованного корня, УНЭП от прочего доверенного (1.2.12).
 */
export function signatureVerdict(f: SignatureFacts, checkedAt: Date): SignatureVerdict {
  const signer = f.signer?.subject ?? null;
  const signed_at = f.signing_time ? f.signing_time.toISOString() : null;
  if (!f.cms) return invalid("файл подписи не CMS SignedData — это не откреплённая подпись", null, null);
  const gost = f.algorithms.find(isGostOid);
  if (gost) return unverified(`подпись по ГОСТ Р 34.10-2012 (OID ${gost}): нужно сертифицированное СКЗИ, в контуре его нет — подпись не считается действительной`, signer, signed_at);
  // подпись без сертификата (-nocerts) проверить нечем, но неверной она не доказана — UNVERIFIED, а не INVALID (1.2.11)
  if (!f.signer) return unverified("в подписи нет сертификата подписанта: проверить подпись нечем", null, signed_at);
  if (f.math === "unsupported") return unverified(`алгоритм подписи не поддерживается (${f.algorithms.join(", ")})`, signer, signed_at);
  if (!f.math) return invalid("подпись не соответствует содержимому документа: документ изменён после подписания или подпись от другого файла", signer, signed_at);
  const at = f.signing_time ?? checkedAt;
  const when = f.signing_time ? "в момент подписания" : "в момент проверки (времени подписания в подписи нет)";
  if (at.getTime() < f.signer.not_before.getTime()) return invalid(`сертификат подписанта ещё не действовал ${when}: действует с ${f.signer.not_before.toISOString()}`, signer, signed_at);
  if (at.getTime() > f.signer.not_after.getTime()) return invalid(`сертификат подписанта истёк ${when}: действовал до ${f.signer.not_after.toISOString()}`, signer, signed_at);
  if (!f.trust_configured) return unverified("нет доверенного корня: каталоги INSPECTOR_TRUST_DIR и INSPECTOR_QUALIFIED_ROOTS_DIR не заданы", signer, signed_at);
  if (!f.chain_trusted) return unverified("цепочка сертификата подписанта не сходится к доверенному корню", signer, signed_at);
  return f.qualified_root
    ? { status: "VALID", kind: "UKEP", reason: "подпись верна, сертификат действовал, корень — аккредитованный УЦ: УКЭП", signer, signed_at }
    : { status: "VALID", kind: "UNEP", reason: "подпись верна, сертификат действовал, корень доверенный, но не аккредитованный УЦ: УНЭП", signer, signed_at };
}

/**
 * Несколько подписантов в одном файле (соподписи КриптоАРМ): худший вердикт решает — INVALID, затем UNVERIFIED.
 * Все VALID — VALID; УКЭП, только если все подписи УКЭП. Подписантов нет — INVALID.
 */
export function combineVerdicts(vs: SignatureVerdict[]): SignatureVerdict {
  if (!vs.length) return invalid("в подписи нет ни одного подписанта", null, null);
  const worst = vs.find((v) => v.status === "INVALID") ?? vs.find((v) => v.status === "UNVERIFIED");
  if (worst) return worst;
  if (vs.length === 1) return vs[0];
  const kind: SignatureKind = vs.every((v) => v.kind === "UKEP") ? "UKEP" : "UNEP";
  return {
    status: "VALID",
    kind,
    reason: `все ${vs.length} подписи верны: ${kind === "UKEP" ? "УКЭП" : "УНЭП (не все корни — аккредитованные УЦ)"}`,
    signer: vs.map((v) => v.signer).join("; "),
    signed_at: vs.map((v) => v.signed_at).filter(Boolean).sort().at(-1) ?? null,
  };
}

// ─────────────────────────────── подписан ли документ электронно (OS-INSP-1.2.14)

/**
 * Документ подписан электронно. Была проверка подписи — решает только её результат: INVALID и UNVERIFIED не считаются
 * подписью, даже когда реестр заявляет УКЭП (ТЗ 5, прим. 2 — тогда реквизиты проверяются как у скана).
 * Проверки не было (подписи рядом с документом нет) — прежнее правило: заявление реестра.
 */
export function electronicallySigned(declared: boolean, check: Pick<SignatureVerdict, "status"> | null | undefined): boolean {
  if (check) return check.status === "VALID";
  return declared;
}
