import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.ts";
import { makeKeyring } from "../src/domain/at-rest.ts";
import { sha256hex } from "../src/domain/blob-crypto.ts";
import { BlobPinnedError, BlobWorkCapacityError, FsBlobStore, LocalAtRest, removeUnpinnedLocalBlobs, setBlobRetentionGuard, withBlobRetention } from "../src/services/blobstore.ts";
import { pipelineSourceRetention, withPipelineSourceLock } from "../src/services/pipeline-source-pins.ts";

let db: DB, root: string, work: string;
const a = Buffer.alloc(60, 1), b = Buffer.alloc(60, 2), sha = sha256hex(a);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { resolve, promise }; };
const local = () => new LocalAtRest({ keyring: makeKeyring(Buffer.alloc(32, 7)), workDir: work, workMaxBytes: 100 });
const store = () => new FsBlobStore(join(root, "blobs"), undefined, local());

beforeAll(async () => {
  process.env.INSPECTOR_DEMO_PASSWORD = "test-pins";
  db = await (await import("../src/db.ts")).openDb("memory");
  await db.run("insert into objects(id,name,created_at) values ('O-PINS','Synthetic pins',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-PINS','O-PINS','PARSING',now(),now())");
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "source-pins-")); work = join(root, "work");
  await db.run("update pipeline_source_pins set released_at=now()");
  setBlobRetentionGuard(pipelineSourceRetention(db, work));
});
afterEach(() => { setBlobRetentionGuard(null); rmSync(root, { recursive: true, force: true }); });
afterAll(async () => { await db?.close(); });

