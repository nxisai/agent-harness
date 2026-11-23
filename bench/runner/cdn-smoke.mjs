#!/usr/bin/env node
// The CDN build in a plain HTML page: no bundler, no npm install on the page's side. After `npm run build:cdn`:
//
//   npm --prefix bench ci     # once, for Playwright and its Chromium (npx playwright install chromium)
//   npm run smoke:cdn
//
// Two servers on 127.0.0.1: the CDN, standing in for S3 behind CloudFront (each object with the Content-Type and
// Cache-Control upload.json gives it as S3 metadata, plus the headers CloudFront's response headers policy for
// /harness/* adds: CORS, nosniff, CORP), and the site,
// serving one page and a stub model proxy at /api/agent (the proxy contract, docs/remote-providers.md). The page,
// on the site's origin:
//
//   - loads ui.js from the CDN with a <script type="module"> carrying the manifest's integrity hash;
//   - imports proxy.js through the minor alias, the alias's ui.js, and a second copy of the version under another
//     path (another module instance, as a second build on the page would be), to show the element is defined once
//     and nothing throws;
//   - points <nxis-agent> at the stub with createProxyProvider.
//
// Then it opens the chat, sends one message, and waits for the stub's reply in the thread. It fails on any page
// error, a console error, a lazy chunk not fetched from the CDN, or a missing CORS or cache header.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'dist-cdn');
const REPLY = 'Hello from the stub proxy.';
const QUESTION = 'Is the CDN build working?';

if (!existsSync(join(OUT, 'upload.json'))) {
  console.error('cdn-smoke: dist-cdn/ is missing. Run `npm run build && npm run build:cdn` first.');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));
const minor = version.split('.').slice(0, 2).join('.');
const manifest = JSON.parse(readFileSync(join(OUT, 'harness', version, 'manifest.json'), 'utf8'));
const { objects } = JSON.parse(readFileSync(join(OUT, 'upload.json'), 'utf8'));
const metadata = new Map(objects.map((o) => [`/${o.key}`, o]));
/** What the response headers policy adds. */
const POLICY = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' };

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/** The CDN: dist-cdn/, plus /copy/ (the same tree again, so the browser loads it as a separate module graph). */
const cdnRequests = [];
const cdn = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  cdnRequests.push(path);
  const inTree = path.startsWith('/copy/') ? path.slice('/copy'.length) : path;
  const file = normalize(join(OUT, inTree));
  if (!file.startsWith(join(OUT, 'harness')) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  // /copy/ is not in the upload plan: served as its version's twin.
  const meta = metadata.get(inTree);
  if (!meta) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': meta.contentType, 'Cache-Control': meta.cacheControl, ...POLICY });
  res.end(readFileSync(file));
});
const cdnPort = await listen(cdn);
const CDN = `http://127.0.0.1:${cdnPort}`;

/** The site: the page, and the stub model proxy. */
const proxyCalls = [];
const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>CDN smoke</title></head>
<body>
<script type="module" src="${CDN}/harness/${version}/ui.js" integrity="${manifest.files['ui.js'].integrity}" crossorigin="anonymous"></script>
<script type="module">
  const { createProxyProvider } = await import('${CDN}/harness/${minor}/proxy.js');
  await import('${CDN}/harness/${minor}/ui.js');
  const copy = await import('${CDN}/copy/harness/${version}/ui.js');
  const el = document.createElement('nxis-agent');
  el.modelProvider = createProxyProvider({ endpoint: '/api/agent' });
  document.body.append(el);
  window.__smoke = {
    defined: customElements.get('nxis-agent') === el.constructor,
    copyIsOther: copy.NxisAgent !== el.constructor,
    nativeDefine: customElements.define === Object.getPrototypeOf(customElements).define,
  };
</script>
</body>
</html>`;
const site = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
    return;
  }
  if (path === '/api/agent' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    proxyCalls.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: REPLY, usage: { promptTokens: 12, outputTokens: 5 }, model: 'Stub' }));
    return;
  }
  res.writeHead(404).end();
});
const sitePort = await listen(site);
const SITE = `http://localhost:${sitePort}`;

const failures = [];
const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // A failed load is reported by URL below; the console's copy of it names none.
  tab.on('console', (m) => m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const responses = [];
  tab.on('response', (r) => {
    if (r.url().startsWith(CDN)) responses.push(r);
    // The element looks for the site's catalogs under /.well-known/; a plain site has none, and that is fine.
    if (r.status() >= 400 && !r.url().startsWith(`${SITE}/.well-known/`)) errors.push(`${r.status()} ${r.url()}`);
  });

  await tab.goto(SITE);
  await tab.waitForFunction(() => window.__smoke, null, { timeout: 30_000 });
  const smoke = await tab.evaluate(() => window.__smoke);
  if (!smoke.defined) failures.push('<nxis-agent> is not the element the page created');
  if (!smoke.copyIsOther) failures.push('the /copy/ build was not a separate module instance, so it proved nothing');
  if (!smoke.nativeDefine) failures.push("customElements.define is not the registry's own after loading");

  await tab.evaluate(() => document.querySelector('nxis-agent').open());
  const input = tab.locator('nxis-agent .composer textarea');
  await input.fill(QUESTION);
  await input.press('Enter');
  await tab.locator('nxis-agent').getByText(REPLY).first().waitFor({ timeout: 30_000 });

  if (proxyCalls.length !== 1) failures.push(`the stub proxy got ${proxyCalls.length} calls, not 1`);
  else if (!JSON.stringify(proxyCalls[0].messages).includes(QUESTION)) failures.push('the stub proxy did not get the question');

  // A lazy chunk came from the CDN, beside ui.js: the guardrails load at the first open or send.
  if (!cdnRequests.some((p) => p === `/harness/${version}/${manifest.chunks.guardrails}`)) failures.push('the guardrails chunk was not fetched from the CDN');
  const ui = responses.find((r) => r.url() === `${CDN}/harness/${version}/ui.js`);
  if (!ui) failures.push('ui.js was not fetched');
  else {
    const h = ui.headers();
    if (h['access-control-allow-origin'] !== '*') failures.push('ui.js has no Access-Control-Allow-Origin');
    if (!/immutable/.test(h['cache-control'] ?? '')) failures.push('ui.js is not cached as immutable');
  }
  const alias = responses.find((r) => r.url() === `${CDN}/harness/${minor}/ui.js`);
  if (alias && /immutable/.test(alias.headers()['cache-control'] ?? '')) failures.push('the alias is cached as immutable');
  failures.push(...errors);

  console.log(`cdn-smoke: ${version} from ${CDN}, page on ${SITE}`);
  console.log(`  one turn: "${QUESTION}" → "${REPLY}" (${proxyCalls.length} proxy call)`);
  console.log(`  fetched from the CDN: ${[...new Set(cdnRequests)].length} file(s), guardrails chunk ${manifest.chunks.guardrails}`);
  console.log(`  loaded three ways (SRI tag, minor alias, a second copy): element defined once, ${errors.length} page error(s)`);
} catch (err) {
  failures.push(err.message);
} finally {
  await browser.close();
  cdn.close();
  site.close();
}

console.log(failures.length ? `\ncdn smoke FAILED:\n  - ${failures.join('\n  - ')}` : '\ncdn smoke ok');
process.exit(failures.length ? 1 : 0);
