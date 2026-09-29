// OS-INSP-5.1.2, 5.2.4 — ПП Москвы № 2078-ПП, разд. 9(1) (ред. № 1318-ПП): запись о применении ИИ-средства для акта.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aiUsageRecord, canonical, LEGAL_BASIS, type UsageInput } from "../src/domain/ai-usage.ts";
import { rinPayload } from "../src/services/rin.ts";

const input = (o: Partial<UsageInput> = {}): UsageInput => ({
  process_id: "P-1",
  object_name: "ЖК Северный",
  generated_at: "2026-09-26T10:00:00.000Z",
  versions: { protocol: 3, matrix: "1.1.0", model: "dev-anchors-0.1", dataset: "gold-2026-09", input_manifest_hash: "m".repeat(64) },
  files: [
    { file_id: "f1", file_name: "pz.pdf", sha256: "a".repeat(64), engine: "pdfium", parse_status: "DONE" },
    { file_id: "f2", file_name: "scan.pdf", sha256: "b".repeat(64), engine: "pdfium+tesseract", parse_status: "DONE" },
  ],
  checks: [
    { param_code: "M-055", parameter_name: "Класс бетона", finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION", expected_value: "B30", actual_value: "B25",
      fragments: [{ file_id: "f1", sha256: "a".repeat(64), sheet_page: 2, bbox_polygon_norm: "[0.1,0.2,0.3,0.25]", extracted_value: "B30" }] },
    { param_code: "M-002", parameter_name: "Общая площадь", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", expected_value: "12 450", actual_value: "12 450", fragments: [] },
  ],
  protocol_body: { process_id: "P-1", sections: { x: 1 } },
  ...o,
});

describe("запись о применении ИИ-средства (2078-ПП п. 9(1).8)", () => {
  it("факт применения, категория по прил. 2 п. 2, версии, дата и основание — дословно", () => {
    const r = aiUsageRecord(input());
    expect(r.legal_basis).toBe(LEGAL_BASIS);
    expect(r.legal_basis).toContain("№ 1318-ПП");
    expect(r.tool).toEqual({ name: "Инспектор ИИ", category: "Программный продукт на основе моделей машинного обучения (прил. 2, п. 2 к Положению)", model_version: "dev-anchors-0.1", matrix_version: "1.1.0", dataset_version: "gold-2026-09" });
    expect(r.applied_at).toBe("2026-09-26T10:00:00.000Z");
  });
  it("перечень полученных данных: каждая запись с результатом системы, решением инспектора и источниками (файл, SHA-256, страница, bbox)", () => {
    const r = aiUsageRecord(input());
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toEqual({
      param_code: "M-055", parameter_name: "Класс бетона", system_result: "кандидат в нарушение", inspector_decision: "подтверждено инспектором", expected: "B30", actual: "B25",
      sources: [{ file_name: "pz.pdf", sha256: "a".repeat(64), page: 2, bbox: [0.1, 0.2, 0.3, 0.25], value: "B30" }],
    });
    expect(r.data[1]).toMatchObject({ system_result: "расхождение не выявлено", inspector_decision: "решение инспектора не принято" });
  });
  it("приложение проверяемо (п. 9(1).3.3): SHA-256 канонического JSON протокола, от порядка ключей не зависит", () => {
    const r = aiUsageRecord(input());
    expect(r.attachments[0].sha256).toBe(createHash("sha256").update(canonical({ process_id: "P-1", sections: { x: 1 } })).digest("hex"));
    expect(aiUsageRecord(input({ protocol_body: { sections: { x: 1 }, process_id: "P-1" } })).attachments[0].sha256).toBe(r.attachments[0].sha256);
    expect(aiUsageRecord(input({ protocol_body: { process_id: "P-1", sections: { x: 2 } } })).attachments[0].sha256).not.toBe(r.attachments[0].sha256);
  });
  it("исправность (п. 9(1).5): все файлы обработаны — «исправно» с движками; сбой разбора — назван файл, данные по нему не получены", () => {
    const ok = aiUsageRecord(input());
    expect(ok.serviceability).toEqual({ ok: true, engines: ["pdfium", "pdfium+tesseract"], files_total: 2, files_failed: [] });
    expect(ok.act_text).toContain("Средство исправно: все 2 файлов комплекта обработаны (pdfium, pdfium+tesseract).");
    const bad = aiUsageRecord(input({ files: [{ file_id: "f1", file_name: "pz.pdf", sha256: "a".repeat(64), engine: null, parse_status: "FAILED" }] }));
    expect(bad.serviceability.ok).toBe(false);
    expect(bad.act_text).toContain("не обработаны файлы pz.pdf");
  });
  it("текст для акта: объект, основание, версии, счётчики, приложение с хешем", () => {
    const t = aiUsageRecord(input()).act_text;
    expect(t).toContain("по объекту «ЖК Северный» применено программное средство «Инспектор ИИ»");
    expect(t).toContain("Версия модели: dev-anchors-0.1; версия Матрицы контроля: 1.1.0");
    expect(t).toContain("проверено параметров Матрицы — 2; данные с источником (файл, страница, координаты) получены по 1, по 1 значение в комплекте не найдено; кандидатов в нарушения — 1, подтверждено инспектором — 1.");
    expect(t).toMatch(/Прилагается: Протокол проверки P-1, версия 3 \(JSON\), SHA-256 [0-9a-f]{64}\./);
  });
});

describe("выгрузка в ИАИС «РиН» (п. 9(1).10)", () => {
  it("запись о применении ИИ передаётся вместе с подтверждёнными нарушениями; без неё — null, а не пропуск поля", () => {
    const body = { process_id: "P-1", object: {}, protocol_version: 3, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: aiUsageRecord(input()) };
    expect(rinPayload(body).ai_usage!.tool.name).toBe("Инспектор ИИ");
    expect(rinPayload({ ...body, ai_usage: undefined }).ai_usage).toBeNull();
  });
});

describe("ограничения безопасности записи (ревью коммита T-079)", () => {
  it("в «РиН» — только подтверждённые инспектором записи (OS-INSP-5.2.1), в акте — все", () => {
    const rec = aiUsageRecord(input());
    expect(rec.data.map((d) => d.param_code)).toEqual(["M-055", "M-002"]);
    const body = { process_id: "P-1", object: {}, protocol_version: 3, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: rec };
    expect(rinPayload(body).ai_usage!.data.map((d) => d.param_code)).toEqual(["M-055"]);
  });
  it("файл ещё разбирается — средство не считается исправным (п. 9(1).5)", () => {
    for (const st of ["PENDING", "PARSING", null]) {
      const r = aiUsageRecord(input({ files: [{ file_id: "f1", file_name: "pz.pdf", sha256: "a".repeat(64), engine: null, parse_status: st }] }));
      expect([st, r.serviceability.ok]).toEqual([st, false]);
    }
  });
});

describe("запись о применении ИИ — края", () => {
  it("канонический JSON: порядок элементов массива значим, вложенные массивы и объекты сериализуются", () => {
    expect(canonical({ b: [2, { d: 1, c: [3] }], a: null })).toBe('{"a":null,"b":[2,{"c":[3],"d":1}]}');
    const h = (b: unknown) => aiUsageRecord(input({ protocol_body: b })).attachments[0].sha256;
    expect(h({ x: [1, 2] })).not.toBe(h({ x: [2, 1] }));
  });
  it("движки — без повторов и пустых, по алфавиту; источник не из реестра — показан file_id", () => {
    const r = aiUsageRecord(input({
      files: [
        { file_id: "f1", file_name: "a.pdf", sha256: "a".repeat(64), engine: "tesseract", parse_status: "DONE" },
        { file_id: "f2", file_name: "b.pdf", sha256: "b".repeat(64), engine: "pdfium", parse_status: "DONE" },
        { file_id: "f3", file_name: "c.pdf", sha256: "c".repeat(64), engine: "pdfium", parse_status: "DONE" },
        { file_id: "f4", file_name: "d.xml", sha256: "d".repeat(64), engine: null, parse_status: "DONE" },
      ],
      checks: [{ param_code: "M-1", parameter_name: "X", finding_status: "CANDIDATE", verification_status: "PENDING", expected_value: null, actual_value: null,
        fragments: [{ file_id: "gone", sha256: "e".repeat(64), sheet_page: null, bbox_polygon_norm: null, extracted_value: null }] }],
    }));
    expect(r.serviceability.engines).toEqual(["pdfium", "tesseract"]);
    expect(r.data[0].sources[0]).toMatchObject({ file_name: "gone", bbox: null, page: null });
  });
  it("отказ разбора — точный текст и список файлов с хешами; пустой хеш реестра — «не задан» и null в приложении", () => {
    const r = aiUsageRecord(input({
      versions: { protocol: 1, matrix: "1", model: "m", dataset: "d", input_manifest_hash: "" },
      files: [{ file_id: "f1", file_name: "pz.pdf", sha256: "a".repeat(64), engine: null, parse_status: "FAILED" }, { file_id: "f2", file_name: "ok.pdf", sha256: "b".repeat(64), engine: "pdfium", parse_status: "DONE" }],
    }));
    const lines = r.act_text.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("программный продукт на основе моделей машинного обучения (прил. 2, п. 2 к Положению)");
    expect(lines[2]).toBe("Средство применено с отказами: не обработаны файлы pz.pdf — данные по ним не получены.");
    expect(lines[4]).toContain("хеш реестра не задан.");
    expect(r.serviceability).toEqual({ ok: false, engines: ["pdfium"], files_total: 2, files_failed: [{ file_name: "pz.pdf", sha256: "a".repeat(64) }] });
    expect(r.attachments[1]).toEqual({ name: "Реестр входных файлов", sha256: null });
    expect(aiUsageRecord(input()).attachments[1]).toEqual({ name: "Реестр входных файлов", sha256: "m".repeat(64) });
  });
  it("счётчики в тексте: кандидаты — по результату системы, подтверждённые — по решению инспектора", () => {
    const c = (fs: string, vs: string) => ({ param_code: "M", parameter_name: "X", finding_status: fs, verification_status: vs, expected_value: null, actual_value: null, fragments: [] });
    const t = aiUsageRecord(input({ checks: [c("CANDIDATE", "PENDING"), c("CANDIDATE", "CONFIRMED_VIOLATION"), c("NEGATIVE_VERIFIED", "PENDING"), c("MISSING_EVIDENCE", "PENDING")] })).act_text;
    expect(t).toContain("проверено параметров Матрицы — 4; данные с источником (файл, страница, координаты) получены по 0, по 4 значение в комплекте не найдено; кандидатов в нарушения — 2, подтверждено инспектором — 1.");
  });
  it("все статусы системы и решения инспектора названы по-русски; неизвестный — как есть", () => {
    const c = (fs: string, vs: string) => ({ param_code: "M", parameter_name: "X", finding_status: fs, verification_status: vs, expected_value: null, actual_value: null, fragments: [] });
    const r = aiUsageRecord(input({ checks: [
      c("MISSING_EVIDENCE", "NEGATIVE_VERIFIED"), c("NOT_APPLICABLE", "CLARIFICATION_REQUIRED"), c("NOT_COMPARABLE", "PENDING"), c("CLARIFICATION_REQUIRED", "PENDING"), c("SOMETHING", "ODD"),
    ] }));
    expect(r.data.map((d) => [d.system_result, d.inspector_decision])).toEqual([
      ["недостаточно источников", "отклонено инспектором"],
      ["параметр неприменим", "инспектор запросил уточнение"],
      ["значения несопоставимы", "решение инспектора не принято"],
      ["требуется уточнение редакции", "решение инспектора не принято"],
      ["SOMETHING", "ODD"],
    ]);
  });
  it("T-133: параметры без значения в комплекте не считаются полученными данными — «Алтуфьево»: 137 проверок, источники у 7", () => {
    const missing = { param_code: "M-059", parameter_name: "Толщина плиты", finding_status: "MISSING_EVIDENCE", verification_status: "PENDING", expected_value: null, actual_value: null, fragments: [] };
    const r = aiUsageRecord(input({ checks: [...input().checks, missing as any] }));
    expect(r.summary).toEqual({ checked: 3, with_sources: 1, not_found: 2 });
    expect(r.act_text).toContain("проверено параметров Матрицы — 3; данные с источником (файл, страница, координаты) получены по 1, по 2 значение в комплекте не найдено");
  });
});
