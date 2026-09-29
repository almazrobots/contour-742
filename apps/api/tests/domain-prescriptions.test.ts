// T-070: статусы предписаний по данным ИАИС «РиН» (OS-INSP-5.4, ТЗ §9.6.4). Имя теста — ссылка трассы.
// L1 — чистые функции, L3 — границы дат и ключа, L5 — свойства на fast-check.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  currentStatus, normalizeEventAt, parsePrescriptionMessage, PRESCRIPTION_STATUSES, PrescriptionMessageError, rinKeyVerdict,
  type PrescriptionEvent,
} from "../src/domain/prescriptions.ts";

const msg = (over: Record<string, unknown> = {}) => ({ prescription_id: "PR-1", process_id: "P-1", status: "ISSUED", event_at: "2026-09-01T10:00:00Z", ...over });
const ev = (status: string, event_at: string, seq: number): PrescriptionEvent => ({ status: status as PrescriptionEvent["status"], event_at, seq });

describe("OS-INSP-5.4.1 принимаются только статусы из перечня ТЗ", () => {
  it("статус вне перечня ISSUED, IN_PROGRESS, COMPLETED, CANCELLED, EXTENDED отклоняется с перечнем допустимых", () => {
    expect(PRESCRIPTION_STATUSES).toEqual(["ISSUED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXTENDED"]);
    for (const s of PRESCRIPTION_STATUSES) expect(parsePrescriptionMessage(msg({ status: s })).status).toBe(s);
    for (const bad of ["DONE", "issued", " ISSUED", "", null, 1, undefined]) {
      let e: unknown;
      try {
        parsePrescriptionMessage(msg({ status: bad }));
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(PrescriptionMessageError);
      expect((e as PrescriptionMessageError).field).toBe("status");
      expect((e as PrescriptionMessageError).allowed).toEqual([...PRESCRIPTION_STATUSES]);
      expect((e as Error).message).toContain("ISSUED, IN_PROGRESS, COMPLETED, CANCELLED, EXTENDED");
    }
  });

  it("сообщение без идентификаторов, не объект или с лишней длиной идентификатора отклоняется", () => {
    for (const raw of [null, undefined, "строка", 42, []]) expect(() => parsePrescriptionMessage(raw)).toThrow(PrescriptionMessageError);
    for (const f of ["prescription_id", "process_id"]) {
      for (const v of [undefined, "", "   ", 5, "x".repeat(201)]) {
        try {
          parsePrescriptionMessage(msg({ [f]: v }));
          expect.unreachable();
        } catch (e) {
          expect((e as PrescriptionMessageError).field).toBe(f);
          expect((e as PrescriptionMessageError).allowed).toBeUndefined();
        }
      }
    }
    expect(parsePrescriptionMessage(msg({ prescription_id: " PR-7 ", process_id: "x".repeat(200) }))).toEqual({
      prescription_id: "PR-7", process_id: "x".repeat(200), status: "ISSUED", event_at: "2026-09-01T10:00:00.000Z",
    });
  });

  it("дата события — ISO 8601 с часовым поясом или календарная дата; несуществующие и без пояса отклоняются", () => {
    expect(normalizeEventAt("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
    expect(normalizeEventAt("2026-09-01T10:00Z")).toBe("2026-09-01T10:00:00.000Z");
    expect(normalizeEventAt("2026-09-01T13:00:00+03:00")).toBe("2026-09-01T10:00:00.000Z");
    expect(normalizeEventAt("2026-09-01T10:00:00.5-01:30")).toBe("2026-09-01T11:30:00.500Z");
    expect(normalizeEventAt("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
    expect(normalizeEventAt("2026-12-31T23:59:59Z")).toBe("2026-12-31T23:59:59.000Z");
    for (const bad of ["2025-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-09-00", "2026-09-01T24:00:00Z", "2026-09-01T10:60Z",
      "2026-09-01T10:00:60Z", "2026-09-01T10:00:00", "01.09.2026", "2026-9-1", "", "2026-09-01T10:00:00+24:00", " 2026-09-01", "0999-01-01"]) {
      expect(normalizeEventAt(bad), bad).toBeNull();
    }
    expect(normalizeEventAt(20260901 as unknown)).toBeNull();
    try {
      parsePrescriptionMessage(msg({ event_at: "01.09.2026" }));
      expect.unreachable();
    } catch (e) {
      expect((e as PrescriptionMessageError).field).toBe("event_at");
    }
  });
});

describe("OS-INSP-5.4.3 текущий статус — по самой поздней дате события в «РиН»", () => {
  it("текущим считается статус с самой поздней датой события, а не последний пришедший", () => {
    const events = [ev("ISSUED", "2026-09-01T00:00:00.000Z", 1), ev("COMPLETED", "2026-09-10T00:00:00.000Z", 2), ev("IN_PROGRESS", "2026-09-05T00:00:00.000Z", 3)];
    expect(currentStatus(events)).toEqual(events[1]);
    expect(currentStatus([])).toBeNull();
  });

  it("при равной дате события текущим становится пришедший позже", () => {
    const a = ev("COMPLETED", "2026-09-10T00:00:00.000Z", 1);
    const b = ev("CANCELLED", "2026-09-10T00:00:00.000Z", 2);
    expect(currentStatus([a, b])).toBe(b);
    expect(currentStatus([b, a])).toBe(b);
    // миллисекунда решает: более поздняя дата выигрывает у пришедшего позже
    expect(currentStatus([ev("EXTENDED", "2026-09-10T00:00:00.001Z", 1), b])?.status).toBe("EXTENDED");
  });

  it("текущий статус не зависит от порядка прихода сообщений", () => {
    const status = fc.constantFrom(...PRESCRIPTION_STATUSES);
    const at = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) });
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(status, at), { minLength: 1, maxLength: 12, selector: (t) => t[1] }), fc.nat(), (pairs, seed) => {
        const inOrder = pairs.map(([s, t], i) => ev(s, new Date(t).toISOString(), i));
        const shuffled = [...inOrder].sort((x, y) => ((x.seq * 7919 + seed) % 97) - ((y.seq * 7919 + seed) % 97))
          .map((e, i) => ({ ...e, seq: i }));
        const latest = inOrder.reduce((m, e) => (e.event_at > m.event_at ? e : m));
        expect(currentStatus(inOrder)?.status).toBe(latest.status);
        expect(currentStatus(shuffled)?.status).toBe(latest.status);
        expect(currentStatus(shuffled)?.event_at).toBe(latest.event_at);
      }),
    );
  });
});