async function owner() {
  const file = randomUUID(), run = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-PINS','O-PINS',$1,'synthetic.pdf',$2,60,'pdf','PD','PINS','1',now())`, [file, sha]);
  await db.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode,status)
    values ($1,$2,$3,'staged-v1','durable','RUNNING')`, [run, file, sha]);
  return run;
}
const locked = <T>(fn: () => Promise<T>) => withPipelineSourceLock(fn, work);
const pin = (run: string) => locked(() => db.run("insert into pipeline_source_pins(run_id,sha256) values ($1,$2)", [run, sha]));
const workFiles = () => readdirSync(work).filter((name) => name !== ".pipeline-source.lock");

describe("T-238: durable source retention", () => {
  it("restores protection for a new BlobStore/guard; last owner release permits eviction", async () => {
    const r1 = await owner(), r2 = await owner(); await pin(r1); await pin(r2);
    const first = store(); await first.put(sha, a); await first.put(sha256hex(b), b);
    await first.localPath(sha);
    // Recreate all in-memory storage/guard state; PostgreSQL pins remain authoritative.
    setBlobRetentionGuard(pipelineSourceRetention(db, work));
    const restarted = store();
    rmSync(work, { recursive: true, force: true }); // tmpfs lost on host restart
    expect(readFileSync(await restarted.localPath(sha))).toEqual(a);
    await expect(restarted.localPath(sha256hex(b))).rejects.toBeInstanceOf(BlobWorkCapacityError);
    expect(readFileSync(join(work, sha))).toEqual(a);
    expect(workFiles()).toEqual([sha]);
    await locked(() => db.run("update pipeline_source_pins set released_at=now() where run_id=$1", [r1]));
    await expect(restarted.localPath(sha256hex(b))).rejects.toBeInstanceOf(BlobWorkCapacityError);
    await locked(() => db.run("update pipeline_source_pins set released_at=now() where run_id=$1", [r2]));
    await restarted.localPath(sha256hex(b));
    expect(existsSync(join(work, sha))).toBe(false);
    expect(await restarted.get(sha)).toEqual(a); // protected encrypted source remains
  });

  it("rejects quarantine of an active source, including an unencrypted fs store", async () => {
    const r = await owner(); await pin(r);
    const st = new FsBlobStore(join(root, "plain")); await st.put(sha, a);
    await expect(st.quarantine(sha)).rejects.toBeInstanceOf(BlobPinnedError);
    expect(await st.get(sha)).toEqual(a);
    await locked(() => db.run("update pipeline_source_pins set released_at=now() where run_id=$1", [r]));
    expect(await st.quarantine(sha)).toMatch(/rejected/);
  });

  it("rollback cleanup retains pinned copies while removing unpinned newcomers", async () => {
    const r = await owner(); await pin(r);
    const st = store(); await st.put(sha, a); await st.put(sha256hex(b), b);
    await removeUnpinnedLocalBlobs(join(root, "blobs"), [sha, sha256hex(b)]);
    expect(await st.get(sha)).toEqual(a);
    expect(await st.exists(sha256hex(b))).toBe(false);
  });

  it("pin commits before collector: collector sees it and refuses eviction", async () => {
    const r = await owner(), st = store(); await st.put(sha, a); await st.put(sha256hex(b), b); await st.localPath(sha);
    const inserted = deferred(), release = deferred();
    const write = locked(() => db.tx(async (t) => {
      await t.run("insert into pipeline_source_pins(run_id,sha256) values ($1,$2)", [r, sha]);
      inserted.resolve(); await release.promise;
    }));
    await inserted.promise;
    const evict = st.localPath(sha256hex(b));
    const observed = expect(evict).rejects.toBeInstanceOf(BlobWorkCapacityError);
    release.resolve(); await write; await observed;
    expect(readFileSync(join(work, sha))).toEqual(a);
  });

  it("collector lock blocks concurrent pin insertion until callback completes", async () => {
    const r = await owner(), entered = deferred(), release = deferred();
    const collecting = withBlobRetention(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let inserted = false;
    const writing = pin(r).then(() => { inserted = true; });
    try {
      const attempt = spawnSync("flock", ["-n", join(work, ".pipeline-source.lock"), "true"]);
      expect(attempt.status).toBe(1); // independent process cannot enter this critical section
      expect(inserted).toBe(false);
    } finally { release.resolve(); await collecting; await writing; }
    expect(inserted).toBe(true);
  });

  it("failed pin transaction does not retain source indefinitely", async () => {
    const r = await owner();
    await expect(locked(() => db.tx(async (t) => {
      await t.run("insert into pipeline_source_pins(run_id,sha256) values ($1,$2)", [r, sha]);
      throw Error("rollback");
    }))).rejects.toThrow("rollback");
    const st = store(); await st.put(sha, a); await st.put(sha256hex(b), b);
    await st.localPath(sha); await st.localPath(sha256hex(b));
    expect(existsSync(join(work, sha))).toBe(false);
  });

  it("stream reservation is serialized and rejects overflow without a partial target", async () => {
    const r = await owner(); await pin(r);
    const loc = local(), entered = deferred(), release = deferred();
    const first = loc.materializeStream(sha, { size: a.length, plainWhileKeyed: false, workLimit: 100,
      async *chunks() { entered.resolve(); await release.promise; yield a; } });
    await entered.promise;
    const second = loc.materialize(sha256hex(b), b);
    const observed = expect(second).rejects.toBeInstanceOf(BlobWorkCapacityError);
    release.resolve(); await first; await observed;
    expect(workFiles()).toEqual([sha]);
    expect(readFileSync(join(work, sha))).toEqual(a);
  });

  it("kernel lock survives flock helper exit, is reentrant, and releases on API process death", async () => {
    await locked(async () => {
      await locked(async () => { expect(spawnSync("flock", ["-n", join(work, ".pipeline-source.lock"), "true"]).status).toBe(1); });
    });
    expect(spawnSync("flock", ["-n", join(work, ".pipeline-source.lock"), "true"]).status).toBe(0);
    const module = new URL("../src/services/pipeline-source-pins.ts", import.meta.url).href;
    const script = `const {withPipelineSourceLock}=await import(process.argv[1]);
      await withPipelineSourceLock(async()=>{process.stdout.write('LOCKED\\n'); setInterval(()=>{},1000); await new Promise(()=>{});},process.argv[2]);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, module, work], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    try {
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => done());
        child.once("exit", (code) => reject(new Error(`lock child exited before acquisition: ${code}`)));
      });
      expect(spawnSync("flock", ["-n", join(work, ".pipeline-source.lock"), "true"]).status).toBe(1);
    } finally { child.kill("SIGKILL"); await exited; }
    expect(spawnSync("flock", ["-n", join(work, ".pipeline-source.lock"), "true"]).status).toBe(0);
  });

  it("oversized stream cannot exceed its reservation, and failed guard deletes nothing", async () => {
    const loc = local();
    await expect(loc.materializeStream(sha, { size: 1, plainWhileKeyed: false, workLimit: 100,
      async *chunks() { yield a; } })).rejects.toThrow("длиннее заявленного");
    expect(workFiles()).toEqual([]);
    await loc.materialize(sha, a);
    setBlobRetentionGuard(async () => { throw Error("database unavailable"); });
    await expect(loc.materialize(sha256hex(b), b)).rejects.toThrow("database unavailable");
    expect(readFileSync(join(work, sha))).toEqual(a);
  });
});
