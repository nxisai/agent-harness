/**
 * The check that nothing internal reaches the public mirror, npm or the CDN (scripts/check-public.mjs).
 *
 * The references below are put together at run time, so this file passes the check itself: it is in the
 * published tree, which CI scans with the same rules.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs module, without types.
import { checkPaths, findInternal } from '../scripts/check-public.mjs';

const HASH = '#';
const PRIVATE = ['nxisai', 'some-private-repo'].join('/');
const hits = (s: string, hidden?: Set<string>) => (findInternal(s, hidden) as Array<{ why: string }>).map((p) => p.why);

describe('check-public', () => {
  it('finds private repositories, issue references and internal hosts', () => {
    expect(hits(`see github.com/${PRIVATE} for more`)).toEqual(['a private repository']);
    expect(hits(`see github.com/${['nxisai', 'agent-harness-private'].join('/')}`)).toEqual(['a private repository']);
    expect(hits(`fixed in nxisai/agent-harness${HASH}12`)).toEqual(['an issue or pull request reference']);
    expect(hits(`as decided in (${HASH}75)`)).toEqual(['a bare issue or pull request number']);
    expect(hits(['curl http://api.example', 'internal/x'].join('.'))).toEqual(['an internal host']);
    expect(hits(['https://api-abc123-uc.a', 'run.app/v1'].join('.'))).toEqual(['a cloud or tunnel host']);
    expect(hits(['https://demo.ngrok', 'io/x'].join('.'))).toEqual(['a cloud or tunnel host']);
    expect(hits(['mongodb+srv:', '', 'user:pw@db.example.com/app'].join('/'))).toEqual(['a database connection string']);
    expect(hits(['write to someone', 'corp-mail.io'].join('@'))).toEqual(['an email address']);
  });

  it('finds a hidden name by its hash, whole or as a dotted part', () => {
    const hidden = new Set([createHash('sha256').update('made-up-service').digest('hex')]);
    expect(hits('calls Made-Up-Service directly', hidden)).toEqual(['an internal name']);
    expect(hits('see made-up-service.md', hidden)).toEqual(['an internal name']);
    expect(hits('calls made-up-services', hidden)).toEqual([]);
  });

  it('allows the public repositories, npm package names, CSS colors and placeholder addresses', () => {
    expect(findInternal('https://github.com/nxisai/agent-harness and nxisai/agent-harness.git')).toEqual([]);
    expect(findInternal('npx skills add nxisai/skills')).toEqual([]);
    expect(findInternal('npm i @nxisai/agent-harness')).toEqual([]);
    expect(findInternal(`color: ${HASH}000; --c: ${HASH}0000; fill="${HASH}123"`)).toEqual([]);
    expect(findInternal(`background: light-dark(${HASH}eee, ${HASH}111); color: ${HASH}333; c: rgba(${HASH}444)`)).toEqual([]);
    expect(findInternal('you@example.com, pw@x.example, git@github.com, a@b.test')).toEqual([]);
  });

  it('looks inside tarballs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxis-check-public-test-'));
    try {
      writeFileSync(join(dir, 'notes.txt'), `Ships from ${PRIVATE}.\n`);
      execFileSync('tar', ['-czf', join(dir, 't.tgz'), '-C', dir, 'notes.txt']);
      const problems = checkPaths([join(dir, 't.tgz')]) as string[];
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`notes.txt:1: ${PRIVATE}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
