# The guardrails policy

The guardrails run in the visitor's browser, and a visitor who controls their browser can skip them. The model proxy (`createProxyProvider` and the endpoint you host for it) is the one point on the agent's path that the site controls and the visitor does not. The **policy document** is what lets the proxy enforce the guardrails too, and lets a site change them without redeploying the page.

- The proxy holds the document, loads it from its own environment, a file or a store, and enforces it on every request.
- The page reads a copy from the proxy and merges it over its own configuration, **tighten-only**.
- A policy can only make the guardrails stricter than the built-in defaults and the page's own configuration. The checks that can't be turned off stay on.

On-device models have no proxy, so none of this applies to them: the browser guardrails are all there is.

## The document

JSON, versioned. Every field but `schema` and `version` is optional.

```json
{
  "schema": 1,
  "version": "2026-11-10.1",
  "preset": "strict",
  "input": { "maxLength": 2000, "sendsPerMinute": 6 },
  "tools": {
    "allow": ["search_*", "book_appointment"],
    "deny": ["delete_*"],
    "tier": { "book_appointment": "critical" },
    "maxPerTurn": 2,
    "perMinute": 15,
    "timeoutMs": 15000
  },
  "model": { "maxSteps": 6, "maxTokens": 8000 },
  "conversation": { "maxGenerations": 60, "maxOutputTokens": 40000 },
  "output": { "maxLength": 4000, "linkOrigins": ["https://help.example.com"] },
  "overrides": { "input/injection-phrases": "off" },
  "lockdown": null,
  "systemPrompt": "You are the booking assistant for Example Clinic."
}
```

| Field | Meaning | At the proxy | In the page |
|---|---|---|---|
| `schema` | Always `1`. A copy with another one is refused whole. | yes | yes |
| `version` | Any string, 1 to 64 characters, that changes when the policy does. | sent back on every reply | sent on every request |
| `preset` | `"strict"` switches the strict preset on. `"standard"` never switches it off. | its limits | screening, `medium` tools, remote MCP |
| `input.maxLength`, `input.sendsPerMinute` | The longest visitor message, and sends a minute per conversation. | yes | yes |
| `tools.allow`, `tools.deny` | Tool names, `*` matching anything. A request may only declare tools the policy allows, and a reply may only call a tool the request declared. | yes | yes |
| `tools.tier` | A floor per tool: where the page's tier is lower, this one applies. | no: a confirmation needs the visitor's click, which only the page sees | the `policy/tier` rule |
| `tools.maxPerTurn`, `tools.perMinute`, `tools.timeoutMs` | The tool limits. | | yes |
| `model.maxSteps`, `model.maxTokens` | Generations and output tokens per turn. | yes | |
| `conversation.maxGenerations`, `conversation.maxOutputTokens` | Generations and output tokens over a conversation's life. | yes | |
| `output.maxLength` | The longest reply shown. | | yes |
| `output.linkOrigins` | Narrows the origins links open in without asking. It never adds one. | | yes |
| `overrides` | Built-in rules turned off, as a host could in code: `{ "rule": "off" }`. | | yes |
| `lockdown` | The kill switch: `{ "scope": "tools" \| "agent", "reason": "…" }`. | refuses the call | yes |
| `systemPrompt` | A prompt the proxy holds and uses instead of the page's. Never served to the browser. | yes | the page sends none |

A field the reader doesn't know is ignored, so a newer proxy's document still reads. A field it knows with the wrong shape (a negative limit, a tier that isn't one) refuses the whole document, so nothing half-read applies, and the built-in defaults do.

Code rules and classifiers are not part of the document. They stay in the page (`rules`, `classifier`), or run in the proxy.

## The copy the page reads

The proxy serves the document without its `systemPrompt`. When it holds one, the copy says so with `"prompt": "proxy"`, and the page then sends no system prompt of its own. The canary, made per request by the proxy, is never in either.

## Tighten-only

`tighten(config, policy)` (from `@nxisai/agent-harness/policy`) is the merge the page uses, and a proxy or a custom engine can use it too:

| What | Merged as |
|---|---|
| Every number | The lower of the page's (its preset's, when it set none) and the policy's. A policy can't raise a limit past the built-in default or the page's own. |
| `preset` | Strict when either says so. |
| `tools.deny` | Both lists. |
| `tools.allow` | Only what both allow. A policy can narrow the list, never add to it. |
| `tools.tier` | A floor, as the `policy/tier` rule: where the policy's tier for a tool is higher than the page's, a `high` or `critical` one needs the visitor's confirmation and the bound approval, and a `medium` one is flagged (confirmed in strict). It never lowers a tier. |
| `output.linkOrigins` | Narrows the page's link origins (`output.onlyOrigins`). The page's own origin is always allowed. |
| `overrides` | The page's and the policy's, except the checks that can't be turned off: `tool/tier`, `tool/approval`, `tool/policy`, `tool/lockdown`, `input/lockdown`, `tool/not-listed`. |
| `lockdown` | The stricter of the page's lock and the policy's. A policy never lifts the page's own lock. |

When the policy and the page disagree on a tool's tier, the stricter one wins.

```ts
import { parsePolicy, tighten, browserCopy } from '@nxisai/agent-harness/policy';

const policy = parsePolicy(await fs.readFile('guardrails.json', 'utf8')); // throws PolicyError on a bad document
const config = tighten(pageConfig, policy);
const forTheBrowser = browserCopy(policy); // no systemPrompt
```

## A system prompt the proxy holds

