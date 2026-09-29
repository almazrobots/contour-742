// NFR-IDS (ТЗ 12.9, TZA-12.9-01/02, T-138): рубеж API — лимит запросов на адрес, детектор атак, блокировки.
// Блокировка — строка ip_blocks в базе: её видят все экземпляры API (кэш обновляется раз в BLOCKS_REFRESH_MS),
// она переживает перезапуск, администратор снимает её одной записью. Решение о блокировке — событие безопасности:
// запись IDS_BLOCK в журнал аудита (хранится год, ТЗ 12.5), уведомление администратору, строка журнала с
// security:true (индекс inspector-security), счётчик в /metrics и алерт InspectorIdsBlock (почта и Telegram, ТЗ 13.7).
import { isIP } from "node:net";
import type { DB } from "../db.ts";
import { IdsWindow, RateLimiter, WEIGHTS, blockDuration, signals, type BlockDecision, type Signal } from "../domain/ids.ts";
import { log, notify } from "./audit.ts";

export const BLOCKS_REFRESH_MS = 5_000;
/** Служебные адреса вне детектора (признаков атаки в них нет). Лимит запросов на них действует: /health ходит в ML и
 *  базу — без лимита это рычаг нагрузки (R2 T-138, E1-M2); проверки изнутри контура идут с loopback и не ограничиваются. */
const EXEMPT = /^\/(?:health|metrics)(?:\?|$)/;

/** Адрес к одному виду: IPv4-mapped IPv6 → IPv4, IPv6 — в нижнем регистре. null — не адрес (R2 T-138, E1-L2). */
export function normalizeIp(raw: string): string | null {
  const v = raw.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const kind = isIP(v);
  return kind === 4 ? v : kind === 6 ? v.toLowerCase() : null;
}

export type IdsOptions = { rps: number; burst: number; now?: () => number };

export class IpGuard {
  private window: IdsWindow;
  private limiter: RateLimiter;
  private blocks = new Map<string, number>(); // адрес → конец блокировки, мс
  private loadedAt = -Infinity;
  private loading: Promise<void> | null = null;
  readonly counters = { events: new Map<Signal, number>(), blocks: 0, blocked: 0, limited: 0 };

  constructor(private db: DB, opts: IdsOptions) {
    const now = opts.now ?? Date.now;
    this.now = now;
    this.window = new IdsWindow(now);
    this.limiter = new RateLimiter(opts.rps, opts.burst, now);
  }
  private now: () => number;

  /** Кэш блокировок из базы: не чаще раза в BLOCKS_REFRESH_MS; параллельные запросы ждут одну загрузку. */
  private async refresh(force = false): Promise<void> {
    if (!force && this.now() - this.loadedAt < BLOCKS_REFRESH_MS) return;
    this.loading ??= (async () => {
      try {
        const rows = await this.db.all<{ ip: string; until: string | Date }>("select ip, until from ip_blocks where released_at is null and until > $1", [new Date(this.now()).toISOString()]);
        this.blocks = new Map(rows.map((r) => [r.ip, new Date(r.until).getTime()]));
        this.loadedAt = this.now();
      } finally {
        this.loading = null;
      }
    })();
    await this.loading;
  }

  /** До обработчика: заблокирован — 403; упёрся в лимит — 429. null — пропустить. */
  async gate(ip: string, url: string): Promise<{ status: 403 | 429; retryAfter: number; error: string } | null> {
    await this.refresh();
    const until = this.blocks.get(ip);
    if (until !== undefined && until > this.now()) {
      this.counters.blocked++;
      return { status: 403, retryAfter: Math.ceil((until - this.now()) / 1000), error: "Доступ с вашего адреса временно закрыт системой защиты. Обратитесь к администратору." };
    }
    const r = this.limiter.take(ip);
    if (!r.ok) {
      this.counters.limited++;
      return { status: 429, retryAfter: r.retryAfter, error: `Слишком много запросов. Повторите через ${r.retryAfter} с.` };
    }
    return null;
  }

