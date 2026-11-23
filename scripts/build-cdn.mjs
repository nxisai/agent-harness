#!/usr/bin/env node
// The CDN build: the packaged element as a self-contained browser bundle that a page loads from a URL, with no npm
// install and no bundler, after `npm run build`:
//
//   <script type="module" src="https://<cdn>/harness/0.15.2/ui.js" integrity="sha384-…" crossorigin="anonymous"></script>
//
// Writes dist-cdn/:
//
//   harness/<version>/ui.js           `./ui`, bundled with the size budget's esbuild options (scripts/bundle-options.mjs).
//                                     Importing it registers <nxis-agent>, as the npm module does.
//   harness/<version>/<name>-<hash>.js every dynamic import() (media, guardrails, the guardrails policy, sources,
//                                     feedback), as content-hashed chunks beside ui.js, loaded on first use. Beside it,
//                                     not in a subdirectory: a longer import path in ui.js would make it differ, by a
//                                     few bytes, from the bundle the size budget measures
//   harness/<version>/proxy.js        createProxyProvider, self-contained, to point the element at a model proxy:
//                                     `el.modelProvider = createProxyProvider({ endpoint })`
//   harness/<version>/manifest.json   every file's size and Subresource Integrity hash, and which chunk is which
//   harness/<version>/LICENSE, NOTICE, THIRD_PARTY_NOTICES
//   harness/<major>.<minor>/          the short-lived alias: ui.js and proxy.js re-export the versioned files (so both
//                                     URLs share one module instance), and manifest.json is the version's
//   upload.json                       the S3 upload plan: each object's key, Content-Type and Cache-Control (object
//                                     metadata), version first, alias last; CORS comes from CloudFront's response
//                                     headers policy for /harness/*. scripts/publish-cdn.mjs carries it out
//   meta.json                         esbuild's metafiles, for `npm run size:cdn`; not published
//
// A version directory is immutable once published: its files are served with a year's `immutable` cache. The alias
// is the only thing that changes with a patch release, and it is cached for five minutes.
//
//   node scripts/build-cdn.mjs [--out dist-cdn]
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { UI_BUNDLE } from './bundle-options.mjs';

// From the module's own path, not `new URL()`: a DOM test environment may replace the global URL.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const ALIAS = 'public, max-age=300';
/** Content-Type per extension, as S3 object metadata. */
export const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const TEXT = 'text/plain; charset=utf-8';

