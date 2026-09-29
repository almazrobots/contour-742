// Фикстура TLS создаётся при запуске тестов, а не хранится в git: закрытый ключ в репозитории — даже синтетический —
// запрещён той же дисциплиной, что у фикстур подписи (ключи удаляются генератором). Нужен openssl.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export default function setup(): void {
  const dir = join(import.meta.dirname, "fixtures/tls-api");
  if (existsSync(join(dir, "cert.pem")) && existsSync(join(dir, "key.pem"))) return;
  mkdirSync(dir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "36500",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
}
