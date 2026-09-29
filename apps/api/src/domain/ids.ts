// NFR-IDS (ТЗ 12.9, TZA-12.9-01/02, T-138): обнаружение вторжений и защита от DDoS прикладного уровня.
// Чистые функции и учёт в памяти; блокировки, журнал и уведомления — services/ids.ts.
//
// Рубежи: nginx (limit_req / limit_conn, тайм-ауты медленных клиентов) → API (ведро токенов на адрес — второй
// рубеж, если прокси обошли или он упал) → детектор: каждый запрос даёт признаки (сигнатура атаки в адресе или
// User-Agent, отказ во входе, в доступе, перебор несуществующих путей, упор в лимит), признаки весят очки, очки
// копятся по адресу в скользящем окне; порог — блокировка адреса с нарастающим сроком (15 мин × 2^(n−1), ≤ сутки).
// Порог и веса подобраны так, чтобы инспектор с истёкшей сессией или опечаткой в пароле блокировки не получал:
// 5 неудач входа = 25 очков из 50, а сигнатура атаки весит 10 — пять попыток инъекции блокируют сразу.

export const WINDOW_MS = 5 * 60_000;
export const BLOCK_SCORE = 50;
export const BLOCK_MS = 15 * 60_000;
export const BLOCK_MAX_MS = 24 * 3600_000;
export const MAX_TRACKED = 20_000;

export const WEIGHTS = {
  path_traversal: 10,
  sql_injection: 10,
  xss: 10,
  sensitive_file: 10,
  jndi: 10,
  scanner: 10,
  auth_fail: 5,
  rate_limited: 3,
  forbidden: 2,
  unauthorized: 1,
  not_found: 1,
} as const;
export type Signal = keyof typeof WEIGHTS;

export const SIGNAL_NAMES: Record<Signal, string> = {
  path_traversal: "обход каталогов",
  sql_injection: "SQL-инъекция",
  xss: "внедрение скрипта",
  sensitive_file: "поиск служебных файлов",
  jndi: "JNDI-инъекция",
  scanner: "сканер уязвимостей",
  auth_fail: "подбор пароля",
  rate_limited: "превышение лимита запросов",
  forbidden: "попытки доступа без прав",
  unauthorized: "запросы без входа",
  not_found: "перебор путей",
};

// Регулярки без вложенных квантификаторов: время проверки линейно по длине адреса (нет ReDoS)
const RULES: Array<[Signal, RegExp]> = [
  ["path_traversal", /(?:\.\.|%2e%2e|\.%2e|%2e\.)(?:\/|\\|%2f|%5c)/i],
  ["sql_injection", /\bunion\b[\s+]+(?:all[\s+]+)?select\b|'\s*or\s*'?\d+'?\s*=\s*'?\d|;\s*(?:drop|delete|insert|update|select)\b|\b(?:pg_)?sleep\s*\(|\bwaitfor\s+delay\b|information_schema/i],
  ["xss", /<\s*script|javascript:|\bon(?:error|load)\s*=|<\s*svg[^>]{0,64}onload/i],
  ["sensitive_file", /\/\.(?:env|git|svn|htaccess|aws|ssh)(?:\/|$|\?)|\/etc\/(?:passwd|shadow)|\/wp-(?:admin|login|content)|\/phpmyadmin|\.php(?:$|\?)|\/(?:actuator|server-status|cgi-bin)\b/i],
  ["jndi", /\$\{\s*jndi\s*:/i],
];
const SCANNER_UA = /\b(?:sqlmap|nikto|nuclei|masscan|zgrab|nmap|acunetix|nessus|openvas|dirbuster|gobuster|wpscan|hydra)\b/i;
const MAX_CHECK = 8192; // длиннее не проверяем: хвост адреса сверх 8 КБ отрежет nginx (large_client_header_buffers)

function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url; // битое %-кодирование — проверяется сырой адрес
  }
}

/** Сигнатуры атаки в адресе (сыром и декодированном) и в User-Agent. */
export function signatures(req: { url: string; ua?: string | null }): Signal[] {
  const raw = req.url.slice(0, MAX_CHECK);
  const both = `${raw}\n${decoded(raw)}`;
  const out = RULES.filter(([, re]) => re.test(both)).map(([k]) => k);
  if (req.ua && SCANNER_UA.test(req.ua.slice(0, 512))) out.push("scanner");
  return out;
}

const LOGIN = /^\/api\/v1\/auth\/login(?:\?|$)/;