/** `sha384-<base64>`, as a `<script integrity>` or an import map's `integrity` takes it. */
export const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`;

const filesUnder = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

const posix = (p) => p.split(sep).join('/');

/**
 * @param {{ out?: string, version?: string, quiet?: boolean }} [o]
 * @returns {Promise<{ out: string, version: string, minor: string, manifest: object }>}
 */
export async function buildCdn(o = {}) {
  const version = o.version ?? PKG.version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`build-cdn: ${version} is not a version`);
  const minor = version.split('.').slice(0, 2).join('.');
  const out = resolve(ROOT, o.out ?? 'dist-cdn');
  const dir = join(out, 'harness', version);
  const aliasDir = join(out, 'harness', minor);
  for (const f of ['dist/ui/index.js', 'dist/providers/proxy.js']) {
    if (!existsSync(join(ROOT, f))) throw new Error(`build-cdn: ${f} is missing. Run \`npm run build\` first.`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // ./ui with splitting: the entry keeps a stable name (the URL the loader writes), every chunk is content-hashed.
  const ui = await build({
    ...UI_BUNDLE,
    entryPoints: { ui: join(ROOT, 'dist/ui/index.js') },
    entryNames: '[name]',
    chunkNames: '[name]-[hash]',
    outdir: dir,
    metafile: true,
    logLevel: 'warning',
    absWorkingDir: ROOT,
  });
  // The proxy provider, on its own: built with ui.js it would split a shared chunk out of ui.js and change what the
  // budget measured. Duplicating its few helpers costs less than that.
  const proxy = await build({
    ...UI_BUNDLE,
    splitting: false,
    entryPoints: { proxy: join(ROOT, 'dist/providers/proxy.js') },
    entryNames: '[name]',
    outdir: dir,
    metafile: true,
    logLevel: 'warning',
    absWorkingDir: ROOT,
  });
  for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) cpSync(join(ROOT, f), join(dir, f));

  // Which lazy chunk is which, by the module it was built from.
  const outputs = ui.metafile.outputs;
  const chunkOf = (re) => {
    // A dynamic import()'s chunk carries the module it was built from as its entryPoint.
    const k = Object.keys(outputs).find((key) => key.endsWith('.js') && re.test(outputs[key].entryPoint ?? '') && !key.endsWith('/ui.js'));
    return k ? posix(relative(dir, join(ROOT, k))) : null;
  };
  const files = {};
  for (const p of filesUnder(dir).sort()) {
    const buf = readFileSync(p);
    files[posix(relative(dir, p))] = { bytes: buf.length, gzip: gzipSync(buf, { level: 9 }).length, integrity: sri(buf) };
  }
  const manifest = {
    name: PKG.name,
    version,
    entry: 'ui.js',
    proxy: 'proxy.js',
    element: 'nxis-agent',
    chunks: {
      media: chunkOf(/dist\/media\/index\.js$/),
      guardrails: chunkOf(/dist\/guardrails\/index\.js$/),
      guardrailsRemote: chunkOf(/dist\/guardrails\/remote\.js$/),
      sources: chunkOf(/dist\/ui\/sources\.js$/),
      feedback: chunkOf(/dist\/ui\/feedback\.js$/),
    },
    files,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // The alias: one-line modules over the versioned files, so a page that loads both gets one module, one element.
  mkdirSync(aliasDir, { recursive: true });
  const aliasFiles = {};
  for (const name of ['ui.js', 'proxy.js']) {
    const body = `export * from "../${version}/${name}";\n`;
    writeFileSync(join(aliasDir, name), body);
    aliasFiles[name] = { bytes: Buffer.byteLength(body), integrity: sri(Buffer.from(body)) };
  }
  // ui.js has side effects (it registers the element) and no default export, so `export *` is the whole module.
  writeFileSync(join(aliasDir, 'manifest.json'), `${JSON.stringify({ ...manifest, alias: minor, aliasFiles }, null, 2)}\n`);

  // The upload plan for S3 behind CloudFront (scripts/publish-cdn.mjs): each object's key, Content-Type and
  // Cache-Control, set as S3 object metadata at upload. The version first, each object a conditional create, its
  // manifest last; then the alias; then an invalidation of the alias. CORS and the other response headers are not
  // the objects' own: CloudFront's response headers policy for /harness/* adds them.
  const object = (base, rel, cacheControl, createOnly) => ({
    key: `harness/${base}/${rel}`,
    file: posix(relative(out, join(out, 'harness', base, rel))),
    contentType: TYPES[extname(rel)] ?? TEXT,
    cacheControl,
    createOnly,
  });
  const versioned = filesUnder(dir)
    .map((p) => posix(relative(dir, p)))
    .sort((a, b) => (a === 'manifest.json') - (b === 'manifest.json') || a.localeCompare(b));
  writeFileSync(
    join(out, 'upload.json'),
    `${JSON.stringify(
      {
        version,
        alias: minor,
        objects: [
          ...versioned.map((rel) => object(version, rel, IMMUTABLE, true)),
          ...['ui.js', 'proxy.js', 'manifest.json'].map((rel) => object(minor, rel, ALIAS, false)),
        ],
        invalidate: [`/harness/${minor}/*`],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(out, 'meta.json'), JSON.stringify({ version, ui: ui.metafile, proxy: proxy.metafile }));

  if (!o.quiet) {
    console.log(`build-cdn: ${PKG.name} ${version} → ${posix(relative(ROOT, dir))}/ (${Object.keys(files).length} files), alias harness/${minor}/`);
    console.log(`  ui.js ${files['ui.js'].gzip} B gzip, ${Object.keys(files).filter((f) => /-[A-Z0-9]{8}\.js$/.test(f)).length} chunk(s), proxy.js ${files['proxy.js'].gzip} B gzip`);
  }
  return { out, version, minor, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out');
  await buildCdn({ out: i > 0 ? process.argv[i + 1] : undefined });
}
