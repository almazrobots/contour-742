// Browser audit for the shared GERA documentation navigation and trace-map views.
// Local mode serves a docs root (default: docs); URL mode uses TRACE_DOCS_BASE as either
// the docs root, its `gera/` directory, or the direct TRACE-MAP.html URL.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const output = resolve("out/trace-docs-audit");
mkdirSync(output, { recursive: true });
const expected = ["detail", "map", "doc", "architecture", "pipeline", "coverage", "audit", "catalog", "metrics", "gaps", "guide"];
const errors = [];
let server;
let browser;
let traceUrl;
let archUrl;
let pipelineUrl;
let guideUrl;

function navigationBaseFromUrl(value) {
  const url = new URL(value);
  if (url.pathname.endsWith(".html")) {
    if (!url.pathname.endsWith("TRACE-MAP.html")) throw new Error("TRACE_DOCS_BASE HTML URL must end in TRACE-MAP.html");
    url.search = "";
    url.hash = "";
    return new URL("./", url);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  if (url.pathname.endsWith("/gera/")) return url;
  return new URL("gera/", url);
}

if (process.env.TRACE_DOCS_BASE) {
  const gera = navigationBaseFromUrl(process.env.TRACE_DOCS_BASE);
  traceUrl = new URL("TRACE-MAP.html", gera).href;
  archUrl = new URL("ARCHITECTURE.html", gera).href;
  pipelineUrl = new URL("PIPELINE.html", gera).href;
  guideUrl = new URL("../guide/index.html", gera).href;
} else {
  let root = resolve(process.argv[2] || "docs");
  if (statSync(root).isFile()) root = resolve(root, "..");
  if (!existsSync(resolve(root, "gera/TRACE-MAP.html")) && existsSync(resolve(root, "TRACE-MAP.html"))) root = resolve(root, "..");
  assert.ok(existsSync(resolve(root, "gera/TRACE-MAP.html")), `missing ${resolve(root, "gera/TRACE-MAP.html")}`);
  for (const path of ["gera/ARCHITECTURE.html", "gera/PIPELINE.html", "guide/index.html"]) {
    assert.ok(existsSync(resolve(root, path)), `missing ${resolve(root, path)}`);
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  server = createServer((req, res) => {
    let requestPath;
    try { requestPath = decodeURIComponent(new URL(req.url, "http://local").pathname); } catch { res.writeHead(400).end(); return; }
    const path = resolve(root, `.${requestPath}`);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
    res.end(readFileSync(path));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const docsUrl = `http://127.0.0.1:${server.address().port}/gera/`;
  traceUrl = new URL("TRACE-MAP.html", docsUrl).href;
  archUrl = new URL("ARCHITECTURE.html", docsUrl).href;
  pipelineUrl = new URL("PIPELINE.html", docsUrl).href;
  guideUrl = new URL("../guide/index.html", docsUrl).href;
}

try {
  browser = await chromium.launch({ headless: true });
  const httpCredentials = process.env.TRACE_DOCS_AUTH_FILE ? JSON.parse(readFileSync(process.env.TRACE_DOCS_AUTH_FILE, "utf8")) : undefined;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, httpCredentials });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(traceUrl, {waitUntil:"domcontentloaded"});
  const traceNav = page.locator(".doc-nav");
  await traceNav.waitFor();
  const traceItems = await traceNav.locator("a[data-doc-view]").evaluateAll((as) => as.map((a) => ({ key: a.dataset.docView, label: a.textContent.trim(), href: new URL(a.href).href })));
  assert.deepEqual(traceItems.map((item) => item.key), expected, "trace navigation order");
  assert.equal(await page.locator("#summary-drawer").getAttribute("open"), null, "drawer starts closed in a fresh profile");
  assert.equal(await page.locator("#stats").isVisible(), false, "summary stats are hidden while drawer is closed");
  await page.locator("#summary-drawer summary").click();
  assert.equal(await page.locator("#summary-drawer").getAttribute("open"), "");
  assert.equal(await page.locator("#stats").isVisible(), true);
  await page.locator("#summary-drawer summary").click();
  await page.reload();
  assert.equal(await page.locator("#summary-drawer").getAttribute("open"), null, "closed drawer state persists on reload");
  await page.locator("#summary-drawer summary").click();
  await page.reload();
  assert.equal(await page.locator("#summary-drawer").getAttribute("open"), "", "open drawer state persists on reload");

  const views = ["detail", "map", "doc", "coverage", "audit", "catalog", "metrics", "gaps"];
  for (const view of views) {
    await page.goto(`${traceUrl}?view=${view}`, {waitUntil:"domcontentloaded"});
    await page.locator(".doc-nav a[aria-current='page']").waitFor();
    assert.equal(await page.locator(".doc-nav a[aria-current='page']").getAttribute("data-doc-view"), view, `${view} nav selection`);
    assert.ok(await page.locator("#stage").evaluate((stage) => stage.children.length > 0), `${view} renders its stage`);
  }

  for (const url of [traceUrl, archUrl, pipelineUrl, guideUrl]) {
    await page.goto(url, {waitUntil:"domcontentloaded"});
    const entries = await page.locator(".doc-nav a[data-doc-view]").evaluateAll((as) => as.map((a) => ({ key: a.dataset.docView, label: a.textContent.trim(), href: new URL(a.href).href })));
    assert.deepEqual(entries, traceItems, `shared nav contract on ${url}`);
    assert.equal(entries[1].href, new URL("TRACE-MAP.html?view=map", traceUrl).href, "map link returns to trace map");
  }

  await page.goto(traceUrl, {waitUntil:"domcontentloaded"});
  await page.locator(".doc-nav a[data-doc-view='architecture']").click();
  await page.waitForURL(archUrl);
  assert.equal(await page.locator(".doc-nav a[aria-current='page']").getAttribute("data-doc-view"), "architecture");
  await page.locator(".doc-nav a[data-doc-view='map']").click();
  await page.waitForURL((url) => url.pathname.endsWith("/TRACE-MAP.html") && url.searchParams.get("view") === "map");

  for (const [name, url] of [["trace", traceUrl], ["architecture", archUrl], ["pipeline", pipelineUrl], ["guide", guideUrl]]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url, {waitUntil:"domcontentloaded"});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `mobile ${name} page has no horizontal overflow`);
    const technicalNavigation = page.locator("details.technical-nav");
    if (name === "guide" && await technicalNavigation.count()) {
      if (!await technicalNavigation.locator("summary").isVisible()) await page.locator("#sidebar-toggle").click();
      await technicalNavigation.locator("summary").click();
      await page.locator(".doc-nav").waitFor({ state: "visible" });
      assert.ok(await page.locator(".doc-nav").evaluate((nav) => nav.getBoundingClientRect().right <= innerWidth + 1), "guide navigation fits its sidebar");
    } else {
      assert.ok(await page.locator(".doc-nav .links").evaluate((links) => links.scrollWidth > links.clientWidth), `mobile ${name} navigation scrolls horizontally`);
    }
    if (name === "trace") await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url, {waitUntil:"domcontentloaded"});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `desktop ${name} page has no horizontal overflow`);
    await page.screenshot({ path: `${output}/${name}-desktop.png`, fullPage: true });
  }
  assert.deepEqual(errors, [], "no browser JavaScript errors");

  writeFileSync(`${output}/status.json`, JSON.stringify({ ok: true, navigationOrder: expected, views, drawer: { closedDefault: true, hidesStats: true, openClosePersists: true }, crossPageNavigation: true, responsivePages: ["trace", "architecture", "pipeline", "guide"], mobileNav: "scrollable header or collapsible guide sidebar", noHorizontalOverflow: true, browserErrors: errors, screenshots: ["desktop.png", "mobile.png"] }, null, 2));
  console.log(`trace docs check: ${expected.length} shared nav items, ${views.length} views, drawer persistence, cross-page links, responsive layout across 4 pages OK`);
} catch (error) {
  writeFileSync(`${output}/status.json`, JSON.stringify({ ok: false, message: error.message, browserErrors: errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
}
