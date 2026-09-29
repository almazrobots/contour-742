// OS-INSP-1.2 Принять файлы комплекта с реестром: правила приёма (ТЗ 9.1 «Обработка ошибок при загрузке»).
import { z } from "zod";
import type { ApprovalStatus, Stage } from "./types.ts";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
// XLSX и изображения (JPG, PNG, TIF) — расширение сверх ТЗ §9.1 по GAP-INSP-04 (OS-INSP-1.2.9):
// в реальном комплекте ИД 36 таблиц и 10 изображений (docs/gera/inspector/corpus-stats.md).
export const SUPPORTED = ["PDF", "DOCX", "XML", "XLSX", "JPG", "PNG", "TIF"] as const;

export type Kind = "pdf" | "docx" | "xml" | "xlsx" | "jpg" | "png" | "tif";

export type FileVerdict = { ok: true; kind: Kind } | { ok: false; code: "UNSUPPORTED_FORMAT" | "FILE_TOO_LARGE" | "CORRUPTED"; message: string };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Тип по содержимому, а не по расширению: расширение подделывается легко. */
export function sniff(buf: Buffer): Kind | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP-контейнер OOXML: имена частей лежат в локальных заголовках незашифрованными
    if (buf.includes(Buffer.from("word/"))) return "docx";
    if (buf.includes(Buffer.from("xl/"))) return "xlsx"; // GAP-INSP-04: сверх ТЗ
    return null;
  }
  // GAP-INSP-04: изображения — сверх ТЗ
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  const tiff = buf.subarray(0, 4).toString("latin1");
  if (tiff === "II*\0" || tiff === "MM\0*") return "tif";
  const head = buf.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<?xml") || /^<[\p{L}_]/u.test(head)) return "xml";
  return null;
}

export function checkFile(name: string, buf: Buffer): FileVerdict {
  if (buf.length > MAX_FILE_BYTES) {
    // OS-INSP-1.2.10: предел — на файл; большой документ принимается частями, связанными в реестре
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `${name}: размер ${(buf.length / 1048576).toFixed(1)} МБ больше допустимых 50 МБ — разделите документ на части и свяжите их в реестре (part_of, part_index)`,
    };
  }
  const kind = sniff(buf);
  if (!kind) return { ok: false, code: "UNSUPPORTED_FORMAT", message: `${name}: неподдерживаемый формат; поддерживаются ${SUPPORTED.join(", ")}` };
  if (kind === "pdf" && !buf.subarray(Math.max(0, buf.length - 2048)).toString("latin1").includes("%%EOF")) {
    return { ok: false, code: "CORRUPTED", message: `${name}: PDF повреждён (нет конца файла) — загрузите файл повторно` };
  }
  if (kind === "png" && !buf.subarray(Math.max(0, buf.length - 16)).includes(Buffer.from("IEND"))) {
    return { ok: false, code: "CORRUPTED", message: `${name}: PNG повреждён (нет конца файла) — загрузите файл повторно` };
  }
  return { ok: true, kind };
}

export function checkPackage(sizes: number[]): { ok: true } | { ok: false; message: string } {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total > MAX_PACKAGE_BYTES) return { ok: false, message: `Пакет ${(total / 1048576).toFixed(1)} МБ больше допустимых 200 МБ` };
  return { ok: true };
}

// ─────────────────────────────── реестр файлов (Перечень ИД, ред. 1.1)

const Approval = z.enum(["DRAFT", "APPROVED", "FOR_CONSTRUCTION", "SUPERSEDED", "CANCELLED"]);

export const ManifestFile = z.object({
  file_id: z.string().min(1),
  file_name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  doc_stage: z.enum(["PD", "RD", "ID"]),
  discipline: z.string().min(1),
  document_code: z.string().min(1),
  revision: z.string().min(1),
  approval_status: Approval.nullable().optional(),
  approval_date: z.string().nullable().optional(),
  sheet_page_range: z.string().nullable().optional(),
  predecessor_id: z.string().nullable().optional(),
  successor_id: z.string().nullable().optional(),
  signature_status: z.string().nullable().optional(),
  // OS-INSP-1.2.10: часть большого документа — file_id основного документа и номер части (1 — основной)
  part_of: z.string().nullable().optional(),
  part_index: z.preprocess((v) => (v === null || v === undefined || v === "" ? null : Number(v)), z.number().int().min(1).nullable()).optional(),
  // OS-INSP-1.2.32, 1.2.34 (T-120): реестр организатора — причина исключения из проверки и число страниц PDF
  exclusion_reason: z.string().max(500).nullable().optional(), // T136-L2: без предела раздувал реестр и журнал отказов
  pdf_pages: z.preprocess((v) => (v === null || v === undefined || v === "" ? null : Number(v)), z.number().int().min(1).nullable()).optional(),
});
export type ManifestFile = z.infer<typeof ManifestFile>;

export const ObjectCard = z.object({
  object_id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().default(""),
  customer: z.string().default(""),
  contractor: z.string().default(""),
  permit_number: z.string().default(""),
  profile: z.record(z.string(), z.boolean()).default({}),
});

export const Manifest = z.object({ object: ObjectCard.optional(), files: z.array(ManifestFile).min(1) });
export type Manifest = z.infer<typeof Manifest>;

/** CSV реестра: первая строка — имена полей, разделитель «;» или «,». */
export function parseCsvManifest(text: string): Manifest {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.trim());
  const files = lines.slice(1).map((l) => {
    const cells = l.split(sep);
    const row: Record<string, string | null> = {};
    head.forEach((h, i) => (row[h] = cells[i]?.trim() ? cells[i].trim() : null));
    return row;
  });
  return Manifest.parse({ files });
}

export function parseManifest(name: string, buf: Buffer): Manifest {
  const text = buf.toString("utf8");
  if (name.toLowerCase().endsWith(".csv")) return parseCsvManifest(text);
  return Manifest.parse(JSON.parse(text));
}

export interface ManifestIndex {
  byName: Map<string, ManifestFile>;
  declaredPerStage: Record<Stage, number>;
}

export function indexManifest(m: Manifest | null): ManifestIndex {
  const byName = new Map<string, ManifestFile>();
  const declaredPerStage: Record<Stage, number> = { PD: 0, RD: 0, ID: 0 };
  for (const f of m?.files ?? []) {
    byName.set(f.file_name, f);
    declaredPerStage[f.doc_stage]++;
  }
  return { byName, declaredPerStage };
}

export function asApproval(s: string | null | undefined): ApprovalStatus | null {
  return Approval.safeParse(s).success ? (s as ApprovalStatus) : null;
}
