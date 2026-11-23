/**
 * Drives the suite through a real browser, once per model.
 *
 * The harness runs in the page: tool discovery, the confirmation policy, the
 * handoff and the rendering are all client-side. Anything that drives the proxy
 * directly would be testing an HTTP adapter and skipping the parts most likely
 * to break, so the bench opens the site and types.
 *
 * The page is not modified to take part. Its own `createProxyProvider` posts to
 * `/api/agent`; the runner intercepts that request and sends it to the bench
 * proxy with the model named on a header. Nothing about the site build is
 * bench-aware, which is what keeps a result descriptive of production.
 *
 *   node runner/run.mjs --models claude-sonnet,gemma-local --site http://localhost:3000
 *
 * A handoff target that calls models itself (the Support Agent) is started
 * with its models pointed at the proxy, so they are metered and reported apart
 * from the page's:
 *
 *   node runner/run.mjs --suite support --remote-agent "node ../support/server.js" \
 *     --remote-ready http://localhost:8787/healthz
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODELS } from '../proxy/registry.mjs';
import { pageState, proxyRecords } from './capture.mjs';
import { assertCase, pct, turnCost } from './score.mjs';
import { writeReport } from './report.mjs';
import { callsBetween, remoteBaseUrl, remoteEnvName, remoteModelId, remoteSummary, remoteUsage } from './remote-models.mjs';
import { AGENT_HOST, clickFeedback, defaultScopeOf, handoffBarOpen, pressSend, recordRemote, remoteTurn, remoteView, SEND, waitForRemote } from './remote.mjs';
import { caseSessions, clearSiteStorage } from './sessions.mjs';

/** @returns {Record<string, string|boolean>} */
function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const opts = args();
const SITE = String(opts.site ?? 'http://localhost:3000');
/** Which suite: `copperline` (default) or `listings`, a module under ../suite. */
const SUITE = String(opts.suite ?? 'copperline');
if (!/^[a-z0-9-]+$/.test(SUITE)) {
  console.error(`Unknown suite "${SUITE}".`);
  process.exit(1);
}
let suite;
try {
  suite = await import(`../suite/${SUITE}.mjs`);
} catch {
  console.error(`No suite named "${SUITE}" in bench/suite.`);
  process.exit(1);
}
const { CASES } = suite;
/** The business a remote agent's card belongs to, for `remoteCardsFromOneScope`: the suite's own rule, if it has one. */
const scopeOf = typeof suite.scopeOf === 'function' ? suite.scopeOf : defaultScopeOf;
/** How to open the site: the path, and whether the page needs a proxy provider given to it. */
const SETUP = { path: '/?surface=fullscreen&open=1', injectProvider: false, ...(suite.SETUP ?? {}) };
const PROXY = String(opts.proxy ?? 'http://127.0.0.1:4100/api/agent');
const RUN_ID = String(opts['run-id'] ?? new Date().toISOString().replace(/[:.]/g, '-'));
const RUNS = new URL('../runs', import.meta.url).pathname;
/** Lane A needs a real GPU, so a headed browser is the default. */
const HEADLESS = opts.headed ? false : opts.headless !== 'false';
const TURN_TIMEOUT = Number(opts.timeout ?? 120_000);

/**
 * The remote agent whose own model calls go through the proxy: its name (the
 * `<NAME>_MODEL_BASE_URL` it reads), and the command that starts it, if the
 * runner is to start it.
 */
const REMOTE = opts['remote-agent'] || opts['remote-name']
  ? { name: String(opts['remote-name'] ?? 'support'), command: opts['remote-agent'] ? String(opts['remote-agent']) : null, ready: opts['remote-ready'] ? String(opts['remote-ready']) : null }
  : null;
if (REMOTE && !/^[A-Za-z0-9_-]{1,40}$/.test(REMOTE.name)) {
  console.error(`--remote-name must be letters, digits, - or _; got "${REMOTE.name}".`);
  process.exit(1);
}

const models = String(opts.models ?? 'claude-sonnet')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const only = opts.cases ? String(opts.cases).split(',').map((c) => c.trim()) : null;
const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;

