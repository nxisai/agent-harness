#!/usr/bin/env node
// `contained` in a real browser. After `npm run build && npm run build:cdn`:
//
//   npm --prefix bench ci     # once, for Playwright and its Chromium
//   npm run check:contained -- [out.png]
//
// Two pages, each loading the CDN build's ui.js from 127.0.0.1, with the same name, logo, theme and stub provider:
//
//   - the page: <nxis-agent> in window mode, in a 640 × 760 viewport;
//   - the preview: <nxis-agent contained> in a 640 × 760 box on a larger page.
//
// It measures the preview's launcher and window against the box (20px from its bottom right, 400 × 620), checks
// the launcher opens it and ✕ closes it, that the preview requests nothing but the element's own files, and
// compares a screenshot of the box with one of the page, pixel for pixel (to within 2/255 a channel, for the shadow's
// rasterization): closed; open with messages off (the default), outside the composer, which is disabled there and
// compared apart; and open with allow-input, all of it. It also checks that with messages off the input and send
// button are disabled and the chips send nothing. The screenshots
// are written side by side to out.png (default: contained-compare.png in the working directory).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'dist-cdn');
const SHOT = resolve(process.argv[2] ?? 'contained-compare.png');
if (!existsSync(join(OUT, 'meta.json'))) {
  console.error('contained-check: dist-cdn/ is missing. Run `npm run build && npm run build:cdn` first.');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));
/** The most a channel may differ by: shadow rasterization, see the comparison below. */
const TOLERANCE = 2;
const W = 640;
const H = 760;

