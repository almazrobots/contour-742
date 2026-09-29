// Защита входа от перебора (ТЗ 12.1). Прототип: учёт в памяти процесса одного экземпляра API.
// В проде частота входа дополнительно ограничивается на прокси / в IdP (ADR-0003: Keycloak), здесь — второй рубеж.
//
// 1. Адрес: не больше IP_LIMIT неудач за окно на любые логины — перебор и «распыление» с одного адреса.
// 2. Учётная запись (только существующая): после ACCOUNT_FREE неудач — нарастающая пауза 2, 4, 8 … с,
//    не больше 15 мин. Жёсткой блокировки нет: чужую запись нельзя запереть навсегда, можно лишь замедлить вход.
// 3. Память ограничена: адреса (не больше MAX_IPS) и логины (не больше MAX_ACCOUNTS). Ключ — сам логин,
//    поэтому существующая и несуществующая записи ведут себя одинаково (нет перечисления логинов).
//    Переполнение адресов вытесняет самые старые НЕзаблокированные адреса; заблокированные остаются,
//    новым адресам вход не закрывается (нет отказа в обслуживании через заполнение учёта).

export const WINDOW_MS = 15 * 60_000;
export const IP_LIMIT = 20;
export const ACCOUNT_FREE = 5;
export const MAX_IPS = 10_000;
export const MAX_ACCOUNTS = 50_000;

/** Учётный ключ — сам логин, одинаково для существующих и несуществующих записей (нет перечисления логинов). */
export function accountKey(login: string): string {
  return `acc:${login.trim().toLowerCase().slice(0, 100)}`;
}

export class LoginThrottle {
  private ip = new Map<string, number[]>();
  private account = new Map<string, { fails: number; last: number }>();
  constructor(private now: () => number = Date.now) {}

  private fresh(ts: number[] | undefined): number[] {
    const t = this.now();
    return (ts ?? []).filter((x) => t - x < WINDOW_MS);
  }

  /** Пауза перед следующей попыткой для учётной записи, мс (0 — можно). */
  accountDelay(userId: string): number {
    const a = this.account.get(userId);
    if (!a || a.fails < ACCOUNT_FREE) return 0;
    const wait = Math.min(2 ** (a.fails - ACCOUNT_FREE + 1) * 1000, WINDOW_MS);
    return Math.max(0, a.last + wait - this.now());
  }

  /** Можно ли пробовать вход. retryAfter — секунды для заголовка Retry-After. */
  check(ip: string, userId: string | null): { ok: true } | { ok: false; retryAfter: number } {
    if (this.fresh(this.ip.get(ip)).length >= IP_LIMIT) return { ok: false, retryAfter: Math.ceil(WINDOW_MS / 1000) };
    const d = userId ? this.accountDelay(userId) : 0;
    return d > 0 ? { ok: false, retryAfter: Math.ceil(d / 1000) } : { ok: true };
  }

  fail(ip: string, userId: string | null): void {
    if (!this.ip.has(ip) && this.ip.size >= MAX_IPS) this.evict();
    this.ip.set(ip, [...this.fresh(this.ip.get(ip)), this.now()]);
    if (userId) {
      if (!this.account.has(userId) && this.account.size >= MAX_ACCOUNTS) this.evictAccounts();
      const a = this.account.get(userId);
      const expired = a && this.now() - a.last > WINDOW_MS;
      this.account.set(userId, { fails: !a || expired ? 1 : a.fails + 1, last: this.now() });
    }
  }

  success(userId: string): void {
    this.account.delete(userId);
  }

  /** Освободить место: сначала истёкшие, затем самые старые незаблокированные адреса. */
  private evict(): void {
    this.prune();
    if (this.ip.size < MAX_IPS) return;
    const open = [...this.ip.entries()].filter(([, ts]) => this.fresh(ts).length < IP_LIMIT).sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]));
    for (const [k] of open.slice(0, Math.max(1, Math.ceil(MAX_IPS / 10)))) this.ip.delete(k);
  }

  /** Освободить место в учёте логинов: самые старые записи без действующей паузы. */
  private evictAccounts(): void {
    this.prune();
    if (this.account.size < MAX_ACCOUNTS) return;
    const open = [...this.account.entries()].filter(([k]) => this.accountDelay(k) === 0).sort((a, b) => a[1].last - b[1].last);
    for (const [k] of open.slice(0, Math.max(1, Math.ceil(MAX_ACCOUNTS / 10)))) this.account.delete(k);
  }

  prune(): void {
    for (const [k, ts] of this.ip) if (!this.fresh(ts).length) this.ip.delete(k);
    for (const [k, a] of this.account) if (this.now() - a.last > WINDOW_MS) this.account.delete(k);
  }

  size(): { ips: number; accounts: number } {
    return { ips: this.ip.size, accounts: this.account.size };
  }
}

/** T-131: гостевой вход демо-стенда без пароля — не больше GUEST_LIMIT сессий с адреса за окно (каждый вход — строка sessions). */
export const GUEST_LIMIT = 10;

export class GuestThrottle {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number = Date.now) {}
  take(ip: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now();
    const ts = (this.hits.get(ip) ?? []).filter((x) => t - x < WINDOW_MS);
    if (ts.length >= GUEST_LIMIT) {
      this.hits.set(ip, ts);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((ts[0] + WINDOW_MS - t) / 1000)) };
    }
    ts.push(t);
    this.hits.delete(ip); // свежий — в конец: вытесняются самые старые адреса
    this.hits.set(ip, ts);
    while (this.hits.size > MAX_IPS) this.hits.delete(this.hits.keys().next().value!);
    return { ok: true };
  }
}
