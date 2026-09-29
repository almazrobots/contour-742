// OS-INSP-4.1.26–4.1.28 (T-139, ТЗ 12.2, OWASP-аудит M1, M2): матрица прав ролей — чистые функции (L1, L6).
import { describe, expect, it } from "vitest";
import { allowed, auditForRole, CAPABILITIES, type Capability } from "../src/domain/access.ts";

const ROLES = ["inspector", "supervisor", "admin", "ml_engineer", "curator"] as const;
const can = (cap: Capability) => ROLES.filter((r) => allowed(r, cap));

describe("права ролей", () => {
  it("работу с проверкой ведут только инспектор и супервизор — администратор решений не выносит", () => {
    expect(can("inspection.work")).toEqual(["inspector", "supervisor"]);
  });
  it("проверки видят инспектор, супервизор и администратор; ML-инженеру и куратору они закрыты", () => {
    expect(can("inspection.read")).toEqual(["inspector", "supervisor", "admin"]);
  });
  it("журналы отклонений и споров открыты ML-инженеру и куратору, инспектору — нет", () => {
    expect(can("feedback.read")).toEqual(["supervisor", "admin", "ml_engineer", "curator"]);
  });
  it("отмена финализации — супервизор или администратор (OS-INSP-4.4.1)", () => {
    expect(can("inspection.unfinalize")).toEqual(["supervisor", "admin"]);
  });
  it("Матрица, нормативы и правила — только администратор (ТЗ 12.2)", () => {
    expect(can("matrix.edit")).toEqual(["admin"]);
  });
  it("журнал аудита с сетевыми следами — супервизор и администратор", () => {
    expect(can("audit.read")).toEqual(["supervisor", "admin"]);
  });
  it("данные дообучения: читают ML-инженер, куратор, администратор; GOLD выпускает куратор, обучает ML-инженер", () => {
    expect(can("ml.read")).toEqual(["admin", "ml_engineer", "curator"].sort((a, b) => ROLES.indexOf(a as any) - ROLES.indexOf(b as any)));
    expect(can("ml.gold.release")).toEqual(["admin", "curator"]);
    expect(can("ml.train")).toEqual(["admin", "ml_engineer"]);
    expect(can("param.verify")).toEqual(["ml_engineer"]);
  });
  it("у каждой роли есть хотя бы одно право, у каждого права — хотя бы одна роль", () => {
    for (const r of ROLES) expect(Object.keys(CAPABILITIES).some((c) => allowed(r, c as Capability))).toBe(true);
    for (const c of Object.keys(CAPABILITIES)) expect(can(c as Capability).length).toBeGreaterThan(0);
  });
  it("служебная роль system, пустая и неизвестная роль прав не имеют", () => {
    for (const r of ["system", "", undefined, "root", "constructor"]) for (const c of Object.keys(CAPABILITIES)) expect(allowed(r, c as Capability)).toBe(false);
  });
  it("неизвестное право и имя из прототипа — нет ни у кого", () => {
    for (const r of ROLES) for (const c of ["constructor", "toString", "__proto__", "admin"]) expect(allowed(r, c as Capability)).toBe(false);
  });
});

describe("аудит в карточке", () => {
  const row = { id: 1, action: "DECISION_CONFIRM", user_name: "Иванов", ip_address: "10.0.0.7", user_agent: "Firefox" };
  it.each(["supervisor", "admin"])("%s видит IP и User-Agent", (role) => {
    expect(auditForRole(role, row)).toEqual(row);
  });
  it.each(["inspector", "ml_engineer", "curator", undefined])("%s видит запись без IP и User-Agent", (role) => {
    expect(auditForRole(role, row)).toEqual({ id: 1, action: "DECISION_CONFIRM", user_name: "Иванов" });
  });
});
