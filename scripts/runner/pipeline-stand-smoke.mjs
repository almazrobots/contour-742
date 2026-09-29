// T-237: real API/PostgreSQL/ML + browser on the isolated GPU branch stand.
// Run only via remote-run.sh --light --as-root. Credentials never enter output.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium, request } from "playwright";

const stand = process.env.PIPELINE_SMOKE_STAND ?? "/opt/w1-gate/stand/w1-feat-resource-ocr-incremental";
const baseURL = process.env.PIPELINE_SMOKE_URL ?? "https://127.0.0.1:45812";
const output = resolve(process.env.PIPELINE_SMOKE_OUTPUT ?? "var/pipeline-stand-smoke");
const fixture = resolve(process.env.PIPELINE_SMOKE_FIXTURE ?? "data/synth/OBJ-SEV-2");
const password = readFileSync(process.env.PIPELINE_SMOKE_PASSWORD_FILE ?? `${stand}/var/secrets/demo_password`, "utf8").trim();
const selected = new Set(["SEV-PD-PZ-1.pdf", "SEV-RD-AR-B.pdf", "SEV-ID-AOSR-7.docx", "SEV-ID-TP-1.xml"]);
const manifest = JSON.parse(readFileSync(`${fixture}/manifest.json`, "utf8"));
if (!process.env.PIPELINE_SMOKE_FIXTURE) manifest.files = manifest.files.filter((f) => selected.has(f.file_name));
manifest.files.forEach((f) => { f.predecessor_id = null; });
manifest.object.object_id = `T237-${randomUUID()}`;
manifest.object.name = "СИНТЕТИКА · T237 золотая трасса";
mkdirSync(output, { recursive: true });
// TLS exception confined to this loopback test stand; no global TLS override.
const client = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
let browser;
const evidence = { baseURL, started: new Date().toISOString(), files: [] };
async function json(path, options = {}) {
  const response = await client.fetch(path, options);
  assert(response.ok(), `${path}: HTTP ${response.status()} ${await response.text()}`);
  return response.json();
}
try {
  evidence.health = await json("/health");
  const { token } = await json("/api/v1/auth/login", { method: "POST", data: { login: "inspector", password } });
  const headers = { authorization: `Bearer ${token}` };
  const multipart = new FormData();
  multipart.append("manifest", new File([JSON.stringify(manifest)], "manifest.json"));
  for (const f of manifest.files) multipart.append("files", new File([readFileSync(`${fixture}/${f.file_name}`)], f.file_name));
  const uploaded = process.env.PIPELINE_SMOKE_PROCESS
    ? { process_id: process.env.PIPELINE_SMOKE_PROCESS }
    : await json("/api/v1/documents/upload", { method: "POST", headers, multipart });
  assert(uploaded.process_id);
  evidence.process_id = uploaded.process_id;
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(`uploaded synthetic package: ${evidence.process_id}`);
  const prefix = `/api/v1/inspection/${evidence.process_id}`;
  let state;
  for (let attempt = 0; attempt < 120; attempt++) {
    state = await json(`${prefix}/status`, { headers });
    if (attempt % 5 === 0) console.log(JSON.stringify({ status: state.status, files: state.files.map((f) => ({ name: f.file_name, status: f.parse_status, error: f.parse_error })) }));
    assert(!state.files.some((f) => f.parse_status === "FAILED"), JSON.stringify(state.files));
    if (state.status === "READY") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(state.status, "READY", "processing deadline exceeded");
  const card = await json(`/api/v1/inspections/${evidence.process_id}`, { headers });
  writeFileSync(`${output}/card.json`, JSON.stringify(card, null, 2));
  for (const file of card.files) {
    assert.equal(file.parse_status, "DONE");
    const { runs } = await json(`/api/v1/files/${file.id}/runs`, { headers });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "COMPLETE");
    const trace = await json(`/api/v1/files/${file.id}/runs/${runs[0].id}/trace?page=1`, { headers });
    assert.equal(trace.context.sha256, file.sha256);
    assert.equal(trace.completeness.publishable, true);
    assert.deepEqual(trace.completeness.reasons, []);
    assert.deepEqual([...new Set(trace.progress.map((p) => p.receipt.stage))], ["preflight", "parse", "merge", "extract", "aggregate"]);
    assert((trace.regions ?? [trace.page]).some((region) => region.lines.length > 0));
    writeFileSync(`${output}/${file.client_file_id}-trace.json`, JSON.stringify(trace, null, 2));
    if (trace.page.source === "ocr") {
      assert.deepEqual(trace.page.engines, ["ppocr-v5", "vl-reader"]);
      assert.deepEqual(trace.page.execution_failures, []);
    }
    evidence.files.push({ id: file.id, name: file.file_name, run_id: runs[0].id, source: trace.page.source,
      engines: trace.page.engines, agreement: trace.page.agreement, completeness: trace.completeness });
  }
  const protocol = await json(`${prefix}/protocol`, { headers });
  writeFileSync(`${output}/protocol.json`, JSON.stringify(protocol, null, 2));
  assert.equal(protocol.process_id, evidence.process_id);
  assert.equal(protocol.summary.confirmed_violations, 0);
  assert(JSON.stringify(protocol).includes('"trace_url"'), "protocol must link evidence to pipeline trace");
  if (process.env.PIPELINE_SMOKE_FIXTURE) {
    const fire = card.checks.find((c) => c.param_code === "M-023");
    assert.equal(fire.expected_value, "С0");
    assert.equal(fire.actual_value, "С1");
    assert.equal(fire.finding_status, "CANDIDATE");
    assert.equal(fire.verification_status, "PENDING");
    const candidate = protocol.sections.candidates.find((c) => c.param_code === "M-023");
    assert.equal(candidate.evidence_group_id, fire.evidence_group_id);
    for (const source of candidate.sources) {
      const saved = evidence.files.find((f) => f.id === source.file_id);
      assert.equal(source.pipeline_run_id, saved.run_id);
      assert.equal((await json(source.trace_url, { headers })).context.run_id, saved.run_id);
    }
    evidence.subject = { parameter: "M-023", expected: fire.expected_value, actual: fire.actual_value,
      finding: fire.finding_status, verification: fire.verification_status };
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  await page.goto(`${baseURL}/#/login`);
  await page.fill("#login", "inspector");
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL(/#\/inspections/);
  await page.goto(`${baseURL}/#/inspections/${evidence.process_id}`);
  await page.getByRole("button", { name: /^Документы/ }).click();
  evidence.browser = [];
  for (const pdf of card.files.filter((f) => f.kind === "pdf")) {
    await page.locator(`#doc-${pdf.id}`).click();
    const panel = page.getByRole("region", { name: "Трасса обработки", exact: true });
    await panel.getByRole("button", { name: "Трасса обработки", exact: true }).click();
    const saved = evidence.files.find((f) => f.id === pdf.id);
    const physicalPages = Number(execFileSync(resolve("ml/.venv/bin/python"), ["-c",
      "import sys,pypdfium2 as p;d=p.PdfDocument(sys.argv[1]);print(len(d));d.close()", resolve(fixture, pdf.file_name)], { encoding: "utf8", timeout: 10000 }).trim());
    assert(Number.isInteger(physicalPages) && physicalPages > 0);
    for (let number = 1; number <= physicalPages; number++) {
      if (number > 1) await page.getByRole("button", { name: "Следующая страница", exact: true }).click();
      const trace = await json(`/api/v1/files/${pdf.id}/runs/${saved.run_id}/trace?page=${number}`, { headers });
      const token = (trace.regions ?? [trace.page]).flatMap((region) => region.lines).flatMap((l) => l.tokens).find((t) => t.bbox);
      await panel.getByText(new RegExp(`^Страница ${number} ·`)).waitFor();
      const word = panel.locator('[aria-label="Транскрипция страницы"] button:enabled').first();
      await word.click();
      const overlay = page.locator(".hl.anchor").last();
      await overlay.waitFor({ timeout: 15000 });
      assert.equal(await overlay.getAttribute("data-label"), token.text);
      let painted;
      // Clicking changes marks and starts a PDF.js render. Wait for actual ink,
      // not a stale React ready flag from the preceding canvas render.
      for (let paintAttempt = 0; paintAttempt < 40; paintAttempt++) {
        painted = await overlay.evaluate((element, bbox) => {
        const sheet = element.parentElement;
        const canvas = sheet.querySelector("canvas.shown");
        const [x0, y0, x1, y1] = bbox;
        const pixels = canvas.getContext("2d").getImageData(Math.floor(x0 * canvas.width), Math.floor(y0 * canvas.height),
          Math.max(1, Math.ceil((x1 - x0) * canvas.width)), Math.max(1, Math.ceil((y1 - y0) * canvas.height))).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 150 && pixels[i + 1] < 150 && pixels[i + 2] < 150) dark++;
        return { left: parseFloat(element.style.left) / 100, top: parseFloat(element.style.top) / 100, dark: dark / (pixels.length / 4) };
        }, token.bbox);
        if (painted.dark > .01) break;
        await page.waitForTimeout(50);
      }
      assert(Math.abs(painted.left - (token.bbox[0] - .006)) < .00001);
      assert(Math.abs(painted.top - (token.bbox[1] - .006)) < .00001);
      const visibleSheet = await page.locator('.doc-view .sheet').first().boundingBox();
      assert(visibleSheet && visibleSheet.y + visibleSheet.height > 120 && visibleSheet.y < 900,
        'source sheet must remain visible while selecting transcript words');
      await page.screenshot({ path: `${output}/${pdf.client_file_id}-page-${number}.png`, fullPage: true });
      evidence.browser.push({ file: pdf.file_name, page: number, rotation: trace.page.region.geometry.rotation,
        token: token.text, overlay: true, ink_fraction: painted.dark });
      assert(painted.dark > .01, `bbox must overlap rendered text: ${pdf.file_name} page ${number}`);
    }
    await page.locator(`#doc-${pdf.id}`).click();
  }
  if (process.env.PIPELINE_SMOKE_COMPLETE === "1") {
    // Exercise the inspector lifecycle on synthetic data. Clarification is a
    // simulated workflow decision, never a claim that model findings are true.
    evidence.simulated_inspector_decisions = [];
    for (const check of card.checks.filter((c) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING")) {
      await json(`/api/v1/checks/${check.id}/decision`, { method: "POST", headers,
        data: { action: "clarify", comment: "СИНТЕТИЧЕСКАЯ проверка жизненного цикла; точность не оценивается" } });
      evidence.simulated_inspector_decisions.push({ check_id: check.id, action: "clarify" });
    }
    evidence.finalization = await json(`${prefix}/finalize`, { method: "POST", headers, data: { critical_reviewed: true } });
    assert.equal((await json(`${prefix}/status`, { headers })).status, "FINALIZED");
    assert.equal((await client.post(`${prefix}/finalize`, { headers, data: { critical_reviewed: true } })).status(), 409);
    evidence.exports = [];
    for (const format of ["json", "xml", "docx", "pdf"]) {
      const response = await client.get(`${prefix}/protocol/export?format=${format}`, { headers });
      assert(response.ok(), `export ${format}: HTTP ${response.status()}`);
      const bytes = await response.body();
      assert(bytes.length > 100, `export ${format} unexpectedly empty`);
      if (format === "pdf") assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      if (format === "docx") assert.equal(bytes.subarray(0, 2).toString(), "PK");
      writeFileSync(`${output}/protocol.${format}`, bytes);
      evidence.exports.push({ format, bytes: bytes.length });
    }
  }
  if (process.env.PIPELINE_SMOKE_VERIFICATION === "1") {
    const admin = await json("/api/v1/auth/login", { method: "POST", data: { login: "admin", password } });
    const adminHeaders = { authorization: `Bearer ${admin.token}` };
    const login = `smoke-${randomUUID()}`;
    await json("/api/v1/admin/verifiers", { method: "POST", headers: adminHeaders,
      data: { login, name: "СИНТЕТИЧЕСКАЯ проверка разметки", password } });
    const verifier = await json("/api/v1/auth/login", { method: "POST", data: { login, password } });
    const verifierHeaders = { authorization: `Bearer ${verifier.token}` };
    assert.equal((await client.get("/api/v1/inspections", { headers: verifierHeaders })).status(), 403);
    const file = manifest.files.find(f => f.file_name.endsWith(".pdf"));
    const original = readFileSync(`${fixture}/${file.file_name}`);
    const sourceVersion = `synthetic-${evidence.process_id}`;
    await json("/api/v1/verification/ingestions", { method: "POST", headers: adminHeaders, data: {
      id: sourceVersion, source_version: sourceVersion, tasks: [{ parameter: "M-007", operation: "reading",
        source_version: sourceVersion, sides: [{ sha256: createHash("sha256").update(original).digest("hex"),
          file_name: file.file_name, kind: "pdf", page: 1, object_key: manifest.object.object_id,
          value: "СИНТЕТИКА", stage: "PD", crop: null, artifact_sha256: null }] }] } });
    const { assignment } = await json("/api/v1/verification/assignments/next", { method: "POST", headers: verifierHeaders });
    assert(assignment, "synthetic annotation was not assigned");
    const sourceResponse = await client.get(assignment.task.sides[0].content_url, { headers: verifierHeaders });
    assert(sourceResponse.ok());
    assert.equal(createHash("sha256").update(await sourceResponse.body()).digest("hex"), createHash("sha256").update(original).digest("hex"));
    const answer = { token: assignment.token, idempotency_key: randomUUID(), answer: "UNSURE",
      comment: "СИНТЕТИЧЕСКАЯ проверка контракта; это не экспертная метка качества" };
    const labels = `/api/v1/verification/assignments/${assignment.id}/labels`;
    await json(labels, { method: "POST", headers: verifierHeaders, data: answer });
    assert.equal((await json(labels, { method: "POST", headers: verifierHeaders, data: answer })).replay, true);
    assert.equal((await client.get(assignment.task.sides[0].content_url, { headers: verifierHeaders })).status(), 403);
    const quality = await json("/api/v1/verification/quality", { headers: adminHeaders });
    assert.equal(quality.items.length, 528);
    evidence.data_verification = { source_digest_verified: true, role_isolation: true, label_replay: true,
      source_access_revoked: true, quality_cells: quality.items.length, synthetic_labels: 1 };
  }
  evidence.finished = new Date().toISOString();
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  await browser?.close();
  await client.dispose();
}
