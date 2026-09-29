// Explicit deployment transfer. Source is read-only; no database or worker starts.
import "../entry-migrate.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.ts";
import { blobObjectKey } from "../domain/blob-crypto.ts";
import { blobStoreFromConfig, sdkS3 } from "../services/blobstore.ts";

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--manifest" || args[2] !== "--manifest-sha256" || args[4] !== "--output") throw Error("Expected pinned manifest and private output directory");
const raw = readFileSync(args[1]);
const digest = createHash("sha256").update(raw).digest("hex");
if (!/^[a-f0-9]{64}$/.test(args[3]) || digest !== args[3]) throw Error("Manifest digest mismatch");
const manifest = JSON.parse(raw.toString());
if (manifest.schema !== "platform-blob-mirror/1" || !Array.isArray(manifest.shas) || !manifest.shas.length || manifest.shas.some((s:unknown)=>typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s))) throw Error("Invalid source SHA manifest");
const target = config.blobStore;
if (target.kind !== "s3" || !/^platform-view\/[a-z0-9-]+\/$/.test(target.prefix)) throw Error("Explicit private platform-view S3 destination required");
const output = resolve(args[5]);
if (output === resolve(config.blobDir) || output.startsWith(resolve(config.blobDir)+"/")) throw Error("Progress must live outside source blobs");
mkdirSync(output, { recursive:true, mode:0o700 });
const path = join(output,"progress.json");
const identity = {schema:"platform-blob-mirror/1",manifest_sha256:digest,source:resolve(config.blobDir),bucket:target.bucket,prefix:target.prefix,encryption_key_sha256:createHash("sha256").update(target.key).digest("hex")};
type Item = {status:"copied"|"failed";error?:string;reason?:string};
let items:Record<string,Item> = {};
if (existsSync(path)) {
  const saved = JSON.parse(readFileSync(path,"utf8"));
  if (JSON.stringify(saved.identity)!==JSON.stringify(identity)) throw Error("Mirror resume identity mismatch");
  items=saved.items;
}
const shas = [...new Set<string>(manifest.shas)];
const store = blobStoreFromConfig();
const remote = sdkS3({endpoint:target.endpoint,region:target.region,forcePathStyle:target.forcePathStyle,credentials:target.credentials,requestTimeoutMs:target.requestTimeoutMs,proxy:target.proxy});
const save = () => {
  const state={identity,revision:process.env.INSPECTOR_REVISION??"unknown",items,updated_at:new Date().toISOString(),complete:shas.every(s=>items[s]?.status==="copied")};
  writeFileSync(path+".tmp",JSON.stringify(state),{mode:0o600});renameSync(path+".tmp",path);
};
let processed=0;
for (const sha of shas) {
  if (items[sha]?.status==="copied") continue;
  try {
    // adopt uses authenticated streaming encryption and checks source SHA before
    // finishing PUT. Source data remains in place; existing objects are immutable.
    const head = await remote.head(target.bucket,blobObjectKey(target.prefix,sha));
    if (head && head.sha256 !== sha) throw Error("Existing target metadata mismatch");
    await store.adopt(sha);
    items[sha]={status:"copied"};
  } catch (error) {
    items[sha]={status:"failed",error:error instanceof Error?error.constructor.name:"UnknownError",reason:error instanceof Error?error.message.slice(0,1000):"unknown"};
    save();throw Error("Blob mirror failed; inspect private progress, source unchanged");
  }
  save();processed++;
  if (processed%20===0) console.log(JSON.stringify({copied:Object.values(items).filter(i=>i.status==="copied").length,total:shas.length}));
}
save();console.log(JSON.stringify({mirror_complete:true,unique_sources:shas.length,source_changed:false}));
