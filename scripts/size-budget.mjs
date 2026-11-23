#!/usr/bin/env node
// Size budgets for what a site pays on page load, checked against the built dist/.
//
// The packaged element (`@nxisai/agent-harness/ui`) is bundled here the way a site's bundler would bundle it:
// esbuild, ESM, minified, with code splitting on, so every dynamic `import()` becomes a chunk of its own that loads
// only when it runs. The page-load graph is the entry chunk plus everything it imports statically; that is what a
// visitor downloads before touching anything. Then:
//
//   - the page-load graph may not grow more than `marginBytes` (gzip) over `baselineBytes`, the size measured
//     before the in-chat media work began;
//   - the media module (`src/media/*`, the `./media` subpath) must never be in it: it loads with a dynamic
//     `import()` on the first Play tap, and its chunk, with whatever it alone pulls in, stays under `mediaMaxBytes`;
//   - hls.js may never be in it (the site injects its own loader; nothing here bundles one);
//   - the main entry (`@nxisai/agent-harness`) may not reach the media module either;
//   - the guardrails (`src/guardrails/*`, the `./guardrails` subpath) are never in either page-load graph: they load
//     with a dynamic `import()` at the first open or send, and their chunk stays under `guardrails.maxBytes`;
//   - the chunk that fetches the model proxy's policy (`src/guardrails/remote.ts`, loaded by the guardrails only with
//     `guardrails-src`) stays under `guardrailsRemote.maxBytes`;
//   - the event cards (`src/ui/event-cards.ts` with the event model, `src/harness/happening.ts`) are never in the ui
//     page-load graph: they load with a dynamic `import()` with the first result that is an event, and their chunk
//     stays under `events.maxBytes`;
//   - every other lazy chunk stays under `lazyChunk.maxBytes`.
//
// With `--cdn`, the same checks run on the CDN build itself (scripts/build-cdn.mjs, `dist-cdn/`), file for file, plus
// its standalone `proxy.js` against `cdnProxy.maxBytes`. The CDN build uses the same esbuild options as the bundle
// measured here (scripts/bundle-options.mjs).
//
//   node scripts/size-budget.mjs          check, after `npm run build`; exit 1 when a budget is broken
//   node scripts/size-budget.mjs --cdn    check the CDN build, after `npm run build:cdn`
//   node scripts/size-budget.mjs --json   the measurements as JSON, for a CI summary
//
// The budgets live in scripts/size-budget.json. Raising one is a decision to make in review, not a side effect.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { UI_BUNDLE } from './bundle-options.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUDGET = JSON.parse(readFileSync(join(ROOT, 'scripts/size-budget.json'), 'utf8'));
const asJson = process.argv.includes('--json');
const cdn = process.argv.includes('--cdn');

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const isMedia = (input) => /(^|\/)dist\/media\//.test(input);
const isGuardrails = (input) => /(^|\/)dist\/guardrails\//.test(input);
const isHls = (input) => /node_modules\/hls\.js\//.test(input);
const isEvents = (input) => /(^|\/)dist\/(ui\/event-cards|harness\/happening|a2ui\/events)\.js$/.test(input);

/**
 * Walk a build's static imports from its entry chunk.
 *
 * @param outputs the esbuild metafile's outputs, keyed by path relative to the repository root
 * @returns the page-load graph (entry plus static imports) and every lazy chunk, each with its sizes and inputs.
 */
function analyze(outputs) {
  const chunks = Object.keys(outputs).filter((k) => k.endsWith('.js'));
  // The entry: the chunk with an entry point that nothing imports (a dynamic import()'s chunk has an entry point too).
  const imported = new Set(chunks.flatMap((k) => outputs[k].imports.map((i) => i.path)));
  const entryOut = chunks.find((k) => outputs[k].entryPoint && !imported.has(k));
  const staticFrom = (from, seen = new Set()) => {
    if (seen.has(from)) return seen;
    seen.add(from);
    for (const i of outputs[from].imports) if (i.kind === 'import-statement') staticFrom(i.path, seen);
    return seen;
  };
  const sizeOf = (keys) => {
    let raw = 0;
    let gzip = 0;
    for (const k of keys) {
      const b = readFileSync(join(ROOT, k));
      raw += b.length;
      gzip += gz(b);
    }
    return { raw, gzip };
  };
  const inputsOf = (keys) => [...new Set([...keys].flatMap((k) => Object.keys(outputs[k].inputs)))];
  const initial = staticFrom(entryOut);
  // A lazy chunk's real cost: itself, plus the shared chunks it imports that the page has not already loaded.
  const lazy = chunks
    .filter((k) => !initial.has(k))
    .map((k) => {
      const own = [...staticFrom(k)].filter((c) => !initial.has(c));
      return { chunk: k, ...sizeOf(own), inputs: inputsOf(own) };
    });
  return { entry: entryOut, initial: { ...sizeOf(initial), chunks: initial.size, inputs: inputsOf(initial) }, lazy };
}

