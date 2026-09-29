import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AnnotationSource } from "../domain/data-verification.ts";
import { parseRange } from "../domain/byte-range.ts";
import { blobStore, servePath } from "./blobstore.ts";
import { HttpError } from "./inspections.ts";

const intact = new Map<string, Promise<void>>();
async function sourcePath(source: AnnotationSource, fragment: boolean): Promise<string> {
  if (fragment) {
    if ((!source.crop&&!source.preview) || !process.env.INSPECTOR_VERIFICATION_STAGING_DIR) throw new HttpError(404,"Фрагмент не подготовлен");
    const root = await realpath(process.env.INSPECTOR_VERIFICATION_STAGING_DIR);
    const path = await realpath(source.preview?join(root,'structured',`${source.preview.key}.json`):join(root,"reader",`${source.sha256}-p${source.crop!.page}-b${source.crop!.band}.png`));
    if (!path.startsWith(root + sep)) throw new HttpError(403,"Путь фрагмента недопустим");
    const hash=createHash("sha256");for await(const bytes of createReadStream(path))hash.update(bytes);
    if(hash.digest("hex")!==(source.preview?.sha256??source.crop!.sha256))throw new HttpError(409,"Фрагмент изменился после постановки задания");
    return path;
  }
  if (!process.env.INSPECTOR_VERIFICATION_CORPUS_DIR) return servePath(blobStore(),source.sha256);
  const root = await realpath(resolve(process.env.INSPECTOR_VERIFICATION_CORPUS_DIR));
  const path = await realpath(join(root,source.sha256));
  if (!path.startsWith(root + sep)) throw new HttpError(403,"Источник вне корпуса");
  const info = await stat(path);
  const key = `${path}:${info.size}:${info.mtimeMs}`;
  let check = intact.get(key);
  if (!check) {
    check = (async () => { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); if (hash.digest("hex") !== source.sha256) throw new HttpError(409,"Оригинал не совпадает с хешем задания"); })();
    void check.catch(() => intact.delete(key));
    intact.set(key,check);
    if (intact.size > 512) intact.delete(intact.keys().next().value!);
  }
  await check;
  return path;
}
export async function sendAnnotationContent(req: FastifyRequest, reply: FastifyReply, source: AnnotationSource, fragment = false) {
  const path = await sourcePath(source,fragment).catch((e) => { if (e instanceof HttpError) throw e; throw new HttpError(404,"Оригинал или фрагмент пока недоступен"); });
  const { size } = await stat(path);
  const imageMime: Record<string,string> = { ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".tif":"image/tiff", ".tiff":"image/tiff" };
  const type = fragment ? source.preview?'application/json; charset=utf-8':"image/png" : source.kind === "pdf" ? "application/pdf" : imageMime[extname(source.file_name).toLowerCase()] ?? "application/octet-stream";
  reply.header("cache-control","private, no-store").header("x-content-type-options","nosniff")
    .header("content-disposition",`${!fragment&&source.preview?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(source.file_name)}`).header("accept-ranges","bytes");
  const range = parseRange(req.headers.range,size);
  if (range === "unsatisfiable") return reply.code(416).header("content-range",`bytes */${size}`).send();
  if (range) return reply.code(206).header("content-range",`bytes ${range.start}-${range.end}/${size}`).header("content-length",String(range.end-range.start+1)).type(type).send(createReadStream(path,{start:range.start,end:range.end}));
  return reply.header("content-length",String(size)).type(type).send(createReadStream(path));
}
