// OS-INSP-1.2.11–1.2.14: откреплённая подпись — сопоставление с документом, вердикт по фактам, «подписан ли электронно».
import { describe, expect, it } from "vitest";
import {
  combineVerdicts, electronicallySigned, isGostOid, isSignatureFile, pairSignature, signatureVerdict, signedDocumentName,
  type SignatureFacts, type SignatureVerdict,
} from "../src/domain/signature.ts";
import { evaluateRequisites, type IdDoc } from "../src/domain/requisites.ts";

const NB = new Date("2026-01-01T00:00:00.000Z");
const NA = new Date("2027-01-01T00:00:00.000Z");
const facts = (o: Partial<SignatureFacts> = {}): SignatureFacts => ({
  cms: true,
  algorithms: ["2.16.840.1.101.3.4.2.1", "1.2.840.113549.1.1.1"],
  signer: { subject: "CN=Иванов", not_before: NB, not_after: NA },
  math: true,
  signing_time: new Date("2026-06-01T12:00:00.000Z"),
  trust_configured: true,
  chain_trusted: true,
  qualified_root: true,
  ...o,
});
const CHECKED = new Date("2026-09-25T00:00:00.000Z");
const v = (o: Partial<SignatureFacts> = {}, at = CHECKED) => signatureVerdict(facts(o), at);

describe("сопоставление подписи с документом (OS-INSP-1.2.11)", () => {
  it("подпись — .sig и .p7s в любом регистре; имя документа — без расширения подписи", () => {
    for (const n of ["Документ.pdf.sig", "Документ.pdf.p7s", "Документ.pdf.SIG", "a.P7S"]) expect([n, isSignatureFile(n)]).toEqual([n, true]);
    for (const n of ["Документ.pdf", "sig", ".sig", "  .p7s", "Документ.sig.pdf", "Документ.pdf.sig.bak", "Документ.p7m"]) expect([n, isSignatureFile(n)]).toEqual([n, false]);
    expect(signedDocumentName("Документ.pdf.sig")).toBe("Документ.pdf");
    expect(signedDocumentName("Документ.pdf.P7S")).toBe("Документ.pdf");
  });
  it("пара по точному имени; при нескольких кандидатах точное совпадение важнее совпадения без регистра", () => {
    expect(pairSignature("Акт.pdf.sig", ["Реестр.pdf", "Акт.pdf"])).toEqual({ ok: true, document: "Акт.pdf" });
    expect(pairSignature("Акт.pdf.p7s", ["АКТ.PDF", "Акт.pdf"])).toEqual({ ok: true, document: "Акт.pdf" });
  });
  it("регистр и форма Unicode имени (NFD с macOS) не мешают паре", () => {
    expect(pairSignature("акт.PDF.sig", ["Акт.pdf"])).toEqual({ ok: true, document: "Акт.pdf" });
    const nfd = "Отчёт о приёмке.pdf".normalize("NFD"); // «ё» распадается на «е» + диерезис
    expect(nfd).not.toBe("Отчёт о приёмке.pdf");
    expect(pairSignature(`${nfd}.sig`, ["Отчёт о приёмке.pdf"])).toEqual({ ok: true, document: "Отчёт о приёмке.pdf" });
  });
  it("подпись без документа — отказ SIGNATURE_WITHOUT_DOCUMENT с именем недостающего документа", () => {
    const r = pairSignature("Акт.pdf.sig", ["Акт.docx", "Акт"]);
    expect(r).toMatchObject({ ok: false, code: "SIGNATURE_WITHOUT_DOCUMENT" });
    expect(!r.ok && r.message).toContain("в пакете нет файла Акт.pdf");
    expect(pairSignature("Акт.pdf.sig", [])).toMatchObject({ ok: false });
  });
});