  /** После ответа: признаки запроса в окно адреса; порог — блокировка. Возвращает решение, если оно принято. */
  async observe(req: { ip: string; url: string; ua?: string | null; status: number; site?: string | null }): Promise<BlockDecision | null> {
    if (EXEMPT.test(req.url)) return null;
    const sig = signals(req);
    for (const k of sig) this.counters.events.set(k, (this.counters.events.get(k) ?? 0) + 1);
    // Межсайтовый запрос (Sec-Fetch-Site: cross-site) — обнаружение без блокировки (R2 T-138, E1-M1): браузер жертвы по
    // <img src=".../.env"> с чужой страницы не должен закрывать доступ ей или офису за NAT. Заголовок может прислать и
    // сканер — поэтому признаки всё равно считаются в метриках (алерт InspectorIdsSignatures) и пишутся событием
    // безопасности, а сдерживают его лимиты API и nginx.
    if (req.site === "cross-site") {
      if (sig.length) log("WARNING", "ids cross-site signal", { ip: req.ip, kinds: sig, path: req.url.split("?")[0].slice(0, 256), security: true });
      return null;
    }
    const d = this.window.add(req.ip, sig);
    if (d) await this.block(d, req.url);
    return d;
  }

  private async block(d: BlockDecision, url: string): Promise<void> {
    const at = new Date(this.now());
    // n-я блокировка адреса — срок вдвое длиннее прежнего; строка на адрес, счётчик blocks растёт
    const prev = await this.db.get<{ blocks: number }>("select blocks from ip_blocks where ip = $1", [d.ip]);
    const n = (prev?.blocks ?? 0) + 1;
    const until = new Date(at.getTime() + blockDuration(n));
    await this.db.tx(async (t) => {
      await t.run(
        `insert into ip_blocks (ip, reason, score, events_json, blocks, blocked_at, until, released_at, released_by) values ($1,$2,$3,$4,$5,$6,$7,null,null)
         on conflict (ip) do update set reason = excluded.reason, score = excluded.score, events_json = excluded.events_json, blocks = excluded.blocks,
           blocked_at = excluded.blocked_at, until = excluded.until, released_at = null, released_by = null`,
        [d.ip, d.reason, d.score, JSON.stringify(d.events), n, at.toISOString(), until.toISOString()],
      );
      await t.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)", [
        null, "IDS_BLOCK", null, JSON.stringify({ reason: d.reason, score: d.score, events: d.events, until: until.toISOString(), block_no: n, last_path: url.split("?")[0].slice(0, 256), has_query: url.includes("?") }), at.toISOString(), d.ip, null,
      ]);
      await notify(t, "admin", null, "WARNING", `Система защиты закрыла доступ с адреса ${d.ip} до ${until.toISOString()} (${n}-я блокировка): ${d.reason}.`);
    });
    this.blocks.set(d.ip, until.getTime());
    this.counters.blocks++;
    log("WARNING", "ids block", { ip: d.ip, reason: d.reason, score: d.score, until: until.toISOString(), security: true });
  }

  /** Снять блокировку (администратор). false — активной блокировки нет. */
  async release(raw: string, by: { id: string; ip?: string | null; ua?: string | null }): Promise<boolean> {
    const ip = normalizeIp(raw);
    if (!ip) throw new Error(`не адрес: ${raw.slice(0, 64)}`);
    const at = new Date(this.now()).toISOString();
    const done = await this.db.tx(async (t) => {
      const r = await t.run("update ip_blocks set released_at = $1, released_by = $2 where ip = $3 and released_at is null and until > $1", [at, by.id, ip]);
      if (!r.rowCount) return false;
      await t.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)", [by.id, "IDS_UNBLOCK", null, JSON.stringify({ ip }), at, by.ip ?? null, by.ua ?? null]);
      return true;
    });
    if (done) {
      this.blocks.delete(ip);
      log("INFO", "ids unblock", { ip, user_id: by.id, security: true });
    }
    return done;
  }

  /** Строки экспозиции Prometheus. */
  lines(): string[] {
    const out = ["# HELP inspector_ids_events_total Признаки атак по видам (NFR-IDS)", "# TYPE inspector_ids_events_total counter"];
    for (const k of Object.keys(WEIGHTS) as Signal[]) out.push(`inspector_ids_events_total{kind="${k}"} ${this.counters.events.get(k) ?? 0}`);
    out.push(
      "# TYPE inspector_ids_blocks_total counter", `inspector_ids_blocks_total ${this.counters.blocks}`,
      "# TYPE inspector_ids_blocked_requests_total counter", `inspector_ids_blocked_requests_total ${this.counters.blocked}`,
      "# TYPE inspector_rate_limited_total counter", `inspector_rate_limited_total ${this.counters.limited}`,
    );
    return out;
  }
}
