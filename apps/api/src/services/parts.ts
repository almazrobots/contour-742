// OS-INSP-1.2.10 Документ частями: сквозная нумерация страниц после разбора частей.
import type { DB } from "../db.ts";
import { pageOffsets } from "../domain/revisions.ts";

/** Записать смещение страниц каждой части (число страниц — из разбора ML). Файлы не из частей получают 0. */
export async function assignPageOffsets(db: DB, inspectionId: string): Promise<void> {
  const files = await db.all<Record<string, any>>("select id, client_file_id, part_of, part_index, pages_json from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  const offsets = pageOffsets(
    files.map((f) => ({ file_id: f.id, client_file_id: f.client_file_id, part_of: f.part_of, part_index: f.part_index, pages: f.pages_json ? (JSON.parse(f.pages_json) as unknown[]).length : null })),
  );
  for (const [id, off] of offsets) await db.run("update files set page_offset = $1 where id = $2", [off, id]);
}
