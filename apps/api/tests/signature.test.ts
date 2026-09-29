// OS-INSP-1.2.11–1.2.13 на настоящей криптографии: откреплённые CMS-подписи из openssl (синтетические УЦ и подписанты,
// генератор — tests/fixtures/signature/gen.sh). Документ и подписи не меняются: время проверки — signingTime из подписи.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.INSPECTOR_DEMO_PASSWORD ||= "test-pass";
const F = resolve(import.meta.dirname, "fixtures/signature");
const TMP = mkdtempSync(join(tmpdir(), "inspector-sig-"));
const read = (n: string) => readFileSync(join(F, n));
const doc = read("doc.pdf");
let S: typeof import("../src/services/signature.ts");
let trust: import("../src/services/signature.ts").TrustStore;

beforeAll(async () => {
  S = await import("../src/services/signature.ts");
  trust = S.loadTrustStore(join(F, "trust"), join(F, "qualified"));
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("проверка откреплённой подписи CMS (OS-INSP-1.2.11, 1.2.12)", () => {
  it("RSA, цепочка через промежуточный УЦ к аккредитованному корню — VALID УКЭП, подписант и время подписания", () => {
    const r = S.checkDetached(doc, read("ukep.sig"), trust);
    expect(r).toMatchObject({ status: "VALID", kind: "UKEP", signer: "CN=Иванов Иван (тест УКЭП)" });
    expect(r.signed_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it("подпись в Base64 с заголовком PEM (вариант сохранения КриптоАРМ) — тоже VALID УКЭП", () => {
    expect(S.checkDetached(doc, read("ukep-base64.sig"), trust)).toMatchObject({ status: "VALID", kind: "UKEP" });
  });
  it("ECDSA P-256, корень доверенный, но не аккредитованный (.p7s) — VALID УНЭП", () => {
    expect(S.checkDetached(doc, read("unep.p7s"), trust)).toMatchObject({ status: "VALID", kind: "UNEP", signer: "CN=Петров Пётр (тест УНЭП), O=Тест корпорация" }); // составное имя — через запятую
  });
  it("тот же корень только в INSPECTOR_TRUST_DIR, без списка аккредитованных — УНЭП, а не УКЭП", () => {
    expect(S.checkDetached(doc, read("ukep.sig"), S.loadTrustStore(join(F, "trust"), null))).toMatchObject({ status: "VALID", kind: "UNEP" });
  });
  it("аккредитованный корень только в INSPECTOR_QUALIFIED_ROOTS_DIR — он же доверенный: УКЭП", () => {
    expect(S.checkDetached(doc, read("ukep.sig"), S.loadTrustStore(null, join(F, "qualified")))).toMatchObject({ status: "VALID", kind: "UKEP" });
  });
  it("документ подменён после подписания — INVALID «не соответствует содержимому»", () => {
    const r = S.checkDetached(read("doc-tampered.pdf"), read("ukep.sig"), trust);
    expect(r).toMatchObject({ status: "INVALID", kind: null, signer: "CN=Иванов Иван (тест УКЭП)" });
    expect(r.reason).toContain("не соответствует содержимому документа");
  });
  it("документ отличается одним последним байтом — INVALID", () => {
    const d = Buffer.from(doc);
    d[d.length - 1] ^= 1;
    expect(S.checkDetached(d, read("unep.p7s"), trust).status).toBe("INVALID");
  });
  it("сертификат подписанта истёк до момента подписания — INVALID с датой окончания", () => {
    const r = S.checkDetached(doc, read("expired.sig"), trust);
    expect(r).toMatchObject({ status: "INVALID", kind: null });
    expect(r.reason).toContain("истёк в момент подписания");
    expect(r.reason).toContain("2021-01-01");
  });
  it("корень подписанта не в доверенных — UNVERIFIED «цепочка не сходится»", () => {
    const r = S.checkDetached(doc, read("foreign.sig"), trust);
    expect(r).toMatchObject({ status: "UNVERIFIED", kind: null, signer: "CN=Сидоров Сидор (чужой УЦ)" });
    expect(r.reason).toContain("не сходится к доверенному корню");
  });
  it("доверенные корни не заданы — VALID недостижим: UNVERIFIED «нет доверенного корня»", () => {
    const none = S.loadTrustStore(null, null);
    expect(none.configured).toBe(false);
    expect(S.checkDetached(doc, read("ukep.sig"), none)).toMatchObject({ status: "UNVERIFIED", reason: expect.stringContaining("нет доверенного корня") });
  });
});

describe("ГОСТ Р 34.10-2012 без СКЗИ (OS-INSP-1.2.13)", () => {
  it("CMS с ГОСТ-OID — UNVERIFIED «нужно сертифицированное СКЗИ», подписант назван", () => {
    const r = S.checkDetached(doc, read("gost.sig"), trust);
    expect(r).toMatchObject({ status: "UNVERIFIED", kind: null, signer: "CN=Иванов Иван (тест УКЭП)" });
    expect(r.reason).toContain("ГОСТ Р 34.10-2012");
    expect(r.reason).toContain("сертифицированное СКЗИ");
  });
});

describe("враждебные и битые файлы подписи (L6)", () => {
  it("текст вместо CMS — INVALID «не CMS»", () => {
    expect(S.checkDetached(doc, read("garbage.sig"), trust)).toMatchObject({ status: "INVALID", reason: expect.stringContaining("не CMS") });
  });
  it("обрезанная подпись, пустой файл, мусор с тегом SEQUENCE, PDF вместо подписи — INVALID «не CMS», без исключений", () => {
    const sig = read("ukep.sig");
    for (const bad of [sig.subarray(0, sig.length >> 1), Buffer.alloc(0), Buffer.from([0x30, 0x82, 0xff, 0xff, 1, 2, 3]), doc]) {
      expect(S.checkDetached(doc, bad, trust)).toMatchObject({ status: "INVALID", reason: expect.stringContaining("не CMS") });
    }
  });
  it("подпись несёт собственный корень внутри CMS — доверие не появляется: UNVERIFIED", () => {
    // цепочка доходит до корня из CMS, но корень не в доверенных каталогах — доверие даёт только конфигурация
    expect(S.checkDetached(doc, read("foreign-selfroot.sig"), trust)).toMatchObject({ status: "UNVERIFIED", reason: expect.stringContaining("не сходится к доверенному корню") });
  });
});

describe("каталоги доверенных корней: громкие ошибки (L7)", () => {
  it("несуществующий каталог — исключение с путём", () => {
    expect(() => S.loadTrustStore(join(TMP, "нет-такого"), null)).toThrow(/каталог доверенных сертификатов не найден/);
  });
  it("файл .pem, который не сертификат, — исключение с именем файла; прочие расширения не читаются", () => {
    const dir = mkdtempSync(join(TMP, "bad-"));
    writeFileSync(join(dir, "readme.txt"), "не сертификат");
    expect(S.loadTrustStore(dir, null).configured).toBe(false);
    writeFileSync(join(dir, "broken.pem"), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    expect(() => S.loadTrustStore(dir, null)).toThrow(/broken\.pem: не сертификат X\.509/);
  });
  it("несколько сертификатов в одном PEM читаются все; DER читается как есть", () => {
    const dir = mkdtempSync(join(TMP, "multi-"));
    writeFileSync(join(dir, "bundle.pem"), Buffer.concat([read("trust/qualified-root.crt"), read("trust/plain-root.crt")]));
    expect(S.loadTrustStore(dir, null).anchors).toHaveLength(2);
    expect(S.readCerts(join(F, "signer-unep.crt"))).toHaveLength(1);
  });
});

// ─────────────────────────────── форматы CMS и алгоритмы (добивка мутантов services/signature.ts)

/** Заменить последнее вхождение OID в DER (тот же размер). Последний rsaEncryption в CMS — signatureAlgorithm подписанта. */
function patchLast(buf: Buffer, from: string, to: string): Buffer {
  const h = buf.toString("hex");
  const i = h.lastIndexOf(from);
  if (i < 0 || i % 2) throw new Error(`OID ${from} не найден`);
  return Buffer.from(h.slice(0, i) + to + h.slice(i + to.length), "hex");
}
const RSA_ENC = "06092a864886f70d010101";

describe("алгоритмы хеша и подписи (OS-INSP-1.2.12)", () => {
  it.each(["sha1", "sha224", "sha384", "sha512"])("RSA и ECDSA с дайджестом %s — VALID (УКЭП и УНЭП)", (md) => {
    expect(S.checkDetached(doc, read(`ukep-${md}.sig`), trust)).toMatchObject({ status: "VALID", kind: "UKEP" });
    expect(S.checkDetached(doc, read(`unep-${md}.p7s`), trust)).toMatchObject({ status: "VALID", kind: "UNEP" });
  });
  it.each([["ukep-sha1.sig", "05"], ["ukep-sha224.sig", "0e"], ["ukep.sig", "0b"], ["ukep-sha384.sig", "0c"], ["ukep-sha512.sig", "0d"]])(
    "%s с алгоритмом подписи shaNNNWithRSAEncryption (…1.1.%s) вместо rsaEncryption — VALID", (file, last) => {
      expect(S.checkDetached(doc, patchLast(read(file), RSA_ENC, RSA_ENC.slice(0, -2) + last), trust)).toMatchObject({ status: "VALID", kind: "UKEP" });
    },
  );
  it("алгоритм подписи называет другой хеш, чем дайджест (sha512WithRSA над sha256) — INVALID", () => {
    expect(S.checkDetached(doc, patchLast(read("ukep.sig"), RSA_ENC, RSA_ENC.slice(0, -2) + "0d"), trust).status).toBe("INVALID");
  });
  it("RSASSA-PSS — UNVERIFIED «алгоритм не поддерживается», а не INVALID", () => {
    expect(S.checkDetached(doc, read("ukep-pss.sig"), trust)).toMatchObject({ status: "UNVERIFIED", reason: expect.stringContaining("не поддерживается") });
  });
});

describe("варианты структуры CMS", () => {
  it("подписант указан по SubjectKeyIdentifier (-keyid) — найден, VALID УКЭП", () => {
    expect(S.checkDetached(doc, read("ukep-keyid.sig"), trust)).toMatchObject({ status: "VALID", kind: "UKEP", signer: "CN=Иванов Иван (тест УКЭП)" });
  });
  it("без подписанных атрибутов (-noattr): подпись прямо над документом — VALID; подмена документа — INVALID", () => {
    expect(S.checkDetached(doc, read("ukep-noattr.sig"), trust)).toMatchObject({ status: "VALID", signed_at: null });
    expect(S.checkDetached(read("doc-tampered.pdf"), read("ukep-noattr.sig"), trust).status).toBe("INVALID");
  });
  it("атрибуты есть, signingTime нет — VALID, signed_at пуст, срок сертификата — на момент проверки", () => {
    expect(S.checkDetached(doc, read("ukep-notime.sig"), trust)).toMatchObject({ status: "VALID", signed_at: null });
    expect(S.checkDetached(doc, read("ukep-notime.sig"), trust, new Date("2041-01-01T00:00:00Z"))).toMatchObject({ status: "INVALID", reason: expect.stringContaining("в момент проверки") });
  });
  it("цепочка проверяется на момент подписания, а не проверки: через 25 лет после истечения корней подпись 2026 года — VALID", () => {
    expect(S.checkDetached(doc, read("ukep.sig"), trust, new Date("2050-01-01T00:00:00Z"))).toMatchObject({ status: "VALID", kind: "UKEP" });
  });
  it("сертификата подписанта в CMS нет (-nocerts) — UNVERIFIED «нет сертификата подписанта», без исключения", () => {
    expect(S.checkDetached(doc, read("ukep-nocerts.sig"), trust)).toMatchObject({ status: "UNVERIFIED", reason: expect.stringContaining("нет сертификата подписанта") });
  });
  it("CMS без подписантов — INVALID «ни одного подписанта»", async () => {
    const asn1js = await import("asn1js");
    const pkijs = await import("pkijs");
    const sd = new pkijs.SignedData({ version: 1, encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" }), signerInfos: [] });
    const der = Buffer.from(new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: sd.toSchema(true) }).toSchema().toBER(false));
    expect(asn1js.fromBER(new Uint8Array(der)).offset).not.toBe(-1);
    expect(S.checkDetached(doc, der, trust)).toMatchObject({ status: "INVALID", reason: expect.stringContaining("ни одного подписанта") });
  });
  it("ContentInfo другого типа (id-data вместо id-signedData) — INVALID «не CMS», даже если внутри рабочая SignedData", () => {
    const h = read("ukep.sig").toString("hex").replace("06092a864886f70d010702", "06092a864886f70d010701");
    expect(S.checkDetached(doc, Buffer.from(h, "hex"), trust)).toMatchObject({ status: "INVALID", reason: expect.stringContaining("не CMS") });
  });
  it("ключ Ed25519, а алгоритм подписи объявлен rsaEncryption — INVALID, без исключения", () => {
    expect(S.checkDetached(doc, read("ed-rsaoid.sig"), trust)).toMatchObject({ status: "INVALID", reason: expect.stringContaining("не соответствует содержимому") });
  });
  it("подписант по SKI, а первым в CMS лежит сертификат без SKI — найден нужный, VALID", () => {
    expect(S.checkDetached(doc, read("keyid-noski-first.sig"), trust)).toMatchObject({ status: "VALID", signer: "CN=Иванов Иван (тест УКЭП)" });
  });
  it("Base64 без заголовка PEM при любом выравнивании (0, 1 и 2 знака «=») — VALID", () => {
    const pads = new Set<number>();
    for (const f of ["ukep.sig", "unep.p7s", "ukep-sha384.sig", "unep-sha384.p7s", "ukep-sha512.sig", "unep-sha512.p7s", "ukep-sha1.sig", "unep-sha1.p7s", "ukep-keyid.sig", "ukep-notime.sig"]) {
      const b64 = read(f).toString("base64");
      pads.add(b64.length - b64.replace(/=+$/, "").length);
      expect([f, S.checkDetached(doc, Buffer.from(b64.replace(/(.{64})/g, "$1\r\n")), trust).status]).toEqual([f, "VALID"]);
    }
    expect([...pads].sort()).toEqual([0, 1, 2]);
  });
  it("сертификат вместо подписи — INVALID «не CMS»", () => {
    expect(S.checkDetached(doc, read("signer-ukep.crt"), trust).reason).toContain("не CMS");
  });
});

describe("атаки на цепочку доверия", () => {
  it("подписант выдан самозванцем без AKI: имя издателя совпадает с доверенным корнем, ключ — нет — UNVERIFIED", () => {
    // без AKI издатель узнаётся только по имени: доверие решает проверка подписи сертификата ключом корня
    expect(S.checkDetached(doc, read("fake-root.sig"), trust).reason).toContain("не сходится к доверенному корню");
  });
  it("атака: конечный сертификат (CA:FALSE) из аккредитованной цепочки выпустил «подписанта» — цепочка не строится, UNVERIFIED, не УКЭП", () => {
    // математика подписи верна и каждое звено подписано ключом предыдущего — отказ даёт только признак CA у издателя
    expect(S.checkDetached(doc, read("by-leaf.sig"), trust)).toMatchObject({ status: "UNVERIFIED", kind: null, reason: expect.stringContaining("не сходится к доверенному корню") });
  });
  it("поддельный УЦ с тем же именем, что аккредитованный корень, но другим ключом — UNVERIFIED, не УКЭП", () => {
    expect(S.checkDetached(doc, read("fake-root.sig"), trust)).toMatchObject({ status: "UNVERIFIED", kind: null });
  });
});

describe("построение цепочки chainToAnchor", async () => {
  const { X509Certificate } = await import("node:crypto");
  const x = (n: string) => new X509Certificate(read(n));
  const leaf = x("signer-ukep.crt");
  const ica = x("qualified-ica.crt");
  const cross = x("qualified-ica-cross.crt");
  const root = x("qualified/qualified-root.crt");
  it("промежуточный УЦ действует ровно с notBefore и ровно до notAfter (границы включены); на 1 мс за границей — цепочки нет", () => {
    const from = new Date(ica.validFrom);
    const to = new Date(ica.validTo);
    expect(S.chainToAnchor(leaf, [ica], trust, from)?.fingerprint256).toBe(root.fingerprint256);
    expect(S.chainToAnchor(leaf, [ica], trust, to)?.fingerprint256).toBe(root.fingerprint256);
    expect(S.chainToAnchor(leaf, [ica], trust, new Date(from.getTime() - 1))).toBeNull();
    expect(S.chainToAnchor(leaf, [ica], trust, new Date(to.getTime() + 1))).toBeNull();
  });
  it("кросс-сертификат от чужого корня стоит первым — тупиковая ветка не мешает найти путь к доверенному корню", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    expect(S.chainToAnchor(leaf, [cross, ica], trust, at)?.fingerprint256).toBe(root.fingerprint256);
    expect(S.chainToAnchor(leaf, [cross], trust, at)).toBeNull();
  });
  it("цикл кросс-сертификатов X ↔ Y без доверенного корня — построение завершается, цепочки нет", () => {
    expect(S.chainToAnchor(x("cyc-leaf.crt"), [x("cyc-x.crt"), x("cyc-y.crt")], trust, new Date("2026-06-01T00:00:00Z"))).toBeNull();
  });
  it("сертификат, который сам доверенный корень, — сам себе якорь", () => {
    expect(S.chainToAnchor(root, [], trust, new Date("2026-06-01T00:00:00Z"))?.fingerprint256).toBe(root.fingerprint256);
  });
});

describe("факты проверки signatureFacts", () => {
  const at = new Date("2026-09-25T00:00:00Z");
  it("не CMS — ни одного выдуманного факта: математика, цепочка и УКЭП ложны", () => {
    expect(S.signatureFacts(doc, read("garbage.sig"), trust, at)).toEqual([
      { cms: false, algorithms: [], signer: null, math: false, signing_time: null, trust_configured: true, chain_trusted: false, qualified_root: false },
    ]);
  });
  it("ГОСТ — математика и цепочка не считаются; в алгоритмах и ГОСТ-OID подписи, и алгоритмы сертификата", () => {
    const [f] = S.signatureFacts(doc, read("gost.sig"), trust, at);
    expect(f).toMatchObject({ cms: true, math: false, chain_trusted: false, qualified_root: false });
    expect(f.algorithms).toEqual(expect.arrayContaining(["1.2.643.7.1.1.2.2", "1.2.643.7.1.1.1.1", "1.2.840.113549.1.1.1", "1.2.840.113549.1.1.11"]));
  });
});

describe("каталоги корней: все расширения сертификатов", () => {
  it(".pem, .crt, .cer и .der (DER) читаются, регистр расширения не важен; прочие файлы пропускаются", async () => {
    const { X509Certificate } = await import("node:crypto");
    const dir = mkdtempSync(join(TMP, "ext-"));
    const pem = read("trust/qualified-root.crt");
    writeFileSync(join(dir, "a.pem"), pem);
    writeFileSync(join(dir, "b.CRT"), read("trust/plain-root.crt"));
    writeFileSync(join(dir, "c.cer"), read("qualified-ica.crt"));
    writeFileSync(join(dir, "d.der"), new X509Certificate(read("signer-unep.crt")).raw);
    writeFileSync(join(dir, "e.txt"), "не сертификат");
    expect(S.loadTrustStore(dir, null).anchors).toHaveLength(4);
    expect(S.readCerts(join(dir, "d.der"))).toHaveLength(1);
  });
});