/** Все признаки запроса: сигнатуры и признак ответа. */
export function signals(req: { url: string; ua?: string | null; status: number }): Signal[] {
  const out = signatures(req);
  if (req.status === 401) out.push(LOGIN.test(req.url) ? "auth_fail" : "unauthorized");
  else if (req.status === 403) out.push("forbidden");
  else if (req.status === 404) out.push("not_found");
  else if (req.status === 429) out.push("rate_limited");
  return out;
}

export type BlockDecision = { ip: string; score: number; reason: string; events: Partial<Record<Signal, number>> };

/** Срок n-й блокировки адреса: 15 мин × 2^(n−1), не больше суток. */
export function blockDuration(n: number): number {
  return Math.min(BLOCK_MS * 2 ** Math.max(0, n - 1), BLOCK_MAX_MS);
}

type Track = { events: Array<[number, Signal]>; last: number };

/** Скользящее окно очков по адресу. Память ограничена MAX_TRACKED адресами: вытесняются самые давние. */
export class IdsWindow {
  readonly windowMs = WINDOW_MS;
  private tracks = new Map<string, Track>();
  constructor(private now: () => number = Date.now) {}

  private fresh(t: Track | undefined): Array<[number, Signal]> {
    const at = this.now();
    return (t?.events ?? []).filter(([ts]) => at - ts < this.windowMs);
  }

  score(ip: string): number {
    return this.fresh(this.tracks.get(ip)).reduce((a, [, k]) => a + WEIGHTS[k], 0);
  }

  /** Учесть признаки запроса; при пороге — решение о блокировке, счёт адреса обнуляется. */
  add(ip: string, sig: Signal[]): BlockDecision | null {
    if (!sig.length) return null;
    const at = this.now();
    if (!this.tracks.has(ip) && this.tracks.size >= MAX_TRACKED) this.evict();
    const events = [...this.fresh(this.tracks.get(ip)), ...sig.map((k) => [at, k] as [number, Signal])];
    const score = events.reduce((a, [, k]) => a + WEIGHTS[k], 0);
    if (score < BLOCK_SCORE) {
      this.tracks.set(ip, { events, last: at });
      return null;
    }
    this.tracks.delete(ip);
    const counts: Partial<Record<Signal, number>> = {};
    for (const [, k] of events) counts[k] = (counts[k] ?? 0) + 1;
    const top = (Object.keys(counts) as Signal[]).sort((a, b) => counts[b]! * WEIGHTS[b] - counts[a]! * WEIGHTS[a]);
    return { ip, score, events: counts, reason: top.map((k) => `${SIGNAL_NAMES[k]} ×${counts[k]}`).join(", ") };
  }

  private evict(): void {
    const at = this.now();
    for (const [k, t] of this.tracks) if (at - t.last >= this.windowMs) this.tracks.delete(k);
    if (this.tracks.size < MAX_TRACKED) return;
    const old = [...this.tracks.entries()].sort((a, b) => a[1].last - b[1].last);
    for (const [k] of old.slice(0, Math.ceil(MAX_TRACKED / 10))) this.tracks.delete(k);
  }

  size(): number {
    return this.tracks.size;
  }
}

/** Ведро токенов на адрес: burst запросов сразу, дальше rps в секунду. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private rps: number,
    private burst: number,
    private now: () => number = Date.now,
    private max = MAX_TRACKED,
  ) {}

  take(ip: string): { ok: true } | { ok: false; retryAfter: number } {
    const at = this.now();
    if (!this.buckets.has(ip) && this.buckets.size >= this.max) this.evict(at);
    const b = this.buckets.get(ip) ?? { tokens: this.burst, at };
    const tokens = Math.min(this.burst, b.tokens + ((at - b.at) / 1000) * this.rps);
    if (tokens >= 1) {
      this.buckets.set(ip, { tokens: tokens - 1, at });
      return { ok: true };
    }
    this.buckets.set(ip, { tokens, at });
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / this.rps)) };
  }

  /** Полные вёдра ничего не помнят — их и вытесняем; не хватило — самые давние. */
  private evict(at: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + ((at - b.at) / 1000) * this.rps >= this.burst) this.buckets.delete(k);
    if (this.buckets.size < this.max) return;
    const old = [...this.buckets.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of old.slice(0, Math.ceil(this.max / 10))) this.buckets.delete(k);
  }

  size(): number {
    return this.buckets.size;
  }
}
