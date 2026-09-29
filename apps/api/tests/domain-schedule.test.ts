// OS-INSP-6.2.2: расписание еженедельного отчёта.
import { describe, expect, it } from "vitest";
import { duePeriod, reportDue, weekStart } from "../src/domain/schedule.ts";

describe("еженедельный отчёт (OS-INSP-6.2.2)", () => {
  it("неделя ISO начинается в понедельник 00:00 UTC — с любого дня недели", () => {
    for (const d of ["2026-09-21T00:00:00Z", "2026-09-23T13:45:00Z", "2026-09-27T23:59:59Z"]) expect(weekStart(new Date(d)).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(weekStart(new Date("2026-09-20T23:59:59Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
  it("период — последняя закончившаяся неделя, ровно 7 суток, в том числе через границу месяца и года", () => {
    expect(duePeriod(new Date("2026-09-25T10:00:00Z"))).toEqual({ since: "2026-09-14T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" });
    expect(duePeriod(new Date("2027-01-01T10:00:00Z"))).toEqual({ since: "2026-12-21T00:00:00.000Z", until: "2026-12-28T00:00:00.000Z" });
  });
  it("отчёт за неделю строится один раз; новая неделя — новый отчёт", () => {
    const now = new Date("2026-09-25T10:00:00Z");
    const p = reportDue(now, [])!;
    expect(p.until).toBe("2026-09-21T00:00:00.000Z");
    expect(reportDue(now, [p.until])).toBeNull();
    expect(reportDue(new Date("2026-09-28T00:00:00Z"), [p.until])!.until).toBe("2026-09-28T00:00:00.000Z");
  });
  it("простой в несколько недель — догоняется последняя неделя, а не пустой период", () => {
    const p = reportDue(new Date("2026-10-20T08:00:00Z"), ["2026-09-21T00:00:00.000Z"])!;
    expect(p).toEqual({ since: "2026-10-12T00:00:00.000Z", until: "2026-10-19T00:00:00.000Z" });
  });
});

describe("запуск по расписанию на БД (OS-INSP-6.2.2)", async () => {
  const { openDb } = await import("../src/db.ts");
  const { runWeeklyReportIfDue } = await import("../src/services/report.ts");
  // отклонение, как в decideIn: решение и запись журнала отклонений (T-234: отчёт считает отклонения по Rejection_Log)
  const dec = async (db: any, at: string, action: string, reason: string | null) => {
    await db.run("insert into decisions (check_id, user_id, action, status, reason_code, comment, created_at) values ('F-1','u',$1, $2, $3, 'c', $4)", [action, action === "reject" ? "NEGATIVE_VERIFIED" : "CONFIRMED_VIOLATION", reason, at]);
    if (action === "reject") await db.run("insert into rejection_log (check_id, inspection_id, param_code, ai_verdict, reason_code, comment, suggested_fix, user_id, created_at) values ('F-1','P','M-001','CANDIDATE',$1,'c','',$2,$3)", [reason, "u", at]);
  };

  it("строит отчёт за прошедшую неделю один раз; границы периода — [since; until)", async () => {
    const db = await openDb("memory");
    await dec(db, "2026-09-13T23:59:59.000Z", "reject", "OCR_ERROR"); // до периода
    await dec(db, "2026-09-14T00:00:00.000Z", "reject", "OCR_ERROR"); // первая секунда периода
    await dec(db, "2026-09-20T23:59:59.000Z", "reject", "BINDING_ERROR");
    await dec(db, "2026-09-21T00:00:00.000Z", "reject", "OCR_ERROR"); // уже следующая неделя
    await dec(db, "2026-09-15T10:00:00.000Z", "confirm", null);
    const now = new Date("2026-09-25T10:00:00Z");
    expect(await runWeeklyReportIfDue(db, now)).toEqual({ since: "2026-09-14T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" });
    expect(await runWeeklyReportIfDue(db, now)).toBeNull();
    const rows = (await db.all("select * from retraining_reports")) as any[];
    expect(rows).toHaveLength(1);
    const body = JSON.parse(rows[0].body_json);
    // OCR_ERROR до периода и в следующей неделе не считаются: в периоде по одному отклонению каждой причины
    expect(body.by_reason.map((r: any) => [r.reason_code, r.n]).sort()).toEqual([["BINDING_ERROR", 1], ["OCR_ERROR", 1]]);
    expect(body.by_reason.map((r: any) => r.recommendation.length > 0)).toEqual([true, true]);
    expect(body.totals).toEqual(expect.arrayContaining([{ action: "confirm", n: 1 }, { action: "reject", n: 2 }]));
    const aud = (await db.all("select action, object_id from audit_log where action = 'RETRAINING_REPORT_BUILT'")) as any[];
    expect(aud).toEqual([{ action: "RETRAINING_REPORT_BUILT", object_id: "2026-09-21T00:00:00.000Z" }]);
    await db.close();
  });

  it("параллельные тики за одну неделю: отчёт и запись аудита — ровно по одной (on conflict … returning)", async () => {
    const db = await openDb("memory");
    await dec(db, "2026-09-15T10:00:00.000Z", "reject", "OCR_ERROR");
    const now = new Date("2026-09-25T10:00:00Z");
    const out = await Promise.all([1, 2, 3].map(() => runWeeklyReportIfDue(db, now)));
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(await db.get("select count(*) n from retraining_reports")).toEqual({ n: 1 });
    expect(await db.get("select count(*) n from audit_log where action = 'RETRAINING_REPORT_BUILT'")).toEqual({ n: 1 });
    await db.close();
  });
});
