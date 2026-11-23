// @vitest-environment happy-dom
/**
 * The CDN build (scripts/build-cdn.mjs): a versioned, self-contained browser bundle of `./ui`.
 *
 * It needs `dist/` (`npm run build`), as the build itself does, and is skipped without it. The browser smoke test,
 * which loads the bundle in a plain page and runs a turn, is `npm run smoke:cdn`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs modules, without types.
import { buildCdn, IMMUTABLE, ALIAS } from '../scripts/build-cdn.mjs';
// @ts-expect-error: as above.
import { publishCommands } from '../scripts/publish-cdn.mjs';
// @ts-expect-error: as above.
import { UI_BUNDLE } from '../scripts/bundle-options.mjs';

const ROOT = resolve(__dirname, '..');
const built = existsSync(join(ROOT, 'dist/ui/index.js')) && existsSync(join(ROOT, 'dist/providers/proxy.js'));
const VERSION = '9.8.7';

describe.skipIf(!built)('the CDN build', () => {
  let out: string;
  let dir: string;
  let manifest: any;

  beforeAll(async () => {
    // Inside the repository, so the test can import the bundle (Vite serves files under its root).
    out = join(ROOT, 'node_modules/.cache', `nxis-cdn-test-${process.pid}`);
    ({ manifest } = await buildCdn({ out, version: VERSION, quiet: true }));
    dir = join(out, 'harness', VERSION);
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const js = () => readdirSync(dir).filter((f) => f.endsWith('.js'));

  it('emits ui.js, proxy.js and every lazy chunk, content-hashed, under the version', () => {
    expect(manifest).toMatchObject({ name: '@nxisai/agent-harness', version: VERSION, entry: 'ui.js', proxy: 'proxy.js', element: 'nxis-agent' });
    for (const [what, file] of Object.entries(manifest.chunks)) {
      expect(file, what).toMatch(/^[a-z]+-[A-Z0-9]{8}\.js$/);
      expect(existsSync(join(dir, file as string)), what).toBe(true);
    }
    for (const f of js().filter((f) => f !== 'ui.js' && f !== 'proxy.js')) expect(f).toMatch(/-[A-Z0-9]{8}\.js$/);
    for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) expect(existsSync(join(dir, f))).toBe(true);
  });

  it('ui.js is byte for byte the bundle the size budget measures', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nxis-cdn-measured-'));
    try {
      await build({ ...UI_BUNDLE, entryPoints: [join(ROOT, 'dist/ui/index.js')], outdir: tmp, logLevel: 'silent', absWorkingDir: ROOT });
      expect(readFileSync(join(dir, 'ui.js')).equals(readFileSync(join(tmp, 'index.js')))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('has no bare imports: every import, static or dynamic, is a file of the build, and proxy.js imports nothing', () => {
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
    const ours = new Set(Object.keys(meta.ui.outputs));
    for (const [f, o] of Object.entries<any>(meta.ui.outputs)) {
      for (const i of o.imports) {
        expect(i.external ?? false, `${f} imports ${i.path}`).toBe(false);
        expect(ours.has(i.path), `${f} imports ${i.path}`).toBe(true);
      }
    }
    for (const o of Object.values<any>(meta.proxy.outputs)) expect(o.imports).toEqual([]);
  });

  it('publishes a Subresource Integrity hash for every file, matching its bytes', () => {
    const listed = Object.keys(manifest.files).sort();
    expect(listed).toEqual(readdirSync(dir).filter((f) => f !== 'manifest.json').sort());
    for (const [f, meta] of Object.entries<any>(manifest.files)) {
      const buf = readFileSync(join(dir, f));
      expect(meta.integrity, f).toBe(`sha384-${createHash('sha384').update(buf).digest('base64')}`);
      expect(meta.bytes, f).toBe(buf.length);
    }
  });

  it('the minor alias re-exports the version, so both URLs are one module; its manifest names the version', () => {
    const alias = join(out, 'harness', '9.8');
    expect(readFileSync(join(alias, 'ui.js'), 'utf8')).toBe(`export * from "../${VERSION}/ui.js";\n`);
    expect(readFileSync(join(alias, 'proxy.js'), 'utf8')).toBe(`export * from "../${VERSION}/proxy.js";\n`);
    const m = JSON.parse(readFileSync(join(alias, 'manifest.json'), 'utf8'));
    expect(m.version).toBe(VERSION);
    expect(m.alias).toBe('9.8');
    expect(m.files).toEqual(manifest.files);
  });

  it('plans the S3 upload: Content-Type and Cache-Control as object metadata, the version write-once, the alias last', () => {
    const plan = JSON.parse(readFileSync(join(out, 'upload.json'), 'utf8'));
    expect(plan).toMatchObject({ version: VERSION, alias: '9.8', invalidate: ['/harness/9.8/*'] });
    const version = plan.objects.filter((o: any) => o.createOnly);
    const alias = plan.objects.filter((o: any) => !o.createOnly);
    // Every file of the version, each to its key, with its file in the build.
    expect(version.map((o: any) => o.key).sort()).toEqual(readdirSync(dir).map((f) => `harness/${VERSION}/${f}`).sort());
    for (const o of plan.objects) expect(existsSync(join(out, o.file)), o.key).toBe(true);
    for (const o of version) expect(o.cacheControl).toBe(IMMUTABLE);
    for (const o of alias) expect(o.cacheControl).toBe(ALIAS);
    expect(alias.map((o: any) => o.key)).toEqual(['harness/9.8/ui.js', 'harness/9.8/proxy.js', 'harness/9.8/manifest.json']);
    const type = (k: string) => plan.objects.find((o: any) => o.key === k).contentType;
    expect(type(`harness/${VERSION}/ui.js`)).toBe('text/javascript; charset=utf-8');
    expect(type(`harness/${VERSION}/manifest.json`)).toBe('application/json; charset=utf-8');
    expect(type(`harness/${VERSION}/LICENSE`)).toBe('text/plain; charset=utf-8');
    // The manifest last within the version, then the alias.
    const keys = plan.objects.map((o: any) => o.key);
    expect(keys.indexOf(`harness/${VERSION}/manifest.json`)).toBe(version.length - 1);
    expect(keys.slice(version.length)).toEqual(alias.map((o: any) => o.key));
    // No CORS or other response headers here: CloudFront's response headers policy adds them.
    expect(JSON.stringify(plan)).not.toMatch(/Access-Control|Cross-Origin/i);
    expect(existsSync(join(out, '_headers'))).toBe(false);
  });

  it('publishes each version file as a conditional create, then the alias, then invalidates it', () => {
    const plan = JSON.parse(readFileSync(join(out, 'upload.json'), 'utf8'));
    const cmds: string[][] = publishCommands(plan, { bucket: 'b', distribution: 'D1', out: '/o' });
    const puts = cmds.filter((c) => c[1] === 'put-object');
    expect(puts.length).toBe(plan.objects.length);
    const ui = puts.find((c) => c.includes(`harness/${VERSION}/ui.js`))!;
    expect(ui).toEqual([
      's3api', 'put-object', '--bucket', 'b', '--key', `harness/${VERSION}/ui.js`, '--body', join('/o', `harness/${VERSION}/ui.js`),
      '--content-type', 'text/javascript; charset=utf-8', '--cache-control', IMMUTABLE, '--if-none-match', '*',
    ]);
    expect(puts.find((c) => c.includes('harness/9.8/ui.js'))).not.toContain('--if-none-match');
    expect(cmds.at(-1)).toEqual(['cloudfront', 'create-invalidation', '--distribution-id', 'D1', '--paths', '/harness/9.8/*']);
    // A version already published (the same build): only the alias, and its invalidation.
    const again: string[][] = publishCommands(plan, { bucket: 'b', distribution: 'D1', out: '/o', skipVersion: true });
    expect(again.filter((c) => c[1] === 'put-object').every((c) => !c.includes('--if-none-match'))).toBe(true);
    expect(again.length).toBe(4);
  });

  it('loaded beside the npm module, defines the element once and throws nothing', async () => {
    const npm = await import('../src/ui/index');
    const first = customElements.get('nxis-agent');
    expect(first).toBe(npm.NxisAgent);
    // A second copy of the element, from the CDN bundle: its own class, so it would throw if it defined again.
    const cdn = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'ui.js')).href);
    expect(cdn.NxisAgent).not.toBe(npm.NxisAgent);
    expect(customElements.get('nxis-agent')).toBe(first);
    expect(customElements.get('nxis-agent-fullscreen')).toBe(npm.NxisAgentFullscreen);
    // @a2ui/lit's elements were skipped, not redefined, and the registry's own define is back.
    expect(customElements.get('a2ui-surface')).toBeDefined();
    expect(customElements.define).toBe(Object.getPrototypeOf(customElements).define);
  });
});
