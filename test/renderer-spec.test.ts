/**
 * The renderer spec is carried twice: verbatim from the NxisAI MCP server (spec/renderer-spec.json, the snapshot a reviewer
 * diffs against the server's own copy) and as the module the build
 * imports (src/harness/renderer-spec.ts). A hand edit to either, or a snapshot refreshed without regenerating the
 * module, fails here.
 *
 * To refresh: `npm run sync:spec -- <path to the MCP server's renderer-spec.json>`, which copies the file and regenerates
 * the module; `npm run sync:spec -- --check` says whether they agree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDERER_SPEC } from '../src/harness/renderer-spec';
// @ts-ignore: a plain .mjs script, with no types of its own.
import { parseSpec, renderModule } from '../scripts/sync-renderer-spec.mjs';

const snapshotText = readFileSync(new URL('../spec/renderer-spec.json', import.meta.url), 'utf8');
const moduleText = readFileSync(new URL('../src/harness/renderer-spec.ts', import.meta.url), 'utf8');

describe('renderer spec sync', () => {
  it('the module holds exactly what the vendored snapshot holds', () => {
    expect(RENDERER_SPEC).toEqual(JSON.parse(snapshotText));
  });

  it('the module is the generator’s output for the snapshot, byte for byte', () => {
    expect(moduleText).toBe(renderModule(parseSpec(snapshotText)));
  });

  it('carries the media labels the Hub’s Listen and Subscribe buttons use', () => {
    expect(RENDERER_SPEC.actions.ListenAction).toMatchObject({
      label: 'Listen',
      latestLabel: 'Listen to the latest',
      previewLabel: 'Listen to preview',
      paidLabel: 'Subscribe to listen',
      registrationLabel: 'Sign up to listen',
    });
    expect(RENDERER_SPEC.actions.SubscribeAction.label).toBe('Subscribe');
    expect(RENDERER_SPEC.partAccess.subscription).toBe('Subscribers');
    expect(RENDERER_SPEC.seriesAccess).toEqual({ all: 'Free', some: 'Free · some for subscribers', none: 'Subscribers' });
  });

  it('refuses a file that is not a renderer spec', () => {
    expect(() => parseSpec('{"version":1}', 'x.json')).toThrow(/not a renderer spec/);
  });
});
