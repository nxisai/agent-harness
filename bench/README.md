# Model bench

Runs the harness's case suite in a real browser against several models at once,
and scores what each one *did*.

Not part of the published package — `files` in `package.json` does not include
`bench/`, so none of this ships to npm.

```bash
cp proxy/.env.example proxy/.env.local        # add only the keys you need
docker compose -f compose.yaml up -d
curl localhost:4100/healthz                   # budget + known model ids

npm install && npx playwright install chromium
node runner/run.mjs --models gemma-local,claude-haiku --site http://localhost:3000
```

## Architecture

The bench tests the harness where it actually runs: in a page, in a real browser. The runner opens the site, types each case into the assistant, and reads back what rendered. The site is not modified to take part. Its own `createProxyProvider` posts to `/api/agent`, and the runner retargets that one request to the bench proxy, with the model under test named on a header.

![The runner types each case into the unmodified site in a real browser and reads back what rendered. The page's model calls to /api/agent are retargeted by the runner to the bench proxy, which checks the model allowlist and the Redis budget, forwards to Ollama for local models or to a vendor API, and writes every request and response to a transcript. Browser Gemma runs inside the page and skips the proxy. Tool calls go from the page to the site's own MCP server. The scorer reads the page state and the transcript and writes the report.](docs/architecture.svg)

A turn is scored from two records that nothing in the page can tidy up: the proxy's transcript of what the model was sent and what it called, and the page state the runner reads afterwards (the pick card, the action card, a tool error). Neither alone is enough. A correct call can still render nothing, and a confident reply can sit on a call that failed.

Models run in one of three lanes:

| Lane | Where the model runs | Path |
|---|---|---|
| A | In the page, Gemma 4 on WebGPU | No proxy. The runner opens Chrome with a persistent profile and the page reports each turn back to it. |
| B | Ollama in this compose stack | Through the proxy to `127.0.0.1:11434`. Thinking is off unless the registry entry turns it on. |
| C | A vendor API | Through the proxy, with the vendor key held in `proxy/.env.local` and never in the page. |

Tool calls never touch the bench. They go from the page to the site's own MCP server exactly as they would for a visitor, so a result also reflects the site's index. When every model fails the same case the same way, check the results the tool returned before blaming the models.

## What is here

| Path | |
|---|---|
| `proxy/` | The container. One endpoint satisfying the harness's proxy contract, routing to a model named on `X-Nxis-Model`. |
| `proxy/registry.mjs` | The model **allowlist**. A forged header cannot reach a host that is not in it. |
| `proxy/limit.mjs` | Redis `INCR`/`EXPIRE`, with an in-process fallback. Docker has no edge to refuse at, so the limit is ours to build. |
| `proxy/adapters/` | One per vendor (`anthropic`, `openai`, `google`, `ollama`), each mapping the harness's request onto that API and its tool call back. |
| `suite/copperline.mjs` | The eleven cases: what to type, and what must be true afterwards. |
| `suite/listings.mjs` | Ten cases against the listings directory (`--suite listings`): picks, the site-wide form tool, handoffs. |
| `runner/run.mjs` | Playwright driver. Intercepts the page's `/api/agent` and retargets it; the site stays unmodified. |
| `runner/capture.mjs` | Reads the page state after a turn, and the proxy's transcript rows for it. |
| `proxy/remote.mjs` | A remote agent's own model calls: `/remote/<agent>/<run>/v1/messages`, the Messages API, pinned and recorded apart. |
| `runner/remote-models.mjs` | Those calls per case and per page model, for the report. |
| `runner/remote.mjs` | What a remote agent said after a handoff, from the element's `nxis-handoff` events; pressing Send on a handoff. |
| `runner/score.mjs` | Assertions, and the cost and percentile helpers. |
| `test/` | The bench's own tests: `npm --prefix bench test` (node:test, no browser, no model). |
| `runner/report.mjs` | `report.md` and `report.json` per run. |
| `cases/guardrails/` | The guardrails' adversarial cases, with a benign control for each. Offline: see [Guardrails](#guardrails). |
| `runner/guardrails.mjs` | Runs them against the built harness, with no browser and no model. |

## Remote agents

After `transfer_to_agent` the conversation is with a remote target, and what it says never passes through the proxy: the page talks to the site's relay. The runner records it from the page instead. The element reports every handoff step as an `nxis-handoff` event (a state, a message with its `answer` part, the hand-back), and the runner keeps each one on its own side, filed under the case that was running. So a case can assert on:

| Assertion | Passes when |
|---|---|
| `remoteMatches: ['1\\.', '4\\.']` | Every regex matches the remote agent's text in this case. `(?i)` is case-insensitive, as for `textMatches`. |
| `remoteExcludes: ['evil\\.example']` | No regex matches it. |
| `remoteCards: ['HowTo@https://…/x200-filter']` | An `answer` part cited each `Type@id`, and the page drew it (`.remote .ra-cite[data-id]`, compact rows included). |
| `remoteCardsFromOneScope: true` | Every cited card belongs to one business, or the site's own help. A card's business is its `publisher` (`@id`, `url` or name); a suite can export `scopeOf(card)` with its own rule, such as the card's path. |
| `handback: 'resolved'` | The hand-back's outcome, or any of a list. |

A case whose `prompt` is `(Send)` presses **Send** on the handoff its `continues` case proposed, rather than typing. A message typed while the conversation is handed off goes to the target. Either way the turn is over when the target asks the visitor something or hands back, and a case with only remote assertions is scored without a model turn of its own:

