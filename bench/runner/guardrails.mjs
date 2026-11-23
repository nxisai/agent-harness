#!/usr/bin/env node
/**
 * The guardrails' adversarial suite (`cases/guardrails/*`), offline: no browser, no model, no spend.
 *
 * Each case runs the headless harness (`AgentHarness`, from the built `dist/`) with the guardrails on, a scripted
 * worst-case model that does whatever it is told, and instrumented tools that only record. It is scored on its one
 * observable, as the OWASP cheat sheets' testing guidance asks:
 *
 * - an attack: `violation` when its harm happened, `no violation` when it didn't;
 * - a control: `violation` when the guardrails interfered with a benign request (a false positive);
 * - `inconclusive` when the run can't tell; and errors, a case that threw, are counted apart.
 *
 *   npm run build && node bench/runner/guardrails.mjs [--out <dir>] [--json]
 *
 * Writes `report.md` and `report.json` to `--out` (default `bench/runs/guardrails-<time>/`) and exits 1 on any
 * violation or error. Whether a real model falls for these is a different question, for the live runner
 * (`runner/run.mjs`); these cases need none.
 *
 * @module
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The built harness and guardrails. */
export async function loadBuilt(root = ROOT) {
  const main = join(root, 'dist/index.js');
  const guard = join(root, 'dist/guardrails/index.js');
  if (!existsSync(main) || !existsSync(guard)) return null;
  const [{ AgentHarness }, { createGuardrails }] = await Promise.all([import(pathToFileURL(main).href), import(pathToFileURL(guard).href)]);
  return { AgentHarness, createGuardrails };
}

/** One case's record: what ran, what was shown, what the guardrails decided. */
function recorder() {
  const rec = { calls: [], shown: [], confirms: [], decisions: [], requests: [], opened: [], canary: '', timedOut: false };
  rec.ui = { message: (_r, t) => void rec.shown.push(t) };
  return rec;
}

/**
 * Run one case.
 *
 * @param {Record<string, any>} c - The case.
 * @param {{ AgentHarness: any, createGuardrails: any }} lib - The harness and guardrails to test.
 * @param {Record<string, any>} [extra] - Configuration over the case's own, such as `overrides`.
 * @returns {Promise<Record<string, any>>} The result: its outcome, and the decisions (never the visitor's text).
 */
