// T-037: согласованные изменения (OS-INSP-1.5.1, 3.1.9). Имя теста — ссылка трассы.
import { describe, expect, it } from "vitest";
import { ApprovedChangeInput, changesFor, type ApprovedChange } from "../src/domain/changes.ts";
import { evidenceCard, type CheckRow } from "../src/domain/protocol.ts";

const change = (id: number, number: string, date: string, param_codes: string[]): ApprovedChange => ({
  id, inspection_id: "P-1", object_id: "OBJ-1", number, date, param_codes, basis_file_id: `f-${id}`, basis_file_name: `изм-${id}.pdf`,
  description: `Изменение ${number}`, created_by: "u-insp", created_at: "2026-09-24T00:00:00Z",
});

const row = (over: Partial<CheckRow> = {}): CheckRow => ({
  id: "F-1", param_code: "M-041", parameter_name: "Ширина эвакуационного выхода", section: "ППМ", unit: "м", evidence_group_id: "g",
  finding_status: "CANDIDATE", verification_status: "PENDING", expected_value: "1.2", actual_value: "0.85", delta: "-0.35", review_priority: "HIGH",
  reason: "r", parent_id: null, title: null, decision: null,
  fragments: [{ file_id: "f", sha256: "a".repeat(64), stage: "RD", document_code: "Р-АР", revision: "B", approval_status: "FOR_CONSTRUCTION", sheet_page: 2, bbox_polygon_norm: "[0,0,1,1]", extracted_value: "0.85", role_expected_actual: "actual" }],
  ...over,
});

describe("OS-INSP-1.5.1 согласованное изменение хранится с номером, датой, параметрами и основанием", () => {
  it("ввод: номер, дата ГГГГ-ММ-ДД и хотя бы один параметр обязательны; основание и описание — нет", () => {
    expect(ApprovedChangeInput.parse({ number: " ИЗМ-3 ", date: "2025-08-01", param_codes: ["M-041"] })).toEqual({ number: "ИЗМ-3", date: "2025-08-01", param_codes: ["M-041"], description: "" });
    expect(ApprovedChangeInput.safeParse({ number: "ИЗМ-3", date: "01.08.2025", param_codes: ["M-041"] }).success).toBe(false);
    expect(ApprovedChangeInput.safeParse({ number: "ИЗМ-3", date: "2025-08-01", param_codes: [] }).success).toBe(false);
    expect(ApprovedChangeInput.safeParse({ number: "", date: "2025-08-01", param_codes: ["M-041"] }).success).toBe(false);
  });
});

describe("OS-INSP-3.1.9 согласованное изменение прикладывается к карточке кандидата", () => {
  const all = [change(1, "ИЗМ-1", "2025-06-01", ["M-041", "M-040"]), change(2, "ИЗМ-2", "2025-09-01", ["m-041 "]), change(3, "ИЗМ-3", "2025-07-01", ["M-055"])];

  it("по коду параметра без учёта регистра и пробелов, новые сверху", () => {
    expect(changesFor("M-041", all).map((c) => c.number)).toEqual(["ИЗМ-2", "ИЗМ-1"]);
    expect(changesFor("M-002", all)).toEqual([]);
  });

  it("карточка содержит номер, дату, параметры, основание и описание; без изменений — пустой список", () => {
    const card = evidenceCard(row({ approved_changes: changesFor("M-041", all) }));
    expect(card.approved_changes[0]).toEqual({ number: "ИЗМ-2", date: "2025-09-01", param_codes: ["m-041 "], basis_file_id: "f-2", basis_file_name: "изм-2.pdf", description: "Изменение ИЗМ-2" });
    expect(card.approved_changes).toHaveLength(2);
    expect(evidenceCard(row()).approved_changes).toEqual([]);
  });

  it("карточка: страница источника из части документа — сквозная, страница файла части сохранена", () => {
    const f = { ...row().fragments[0], part_index: 2, page_offset: 3 };
    expect(evidenceCard(row({ fragments: [f] })).sources[0]).toMatchObject({ page: 5, page_in_file: 2, part_index: 2 });
    expect(evidenceCard(row()).sources[0]).toMatchObject({ page: 2, page_in_file: 2, part_index: null });
  });
});
