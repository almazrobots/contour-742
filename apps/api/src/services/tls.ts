// NFR-TLS (ТЗ 1.3, 12.3): API в эксплуатационном контуре доступен только по HTTPS, TLS 1.3.
// TLS терминирует сам API (без прокси): опции https для Fastify. Версия зажата с обеих сторон —
// клиент с TLS 1.2 и ниже получает отказ на рукопожатии, а не «ослабленное» соединение.
import { readFileSync } from "node:fs";
import type { SecureVersion } from "node:tls";

export const TLS_VERSION: SecureVersion = "TLSv1.3";

export type HttpsOptions = { cert: Buffer | string; key: Buffer | string; minVersion: SecureVersion; maxVersion: SecureVersion };

/** Чистая сборка опций https: только TLS 1.3. */
export function httpsOptions(cert: Buffer | string, key: Buffer | string): HttpsOptions {
  return { cert, key, minVersion: TLS_VERSION, maxVersion: TLS_VERSION };
}

/** Опции https по путям из конфига (config.tls). null — TLS не настроен (только профиль dev). Нет файла — падение при старте. */
export function loadHttpsOptions(tls: { cert: string; key: string } | null): HttpsOptions | null {
  if (!tls) return null;
  return httpsOptions(readFileSync(tls.cert), readFileSync(tls.key));
}
