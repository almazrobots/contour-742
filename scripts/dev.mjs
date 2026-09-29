#!/usr/bin/env node
// Локальный запуск профиля dev: ML (Python, :8811), API (Node, :8810), веб (Vite, :5810).
// Остановка — Ctrl+C: дочерние процессы гасятся вместе с этим.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
if (!existsSync(join(root, "ml/.venv/bin/uvicorn"))) {
  console.error("Нет ml/.venv — выполните: cd ml && uv venv --python 3.12 && uv pip install -e '.[dev]'");
  process.exit(1);
}
const procs = [
  ["ml ", join(root, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--host", "127.0.0.1", "--port", "8811", "--log-level", "warning"], join(root, "ml")],
  ["api", "pnpm", ["--filter", "@inspector/api", "dev"], root],
  ["web", "pnpm", ["--filter", "@inspector/web", "dev"], root],
].map(([name, cmd, args, cwd]) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, INSPECTOR_PROFILE: process.env.INSPECTOR_PROFILE ?? "dev" }, stdio: ["ignore", "pipe", "pipe"] });
  const out = (b) => String(b).split("\n").filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  p.on("exit", (c) => console.log(`[${name}] завершён (${c})`));
  return p;
});
console.log("Веб: http://127.0.0.1:45810 · API: http://127.0.0.1:8810 · ML: http://127.0.0.1:8811");
const stop = () => (procs.forEach((p) => p.kill()), process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
