// T-131 (OWASP T-140 E1-H1): доверенные прокси для адреса клиента. Демо стоит за Caddy и nginx — без доверия все
// клиенты для API один адрес, и счётчик неудачных входов по адресу закрывал вход всем. Доверие — только списком
// адресов и сетей своих прокси (proxy-addr: loopback, uniquelocal, CIDR); «доверять всем» — ошибка конфигурации:
// тогда X-Forwarded-For подделывает любой и обходит ограничение попыток.

const EVERYONE = new Set(["true", "*", "0.0.0.0/0", "::/0"]);

export function parseTrustProxy(raw: string | undefined): string | false {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) return false;
  const bad = items.find((s) => EVERYONE.has(s.toLowerCase()));
  if (bad) throw new Error(`INSPECTOR_TRUST_PROXY: «${bad}» — доверие всем адресам запрещено, перечислите свои прокси`);
  return items.join(", ");
}
