// T-238: sources and their durable owners share a kernel lock, independent of DB connection lifetime.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import type { BlobRetentionGuard } from "./blobstore.ts";

const held = new AsyncLocalStorage<{ path: string; active: boolean }>();
const defaultDirectory = () => config.blobAtRest.workDir ?? config.blobDir;

export function assertPipelineSourceLock(): void {
  const token = held.getStore();
  if (!token?.active || token.path !== join(resolve(defaultDirectory()), ".pipeline-source.lock")) {
    throw Error("source pin mutation requires the shared filesystem lock around its transaction");
  }
}

/** Hold across the entire pin/unpin transaction, or the entire materialization/cleanup operation.
 * The child locks an inherited descriptor, then exits; Node keeps the same open-file-description
 * until finally closes it. Process death releases the kernel lock without a TTL or PID guess.
 * Re-entry from the same awaited chain is safe; do not launch unawaited work inside the callback.
 * Every API process sharing the sources must use the same mounted directory and this protocol.
 */
export async function withPipelineSourceLock<T>(fn: () => Promise<T>, directory = defaultDirectory()): Promise<T> {
  const path = join(resolve(directory), ".pipeline-source.lock");
  const current = held.getStore();
  if (current?.active && current.path === path) return fn();
  await mkdir(directory, { recursive: true });
  const fh = await open(path, "a+", 0o600);
  const token = { path, active: false };
  try {
    await new Promise<void>((done, reject) => {
      // flock uses fd 3 directly; no shell and no user-provided command interpolation.
      const child = spawn("flock", ["-x", "-w", "30", "3"], { stdio: ["ignore", "ignore", "ignore", fh.fd] });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`source lock unavailable: ${signal ?? code}`)));
    });
    token.active = true;
    return await held.run(token, fn);
  } finally {
    token.active = false;
    await fh.close();
  }
}

/** Install before accepting work. No DB transaction remains open while filesystem IO runs.
 * The same filesystem lock must enclose every production INSERT/UPDATE/DELETE of source pins.
 * A DB read failure performs no cleanup; API restart reconstructs retention from durable pins.
 */
export function pipelineSourceRetention(db: DB, directory = defaultDirectory()): BlobRetentionGuard {
  return (fn) => withPipelineSourceLock(async () => {
    const rows = await db.all<{ sha256: string }>("select distinct sha256 from pipeline_source_pins where released_at is null");
    return fn(new Set(rows.map((row) => row.sha256)));
  }, directory);
}