const LOGO = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="9" fill="#123F35"/><path d="M9 12l5 16 6-12 6 12 5-16" fill="none" stroke="#F2C14E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="9" r="3" fill="#E4572E"/></svg>`;
const setup = (attrs) => `
  await import('/harness/${version}/ui.js');
  const el = document.createElement('nxis-agent');
  ${attrs.map((a) => `el.setAttribute('${a}', '');`).join(' ')}
  el.setAttribute('discover', 'false');
  el.name = 'Wrenfield';
  el.logo = ${JSON.stringify(LOGO)};
  el.theme = { accent: '#C2410C', accentStrong: '#9A3412', accentTint: '#FFF1E8' };
  el.emptyState = 'This chat is run by NxisAI for this site.';
  el.suggestions = ['What can you do on this page?', 'What information is available here?'];
  el.modelProvider = { name: 'preview', label: 'proxy', local: false, ready: true, loading: false, complete: async () => ({ text: 'Hi.' }) };
`;
const pages = {
  '/page': `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style></head><body>
<script type="module">${setup([])} document.body.append(el); window.__el = el;</script></body></html>`,
  '/preview': `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#E9EDF3}
#box{position:absolute;left:280px;top:70px;width:${W}px;height:${H}px;background:#fff}
</style></head><body><div id="box"></div>
<script type="module">${setup(['contained'])} document.getElementById('box').append(el); window.__el = el;</script></body></html>`,
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pages[path]) return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages[path]);
  const file = normalize(join(OUT, path));
  if (!file.startsWith(join(OUT, 'harness')) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (ok, msg) => ok || failures.push(msg);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const preview = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const previewRequests = [];
  preview.on('request', (q) => previewRequests.push(q.url().replace(BASE, '')));
  for (const [tab, path] of [[page, '/page'], [preview, '/preview']]) {
    tab.on('pageerror', (e) => failures.push(`${path}: ${e.message}`));
    await tab.goto(BASE + path);
    await tab.waitForFunction(() => window.__el?.shadowRoot?.querySelector('.launcher'));
  }
  const settle = (tab) => tab.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const rects = () =>
    preview.evaluate(() => {
      const box = document.getElementById('box').getBoundingClientRect();
      const r = (sel) => window.__el.shadowRoot.querySelector(sel).getBoundingClientRect();
      const rel = (x) => ({ right: box.right - x.right, bottom: box.bottom - x.bottom, width: x.width, height: x.height, left: x.left - box.left, top: x.top - box.top });
      return { launcher: rel(r('.launcher')), window: rel(r('.overlay')), shown: window.__el.shadowRoot.querySelector('.overlay').classList.contains('show') };
    });
  const shots = [];
  const shoot = async (label, mask = null) => {
    await settle(page);
    await settle(preview);
    shots.push({
      label,
      mask,
      page: await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }),
      preview: await preview.locator('#box').screenshot(),
    });
  };

  // Closed: the launcher, 20px from the box's bottom right, 56 × 56.
  let r = await rects();
  check(!r.shown, 'the preview starts closed');
  check(r.launcher.right === 20 && r.launcher.bottom === 20 && r.launcher.width === 56 && r.launcher.height === 56, `launcher not at the box's corner: ${JSON.stringify(r.launcher)}`);
  await shoot('closed');

  // Open from the launcher: the window, 20px from the box's bottom right, 400 × 620, inside the box.
  await preview.evaluate(() => window.__el.shadowRoot.querySelector('.launcher').click());
  await page.evaluate(() => window.__el.shadowRoot.querySelector('.launcher').click());
  r = await rects();
  check(r.shown, 'the launcher did not open the preview');
  check(r.window.right === 20 && r.window.bottom === 20 && r.window.width === 400 && r.window.height === 620, `window not at the box's corner: ${JSON.stringify(r.window)}`);
  check(r.window.left >= 0 && r.window.top >= 0, 'the window spills out of the box');
  // Focus is in the composer on both; take it out so neither draws a caret.
  for (const tab of [page, preview]) await tab.evaluate(() => window.__el.shadowRoot.activeElement?.blur());
  // Messages are off by default: the composer is the one part that differs, so it is compared apart.
  const composer = await preview.evaluate(() => {
    const box = document.getElementById('box').getBoundingClientRect();
    const c = window.__el.shadowRoot.querySelector('.composer').getBoundingClientRect();
    return [Math.floor(c.left - box.left), Math.floor(c.top - box.top), Math.ceil(c.right - box.left), Math.ceil(c.bottom - box.top)];
  });
  const off = await preview.evaluate(async () => {
    const root = window.__el.shadowRoot;
    const ta = root.querySelector('.composer textarea');
    const chips = [...root.querySelectorAll('.thread .chip')];
    chips.forEach((c) => c.click());
    root.querySelector('.composer .go').click();
    await new Promise((r) => setTimeout(r, 100));
    return { disabled: ta.disabled, send: root.querySelector('.composer .go').disabled, placeholder: ta.placeholder, chips: chips.length, sent: root.querySelectorAll('.thread .msg').length };
  });
  check(off.disabled && off.send, 'messages off: the input or the send button is not disabled');
  check(off.placeholder === 'Preview only: messages are off', `messages off: the placeholder reads ${off.placeholder}`);
  check(off.chips > 0 && off.sent === 0, `messages off: ${off.sent} message(s) sent from ${off.chips} chip(s)`);
  await shoot('open, messages off', composer);

  // With allow-input, the whole window is the visitor's.
  await preview.evaluate(() => { window.__el.allowInput = true; window.__el.shadowRoot.activeElement?.blur(); });
  await shoot('open, allow-input');

  // Expand fills the box; shrink puts it back; ✕ closes to the launcher.
  await preview.evaluate(() => window.__el.shadowRoot.querySelector('.modebtn').click());
  r = await rects();
  check(r.window.left === 0 && r.window.top === 0 && r.window.width === W && r.window.height === H, `expanded, the window does not fill the box: ${JSON.stringify(r.window)}`);
  await preview.evaluate(() => window.__el.shadowRoot.querySelector('.modebtn').click());
  r = await rects();
  check(r.window.width === 400 && r.window.height === 620, 'shrinking did not restore the window');
  await preview.evaluate(() => window.__el.shadowRoot.querySelector('.close').click());
  r = await rects();
  check(!r.shown, '✕ did not close the preview');

  // A box smaller than the window: capped to it, less 16px a side.
  await preview.evaluate(() => Object.assign(document.getElementById('box').style, { width: '360px', height: '500px' }));
  await preview.evaluate(() => window.__el.shadowRoot.querySelector('.launcher').click());
  r = await rects();
  check(r.window.width === 360 - 32 && r.window.height === 500 - 32 && r.window.right === 20, `not capped to a small box: ${JSON.stringify(r.window)}`);

  // Nothing fetched but the pages and the element's own files.
  const foreign = previewRequests.filter((p) => p !== '/preview' && !p.startsWith(`/harness/${version}/`));
  check(foreign.length === 0, `the preview requested ${foreign.join(', ')}`);

  // Pixel comparison, in the browser.
  const diffs = [];
  for (const s of shots) {
    const n = await preview.evaluate(
      async ([a, b, mask]) => {
        const inMask = (x, y) => mask && x >= mask[0] && x < mask[2] && y >= mask[1] && y < mask[3];
        const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return -1;
        const px = (img) => { const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
        const [da, db] = [px(ia), px(ib)];
        let d = 0;
        let max = 0;
        let masked = 0;
        let box = [1e9, 1e9, -1, -1];
        for (let i = 0; i < da.length; i += 4) {
          const m = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
          if (!m) continue;
          const x = (i / 4) % ia.width, y = Math.floor(i / 4 / ia.width);
          if (inMask(x, y)) { masked++; continue; }
          d++;
          max = Math.max(max, m);
          box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
        }
        return { d, max, box, masked };
      },
      [`data:image/png;base64,${s.page.toString('base64')}`, `data:image/png;base64,${s.preview.toString('base64')}`, s.mask],
    );
    diffs.push(
      `${s.label}: ${n.d} differing pixels, at most ${n.max}/255 in a channel, within ${JSON.stringify(n.box)}` +
        (s.mask ? `; the composer (${JSON.stringify(s.mask)}), compared apart: ${n.masked} pixels differ` : ''),
    );
    // A fixed element is composited in a layer of its own and an absolute one in the box's, and Chromium rasterizes
    // the window's blurred shadow 1 or 2 levels apart between the two. Anything more is a real difference.
    check(n.max <= TOLERANCE, `${s.label}: the preview differs from the page by up to ${n.max}/255 in ${n.d} pixels`);
  }

  // The screenshots, side by side.
  const sheet = await browser.newPage({ viewport: { width: 2 * W + 3 * 24, height: shots.length * (H + 40) + 24 } });
  const img = (b) => `<img src="data:image/png;base64,${b.toString('base64')}" width="${W}" height="${H}">`;
  await sheet.setContent(`<style>body{margin:0;padding:12px;background:#334155;font:600 14px system-ui;color:#fff;display:grid;grid-template-columns:repeat(2,${W}px);gap:0 24px;padding:12px 24px}figure{margin:0 0 12px}figcaption{height:28px}img{display:block;outline:1px dashed #94a3b8}</style>
    ${shots.map((s) => `<figure><figcaption>window mode, a ${W}×${H} page (${s.label})</figcaption>${img(s.page)}</figure><figure><figcaption>contained, a ${W}×${H} box (${s.label})</figcaption>${img(s.preview)}</figure>`).join('')}`);
  writeFileSync(SHOT, await sheet.screenshot({ fullPage: true }));
  console.log(diffs.join('\n'));
  console.log(`requests from the preview: ${[...new Set(previewRequests)].join(', ')}`);
  console.log(`screenshots: ${SHOT}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`contained-check FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('contained-check ok');