Optional. When the policy carries `systemPrompt`, the proxy uses it for every request and ignores any prompt a request carries, so a visitor who rewrites the page's prompt in their browser changes nothing. The proxy adds a data rule (the page's untrusted text arrives in `<data-…>` blocks) and makes and checks its own canary.

The copy the page reads says `"prompt": "proxy"`. The page then sends a remote model no system message at all, and no canary line. An on-device model still gets the page's prompt: it has no proxy.

Things to know:

- The held prompt replaces every agent's prompt, so a page with several agents that each have their own prompt should keep them in the page.
- The visitor's saved details, which the page puts in its system prompt as a data block, don't reach the model when the proxy holds the prompt. The page still fills forms from them.
- With no `systemPrompt`, the page's prompt is used, exactly as before.

## The page: `guardrails-src`

```html
<nxis-agent guardrails-src="/api/agent"></nxis-agent>
```

The guardrails load a small chunk of their own to fetch the copy (only when the attribute is set), at the first open or send:

- **Cached with its ETag.** The copy is kept in `localStorage` and revalidated with `If-None-Match`; a `304` reuses it.
- **Merged tighten-only** over `agent.guardrails` and the `guardrails` attribute, on every check.
- **Kept current.** Each completion sends the version held as `Nxis-Guardrails-Version`. When the proxy answers with another version in the same header, the page fetches the copy again. A change on the proxy applies to its next request at once, and to the page's own checks as soon as the new copy arrives.
- **If it can't be fetched or read** (the network, a `405` or `404`, a malformed copy, another schema), nothing is merged: the page's configuration and the built-in defaults apply, and the proxy still enforces its own copy. A copy that loaded once is kept if a later fetch fails, since it can only be stricter.

- **Opening hours.** The copy may also carry `openingHours`: the business's hours as its owner keeps them (`{ timeZone, weekly: { mon: [["07:00", "18:00"]], … }, closed?: ["YYYY-MM-DD"] }`). It is not part of the policy and merges into nothing; the results card's open status for the business's own records reads it, in that time zone (an emergency service keeps its own hours).

The attribute is read once, when the guardrails load. Headless, fetch the copy yourself and pass `tighten(config, parsePolicy(copy))` as the configuration.

## The proxy contract, with guardrails

Everything in [remote-providers.md](remote-providers.md) still holds. With a policy configured, the proxy adds:

| | |
|---|---|
| `GET` the endpoint | The copy: the document without `systemPrompt` (`"prompt": "proxy"` when it holds one), with `ETag` and `Cache-Control: no-cache`; `304` on `If-None-Match`. |
| Request `Nxis-Conversation` | The conversation id the proxy issued, sent back by `createProxyProvider`. |
| Request `Nxis-Guardrails-Version` | The policy version the page holds. |
| Response `Nxis-Conversation` | A new signed conversation id (HMAC over the id, its expiry and the origin; short-lived), when the request had none that was good. |
| Response `Nxis-Guardrails-Version` | The current version, when it differs from the page's. |
| A refusal | A non-2xx answer with `{ "error": "…", "refusal": { "stage", "rule", "action": "block", "severity" } }`, and `Nxis-Guardrail: <rule>`. Never with what the visitor wrote. |

`createProxyProvider` sends the two request headers only once it has something to send, so with no guardrails at the proxy, requests are as they always were. It keeps only the four typed fields of a refusal, and only in the shapes the guardrails use; anything else is an ordinary failure. The guardrails then say the page's own message for that rule, and raise `nxis-guardrail` with the same detail as their own decision:

| Rule | Status | What the visitor reads |
|---|---|---|
| `input/length` | 413 | "That message is too long (over 4,000 characters). Please shorten it." |
| `input/rate` | 429 | "You're sending messages quickly. Wait a moment, then try again." |
| `input/lockdown` | 503 | "The assistant isn't available right now. Please try again later." |
| `spend/cap`, `spend/credits` | 503 | "The assistant isn't available right now. Please try again later." |
| `tool/lockdown` | 503 | "I can't take actions right now, but I can still answer questions." |
| `tool/not-listed` | 403 | "I can't use that here." |
| `tool/policy` | 422 | "I can't tell how safe that is, so I won't do it." |
| `model/budget` | 429 | "I've gone round too many times on this one. What next?" |
| `output/canary` | 422 | "I can't share that." |
| `output/secret` | 422 | "I can't show that reply: it looked like it held a password or a key." |
| anything else | | "I can't help with that here." |

An endpoint on another origin than the page must allow the request headers (`Access-Control-Allow-Headers`) and expose the response ones (`Access-Control-Expose-Headers`).

The `agent-model-proxy` skill writes a proxy that does all of this, for Netlify, Vercel, Cloudflare and Docker.

## What the proxy enforces, and what stays in the browser

| At the proxy, on every request | Only in the browser |
|---|---|
| Input length (the newest message's own words, outside data blocks) | Approvals tied to a call, and every confirmation |
| Send rate per conversation, and per IP and origin | Link confirmation and `link-origins` |
| Generations and output tokens, per turn and per conversation | Screening what the visitor typed, and tool results |
| The declared tools: the allow and deny lists; a reply may only call a declared tool | Tool tiers, which decide what the visitor confirms |
| The kill switch | The page's own rules and classifier |
| The reply, screened on the model's stream for the canary and secrets, cut before it is sent | Replies cut for length; `output.redact` |
| The system prompt, when the policy holds one | |

Until the page has the new copy, a refusal from the proxy is said with the page's own message and numbers (a length refusal names the page's limit, not the proxy's). On-device models have no proxy, so for them only the right-hand column exists.