describe("вердикт проверки подписи (OS-INSP-1.2.12)", () => {
  it("математика верна, сертификат действовал, корень аккредитованный — VALID УКЭП с подписантом и временем", () => {
    expect(v()).toEqual({ status: "VALID", kind: "UKEP", reason: expect.stringContaining("УКЭП"), signer: "CN=Иванов", signed_at: "2026-06-01T12:00:00.000Z" });
  });
  it("корень доверенный, но не аккредитованный — VALID УНЭП", () => {
    expect(v({ qualified_root: false })).toMatchObject({ status: "VALID", kind: "UNEP", reason: expect.stringContaining("УНЭП") });
  });
  it("не CMS — INVALID «не CMS» без подписанта", () => {
    expect(v({ cms: false, signer: null })).toEqual({ status: "INVALID", kind: null, reason: expect.stringContaining("не CMS"), signer: null, signed_at: null });
  });
  it("нет сертификата подписанта — UNVERIFIED: проверить нечем, но и неверной подпись не доказана", () => {
    expect(v({ signer: null })).toMatchObject({ status: "UNVERIFIED", kind: null, reason: expect.stringContaining("нет сертификата подписанта"), signer: null });
  });
  it("подпись не сходится с документом — INVALID «документ изменён»", () => {
    expect(v({ math: false })).toMatchObject({ status: "INVALID", kind: null, reason: expect.stringContaining("не соответствует содержимому документа"), signer: "CN=Иванов" });
  });
  it("алгоритм не поддерживается (RSA-PSS и т. п.) — UNVERIFIED, не INVALID", () => {
    const r = v({ math: "unsupported", algorithms: ["1.2.840.113549.1.1.10"] });
    expect(r).toMatchObject({ status: "UNVERIFIED", kind: null, reason: expect.stringContaining("1.2.840.113549.1.1.10") });
    expect(r.reason).toMatch(/^алгоритм подписи не поддерживается/);
    expect(v({ math: "unsupported", algorithms: ["2.16.840.1.101.3.4.2.1", "1.2.840.113549.1.1.10"] }).reason).toContain("(2.16.840.1.101.3.4.2.1, 1.2.840.113549.1.1.10)");
  });
  it("время подписания — ровно notBefore и ровно notAfter: сертификат действовал (границы включены)", () => {
    expect(v({ signing_time: NB }).status).toBe("VALID");
    expect(v({ signing_time: NA }).status).toBe("VALID");
  });
  it("на миллисекунду раньше notBefore или позже notAfter — INVALID с датой границы", () => {
    const early = v({ signing_time: new Date(NB.getTime() - 1) });
    expect(early).toMatchObject({ status: "INVALID", reason: expect.stringContaining("ещё не действовал в момент подписания") });
    expect(early.reason).toContain(NB.toISOString());
    const late = v({ signing_time: new Date(NA.getTime() + 1) });
    expect(late).toMatchObject({ status: "INVALID", reason: expect.stringContaining("истёк в момент подписания") });
    expect(late.reason).toContain(NA.toISOString());
  });
  it("без signingTime срок сертификата сверяется с моментом проверки; signed_at пуст", () => {
    expect(v({ signing_time: null }, NA)).toMatchObject({ status: "VALID", signed_at: null });
    expect(v({ signing_time: null }, NB)).toMatchObject({ status: "VALID" });
    const late = v({ signing_time: null }, new Date(NA.getTime() + 1));
    expect(late).toMatchObject({ status: "INVALID", signed_at: null, reason: expect.stringContaining("в момент проверки") });
    expect(v({ signing_time: null }, new Date(NB.getTime() - 1))).toMatchObject({ status: "INVALID", reason: expect.stringContaining("ещё не действовал в момент проверки") });
  });
  it("доверенные корни не заданы — UNVERIFIED «нет доверенного корня», даже при верной математике", () => {
    expect(v({ trust_configured: false, chain_trusted: false, qualified_root: false })).toMatchObject({ status: "UNVERIFIED", kind: null, reason: expect.stringContaining("нет доверенного корня") });
  });
  it("цепочка не сходится к доверенному корню — UNVERIFIED", () => {
    expect(v({ chain_trusted: false, qualified_root: false })).toMatchObject({ status: "UNVERIFIED", kind: null, reason: expect.stringContaining("не сходится к доверенному корню") });
  });
  it("порядок: подмена документа важнее недоверенного корня; истёкший сертификат — тоже", () => {
    expect(v({ math: false, chain_trusted: false }).status).toBe("INVALID");
    expect(v({ signing_time: new Date(NA.getTime() + 1), trust_configured: false }).status).toBe("INVALID");
  });
});

describe("ГОСТ Р 34.10-2012 без СКЗИ (OS-INSP-1.2.13)", () => {
  it("OID ГОСТ 2012 (1.2.643.7.1.1.*) и КриптоПро (1.2.643.2.2.*) узнаются; прочие 1.2.643.* и RSA — нет", () => {
    for (const o of ["1.2.643.7.1.1.1.1", "1.2.643.7.1.1.2.2", "1.2.643.7.1.1.3.2", "1.2.643.2.2.19", "1.2.643.2.2.3"]) expect([o, isGostOid(o)]).toEqual([o, true]);
    for (const o of ["1.2.643.100.1", "1.2.643.7.1.2.1", "1.2.840.113549.1.1.11", "11.2.643.7.1.1.1.1", "1.2.643.7.1.1"]) expect([o, isGostOid(o)]).toEqual([o, false]);
  });
  it("ГОСТ-подпись — UNVERIFIED «нужно сертифицированное СКЗИ», даже если прочие факты хороши", () => {
    const r = v({ algorithms: ["1.2.643.7.1.1.2.2", "1.2.643.7.1.1.1.1"] });
    expect(r).toMatchObject({ status: "UNVERIFIED", kind: null, signer: "CN=Иванов" });
    expect(r.reason).toContain("сертифицированное СКЗИ");
    expect(r.reason).toContain("1.2.643.7.1.1.2.2");
  });
  it("ГОСТ важнее математики и корня: без СКЗИ «неверна» не утверждается", () => {
    expect(v({ algorithms: ["1.2.643.2.2.9"], math: false, chain_trusted: false }).status).toBe("UNVERIFIED");
  });
});

