// NFR-MTLS: тестовая PKI для rin-mtls.test.ts создаётся при запуске тестов, а не хранится в git — закрытый ключ
// в репозитории запрещён (та же дисциплина, что у setup-tls.ts). EC P-256: OpenSSL в Node ГОСТ не умеет. Нужен openssl.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["ca.crt", "server.crt", "server.key", "client.crt", "client.key", "client.p12", "other-ca.crt", "other-client.crt", "other-client.key", "rogue-server.crt", "rogue-server.key"];

export default function setup(): void {
  const dir = join(import.meta.dirname, "fixtures/mtls");
  if (FILES.every((n) => existsSync(join(dir, n)))) return;
  mkdirSync(dir, { recursive: true });
  const f = (n: string) => join(dir, n);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  const key = (n: string) => ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f(n));
  const ca = (name: string, cn: string) => {
    key(`${name}.key`);
    ssl("req", "-x509", "-new", "-key", f(`${name}.key`), "-sha256", "-days", "7300", "-subj", `/CN=${cn}`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", f(`${name}.crt`));
  };
  const leaf = (name: string, cn: string, issuer: string, ext: string) => {
    key(`${name}.key`);
    ssl("req", "-new", "-key", f(`${name}.key`), "-subj", `/CN=${cn}`, "-out", f(`${name}.csr`));
    writeFileSync(f(`${name}.ext`), ext);
    ssl("x509", "-req", "-in", f(`${name}.csr`), "-CA", f(`${issuer}.crt`), "-CAkey", f(`${issuer}.key`), "-CAcreateserial",
      "-days", "7300", "-sha256", "-extfile", f(`${name}.ext`), "-out", f(`${name}.crt`));
    rmSync(f(`${name}.csr`));
    rmSync(f(`${name}.ext`));
  };
  const server = "basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n";
  const client = "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n";
  ca("ca", "Inspector Test RiN Root CA");
  ca("other-ca", "Inspector Test Other CA");
  leaf("server", "localhost", "ca", server);
  leaf("client", "inspector-test-client", "ca", client);
  leaf("other-client", "inspector-other-client", "other-ca", client);
  leaf("rogue-server", "localhost", "other-ca", server);
  ssl("pkcs12", "-export", "-inkey", f("client.key"), "-in", f("client.crt"), "-certfile", f("ca.crt"), "-passout", "pass:test-only",
    "-keypbe", "AES-256-CBC", "-certpbe", "AES-256-CBC", "-macalg", "sha256", "-out", f("client.p12"));
  // ключи CA больше не нужны — как и в выпущенном наборе
  for (const n of ["ca.key", "other-ca.key", "ca.srl", "other-ca.srl"]) rmSync(f(n), { force: true });
}
