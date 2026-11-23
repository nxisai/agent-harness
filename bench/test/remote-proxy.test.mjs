/**
 * A remote agent's models through the bench proxy, against a scripted remote agent and a mock vendor: nothing here
 * reaches a real model or spends anything. The agent posts as Anthropic's client does to the base URL the runner
 * gives it; the proxy pins the model to the registry's, uses its own key, and records each call apart from the
 * page's, and the report shows them in a section of their own.
 *
 *   node --test bench/test/
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'bench-remote-'));
process.env.TRANSCRIPT_DIR = dir;
process.env.RUNS_DIR = dir;
// A stand-in, so the registry lets the Claude entries through; the mock vendor checks it arrives.
process.env.ANTHROPIC_API_KEY = 'proxy-test-key';

const { MODELS, resolve } = await import('../proxy/registry.mjs');
const { append } = await import('../proxy/transcript.mjs');
const { handleRemote, isRemotePath, resolveRemote, streamUsage } = await import('../proxy/remote.mjs');
const { callsBetween, remoteBaseUrl, remoteEnvName, remoteModelId, remoteSummary, remoteUsage } = await import('../runner/remote-models.mjs');
const { proxyRecords } = await import('../runner/capture.mjs');
const { writeReport } = await import('../runner/report.mjs');

/** The vendor, mocked: what it was sent, and an answer with usage, streamed when asked. */
const vendor = { calls: [] };
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  vendor.calls.push({ url: req.url, headers: req.headers, body });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1. Turn it off.' } })}\n\n`);
    res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 300 } })}\n\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'filter replacement x200' }], stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 20 } }));
});

let proxy;
let base;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  proxy = createServer((req, res) => {
    const url = new URL(req.url, 'http://bench');
    if (!isRemotePath(url.pathname)) return res.writeHead(404).end();
    return handleRemote(req, res, url, {
      models: MODELS,
      resolve,
      take: async () => ({ allowed: true, retryAfter: 0, backend: 'memory' }),
      append,
      maxTokens: 4096,
      upstream: up,
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  base = remoteBaseUrl(`http://127.0.0.1:${proxy.address().port}/api/agent`, 'support', 'run-1');
});
after(async () => {
  proxy.close();
  upstream.close();
  await rm(dir, { recursive: true, force: true });
});

/** The scripted Support Agent: its rewrite and compose calls, as its Anthropic client makes them. */
const call = (model, body, headers = {}) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'agent-own-key', 'anthropic-version': '2023-06-01', 'x-nxis-model': model, ...headers },
    body: JSON.stringify(body),
  });

test('the runner gives the agent its base URL, by the name it reads', () => {
  assert.equal(remoteEnvName('support'), 'SUPPORT_MODEL_BASE_URL');
  assert.equal(base.replace(/:\d+/, ':P'), 'http://127.0.0.1:P/remote/support/run-1');
});

