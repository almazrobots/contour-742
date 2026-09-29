// L1/L3: уровень журнала ответа и признак безопасности — границы кодов 399/400/401/403/404/428/429/430/499/500.
import { describe, expect, it } from "vitest";
import { responseLog } from "../src/domain/access-log.ts";

describe("журнал ответа: уровень и признак безопасности (ТЗ 13.2, 13.3)", () => {
  it("401, 403, 429 — WARNING с признаком security; прочие 4xx и 2xx — INFO; 5xx — ERROR без признака", () => {
    const at = (s: number) => [responseLog(s).level, responseLog(s).security];
    expect([200, 399, 400, 404, 428, 430, 499].map(at)).toEqual(Array(7).fill(["INFO", false]));
    expect([401, 403, 429].map(at)).toEqual(Array(3).fill(["WARNING", true]));
    expect([500, 503].map(at)).toEqual(Array(2).fill(["ERROR", false]));
  });
});
