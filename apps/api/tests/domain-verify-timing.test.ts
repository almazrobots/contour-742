// NFR-VERIFY-30 (ТЗ 9.3.6): замер цикла верификации по журналу аудита — L1 примеры, L3 границы, L5 свойство.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cycleOf, DEFAULT_IDLE_MINUTES, MIN_PARTICIPANTS, summarize, TARGET_MINUTES, type TimingEvent } from "../src/domain/verify-timing.ts";

const T0 = Date.parse("2026-09-25T09:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (sec: number, action: string, object_id: string | null = null, user_id = "u-1"): TimingEvent => ({ user_id, action, object_id, timestamp: at(sec) });

describe("L1 · цикл верификации одной проверки", () => {
  it("начало — открытие верификации, конец — финализация протокола; решения и кандидаты посчитаны", () => {
    const c = cycleOf([
      ev(0, "VERIFICATION_OPENED", "INS-1"),
      ev(60, "DECISION_CONFIRM", "c1"),
      ev(120, "DECISION_REJECT", "c2"),
      ev(180, "DECISION_CONFIRM", "c2"), // пересмотр того же кандидата — решение есть, кандидат тот же
      ev(200, "CANDIDATE_SPLIT", "c3"),
      ev(600, "PROTOCOL_FINALIZED", "INS-1"),
    ]);
    expect(c.start_source).toBe("VERIFICATION_OPENED");
    expect(c.completed).toBe(true);
    expect(c.user_id).toBe("u-1");
    expect(c.wall_minutes).toBe(10);
    expect(c.decisions).toBe(3);
    expect(c.candidates).toBe(2);
    expect(c.confirmed).toBe(2);
    expect(c.splits).toBe(1);
    expect(c.within_target).toBe(true);
  });

  it("повторное открытие страницы не сдвигает начало: считается первое открытие", () => {
    const c = cycleOf([ev(0, "VERIFICATION_OPENED"), ev(300, "VERIFICATION_OPENED"), ev(400, "DECISION_CONFIRM", "c1"), ev(500, "PROTOCOL_FINALIZED")]);
    expect(c.started_at).toBe(at(0));
  });

  it("решение раньше открытия экрана — началом становится решение, чтобы замер не занижал время", () => {
    const c = cycleOf([ev(300, "VERIFICATION_OPENED"), ev(100, "DECISION_CONFIRM", "c1"), ev(700, "PROTOCOL_FINALIZED")]);
    expect(c.start_source).toBe("FIRST_DECISION");
    expect(c.started_at).toBe(at(100));
    const same = cycleOf([ev(100, "VERIFICATION_OPENED"), ev(100, "DECISION_CONFIRM", "c1"), ev(700, "PROTOCOL_FINALIZED")]);
    expect(same.start_source).toBe("VERIFICATION_OPENED");
  });

  it("финализация раньше начала цикла (прошлая, до отмены) концом не считается", () => {
    const c = cycleOf([ev(0, "PROTOCOL_FINALIZED"), ev(100, "VERIFICATION_OPENED"), ev(400, "DECISION_CONFIRM", "c1"), ev(1300, "PROTOCOL_FINALIZED")]);
    expect(c.finished_at).toBe(at(1300));
    expect(c.wall_minutes).toBe(20);
  });

  it("без события открытия началом становится первое решение, источник помечен FIRST_DECISION", () => {
    const c = cycleOf([ev(100, "DECISION_CONFIRM", "c1"), ev(400, "DECISION_CLARIFY", "c2"), ev(700, "PROTOCOL_FINALIZED")]);
    expect(c.start_source).toBe("FIRST_DECISION");
    expect(c.started_at).toBe(at(100));
    expect(c.wall_minutes).toBe(10);
  });

  it("без финализации цикл незавершён: в цель не засчитывается и не отклоняется (within_target = null)", () => {
    const c = cycleOf([ev(0, "VERIFICATION_OPENED"), ev(60, "DECISION_CONFIRM", "c1")]);
    expect(c.completed).toBe(false);
    expect(c.finished_at).toBeNull();
    expect(c.within_target).toBeNull();
  });

  it("без открытия и без решений цикла нет — start_source = null", () => {
    const c = cycleOf([ev(0, "PROTOCOL_FINALIZED")]);
    expect(c.start_source).toBeNull();
    expect(c.completed).toBe(false);
    expect(c.decisions).toBe(0);
  });

  it("паузы длиннее порога простоя не входят в активное время", () => {
    // 0 → 5 мин (засчитано) → 45 мин (пауза 40 мин — нет) → 50 мин (засчитано)
    const c = cycleOf([ev(0, "VERIFICATION_OPENED"), ev(300, "DECISION_CONFIRM", "c1"), ev(2700, "DECISION_CONFIRM", "c2"), ev(3000, "PROTOCOL_FINALIZED")]);
    expect(c.wall_minutes).toBe(50);
    expect(c.active_minutes).toBe(10);
    expect(c.within_target).toBe(false);
  });

  it("события после финализации в цикл не входят", () => {
    const c = cycleOf([ev(0, "VERIFICATION_OPENED"), ev(60, "DECISION_CONFIRM", "c1"), ev(120, "PROTOCOL_FINALIZED"), ev(9000, "DECISION_CONFIRM", "c9")]);
    expect(c.decisions).toBe(1);
    expect(c.wall_minutes).toBe(2);
  });
});

describe("L3 · границы цели ТЗ и порога простоя", () => {
  it("ровно 30:00 — в цели", () => {
    expect(TARGET_MINUTES).toBe(30);
    expect(cycleOf([ev(0, "VERIFICATION_OPENED"), ev(1800, "PROTOCOL_FINALIZED")]).within_target).toBe(true);
  });
  it("30:01 — вне цели", () => {
    expect(cycleOf([ev(0, "VERIFICATION_OPENED"), ev(1801, "PROTOCOL_FINALIZED")]).within_target).toBe(false);
  });
  it("пауза ровно на пороге простоя засчитывается в активное время, на секунду длиннее — нет", () => {
    const idle = DEFAULT_IDLE_MINUTES * 60;
    expect(cycleOf([ev(0, "VERIFICATION_OPENED"), ev(idle, "PROTOCOL_FINALIZED")]).active_minutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(cycleOf([ev(0, "VERIFICATION_OPENED"), ev(idle + 1, "PROTOCOL_FINALIZED")]).active_minutes).toBe(0);
  });
  it("порог простоя — параметр", () => {
    expect(cycleOf([ev(0, "VERIFICATION_OPENED"), ev(300, "PROTOCOL_FINALIZED")], { idleMinutes: 4 }).active_minutes).toBe(0);
  });
});

describe("L1 · сводка по участникам", () => {
  const done = (user: string, sec: number) => cycleOf([ev(0, "VERIFICATION_OPENED", null, user), ev(sec, "PROTOCOL_FINALIZED", null, user)]);

  it("меньше пяти разных участников — вердикт «недостаточно участников», даже если все в цели", () => {
    const s = summarize([done("a", 600), done("b", 900), done("a", 1200)]);
    expect(s.participants).toBe(2);
    expect(s.enough_participants).toBe(false);
    expect(s.verdict).toBe("INSUFFICIENT_PARTICIPANTS");
  });

  it("пять участников и все циклы в цели — цель подтверждена; медиана и максимум по wall-clock", () => {
    const s = summarize(["a", "b", "c", "d", "e"].map((u, i) => done(u, 600 + i * 300)));
    expect(MIN_PARTICIPANTS).toBe(5);
    expect(s.enough_participants).toBe(true);
    expect(s.median_wall_minutes).toBe(20);
    expect(s.max_wall_minutes).toBe(30);
    expect(s.within_target_share).toBe(1);
    expect(s.verdict).toBe("CONFIRMED");
  });

  it("один цикл из пяти дольше 30 минут — цель не подтверждена, доля в цели 0,8", () => {
    const s = summarize([done("a", 600), done("b", 600), done("c", 600), done("d", 600), done("e", 1801)]);
    expect(s.within_target_share).toBe(0.8);
    expect(s.verdict).toBe("NOT_CONFIRMED");
  });

  it("незавершённые циклы не входят ни в участников, ни в медиану", () => {
    const open = cycleOf([ev(0, "VERIFICATION_OPENED", null, "z")]);
    const s = summarize([open, done("a", 600)]);
    expect(s.cycles_total).toBe(2);
    expect(s.cycles_completed).toBe(1);
    expect(s.participants).toBe(1);
    expect(s.median_wall_minutes).toBe(10);
  });

  it("медиана чётного числа циклов — среднее двух средних, вход не обязан быть упорядочен", () => {
    const s = summarize([done("d", 2400), done("a", 600), done("c", 1800), done("b", 1200)]);
    expect(s.median_wall_minutes).toBe(25);
    expect(s.max_wall_minutes).toBe(40);
  });

  it("пустой набор — медианы нет, вердикт «недостаточно участников»", () => {
    const s = summarize([]);
    expect(s.median_wall_minutes).toBeNull();
    expect(s.within_target_share).toBeNull();
    expect(s.verdict).toBe("INSUFFICIENT_PARTICIPANTS");
  });
});

describe("L5 · свойства замера на случайных журналах", () => {
  const ACTIONS = ["VERIFICATION_OPENED", "DECISION_CONFIRM", "DECISION_REJECT", "DECISION_CLARIFY", "CANDIDATE_SPLIT", "PROTOCOL_FINALIZED", "PROTOCOL_EXPORTED"];
  const journal = fc.array(fc.record({ sec: fc.integer({ min: 0, max: 20_000 }), action: fc.constantFrom(...ACTIONS), obj: fc.constantFrom("c1", "c2", "c3") }), { maxLength: 40 });

  it("активное время никогда не больше wall-clock и не меньше нуля, при любом пороге простоя", () => {
    fc.assert(
      fc.property(journal, fc.integer({ min: 0, max: 120 }), (js, idle) => {
        const c = cycleOf(js.map((j) => ev(j.sec, j.action, j.obj)), { idleMinutes: idle });
        if (c.wall_minutes === null) return c.active_minutes === null;
        return c.active_minutes! >= 0 && c.active_minutes! <= c.wall_minutes + 1e-9;
      }),
    );
  });

  it("порядок событий во входе не влияет на результат", () => {
    fc.assert(
      fc.property(journal, (js) => {
        const evs = js.map((j) => ev(j.sec, j.action, j.obj));
        expect(cycleOf([...evs].reverse())).toEqual(cycleOf(evs));
      }),
    );
  });
});