/** Bundle one entry with the shipped options into a scratch directory, and analyze it. */
async function measure(entry) {
  const outdir = mkdtempSync(join(tmpdir(), 'nxis-size-'));
  try {
    const result = await build({
      ...UI_BUNDLE,
      entryPoints: [join(ROOT, entry)],
      outdir,
      metafile: true,
      write: true,
      logLevel: 'silent',
      absWorkingDir: ROOT,
    });
    return analyze(result.metafile.outputs);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const UI = 'dist/ui/index.js';
const MAIN = 'dist/index.js';
for (const f of [UI, MAIN]) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`size-budget: ${f} is missing. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

/** The CDN build's metafiles (written by scripts/build-cdn.mjs beside the published tree, never published). */
const CDN_META = 'dist-cdn/meta.json';
if (cdn && !existsSync(join(ROOT, CDN_META))) {
  console.error(`size-budget: ${CDN_META} is missing. Run \`npm run build:cdn\` first.`);
  process.exit(2);
}
const cdnMeta = cdn ? JSON.parse(readFileSync(join(ROOT, CDN_META), 'utf8')) : null;

const ui = cdn ? analyze(cdnMeta.ui.outputs) : await measure(UI);
const main = await measure(MAIN);
// The media module's chunk: the lazy chunk whose own inputs hold src/media/index (built to dist/media/index.js).
const media = ui.lazy.find((c) => c.inputs.some((i) => /dist\/media\/index\.js$/.test(i)));
// The guardrails' chunk, likewise, and the chunk that fetches the model proxy's policy (`guardrails-src`).
const guardrails = ui.lazy.find((c) => c.inputs.some((i) => /dist\/guardrails\/index\.js$/.test(i)));
const remote = ui.lazy.find((c) => c.inputs.some((i) => /dist\/guardrails\/remote\.js$/.test(i)));
// The event cards' chunk.
const events = ui.lazy.find((c) => c.inputs.some((i) => /dist\/ui\/event-cards\.js$/.test(i)));

const failures = [];
const limit = BUDGET.ui.baselineBytes + BUDGET.ui.marginBytes;
if (ui.initial.gzip > limit) {
  failures.push(
    `the ui page-load graph is ${kb(ui.initial.gzip)} gzip, over its budget of ${kb(limit)} ` +
      `(baseline ${kb(BUDGET.ui.baselineBytes)} + ${kb(BUDGET.ui.marginBytes)})`,
  );
}
const eagerMedia = ui.initial.inputs.filter(isMedia);
if (eagerMedia.length) failures.push(`the media module is in the ui page-load graph (imported statically): ${eagerMedia.join(', ')}`);
const mainMedia = main.initial.inputs.filter(isMedia);
if (mainMedia.length) failures.push(`the media module is in the main entry's page-load graph: ${mainMedia.join(', ')}`);
const hls = [...ui.initial.inputs, ...main.initial.inputs].filter(isHls);
if (hls.length) failures.push(`hls.js is in a page-load graph: ${hls[0]}`);
const eagerGuardrails = [...ui.initial.inputs, ...main.initial.inputs].filter(isGuardrails);
if (eagerGuardrails.length) failures.push(`the guardrails are in a page-load graph (imported statically): ${eagerGuardrails.join(', ')}`);
if (!guardrails) failures.push('the ui entry loads no guardrails chunk: every turn must pass through them');
if (guardrails && guardrails.gzip > BUDGET.guardrails.maxBytes) {
  failures.push(`the guardrails chunk is ${kb(guardrails.gzip)} gzip, over its budget of ${kb(BUDGET.guardrails.maxBytes)}`);
}
if (remote && remote.gzip > BUDGET.guardrailsRemote.maxBytes) {
  failures.push(`the guardrails policy chunk is ${kb(remote.gzip)} gzip, over its budget of ${kb(BUDGET.guardrailsRemote.maxBytes)}`);
}
const eagerEvents = ui.initial.inputs.filter(isEvents);
if (eagerEvents.length) failures.push(`the event cards are in the ui page-load graph (imported statically): ${eagerEvents.join(', ')}`);
if (events && events.gzip > BUDGET.events.maxBytes) {
  failures.push(`the event cards chunk is ${kb(events.gzip)} gzip, over its budget of ${kb(BUDGET.events.maxBytes)}`);
}
if (media && media.gzip > BUDGET.media.maxBytes) {
  failures.push(`the media chunk is ${kb(media.gzip)} gzip, over its budget of ${kb(BUDGET.media.maxBytes)}`);
}
/** A chunk's name for the report: its path in the CDN build, or its file name in a scratch build. */
const label = (k) => (cdn ? relative(ROOT, join(ROOT, k)) : k.split('/').pop());
// Every other lazy chunk (sources, feedback, and whatever splitting shares between them).
const budgeted = new Set([media, guardrails, remote, events].filter(Boolean).map((c) => c.chunk));
const others = ui.lazy.filter((c) => !budgeted.has(c.chunk));
for (const c of others) {
  if (c.gzip > BUDGET.lazyChunk.maxBytes) {
    failures.push(`the lazy chunk ${label(c.chunk)} is ${kb(c.gzip)} gzip, over its budget of ${kb(BUDGET.lazyChunk.maxBytes)}`);
  }
}
// The CDN build's standalone proxy provider, which a page imports beside ui.js to reach a model proxy.
let proxy = null;
if (cdn) {
  const out = Object.keys(cdnMeta.proxy.outputs).find((k) => k.endsWith('.js'));
  const b = readFileSync(join(ROOT, out));
  proxy = { gzip: gz(b), raw: b.length, limit: BUDGET.cdnProxy.maxBytes, chunk: out };
  if (Object.keys(cdnMeta.proxy.outputs).filter((k) => k.endsWith('.js')).length !== 1) failures.push('the CDN proxy.js must be one self-contained file');
  if (proxy.gzip > BUDGET.cdnProxy.maxBytes) failures.push(`the CDN proxy.js is ${kb(proxy.gzip)} gzip, over its budget of ${kb(BUDGET.cdnProxy.maxBytes)}`);
}

