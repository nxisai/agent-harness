/**
 * The player stays out of every page-load graph: nothing outside src/media imports it
 * except as types or with a dynamic import(), and the package exposes it as its own subpath. scripts/size-budget.mjs
 * checks the same on the built bundle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('the media module', () => {
  it('is imported by nothing outside it, except as types or by a dynamic import()', () => {
    const offenders = files(SRC)
      .filter((f) => !f.includes(`${join(SRC, 'media')}`))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => /^\s*(import|export)\b(?!\s+type\b).*from\s+['"][./]*\/?media\//.test(l) || /^\s*import\s+['"][./]*\/?media\//.test(l))
          .map((l) => `${f}: ${l.trim()}`),
      );
    expect(offenders).toEqual([]);
    expect(readFileSync(join(SRC, 'ui', 'agent.ts'), 'utf8')).toMatch(/import\('\.\.\/media\/index\.js'\)/);
  });

  it('imports nothing from the chat at run time, so no code is shared with the page-load graph', () => {
    for (const f of files(join(SRC, 'media'))) {
      const runtime = readFileSync(f, 'utf8').split('\n').filter((l) => /^\s*import\b(?!\s+type\b)/.test(l) && /from\s+['"]\.\.\//.test(l));
      expect(runtime, f).toEqual([]);
    }
  });

  it('is the package’s ./media subpath, and hls.js is no dependency', () => {
    expect((pkg as any).exports['./media']).toEqual({ types: './dist/media/index.d.ts', default: './dist/media/index.js' });
    const deps = { ...(pkg as any).dependencies, ...(pkg as any).devDependencies, ...(pkg as any).peerDependencies, ...(pkg as any).optionalDependencies };
    expect(Object.keys(deps)).not.toContain('hls.js');
  });
});
