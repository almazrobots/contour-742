// Варианты CMS, которые openssl не выпускает (генерация фикстур; криптографии не требует):
//  ed-rsaoid.sig — подпись Ed25519, но signatureAlgorithm подписанта объявлен rsaEncryption: ключ и алгоритм не совпадают;
//  keyid-noski-first.sig — подписант по SubjectKeyIdentifier, а перед ним в certificates лежат: сертификат совсем без
//  расширений, сертификат без SKI и промежуточный УЦ (с другим SKI). Подписант обязан найтись по совпадению SKI.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const asn1js = require("asn1js");
const pkijs = require("pkijs");

const parse = (file) => {
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(readFileSync(file)).result });
  return new pkijs.SignedData({ schema: ci.content });
};
const write = (name, sd) => writeFileSync(new URL(`./${name}`, import.meta.url), Buffer.from(new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: sd.toSchema(true) }).toSchema().toBER(false)));
const cert = (name) => new pkijs.Certificate({ schema: asn1js.fromBER(Buffer.from(readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(/-----[^-]+-----|\s+/g, ""), "base64")).result });

const [edFile, keyidFile] = process.argv.slice(2);
const ed = parse(edFile);
ed.signerInfos[0].signatureAlgorithm = new pkijs.AlgorithmIdentifier({ algorithmId: "1.2.840.113549.1.1.1" });
write("ed-rsaoid.sig", ed);

const kid = parse(keyidFile);
const noext = cert("noski.crt");
noext.extensions = undefined; // подпись сертификата после этого не сходится — он здесь посторонний, это не важно
const [signer, ...rest] = kid.certificates; // openssl кладёт подписанта первым
kid.certificates = [new pkijs.Certificate({ schema: asn1js.fromBER(noext.toSchema(true).toBER(false)).result }), cert("noski.crt"), ...rest, signer];
write("keyid-noski-first.sig", kid);