export async function runCase(c, lib, extra = {}) {
  const rec = recorder();
  let now = 1_700_000_000_000;
  const clock = { advance: (ms) => void (now += ms) };
  const g = lib.createGuardrails({ ...(c.config ?? {}), ...extra, onDecision: (d) => void rec.decisions.push(d) });
  g.now = () => now;
  const conv = c.messages ? c.messages.map((m) => ({ ...m })) : [{ role: 'system', content: 'You help visitors on this site.' }];
  let n = 0;
  const provider = {
    name: 'scripted-attacker',
    local: false,
    ready: true,
    loading: false,
    async complete(req) {
      rec.requests.push(req);
      const replies = c.replies ?? [{ text: 'OK.' }];
      const r = replies[Math.min(n++, replies.length - 1)];
      return typeof r === 'function' ? r(req) : r;
    },
  };
  // A tool runs only through here, so the record says whether the visitor had confirmed it.
  let approving = false;
  const src = {
    discoverTools: async () => c.tools ?? [],
    modelContext: () => null,
    execTool: async (_t, name, args) => {
      rec.calls.push({ name, args, approved: approving });
      return c.exec ? c.exec(name, args) : { content: [{ type: 'text', text: 'Done.' }] };
    },
  };
  const bubble = { thinking() {}, update() {}, finalize: (t) => void (t && rec.shown.push(t)) };
  let approvals = 0;
  const renderer = {
    streaming: () => bubble,
    message: (_r, t) => void rec.shown.push(t),
    status() {},
    results() {},
    detail() {},
    toolError: (_t, m) => void rec.shown.push(m),
    ask: (req) => req.onComplete({}),
    confirm: (req) => {
      rec.confirms.push(req.tool.name);
      // The visitor, as the case says: confirms nothing, the first, or everything.
      if (c.approve === 'all' || (c.approve === 'first' && approvals++ === 0)) {
        approving = true;
        req.onSubmit(req.values);
      }
    },
  };
  const harness = new lib.AgentHarness({ provider, toolSource: src, renderer, recommend: false, guardrails: g });
  const started = Date.now();
  try {
    if (c.run) {
      await c.run({ g, conv, rec, src, clock, provider, harness });
    } else {
      for (const goal of c.turns ?? []) {
        approving = false;
        const turn = harness.turn(goal, conv);
        const limit = new Promise((r) => setTimeout(() => r('timeout'), c.timeoutMs ?? 10_000));
        if ((await Promise.race([turn, limit])) === 'timeout') {
          rec.timedOut = true;
          break;
        }
        // A confirmed run is started from the press, after the turn; let it finish.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (c.after) await c.after({ g, conv, rec, src, clock, provider, harness });
    // The canary the model was actually given, if any: read from the first request's system prompt.
    rec.canary = /(nxc-[a-z0-9]+)/.exec(rec.requests[0]?.messages?.[0]?.content ?? '')?.[1] ?? '';
  } catch (err) {
    return { ...meta(c), outcome: 'error', detail: String(err?.message || err), decisions: rec.decisions, ms: Date.now() - started };
  }
  const seen = c.observe(rec);
  const outcome = seen === null || seen === undefined ? 'inconclusive' : seen ? 'violation' : 'no violation';
  return { ...meta(c), outcome, decisions: rec.decisions, ms: Date.now() - started };
}

const meta = (c) => ({ id: c.id, category: c.category, lang: c.lang, kind: c.kind, observable: c.observable });

/** Run every case, one after another. */
export async function runSuite(cases, lib) {
  const results = [];
  for (const c of cases) results.push(await runCase(c, lib));
  return results;
}

/** Totals: per kind and outcome, and per category. Errors are their own count, never an outcome. */
export function summarise(results) {
  const count = (pred) => results.filter(pred).length;
  const by = (kind) => ({
    total: count((r) => r.kind === kind),
    violation: count((r) => r.kind === kind && r.outcome === 'violation'),
    noViolation: count((r) => r.kind === kind && r.outcome === 'no violation'),
    inconclusive: count((r) => r.kind === kind && r.outcome === 'inconclusive'),
  });
  const categories = [...new Set(results.map((r) => r.category))].map((category) => ({
    category,
    langs: [...new Set(results.filter((r) => r.category === category).map((r) => r.lang))],
    attacks: results.filter((r) => r.category === category && r.kind === 'attack').map((r) => r.outcome),
    controls: results.filter((r) => r.category === category && r.kind === 'control').map((r) => r.outcome),
  }));
  return { attacks: by('attack'), controls: by('control'), errors: count((r) => r.outcome === 'error'), categories };
}

/** `report.md` and `report.json`. */
export async function writeGuardrailsReport(dir, results) {
  const s = summarise(results);
  await mkdir(dir, { recursive: true });
  const out = [
    '# Guardrails bench',
    '',
    'Offline: the headless harness, a scripted worst-case model that does whatever it is told, instrumented tools, dummy data. No model was called.',
    '',
    `Attacks: **${s.attacks.violation} violation**, ${s.attacks.noViolation} no violation, ${s.attacks.inconclusive} inconclusive, of ${s.attacks.total}.`,
    `Benign controls (false positives): **${s.controls.violation} violation**, ${s.controls.noViolation} no violation, ${s.controls.inconclusive} inconclusive, of ${s.controls.total}.`,
    `Errors (counted apart): ${s.errors}.`,
    '',
    '| Case | Category | Lang | Kind | Outcome | Observable |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.lang} | ${r.kind} | ${r.outcome}${r.detail ? ` (${r.detail})` : ''} | ${r.observable} |`),
    '',
  ];
  await writeFile(join(dir, 'report.md'), out.join('\n'));
  await writeFile(join(dir, 'report.json'), JSON.stringify({ summary: s, results }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const lib = await loadBuilt();
  if (!lib) {
    console.error('guardrails bench: dist/ is missing. Run `npm run build` first.');
    process.exit(2);
  }
  const { cases } = await import('../cases/guardrails/cases.mjs');
  const results = await runSuite(cases, lib);
  const at = process.argv.indexOf('--out');
  const dir = at > 0 ? resolve(process.argv[at + 1]) : join(ROOT, 'bench/runs', `guardrails-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await writeGuardrailsReport(dir, results);
  const s = summarise(results);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ summary: s, results }, null, 2));
  else {
    for (const r of results) console.log(`${r.outcome.padEnd(13)} ${r.kind.padEnd(8)} ${r.id}`);
    console.log(`\nattacks ${s.attacks.violation}/${s.attacks.total} violated · controls ${s.controls.violation}/${s.controls.total} false positives · ${s.errors} errors · ${dir}`);
  }
  process.exit(s.attacks.violation || s.controls.violation || s.errors ? 1 : 0);
}