describe("несколько подписантов в одном файле", () => {
  const ok = (kind: "UKEP" | "UNEP", signer: string, at: string): SignatureVerdict => ({ status: "VALID", kind, reason: "ok", signer, signed_at: at });
  it("все УКЭП — VALID УКЭП, подписанты перечислены, время — последнее", () => {
    const r = combineVerdicts([ok("UKEP", "A", "2026-03-01T00:00:00.000Z"), ok("UKEP", "B", "2026-01-01T00:00:00.000Z"), ok("UKEP", "C", "2026-02-01T00:00:00.000Z")]);
    expect(r).toMatchObject({ status: "VALID", kind: "UKEP", signer: "A; B; C", signed_at: "2026-03-01T00:00:00.000Z" });
    expect(r.reason).toBe("все 3 подписи верны: УКЭП");
  });
  it("хотя бы одна УНЭП — итог УНЭП; одна подпись возвращается как есть", () => {
    const mixed = combineVerdicts([ok("UKEP", "A", "x"), ok("UNEP", "B", "y")]);
    expect(mixed).toMatchObject({ status: "VALID", kind: "UNEP" });
    expect(mixed.reason).toBe("все 2 подписи верны: УНЭП (не все корни — аккредитованные УЦ)");
    // без времени у части подписантов — берётся последнее из известных; ни у кого нет — пусто
    const noTime = (s: string, at: string | null): SignatureVerdict => ({ ...ok("UKEP", s, "x"), signed_at: at });
    expect(combineVerdicts([noTime("A", "2026-05-01T00:00:00.000Z"), noTime("B", null)]).signed_at).toBe("2026-05-01T00:00:00.000Z");
    expect(combineVerdicts([noTime("A", null), noTime("B", null)]).signed_at).toBeNull();
    const one = ok("UNEP", "A", "x");
    expect(combineVerdicts([one])).toBe(one);
  });
  it("INVALID важнее UNVERIFIED, UNVERIFIED важнее VALID; подписантов нет — INVALID", () => {
    const unv: SignatureVerdict = { status: "UNVERIFIED", kind: null, reason: "u", signer: "U", signed_at: null };
    const inv: SignatureVerdict = { status: "INVALID", kind: null, reason: "i", signer: "I", signed_at: null };
    expect(combineVerdicts([ok("UKEP", "A", "x"), unv, inv])).toBe(inv);
    expect(combineVerdicts([ok("UKEP", "A", "x"), unv])).toBe(unv);
    expect(combineVerdicts([])).toMatchObject({ status: "INVALID", reason: expect.stringContaining("ни одного подписанта") });
  });
});

describe("подписан ли документ электронно (OS-INSP-1.2.14)", () => {
  it("проверки нет — решает заявление реестра; проверка есть — только VALID", () => {
    expect(electronicallySigned(true, null)).toBe(true);
    expect(electronicallySigned(true, undefined)).toBe(true);
    expect(electronicallySigned(false, null)).toBe(false);
    expect(electronicallySigned(true, { status: "INVALID" })).toBe(false);
    expect(electronicallySigned(true, { status: "UNVERIFIED" })).toBe(false);
    expect(electronicallySigned(false, { status: "VALID" })).toBe(true);
  });
  const doc = (o: Partial<IdDoc>): IdDoc => ({
    file_id: "f1", client_file_id: "ID-01", sha256: "a".repeat(64), file_name: "aosr.pdf", kind: "pdf", document_code: "АОСР-1", revision: "1",
    approval_status: "APPROVED", revision_role: "CURRENT", signature_status: "УКЭП", title: null, requisites: [], ...o,
  });
  it("реестр заявляет УКЭП, подпись INVALID — реквизиты проверяются как у скана, причина названа", () => {
    const [c] = evaluateRequisites([doc({ signature_check: { status: "INVALID", reason: "подпись не соответствует содержимому документа" } })]);
    expect(c).toMatchObject({ param_code: "REQ-ID-01", status: "MISSING_EVIDENCE" });
    expect(c.reason).toContain("в реестре подпись УКЭП");
    expect(c.reason).toContain("проверка электронной подписи: INVALID — подпись не соответствует содержимому документа");
  });
  it("UNVERIFIED (ГОСТ без СКЗИ) — тоже как скан; VALID — визуальная подпись не требуется даже при скан-статусе в реестре", () => {
    expect(evaluateRequisites([doc({ signature_check: { status: "UNVERIFIED", reason: "нужно СКЗИ" } })])).toHaveLength(1);
    expect(evaluateRequisites([doc({ signature_status: "SCAN_SIGNED", signature_check: { status: "VALID", reason: "ok" } })])).toEqual([]);
    expect(evaluateRequisites([doc({})])).toEqual([]); // подписи рядом нет — прежнее правило: заявление реестра
  });
});
