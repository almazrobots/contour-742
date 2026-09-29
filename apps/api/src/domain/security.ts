// Защита входа и выборок (OWASP-аудит слоя данных 2026-09-26: HIGH-3, M-2, M-3, M-6). Чистые функции без IO.
import { createHash } from "node:crypto";
import { z } from "zod";

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * HIGH-3: в sessions хранится не токен, а его SHA-256 (hex). Соль не нужна — у токена 192 бита случайности,
 * перебор по хешу бессмыслен; дамп или реплика базы больше не дают готовый Bearer.
 */
export function tokenHash(token: string): string {
  return sha256hex(token);
}

/**
 * M-6: что писать в LOGIN_FAILED. Существующий логин — как есть (он и так в users). Несуществующий — только
 * префикс хеша: в поле логина регулярно вводят пароль, а он не должен лечь в журнал открытым текстом.
 * Префикс позволяет связать серию попыток с одним вводом, не раскрывая его.
 */
export function failedLoginDetails(login: string, known: boolean): { login: string } | { login_sha256: string; known: false } {
  const clipped = String(login).slice(0, 100);
  return known ? { login: clipped } : { login_sha256: sha256hex(clipped).slice(0, 16), known: false };
}

/**
 * M-3: есть ли символ NUL в строке или в любой строке/ключе вложенных объектов и массивов. PostgreSQL не хранит
 * \u0000 в text/json (22021) — такой ввод отбивается 400 до базы и до аутентификации.
 * Обход — явным стеком, а не рекурсией: глубоко вложенное тело не роняет процесс переполнением стека.
 */
export function hasNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\u0000")) return true;
    } else if (v !== null && typeof v === "object") {
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) stack.push(...v);
      else if (!Buffer.isBuffer(v)) {
        for (const [k, x] of Object.entries(v)) {
          if (k.includes("\u0000")) return true;
          stack.push(x);
        }
      }
    }
  }
  return false;
}

/** M-2: потолок строк одной страницы любой списочной выдачи API. */
export const PAGE_MAX = 500;

/**
 * M-2: limit/offset списочных маршрутов из строки запроса. Умолчание — по маршруту (не меньше текущих объёмов,
 * на которые рассчитан интерфейс), потолок — PAGE_MAX. Прочие ключи строки запроса не трогает.
 */
export function pageQuery(defaultLimit: number) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(Math.min(defaultLimit, PAGE_MAX)),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  });
}
export type PageQuery = { limit: number; offset: number };
