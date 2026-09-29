// Реестр пакета для замера W3 на корпусе (T-210, OS-INSP-6.5.70): стадия, раздел и шифр документа — тем же путём, что у
// загрузчика cli/load-package.ts (OS-INSP-1.2.24–1.2.26): служебный мусор и файл реестра — не документы, дубликаты по
// SHA-256 — один раз, затем deriveRegistry (стадия по папке → по букве стадии в имени → ПД по умолчанию; раздел и шифр —
// parseDocName). Комплект ПД — базовые шифры документов РД (как services/inspections.ts, LNK-01).
// Вход — JSONL {object, files: [{path, sha256, size}]}, выход — JSONL: по файлу {object, sha256, status, …} и по объекту
// {object, kit_bases}. Пути только читаются здесь и в вывод не копируются.
// Запуск: pnpm --filter ./apps/api exec tsx scripts/w3-registry.ts <in.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { dedupeBySha, deriveRegistry, isJunk, isRegistryFile, type HashedFile } from "../src/domain/archive.ts";
import { parseDocName } from "../src/domain/cipher.ts";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: w3-registry.ts <in.jsonl> <out.jsonl>");

const out: string[] = [];
const put = (x: unknown) => out.push(JSON.stringify(x));
for (const line of readFileSync(inFile, "utf8").split("\n").filter(Boolean)) {
  const { object, files } = JSON.parse(line) as { object: string; files: HashedFile[] };
  const docs: HashedFile[] = [];
  for (const f of files) {
    if (isJunk(f.path)) put({ object, sha256: f.sha256, status: "junk" });
    else if (isRegistryFile(f.path)) put({ object, sha256: f.sha256, status: "registry" });
    else docs.push(f);
  }
  const { unique, duplicates } = dedupeBySha(docs);
  for (const d of duplicates) put({ object, sha256: d.sha256, status: "duplicate" });
  if (!unique.length) {
    put({ object, kit_bases: [] });
    continue;
  }
  const reg = deriveRegistry(unique, { approval: true, object_id: object });
  const kit = new Set<string>();
  reg.manifest.files.forEach((m, i) => {
    const n = reg.notes.files[i];
    put({
      object,
      sha256: m.sha256,
      status: "ok",
      doc_stage: m.doc_stage,
      stage_source: n.stage_source,
      code_from_name: n.code_from_name,
      discipline: m.discipline,
      document_code: m.document_code,
      revision: m.revision,
      approval_status: m.approval_status ?? null,
      base: n.base,
    });
    const b = parseDocName(m.document_code || m.file_name).base;
    if (m.doc_stage === "RD" && b) kit.add(b);
  });
  put({ object, kit_bases: [...kit] });
}
writeFileSync(outFile, out.join("\n") + "\n");