test('a remote agent’s calls go to the registry’s model, with the proxy’s key, and are recorded apart', async () => {
  const from = new Date().toISOString();
  const rewrite = await call('claude-haiku', { model: 'claude-whatever', max_tokens: 99999, messages: [{ role: 'user', content: 'how replace filter x200' }] });
  assert.equal(rewrite.status, 200);
  assert.equal((await rewrite.json()).content[0].text, 'filter replacement x200');
  const compose = await call('claude-sonnet-5-5', { model: 'claude-sonnet-5-5', max_tokens: 800, stream: true, messages: [{ role: 'user', content: 'compose' }] });
  assert.equal(compose.status, 200);
  assert.match(await compose.text(), /Turn it off/);
  const to = new Date().toISOString();

  // The vendor saw the pinned models and the proxy's own key, never the agent's.
  assert.deepEqual(vendor.calls.map((c) => [c.url, c.body.model, c.body.max_tokens, c.headers['x-api-key']]), [
    ['/v1/messages', 'claude-haiku-5-5', 4096, 'proxy-test-key'],
    ['/v1/messages', 'claude-sonnet-5-5', 800, 'proxy-test-key'],
  ]);
  assert.ok(vendor.calls.every((c) => !JSON.stringify(c.headers).includes('agent-own-key')));

  // Recorded in the run's remote transcript, not the page model's.
  const rows = await proxyRecords('run-1', remoteModelId('support'), 'remote');
  assert.deepEqual(rows.map((r) => [r.model, r.stream, r.response.usage]), [
    ['claude-haiku', false, { promptTokens: 400, outputTokens: 20 }],
    ['claude-sonnet', true, { promptTokens: 1200, outputTokens: 300 }],
  ]);
  assert.ok(rows.every((r) => r.ok && typeof r.latencyMs === 'number'));
  const files = await readFile(join(dir, 'run-1', 'remote-support.jsonl'), 'utf8');
  assert.equal(files.trim().split('\n').length, 2);

  // Costed from the registry's rates, by model, for the case they fell in.
  const mine = callsBetween(rows, from, to);
  const u = remoteUsage(mine, MODELS);
  assert.equal(u.calls, 2);
  assert.ok(Math.abs(u.byModel['claude-haiku'].costUsd - (400 / 1e6) * 0.1 - (20 / 1e6) * 0.5) < 1e-12);
  assert.ok(Math.abs(u.costUsd - u.byModel['claude-haiku'].costUsd - u.byModel['claude-sonnet'].costUsd) < 1e-12);
  assert.deepEqual(callsBetween(rows, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z'), []);

  // The report: the page's cost stays the page's, and the remote agent has its own section.
  const results = [
    { modelId: 'gemma-local', caseId: 'route-howto', pass: true, checks: [], costUsd: null, latencyMs: 900, remoteModel: remoteUsage([], MODELS) },
    { modelId: 'gemma-local', caseId: 'howto-steps', pass: true, checks: [], costUsd: null, latencyMs: null, remoteModel: u },
  ];
  const byPageModel = remoteSummary(results, ['gemma-local']);
  assert.equal(byPageModel['gemma-local'].calls, 2);
  assert.equal(byPageModel['gemma-local'].p50, u.latencyMs);
  const models = [{ id: 'gemma-local', display: 'Gemma 3 4B (local)', lane: 'B' }];
  await writeReport(dir, { runId: 'run-1', site: 'http://localhost:3000', corpus: 'fixture', models, results, latency: { 'gemma-local': { p50: 900, p95: 900 } }, remoteAgent: { name: 'support', env: 'SUPPORT_MODEL_BASE_URL', byPageModel } });
  const md = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(md, /\| Gemma 3 4B \(local\) \| 2\/2 \| B \| 900ms \| 900ms \| — \|/);
  assert.match(md, /## Remote agent: support/);
  assert.match(md, /\| Gemma 3 4B \(local\) \| 2 \| 0 \| .* \| \$0\.\d{4} \| claude-haiku ×1, claude-sonnet ×1 \|/);
});

test('refuses a page, an unknown model, and a model that is not Anthropic’s, before calling anything', async () => {
  const n = vendor.calls.length;
  assert.equal((await call('claude-haiku', { messages: [] }, { origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await call('no-such-model', { messages: [] })).status, 400);
  assert.match((await (await call('', { model: 'gemma-local', messages: [] })).json()).error.message, /not an Anthropic model/);
  assert.equal((await fetch(`${base}/v1/other`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal(vendor.calls.length, n);
  assert.deepEqual(resolveRemote(MODELS, resolve, undefined, undefined), { error: 'Name the model on X-Nxis-Model.' });
});

test('reads a stream’s usage, input from its start and output from its last delta', () => {
  const sse = ['data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}', 'data: {"type":"message_delta","usage":{"output_tokens":7}}', ': keep-alive'].join('\n');
  assert.deepEqual(streamUsage(sse), { promptTokens: 15, outputTokens: 7 });
});