describe("OS-INSP-5.4.4 повтор сообщения распознаётся по ключу предписание+статус+дата", () => {
  it("один и тот же момент в разных часовых поясах даёт одну дату события — повтор ловит уникальный ключ базы", () => {
    const m = parsePrescriptionMessage(msg());
    const same = parsePrescriptionMessage(msg({ event_at: "2026-09-01T13:00:00+03:00", process_id: "P-2" }));
    expect(same.event_at).toBe(m.event_at);
    expect(parsePrescriptionMessage(msg({ event_at: "2026-09-01T10:00:00.001Z" })).event_at).not.toBe(m.event_at);
  });

  it("повтор сообщений не меняет текущий статус", () => {
    const status = fc.constantFrom(...PRESCRIPTION_STATUSES);
    const at = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) });
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(status, at), { minLength: 1, maxLength: 8, selector: (t) => t[1] }), (pairs) => {
        const once = pairs.map(([s, t], i) => ev(s, new Date(t).toISOString(), i));
        const twice = [...once, ...once.map((e, i) => ({ ...e, seq: once.length + i }))];
        expect(currentStatus(twice)?.status).toBe(currentStatus(once)?.status);
      }),
    );
  });
});

describe("OS-INSP-5.4.6 ключ интеграции «РиН»", () => {
  it("без настроенного ключа — 503, без ключа или с неверным — 401, с верным — пропуск", () => {
    expect(rinKeyVerdict(undefined, "k")).toEqual({ ok: false, status: 503, error: "Интеграция с ИАИС «РиН» не настроена" });
    expect(rinKeyVerdict("", "")).toMatchObject({ ok: false, status: 503 });
    expect(rinKeyVerdict("secret-key", undefined)).toMatchObject({ ok: false, status: 401 });
    expect(rinKeyVerdict("secret-key", "")).toMatchObject({ ok: false, status: 401 });
    expect(rinKeyVerdict("secret-key", "secret-kez")).toMatchObject({ ok: false, status: 401 });
    expect(rinKeyVerdict("secret-key", "secret-key ")).toMatchObject({ ok: false, status: 401 });
    expect(rinKeyVerdict("secret-key", ["secret-key", "secret-key"])).toMatchObject({ ok: false, status: 401 });
    expect(rinKeyVerdict("secret-key", "secret-key")).toEqual({ ok: true });
  });
});