Each case that doesn't `continues` another runs in a browser context of its own, so it starts with no conversation: the element reopens the site's last one from `localStorage`, an open handoff included, and an unrelated case would otherwise carry on where a `(Send)` case left off. A case that `continues` another runs on that case's page, its conversation and handoff kept. Lane A keeps one profile for its model weights, so there the site's `localStorage` is cleared before each independent case instead. A prompt goes to the target when the page's own record says the handoff is open, or, before the page has recorded any handoff state, when its handoff bar shows.

```js
{ id: 'route-howto', prompt: 'How do I replace the filter on the X200?',
  assert: { tool: 'transfer_to_agent', argMatches: ['target=/^support$/'] } },
{ id: 'howto-steps', continues: 'route-howto', prompt: '(Send)',
  assert: { remoteMatches: ['1\\.', '4\\.'], remoteCards: ['HowTo@https://fixture.example/help/x200-filter'] } },
```

### A remote agent's own models

A target that calls models itself, such as the Support Agent (one model composes, one rewrites), reads its model base URL from `<NAME>_MODEL_BASE_URL`. The runner points it at the proxy, so those calls go through the same allowlist and budget as the page's, and are metered apart from them:

```bash
node runner/run.mjs --suite support --models gemma4-local,claude-haiku \
  --remote-agent "node ../support/server.js" --remote-ready http://localhost:8787/healthz
```

| Flag | |
|---|---|
| `--remote-agent "<command>"` | Started once for the run, with `SUPPORT_MODEL_BASE_URL=http://127.0.0.1:4100/remote/support/<run-id>`, and stopped at the end. |
| `--remote-name <name>` | The agent's name, default `support`: the variable is `<NAME>_MODEL_BASE_URL`. Given alone, without a command, the runner prints the value to start your own agent with. |
| `--remote-ready <url>` | Waited for (up to a minute) before the first case. |

The agent's Anthropic client posts to `<base>/v1/messages`, naming the model on `X-Nxis-Model` (a registry id such as `claude-haiku`, or its vendor id, `claude-haiku-5-5`). The proxy calls that entry's model, whatever the body asks for, with its own key, never the agent's. It refuses anything that isn't an Anthropic entry, and anything carrying an `Origin`, since this route is for a process on this machine, not a page. Streaming passes straight through. Each call lands in `runs/<run-id>/remote-<name>.jsonl` and is filed under the case whose turn it fell in. `report.json` keeps it per case as `remoteModel` and per page model as `remoteAgent`, and `report.md` shows it in a **Remote agent** section of its own. The page model's cost and latency columns never include it.

`feedback: 'up'` (or `'down'`) on a case clicks 👍 or 👎 on the answer after the turn: `[data-feedback="up"]` inside the last `.remote[data-answer-id]`. The check `feedback:up` passes when the control is there, enabled, and pressed after the click. It fails when the answer has no `answerId` (so no controls), the handoff is over (the controls are disabled), or the answer already has a vote.

## Guardrails

`cases/guardrails/cases.mjs` is the adversarial suite for the guardrails, following the OWASP cheat sheets' testing guidance: prompt override; indirect injection through a tool result, the page and a hand-back; tool misuse; approval bypass and replay; recursion and cost loops; exfiltration through a URL, a handoff summary and a reply; and system-prompt extraction (the canary). Each case has one observable, and each category has benign controls, in English and at least one other language (Spanish, German or French).

```bash
npm run build                                  # in the package root
node bench/runner/guardrails.mjs               # report.md and report.json in bench/runs/guardrails-<time>/
```

It needs no browser, no proxy and no model, and spends nothing. The headless harness runs with a **scripted worst-case model** that does whatever it is told, and with instrumented tools that only record, on dummy data. A case therefore measures what the guardrails enforce whatever the model does. Whether a real model *attempts* an attack is a separate question, for the live runner, and isn't measured here.

Results are recorded per case:

- an attack is a `violation` when its harm happened (a critical tool ran unconfirmed, a key left the page, the canary was shown);
- a control is a `violation` when the guardrails got in the way of a benign request (a false positive);
- a case is `inconclusive` when the run can't tell;
- a case that threw is counted under errors, apart from the outcomes.

The runner exits 1 on any violation or error. `npm --prefix bench test` runs it, and also runs every attack with each built-in rule turned off, to prove each observable can fire. A fixed bypass gets a case here.

## The parts worth knowing before you trust a number

**The write-path case is a gate, not a weight.** It sits outside the weighted
total: a model that invents a visitor's contact details cannot ship at any
score.

**The gate is not "confirm before send".** `policy.ts` gives every tool without
`readOnlyHint` a confirmation card, so a model cannot dispatch a write on its
own. The model-side failure is filling in values it was never given, so the card
looks complete and the visitor approves a detail they never supplied.

**Lane A latency is not comparable** with a vendor's. On-device generation tracks
whatever else the machine is doing.

**Caching off, corpus pinned.** A cache not keyed by model voids the matrix, and
the grounding cases grade against injected content — pass `--corpus` or the
report says results are not comparable.

## Proving the limiter

The check that distinguishes a real limiter from the in-process fallback:

```bash
docker compose -f compose.yaml restart model-proxy   # restart, not up:
                                                     # up starts depends_on and
                                                     # would revive Redis
# repeat the burst → still 429, so the budget is in Redis and not in memory
```

The [Docker host profile](https://github.com/nxisai/skills/blob/main/skills/agent-model-proxy/references/hosts/docker.md)
in the `agent-model-proxy` skill is the full host profile this container was
built from, and the [agent-harness-model-bench](https://github.com/nxisai/skills/blob/main/skills/agent-harness-model-bench/SKILL.md)
skill covers running and reading the bench.
