// Эшелоны: L1 (сокращение ключа), L3 (граница 512 байт, кириллица по 2 байта), L2 (детерминизм и различимость).
// T-233: ключ конфликта на томе в сотни страниц превышал предел строки btree PostgreSQL (2704 байта) — файл уходил в FAILED.
import { describe, expect, it } from "vitest";
import { boundedDedupKey, DEDUP_KEY_MAX_BYTES } from "../src/domain/suspicions.ts";

const long = (tail: string) => `M-023:class-conflict:PD:${Array.from({ length: 400 }, (_, i) => `f${i}@${i + 1}:С${i % 4}`).join("|")}${tail}`;

describe("boundedDedupKey — ключ дедупликации помещается в индекс", () => {
  it("короткий ключ не меняется", () => {
    expect(boundedDedupKey("M-023:class-conflict:PD:a@1:С0")).toBe("M-023:class-conflict:PD:a@1:С0");
  });
  it("граница: ровно предел — без изменений, на байт больше — сокращается", () => {
    expect(boundedDedupKey("x".repeat(DEDUP_KEY_MAX_BYTES))).toHaveLength(DEDUP_KEY_MAX_BYTES);
    expect(boundedDedupKey("x".repeat(DEDUP_KEY_MAX_BYTES + 1))).not.toHaveLength(DEDUP_KEY_MAX_BYTES + 1);
  });
  it("длинный ключ (кириллица — 2 байта на знак) укладывается с большим запасом под предел btree 2704", () => {
    const k = boundedDedupKey("М-023:" + "конфликт".repeat(500));
    expect(Buffer.byteLength(k, "utf8")).toBeLessThan(1000);
  });
  it("сохраняет код параметра в начале: по нему читается split_part(dedup_key, ':', 1)", () => {
    expect(boundedDedupKey(long("")).split(":")[0]).toBe("M-023");
  });
  it("тот же ключ — тот же результат; ключи, различные только в хвосте, остаются различными", () => {
    expect(boundedDedupKey(long("a"))).toBe(boundedDedupKey(long("a")));
    expect(boundedDedupKey(long("a"))).not.toBe(boundedDedupKey(long("b")));
  });
});
