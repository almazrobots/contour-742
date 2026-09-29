// CMS SignedData с алгоритмами ГОСТ Р 34.10/34.11-2012 по OID (OS-INSP-1.2.13). Настоящей ГОСТ-криптографии нет:
// подпись — случайные байты. Этого достаточно: без сертифицированного СКЗИ система не проверяет ГОСТ вовсе.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const asn1js = require("asn1js");
const pkijs = require("pkijs");

const pem = readFileSync(new URL("./signer-ukep.crt", import.meta.url), "utf8").replace(/-----[^-]+-----|\s+/g, "");
const cert = new pkijs.Certificate({ schema: asn1js.fromBER(Buffer.from(pem, "base64")).result });
const GOST_DIGEST = "1.2.643.7.1.1.2.2"; // ГОСТ Р 34.11-2012, 256 бит
const GOST_SIGN = "1.2.643.7.1.1.1.1"; // ГОСТ Р 34.10-2012, 256 бит
const signed = new pkijs.SignedData({
  version: 1,
  digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: GOST_DIGEST })],
  encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" }),
  certificates: [cert],
  signerInfos: [
    new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: GOST_DIGEST }),
      signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: GOST_SIGN }),
      signature: new asn1js.OctetString({ valueHex: randomBytes(64) }),
    }),
  ],
});
const ci = new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: signed.toSchema(true) });
writeFileSync(new URL("./gost.sig", import.meta.url), Buffer.from(ci.toSchema().toBER(false)));