/**
 * Lane A: the model the site runs in the visitor's browser, with no proxy
 * involved. Not in the proxy's registry, which only says where it may send a
 * request; this lane never sends one.
 */
const LANE_A = {
  'gemma-browser': { lane: 'A', display: 'Gemma 4 E2B (on-device)' },
};
const entryOf = (m) => MODELS[m] ?? LANE_A[m];

for (const m of models) {
  if (!entryOf(m)) {
    console.error(`Unknown model "${m}". Known: ${[...Object.keys(MODELS), ...Object.keys(LANE_A)].join(', ')}.`);
    process.exit(1);
  }
}
if (!cases.length) {
  console.error(`No cases matched. Known: ${CASES.map((c) => c.id).join(', ')}.`);
  process.exit(1);
}

// Imported here, not at the top, so a mistyped flag reports the flag rather
// than a missing dependency.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'playwright is not installed. From this directory:\n' +
      '  npm install && npx playwright install chromium',
  );
  process.exit(1);
}

/**
 * Type a prompt and wait for the turn to finish.
 *
 * "Finished" is the proxy's response having arrived and the panel then having
 * stopped changing. Waiting on the network alone is too early — the harness
 * still has to dispatch a tool and render — and waiting on the DOM alone cannot
 * tell a slow model from a finished one.
 *
 * @param {import('playwright').Page} page
 * @param {string} prompt
 * @returns {Promise<void>}
 */
async function takeTurn(page, prompt, lane = 'C') {
  // A remote turn: Send on the handoff the last case proposed, or a message typed while the conversation is with
  // the target. Neither reaches the page's model, so the turn is over when the target answers. A handoff the page
  // restored from storage sends no event, so the page's handoff bar says too (see remoteTurn).
  const remote = remoteTurn(prompt, page.__remote ?? [], prompt !== SEND && (await handoffBarOpen(page)));
  const before = page.__remote?.length ?? 0;
  if (prompt === SEND) await pressSend(page);

  // The message box, not the first textarea: an action card's own fields are textareas too.
  const input = page.locator(`${AGENT_HOST} .composer textarea`).first();
  if (prompt !== SEND) {
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.fill(prompt);
  }

  if (remote) {
    if (prompt !== SEND) await input.press('Enter');
    await waitForRemote(page, before, TURN_TIMEOUT);
  } else if (lane === 'A') {
    // In the browser: done when the recorder has the turn's first completion
    // and nothing is still generating (a recommendation is a second one).
    // Read from the runner's side, so a turn that navigates (open_page) still
    // reports: the page's own state does not survive the page change.
    const before = page.__benchRows.length;
    await input.press('Enter');
    const deadline = Date.now() + TURN_TIMEOUT;
    while (Date.now() < deadline && !(page.__benchRows.length > before && page.__benchBusy === 0)) {
      await page.waitForTimeout(500);
    }
  } else {
    // The page's own request, which the route below fulfils from the proxy.
    const answered = page
      .waitForResponse((r) => new URL(r.url()).pathname === '/api/agent', { timeout: TURN_TIMEOUT })
      .catch(() => null);
    await input.press('Enter');
    await answered;
  }

  let last = '';
  let stable = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { transcript } = await pageState(page).catch(() => ({ transcript: last }));
    // Still generating: a recommendation is a second completion after the search,
    // and the page sits still on "Comparing them…" while it runs.
    const busy = lane === 'A' ? page.__benchBusy : (page.__inflight ?? 0);
    if (transcript === last && !busy) {
      stable += 1;
      // Three consecutive identical reads, which at 400ms apart is a little
      // over a second of quiet. Enough to let a tool dispatch and render.
      if (stable >= 3) return;
    } else {
      stable = 0;
      last = transcript;
    }
    await page.waitForTimeout(400);
  }
}

/**
 * Give a page that runs its model in the browser a provider that posts to
 * `/api/agent` instead, so the route above can send its turns to the proxy.
 *
 * Inline rather than the harness's createProxyProvider, which the page only
 * holds inside its bundle: the same request and response, nothing more.
 *
 * @param {import('playwright').Page} page
 */
