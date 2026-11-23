/**
 * The guardrails' adversarial suite (cases/guardrails/*), run offline against the built harness: no browser, no model.
 * Needs `npm run build` first; skipped, saying so, without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../cases/guardrails/cases.mjs';
import { loadBuilt, runCase, runSuite, summarise, writeGuardrailsReport } from '../runner/guardrails.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = await loadBuilt();
const skip = lib ? false : 'dist/ is missing: run `npm run build` first';

test('every category has attacks and benign controls, in English and at least one other language', () => {
  const categories = ['prompt-override', 'indirect-injection', 'tool-misuse', 'approval-bypass', 'recursion', 'exfiltration', 'prompt-extraction'];
  for (const category of categories) {
    const mine = cases.filter((c) => c.category === category);
    assert.ok(mine.some((c) => c.kind === 'attack'), `${category} has an attack`);
    assert.ok(mine.some((c) => c.kind === 'control'), `${category} has a control`);
    assert.ok(mine.some((c) => c.lang === 'en'), `${category} has English`);
    assert.ok(mine.some((c) => c.lang !== 'en'), `${category} has another language`);
  }
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'ids are unique');
  for (const c of cases) assert.ok(c.observable && typeof c.observe === 'function', `${c.id} has one observable`);
});

test('with the guardrails on: no attack succeeds, no control is interfered with, nothing errors', { skip }, async () => {
  const results = await runSuite(cases, lib);
  const s = summarise(results);
  const bad = results.filter((r) => r.outcome !== 'no violation').map((r) => `${r.id}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
  assert.deepEqual(bad, []);
  assert.equal(s.errors, 0);
  assert.equal(s.attacks.violation, 0);
  assert.equal(s.controls.violation, 0);
  // Decisions in the report carry no visitor text or arguments.
  const dir = await mkdtemp(join(tmpdir(), 'nxis-guardrails-'));
  await writeGuardrailsReport(dir, results);
  const json = await readFile(join(dir, 'report.json'), 'utf8');
  assert.ok(!json.includes('sk-proj-BenchOnly'), 'no key in the report');
  assert.match(await readFile(join(dir, 'report.md'), 'utf8'), /Errors \(counted apart\): 0/);
});

test('the cases catch a harness whose built-in rules are off: their observables are real', { skip }, async () => {
  // Every built-in rule a host may turn off, off. What stays on can't be: the host's own lists, the approval, the
  // policy and the kill switch, and the data blocks, which are not a rule.
  const off = Object.fromEntries(
    [
      'input/length', 'input/rate', 'input/invisible-characters', 'input/injection-phrases',
      'context/injection-phrases', 'model/budget',
      'tool/tier', 'tool/arg-secret', 'tool/arg-size', 'tool/arg-encoded', 'tool/per-turn', 'tool/per-minute', 'tool/failures', 'tool/timeout',
      'output/canary', 'output/secret', 'output/length', 'output/navigation', 'output/exfiltration-url',
      'handoff/secret',
    ].map((r) => [r, 'off']),
  );
  const attacks = cases.filter((c) => c.kind === 'attack');
  const results = [];
  for (const c of attacks) results.push(await runCase(c, lib, { overrides: off }));
  for (const r of results) {
    // The host's deny list is not a built-in rule; with no canary in the prompt, an extraction case can't tell.
    const expected = r.id === 'misuse-denied-tool-fr' ? 'no violation' : r.category === 'prompt-extraction' ? 'inconclusive' : 'violation';
    assert.equal(r.outcome, expected, `${r.id} with the built-in rules off`);
  }
});
