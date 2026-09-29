// OS-INSP-5.1.7 Итоговый выходной набор проверки: протокол в JSON, XML, PDF, DOCX, статус, паспорт параметра, отчёт о
// приёме, отчёт автоматической верификации и опись MANIFEST.sha256. OS-INSP-6.5.9: верификация не «MATCH» — набор
// помечается UNVERIFIED (в README и файлом-флагом) с названием поля расхождения.
//
//   node apps/api/src/cli/output-set.ts --api https://host:port --process-id ID --out каталог [--ca ca.pem]
//        --login L --password-file F [--intake intake-report.json] [--verification verification.json] [--param M-023]
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { apiClient, checkApiUrl, nodeHttp, readPassword, type Http } from "./load-package.ts";

export interface OutputSetOptions {
  api: string;
  processId: string;
  out: string;
  login: string;
  password: string;
  intake?: string;
  verification?: string;
  param?: string;
}

export interface OutputSetResult {
  files: Array<{ name: string; sha256: string; bytes: number }>;
  skipped: Array<{ name: string; reason: string }>;
  verified: boolean | null;
  mismatch: string[];
  versions: Record<string, string | null>;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Расхождения верификации: поля, где verdict не MATCH (поле `field`/`fields`/`mismatches` — что есть). */
export function verificationMismatch(v: any): { verified: boolean; fields: string[] } {
  const verified = v?.verdict === "MATCH";
  const fields: string[] = [];
  for (const k of ["mismatches", "fields", "diff"]) {
    const x = v?.[k];
    if (Array.isArray(x)) for (const it of x) fields.push(typeof it === "string" ? it : String(it?.field ?? it?.path ?? JSON.stringify(it)));
  }
  if (typeof v?.field === "string") fields.push(v.field);
  return { verified, fields };
}

export async function buildOutputSet(o: OutputSetOptions, http: Http, log: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<OutputSetResult> {
  // пароль уходит только по https (открытый http — лишь на петле), как у загрузчика (SEC-09)
  checkApiUrl(o.api);
  // код параметра идёт в имя файла: только «M-NNN», иначе «../» вывел бы запись за пределы --out (SEC-10)
  if (o.param !== undefined && !/^M-\d{3}$/.test(o.param)) throw new Error(`--param ${o.param}: ждём код параметра вида M-023`);
  await mkdir(o.out, { recursive: true });
  const api = await apiClient(o.api, http, o.login, o.password);
  const id = encodeURIComponent(o.processId);
  const skipped: OutputSetResult["skipped"] = [];
  const put = async (name: string, body: Buffer) => writeFile(join(o.out, name), body);

  const status = await api.call("GET", `/api/v1/inspection/${id}/status`);
  if (status.status !== 200) throw new Error(`Статус проверки ${o.processId}: ${status.status}`);
  await put("status.json", status.body);

  let protocol: any = null;
  for (const format of ["json", "xml", "pdf", "docx"]) {
    const r = await api.call("GET", `/api/v1/inspection/${id}/protocol/export?format=${format}`);
    if (r.status !== 200) throw new Error(`Протокол ${format}: сервер ответил ${r.status} ${r.body.toString("utf8").slice(0, 200)}`);
    await put(`protocol.${format}`, r.body);
    if (format === "json") protocol = JSON.parse(r.body.toString("utf8"));
    log(`протокол ${format}: ${r.body.length} байт`);
  }

  const param = o.param ?? "M-023";
  const pp = await api.call("GET", `/api/v1/params/${encodeURIComponent(param)}/passport`);
  if (pp.status === 200) await put(`passport-${param}.json`, pp.body);
  else skipped.push({ name: `passport-${param}.json`, reason: `эндпоинт паспорта ответил ${pp.status}` });

  if (o.intake) {
    await copyFile(o.intake, join(o.out, "intake-report.json"));
    const md = o.intake.replace(/\.json$/, ".md");
    if (md !== o.intake) await copyFile(md, join(o.out, "intake-report.md")).catch(() => skipped.push({ name: "intake-report.md", reason: "нет рядом с intake-report.json" }));
  } else skipped.push({ name: "intake-report.json", reason: "не передан --intake" });

  let verified: boolean | null = null;
  let mismatch: string[] = [];
  if (o.verification) {
    const buf = await readFile(o.verification);
    await put("verification.json", buf);
    const v = verificationMismatch(JSON.parse(buf.toString("utf8")));
    verified = v.verified;
    mismatch = v.fields;
  } else skipped.push({ name: "verification.json", reason: "не передан --verification" });
  // OS-INSP-6.5.9: без верификации набор тоже не считается проверенным
  if (verified !== true) await put("UNVERIFIED", Buffer.from(verified === false ? `Верификация: расхождение${mismatch.length ? ` в полях: ${mismatch.join(", ")}` : ""}\n` : "Верификация не проводилась\n"));

  const versions: Record<string, string | null> = {
    protocol_version: protocol?.protocol_version != null ? String(protocol.protocol_version) : null,
    matrix_version: protocol?.versions?.matrix_version ?? null,
    model_version: protocol?.versions?.model_version ?? null,
    dataset_version: protocol?.versions?.dataset_version ?? null,
    input_manifest_hash: protocol?.versions?.input_manifest_hash ?? null,
  };

  const readme: string[] = [
    `# Выходной набор проверки${verified === true ? "" : " — UNVERIFIED"}`,
    "",
    `- Проверка (process_id): \`${o.processId}\``,
    `- Сформирован: ${new Date().toISOString()}`,
    ...Object.entries(versions).map(([k, v]) => `- ${k}: \`${v ?? "—"}\``),
    "",
    verified === true
      ? "Автоматическая верификация: **MATCH**."
      : verified === false
        ? `**UNVERIFIED** (OS-INSP-6.5.9): автоматическая верификация дала расхождение${mismatch.length ? ` — поля: ${mismatch.map((m) => `\`${m}\``).join(", ")}` : ""}.`
        : "**UNVERIFIED**: отчёт автоматической верификации не приложен.",
    "",
    "## Файлы",
    "",
    "| Файл | Что это |",
    "|---|---|",
    "| protocol.json / .xml / .pdf / .docx | протокол проверки в четырёх форматах (одна версия) |",
    "| status.json | статус проверки и разбора файлов на момент сборки набора |",
    `| passport-${param}.json | паспорт параметра: метрики, порядок и алгоритм расчёта |`,
    "| intake-report.json / .md | отчёт о приёме пакета: вход, SHA-256 архива, дубликаты, части, реестр |",
    "| verification.json | отчёт автоматической верификации |",
    "| MANIFEST.sha256 | опись набора: SHA-256 каждого файла (`shasum -a 256 -c MANIFEST.sha256`) |",
    "",
    ...(skipped.length ? ["## Не вошло", "", ...skipped.map((s) => `- ${s.name}: ${s.reason}`), ""] : []),
  ];
  await put("README.md", Buffer.from(readme.join("\n")));

  const files: OutputSetResult["files"] = [];
  for (const name of (await readdir(o.out)).filter((n) => n !== "MANIFEST.sha256").sort()) {
    const b = await readFile(join(o.out, name));
    files.push({ name, sha256: sha(b), bytes: b.length });
  }
  await put("MANIFEST.sha256", Buffer.from(files.map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n"));
  log(`набор: ${files.length} файлов + MANIFEST.sha256 в ${o.out}${verified === true ? "" : " — UNVERIFIED"}`);
  return { files, skipped, verified, mismatch, versions };
}

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: "string" },
      ca: { type: "string" },
      "process-id": { type: "string" },
      out: { type: "string" },
      login: { type: "string" },
      "password-file": { type: "string" },
      intake: { type: "string" },
      verification: { type: "string" },
      param: { type: "string" },
    },
  });
  const need = (k: keyof typeof values) => {
    const v = values[k];
    if (!v) throw new Error(`Не указан --${k}`);
    return v;
  };
  await buildOutputSet(
    {
      api: need("api"),
      processId: need("process-id"),
      out: resolve(need("out")),
      login: need("login"),
      password: await readPassword(need("password-file")),
      intake: values.intake,
      verification: values.verification,
      param: values.param,
    },
    nodeHttp({ ca: values.ca ? await readFile(values.ca) : undefined }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((e: unknown) => {
    process.stderr.write(`output-set: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