async function giveProxyProvider(page) {
  await page.waitForFunction(() => (customElements.get('nxis-agent') || customElements.get('nxis-agent-fullscreen')) && document.querySelector('nxis-agent, nxis-agent-fullscreen'), null, { timeout: 30_000 });
  await page.evaluate(() => {
    const el = document.querySelector('nxis-agent, nxis-agent-fullscreen');
    let served = 'bench';
    el.modelProvider = {
      name: 'bench-proxy',
      get label() {
        return served;
      },
      ready: true,
      loading: false,
      async complete({ messages, tools, maxTokens, signal }) {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          signal,
          body: JSON.stringify({
            messages,
            tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } })),
            maxTokens,
          }),
        });
        if (!res.ok) throw new Error(`Agent endpoint /api/agent returned ${res.status}`);
        const body = await res.json();
        const call = body.call ?? (Array.isArray(body.calls) ? body.calls[0] : undefined);
        if (typeof body.model === 'string' && body.model) served = body.model;
        return {
          text: typeof body.text === 'string' ? body.text : '',
          ...(call ? { call } : {}),
          ...(body.usage ? { usage: body.usage } : {}),
          ...(body.model ? { model: body.model } : {}),
        };
      },
    };
    el.open?.();
  });
}

/** Lane A's browser profile, kept so the on-device weights download once. */
const CHANNEL = String(opts.channel ?? 'chrome');
/** One profile per browser: an older Chromium refuses a profile a newer Chrome has written. */
const PROFILE = new URL(`../.profile/${CHANNEL}`, import.meta.url).pathname;

/**
 * Record every completion the page's own model makes, in the page.
 *
 * Lane A never reaches the proxy, so the proxy cannot keep its transcript.
 * The widget's provider is the object the harness calls, so wrapping its
 * `complete` sees exactly what the model was asked and answered, and how long
 * generation took (the weights' download is `load`, and not counted).
 *
 * @param {import('playwright').Page} page
 */
async function recordInPage(page) {
  // Kept on the runner's side and reported through a binding, which outlives
  // the page's own documents: a turn that opens another page would otherwise
  // take its record with it.
  if (!page.__benchRows) {
    page.__benchRows = [];
    page.__benchBusy = 0;
    await page.exposeBinding('__benchReport', (_source, event) => {
      if (event.type === 'start') page.__benchBusy += 1;
      else {
        page.__benchBusy = Math.max(0, page.__benchBusy - 1);
        page.__benchRows.push(event.row);
      }
    });
  }
  await page.waitForFunction(() => document.querySelector('nxis-agent, nxis-agent-fullscreen')?.provider, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const el = document.querySelector('nxis-agent, nxis-agent-fullscreen');
    const provider = el.provider;
    if (provider.__benchWrapped) return;
    const original = provider.complete.bind(provider);
    provider.complete = async (req) => {
      window.__benchReport({ type: 'start' });
      const caseId = window.__benchCase;
      const started = performance.now();
      try {
        const c = await original(req);
        window.__benchReport({
          type: 'end',
          row: {
            caseId,
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            display: c.model ?? provider.label ?? provider.name,
            response: { text: c.text ?? '', call: c.call ?? null, usage: c.usage ?? null },
          },
        });
        return c;
      } catch (err) {
        window.__benchReport({ type: 'end', row: { caseId, ok: false, error: String(err?.message ?? err), latencyMs: Math.round(performance.now() - started) } });
        throw err;
      }
    };
    provider.__benchWrapped = true;
    el.open?.();
  });
}

/**
 * Start the remote agent with its models pointed at the proxy, and wait for it
 * to answer. Without a command, say what to set, for an agent started by hand.
 */
async function startRemote() {
  if (!REMOTE) return null;
  const env = remoteEnvName(REMOTE.name);
  const base = remoteBaseUrl(PROXY, REMOTE.name, RUN_ID);
  if (!REMOTE.command) {
    console.log(`\nremote agent "${REMOTE.name}": start it with ${env}=${base}`);
    return null;
  }
  console.log(`\nremote agent "${REMOTE.name}": ${REMOTE.command} (${env}=${base})`);
  const child = spawn(REMOTE.command, { shell: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, [env]: base } });
  if (REMOTE.ready) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = await fetch(REMOTE.ready).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill();
        console.error(`The remote agent did not answer ${REMOTE.ready}.`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return child;
}