const report = {
  ui: { gzip: ui.initial.gzip, raw: ui.initial.raw, chunks: ui.initial.chunks, baseline: BUDGET.ui.baselineBytes, limit },
  main: { gzip: main.initial.gzip, raw: main.initial.raw },
  media: media ? { gzip: media.gzip, raw: media.raw, limit: BUDGET.media.maxBytes, chunk: relative(ROOT, media.chunk) } : null,
  guardrails: guardrails
    ? { gzip: guardrails.gzip, raw: guardrails.raw, limit: BUDGET.guardrails.maxBytes, chunk: relative(ROOT, guardrails.chunk) }
    : null,
  guardrailsRemote: remote ? { gzip: remote.gzip, raw: remote.raw, limit: BUDGET.guardrailsRemote.maxBytes, chunk: relative(ROOT, remote.chunk) } : null,
  events: events ? { gzip: events.gzip, raw: events.raw, limit: BUDGET.events.maxBytes, chunk: label(events.chunk) } : null,
  lazyChunks: ui.lazy.length,
  otherLazy: others.map((c) => ({ gzip: c.gzip, raw: c.raw, limit: BUDGET.lazyChunk.maxBytes, chunk: label(c.chunk) })),
  ...(cdn ? { build: 'cdn', proxy } : { build: 'measured' }),
  failures,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const delta = ui.initial.gzip - BUDGET.ui.baselineBytes;
  console.log(`ui page-load graph   ${kb(ui.initial.gzip)} gzip (${kb(ui.initial.raw)} raw, ${ui.initial.chunks} chunk(s)); ` +
    `baseline ${kb(BUDGET.ui.baselineBytes)}, ${delta >= 0 ? '+' : ''}${delta} B; limit ${kb(limit)}`);
  console.log(`main page-load graph ${kb(main.initial.gzip)} gzip`);
  console.log(media
    ? `media chunk          ${kb(media.gzip)} gzip (${kb(media.raw)} raw); limit ${kb(BUDGET.media.maxBytes)}; loads on demand`
    : 'media chunk          none (the ui entry imports no media module)');
  console.log(guardrails
    ? `guardrails chunk     ${kb(guardrails.gzip)} gzip (${kb(guardrails.raw)} raw); limit ${kb(BUDGET.guardrails.maxBytes)}; loads at the first open or send`
    : 'guardrails chunk     none');
  console.log(remote
    ? `guardrails policy    ${kb(remote.gzip)} gzip (${kb(remote.raw)} raw); limit ${kb(BUDGET.guardrailsRemote.maxBytes)}; loads with guardrails-src`
    : 'guardrails policy    none');
  console.log(events
    ? `event cards chunk    ${kb(events.gzip)} gzip (${kb(events.raw)} raw); limit ${kb(BUDGET.events.maxBytes)}; loads with the first event`
    : 'event cards chunk    none');
  for (const c of others) console.log(`lazy chunk           ${kb(c.gzip)} gzip (${kb(c.raw)} raw); limit ${kb(BUDGET.lazyChunk.maxBytes)}; ${label(c.chunk)}`);
  if (proxy) console.log(`cdn proxy.js         ${kb(proxy.gzip)} gzip (${kb(proxy.raw)} raw); limit ${kb(proxy.limit)}`);
  if (cdn) console.log(`(measured: the CDN build, entry ${label(ui.entry)})`);
  console.log(failures.length ? `\nsize budget FAILED:\n  - ${failures.join('\n  - ')}` : '\nsize budget ok');
}
process.exit(failures.length ? 1 : 0);
