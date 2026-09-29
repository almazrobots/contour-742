#!/usr/bin/env node
// Загрузить синтетические пакеты data/synth/* в работающий API (демо). ADR-0002: только синтетика.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const API = process.env.INSPECTOR_API ?? "http://127.0.0.1:8810";
const password = process.env.INSPECTOR_DEMO_PASSWORD ?? readFileSync(join(root, "var/demo-password.txt"), "utf8").trim();
const login = await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password }) });
if (!login.ok) throw new Error(`Вход не удался: ${login.status}`);
const { token } = await login.json();
for (const obj of readdirSync(join(root, "data/synth"))) {
  const dir = join(root, "data/synth", obj);
  if (!statSync(dir).isDirectory()) continue;
  const form = new FormData();
  form.append("manifest", new Blob([readFileSync(join(dir, "manifest.json"))]), "manifest.json");
  for (const f of readdirSync(dir).filter((f) => /\.(pdf|docx|xml|xlsx|png|jpg|tif)$/.test(f))) form.append("files", new Blob([readFileSync(join(dir, f))]), f);
  const r = await fetch(`${API}/api/v1/documents/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const j = await r.json();
  console.log(`${obj}: ${r.status} process_id=${j.process_id} принято ${j.accepted?.length ?? 0}, отклонено ${j.rejected?.length ?? 0}`);
}
