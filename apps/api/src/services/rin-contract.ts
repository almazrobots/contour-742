/*
 * Контракт автозабора пакетов из ИАИС «РиН» (OS-INSP-1.2.15, TZA-7.6-01).
 *
 * ДОПУЩЕНИЕ. Публичной спецификации API «РиН» нет; настоящий контракт ждём от организатора (T-067).
 * До него принят контракт по образцу передачи протокола (ТЗ 9.6): REST + JSON, pull-модель.
 *
 *   GET {rinUrl}/api/v1/packages[?since=<ISO 8601>]   → 200, JSON-массив пакетов (или { "packages": [...] })
 *     since — включительно: пакеты с created_at ≥ since. Повторы отсекает учёт rin_packages (OS-INSP-1.2.16).
 *     пакет: { package_id, object_id, object: { name, address?, customer?, contractor?, permit_number?, profile? },
 *              created_at, manifest: <реестр файлов, как у ручной загрузки> | null,
 *              files: [{ file_id, file_name, sha256, size, url }] }
 *   GET url                                            → 200, байты файла
 *     url — абсолютный или относительно {rinUrl}/; только тот же origin, что у rinUrl; редиректы не выполняются (3xx — отказ по пакету).
 *
 * Вся зависимость от формы ответа — в этом файле: схема, маппер в предметный RinPackage и обратный
 * сериализатор для заглушки. Замена контракта по T-067 правит только его.
 */
import { z } from "zod";
import type { RinPackage } from "../domain/rin-pull.ts";
import { Manifest } from "../domain/upload.ts";

/** Имя файла — только имя: разделители путей и «.»/«..» из внешней системы не принимаются (L6). */
const FileName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !/[\\/\0]/.test(s) && s !== "." && s !== "..", "имя файла содержит путь");

const WireFile = z.object({
  file_id: z.string().min(1).max(200),
  file_name: FileName,
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  size: z.number().int().min(0),
  url: z.string().min(1).max(2000),
});

const WireObject = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  customer: z.string().optional(),
  contractor: z.string().optional(),
  permit_number: z.string().optional(),
  profile: z.record(z.string(), z.boolean()).optional(),
});

const WirePackage = z.object({
  package_id: z.string().min(1).max(200),
  object_id: z.string().min(1).max(200),
  object: WireObject,
  created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "created_at не дата ISO 8601"),
  manifest: Manifest.nullable().optional(),
  files: z.array(WireFile).min(1, "пакет без файлов"),
});
export type WirePackage = z.infer<typeof WirePackage>;

const base = (rinUrl: string) => (rinUrl.endsWith("/") ? rinUrl : rinUrl + "/");

/** Адрес списка пакетов. */
export function packagesUrl(rinUrl: string, since: string | null): string {
  const u = new URL("api/v1/packages", base(rinUrl));
  if (since) u.searchParams.set("since", since);
  return u.toString();
}

/** Адрес файла пакета: относительный — от rinUrl; чужой origin — null (файл не скачивается, пакет отклоняется). */
export function resolveFileUrl(url: string, rinUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(url.replace(/^\/+/, ""), base(rinUrl));
  } catch {
    return null;
  }
  return u.origin === new URL(rinUrl).origin ? u.toString() : null;
}

export interface ParsedList {
  packages: RinPackage[];
  /** Пакеты, не прошедшие схему: с узнаваемым package_id отклоняются (OS-INSP-1.2.19), без него — только в журнал. */
  invalid: Array<{ package_id: string | null; object_id: string | null; error: string }>;
}

/** Ответ списка → предметные пакеты. Каждый пакет проверяется отдельно: один битый не роняет остальные. */
export function parsePackages(json: unknown, rinUrl: string): ParsedList {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as any).packages) ? (json as any).packages : null;
  if (!list) throw new Error("ответ «РиН» — не список пакетов");
  const out: ParsedList = { packages: [], invalid: [] };
  for (const raw of list as unknown[]) {
    const id = raw && typeof raw === "object" && typeof (raw as any).package_id === "string" && (raw as any).package_id ? String((raw as any).package_id).slice(0, 200) : null;
    const obj = raw && typeof raw === "object" && typeof (raw as any).object_id === "string" ? String((raw as any).object_id).slice(0, 200) : null;
    const r = WirePackage.safeParse(raw);
    if (!r.success) {
      out.invalid.push({ package_id: id, object_id: obj, error: r.error.issues.map((i) => `${i.path.join(".") || "пакет"}: ${i.message}`).join("; ").slice(0, 500) });
      continue;
    }
    const w = r.data;
    const foreign = w.files.find((f) => resolveFileUrl(f.url, rinUrl) === null);
    if (foreign) {
      out.invalid.push({ package_id: w.package_id, object_id: w.object_id, error: `files.url: адрес файла ${foreign.file_name} вне ИАИС «РиН»` });
      continue;
    }
    out.packages.push({
      package_id: w.package_id,
      object_id: w.object_id,
      card: {
        object_id: w.object_id,
        name: w.object.name,
        address: w.object.address ?? "",
        customer: w.object.customer ?? "",
        contractor: w.object.contractor ?? "",
        permit_number: w.object.permit_number ?? "",
        profile: w.object.profile ?? {},
      },
      created_at: new Date(w.created_at).toISOString(),
      manifest: w.manifest ?? null,
      files: w.files.map((f) => ({ file_id: f.file_id, file_name: f.file_name, sha256: f.sha256.toLowerCase(), size: f.size, url: resolveFileUrl(f.url, rinUrl)! })),
    });
  }
  return out;
}

/** Предметный пакет → форма ответа «РиН». Нужен заглушке для демо, чтобы форма жила в одном месте. */
export function toWire(p: RinPackage): WirePackage {
  const { object_id: _id, ...object } = p.card;
  return { package_id: p.package_id, object_id: p.object_id, object, created_at: p.created_at, manifest: p.manifest, files: p.files.map((f) => ({ ...f })) };
}