const remoteChild = await startRemote();
const results = [];
const proxied = models.some((m) => entryOf(m).lane !== 'A');
const browser = proxied ? await chromium.launch({ headless: HEADLESS }) : null;

try {
  for (const modelId of models) {
    const entry = entryOf(modelId);
    const laneA = entry.lane === 'A';
    console.log(`\n── ${modelId} (${entry.display}, lane ${entry.lane})`);

    // A context per independent case, so no case inherits another's storage:
    // the element reopens the origin's last conversation, an open handoff
    // included, and the remembered surface from `agent-surface.ts` would carry
    // over too. A case that `continues` another keeps that case's page.
    // Lane A is the exception: its weights are gigabytes in Cache Storage, so
    // it keeps one profile between runs, headed, in real Chrome for WebGPU, and
    // the site's localStorage is cleared before each independent case instead.
    const profile = laneA
      ? await chromium.launchPersistentContext(PROFILE, {
          headless: false,
          // `chromium` is Playwright's own build, with the WebMCP polyfill like the
          // proxied lanes; `chrome` is the installed browser, with its native WebMCP.
          ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }),
          args: ['--enable-unsafe-webgpu'],
          viewport: { width: 1280, height: 900 },
        })
      : null;
    const sessions = caseSessions({
      cases,
      shared: profile ?? undefined,
      newContext: () => browser.newContext(),
      clearSite: (page) => clearSiteStorage(page, new URL(SITE).origin),
      async load(page) {
        // Before the site loads, so the first page's handoff events are heard too.
        await recordRemote(page);
        // The site's own parameters, so this also exercises agent-surface.ts.
        // Generous: a dev server behind a tunnel serves every module unbundled.
        await page.goto(`${SITE}${SETUP.path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        if (laneA) await recordInPage(page);
        else if (SETUP.injectProvider) await giveProxyProvider(page);
      },
    });

    for (const kase of cases) {
      const { page } = await sessions.pageFor(kase);
      if (laneA) await page.evaluate((id) => (window.__benchCase = id), kase.id);
      // What the remote agent does from here on is filed under this case.
      page.__benchCaseId = kase.id;

      // Retarget the page's endpoint at the bench proxy, naming the model and
      // the case. Origin is set explicitly: the proxy refuses a request without
      // an allowlisted one, and that check is the point of having it.
      // Fetched from here and handed back, rather than redirected: a browser
      // route may not change an https page's request to an http one, and the
      // proxy is http on this machine.
      await page.unroute('**/api/agent');
      if (!laneA) await page.route('**/api/agent', async (route) => {
        page.__inflight = (page.__inflight ?? 0) + 1;
        try {
          const response = await route.fetch({
            url: PROXY,
            // A local model can take minutes; the default would give up at 30s.
            timeout: TURN_TIMEOUT,
            headers: {
              ...route.request().headers(),
              origin: new URL(SITE).origin,
              'x-nxis-model': modelId,
              'x-bench-run': RUN_ID,
              'x-bench-case': kase.id,
            },
          });
          await route.fulfill({ response });
        } catch {
          await route.abort().catch(() => {});
        } finally {
          page.__inflight -= 1;
        }
      });

      process.stdout.write(`  ${kase.id} … `);
      let state = { actionCard: false, transcript: '', awaitingConfirm: false, cardTitle: null, fields: [] };
      let error = null;
      let feedback = null;
      // The remote agent's calls carry no case: the ones made during this turn are this case's.
      const caseStarted = new Date().toISOString();
      try {
        await takeTurn(page, kase.prompt, entry.lane);
        // 👍 or 👎 on the answer just given, as a visitor would.
        if (kase.feedback) feedback = await clickFeedback(page, kase.feedback);
        // A turn that opened another page may still be loading it.
        state = await pageState(page).catch(async () => {
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          return pageState(page);
        });
      } catch (err) {
        error = String(err?.message ?? err);
      }

      // The case's first request is the model's decision; a recommendation, when
      // a search found several records, is a second one.
      const rows = laneA
        ? page.__benchRows.filter((r) => r.caseId === kase.id)
        : await proxyRecords(RUN_ID, modelId, kase.id);
      const record = rows[0] ?? null;
      state.recommended = rows.some((r) => r?.response?.call?.name === 'recommend');
      state.remote = remoteView(page.__remote ?? [], kase.id);
      const remoteRows = REMOTE ? callsBetween(await proxyRecords(RUN_ID, remoteModelId(REMOTE.name), 'remote'), caseStarted, new Date().toISOString()) : [];
      state.scopeOf = scopeOf;
      const verdict = error
        ? { pass: false, checks: [{ name: 'driver', pass: false, detail: error }] }
        : assertCase(kase, record, state);
      if (feedback) {
        verdict.checks.push({ name: `feedback:${kase.feedback}`, pass: feedback.clicked, detail: feedback.detail });
        verdict.pass = verdict.pass && feedback.clicked;
      }

      results.push({
        modelId,
        // The name the proxy served, where the runner's own registry cannot say:
        // a vendor id left to .env.local is unset in this process.
        display: /\(set [A-Z_]+\)/.test(entry.display) ? (record?.display ?? entry.display) : entry.display,
        lane: entry.lane,
        caseId: kase.id,
        measures: kase.measures,
        gate: !!kase.gate,
        pass: verdict.pass,
        checks: verdict.checks,
        latencyMs: record?.latencyMs ?? null,
        usage: record?.response?.usage ?? null,
        costUsd: record ? turnCost(record, entry) : null,
        servedModel: record?.display ?? null,
        call: record?.response?.call ?? null,
        text: record?.response?.text ?? '',
        pageTranscript: state.transcript,
        // The remote agent's own model calls in this case: apart from the page's `usage` and `costUsd`.
        remoteModel: REMOTE ? remoteUsage(remoteRows, MODELS) : null,
        // What a remote agent said and cited in this case, after a handoff.
        remote: state.remote.messages || state.remote.handback
          ? { text: state.remote.text, cards: state.remote.cardKeys, cites: state.remote.cites, answerIds: state.remote.answerIds, handback: state.remote.handback }
          : null,
        actionCard: state.actionCard,
        // What the model recommended after a search, kept so a pick the
        // grounding check refused can be read afterwards.
        recommendation: rows.find((r) => r?.response?.call?.name === 'recommend')?.response?.call?.args ?? null,
        // Carried through so the judge pass can run later without re-driving
        // the browser.
        judge: kase.judge ?? null,
      });

      console.log(
        verdict.pass ? 'pass' : `FAIL  ${verdict.checks.filter((c) => !c.pass).map((c) => c.name).join(', ')}`,
      );

      // Keep the page only when something continues from it.
      await sessions.done(kase, page);
    }

    await sessions.closeAll();
    await profile?.close();
  }
} finally {
  await browser?.close();
  remoteChild?.kill();
}

await mkdir(join(RUNS, RUN_ID), { recursive: true });
const summary = {
  runId: RUN_ID,
  site: SITE,
  startedAt: new Date().toISOString(),
  // Recorded because a result is only comparable against another run of the
  // same corpus; the scorer refuses to merge runs whose snapshot differs.
  corpus: opts.corpus ? String(opts.corpus) : null,
  models: models.map((m) => ({
    id: m,
    ...entryOf(m),
    display: results.find((r) => r.modelId === m)?.display ?? entryOf(m).display,
    keyRef: undefined,
  })),
  results,
  // The remote agent's models, per page model, never folded into the page's cost or latency.
  remoteAgent: REMOTE ? { name: REMOTE.name, env: remoteEnvName(REMOTE.name), byPageModel: remoteSummary(results, models) } : null,
  latency: Object.fromEntries(
    models.map((m) => {
      const xs = results.filter((r) => r.modelId === m && r.latencyMs).map((r) => r.latencyMs);
      return [m, { p50: pct(xs, 0.5), p95: pct(xs, 0.95), n: xs.length }];
    }),
  ),
};
await writeFile(join(RUNS, RUN_ID, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await writeReport(join(RUNS, RUN_ID), summary);

console.log(`\nrun ${RUN_ID}`);
console.log(`  ${join(RUNS, RUN_ID, 'report.json')}`);
console.log(`  ${join(RUNS, RUN_ID, 'report.md')}`);
