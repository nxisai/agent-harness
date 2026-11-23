# Handing a conversation to another agent, or to a person

The in-page assistant can hand a conversation to someone else: a remote agent that can finish what it can't, or a person on the site's team. Both are reached the same way, over [A2A 1.0](https://a2a-protocol.org/latest/specification/). A person sits behind a help desk that speaks A2A, so the harness never needs to know which kind it is talking to.

You host two things; the harness writes the client:

- **A relay** on your own origin, which holds the credentials, the list of targets, and the record of each handoff.
- **The targets** behind it: any A2A 1.0 agent, and a desk for people.

Nothing leaves the page until the visitor has seen what will be sent and pressed Send.

## The client

```ts
const agent = document.querySelector('nxis-agent');
agent.handoff = {
  relay: '/api/handoff',
  targets: {
    booking: { kind: 'agent', label: 'Booking' },
    team: { kind: 'person', label: 'Our team' },
  },
};
```

That registers up to two tools, `transfer_to_agent` for the `agent` targets and `talk_to_a_person` for the `person` targets, each listing only the targets named here. Both are consequential, so the element asks the visitor to confirm before one runs. Once a conversation is handed off, what the visitor types goes to the target until the target finishes, hands back, or the visitor presses **Back to the assistant**.

Headless, the same pieces are exported:

```ts
import { HandoffController, registerHandoffTools, AgentCoordinator } from '@nxisai/agent-harness';

const handoff = new HandoffController({ relay: '/api/handoff', targets });
await registerHandoffTools(document.modelContext, handoff, { conversationId: () => currentId });
const coordinator = new AgentCoordinator({ agents, rules, fallback: 'main', handoff: { controller: handoff, conversationId: () => currentId } });

handoff.addEventListener('handoff', (e) => render(e.detail)); // every HandoffEvent
```

A target's URL and credentials are never in the page. The browser knows a target by its name and label only.

### NxisAI's relay: targets from agent cards

With NxisAI's hosted relay, the page names the relay alone:

```ts
agent.handoff = { relay: 'https://agents.nxis.ai/v1/s/<site>/handoff' };
```

The relay serves the site's specialists as [A2A Agent Cards](https://a2a-protocol.org/latest/specification/) beside it: `GET <edge>/v1/s/<site>/agents` answers `{ "agents": [AgentCard, …] }`, with an `ETag`. Each card carries the NxisAI handoff extension, `https://nxis.ai/a2a/handoff/v1`, whose `params` are `{ target, kind, label }`, and its `url` is the relay's own endpoint for that target, `<edge>/v1/s/<site>/handoff/<target>`. The harness:

- **reads the cards lazily**: with the relay's target list, the first time the targets are read (when the agent is first opened), never on page load. The code that reads them is a chunk of its own, loaded then too.
- **keeps them thirty seconds**, like the target list, and reads them again after that with `If-None-Match`, so an unchanged list costs a 304. A specialist enabled, renamed or paused in the dashboard reaches the chat within a minute, with no site deploy: every turn describes the handoff tools from the targets listed now, and leaves out a tool with none left.
- **trusts only the relay's cards**: a card whose `url` isn't on the relay's origin, under the relay's path, for the target it names, is ignored. A card the relay's target list doesn't list is not offered either.
- **tells the model what each one does**: the tool's description gives each target's card description and its skills, each with its description and up to two examples.

A relay whose path doesn't end in `/handoff` has no card list, and one that answers 404 for it is not asked again.

`targets` still works with any relay, including NxisAI's. A target named there keeps its `kind`, `label`, `description` and `takes`; its card, when there is one, adds what the model reads. A target the relay's cards list that the page doesn't name is offered too.

### Your own agent cards

A site that runs its own relay can point each target at the agent card it publishes, on the relay's origin:

```ts
agent.handoff = {
  relay: '/api/handoff',
  targets: {
    team: { kind: 'person', label: 'Our team', card: '/a2a/desk/agent-card.json' },
  },
};
```

The card is read with the same parser as the relay's, when the targets are, and its description and skills go into the tool's description. A card on another origin, or whose endpoint is on another origin, is not read.

### Targets

| Field | Meaning |
| --- | --- |
| `kind` | `'agent'` or `'person'`. Decides which tool offers it and how waiting is shown. |
| `label` | What the visitor reads: "You're talking with *Booking*". |
| `description` | Optional. What it handles, shown to the model so it picks the right one. |
| `takes` | Optional. Names of site forms this target handles in their place, by tool name: `['quote_form']`. See [Targets that take a form](#targets-that-take-a-form). |
| `card` | Optional. This target's A2A agent card, on the relay's origin: `'/a2a/desk/agent-card.json'`. See [Your own agent cards](#your-own-agent-cards). |

Availability, queue length, hours and whether the transcript may be shared come from the relay at runtime, not from this config.

### Targets that take a form

A site with an agent for quotes wants a quote to go to that agent, not into the page's quote form. Telling the model so in the prompt is not enough: asked "Get a quote from McManus Electric", it sees a tool named for exactly that and calls it. So the target says which forms it takes:

```ts
agent.handoff = {
  relay: '/api/handoff',
  targets: {
    quote: {
      kind: 'agent',
      label: 'Royal Oak Quotes',
      description: 'takes a quote request for a contractor in conversation and sends it',
      takes: ['quote_form'],
    },
  },
};
```

Names are matched without the site-wide suffix, so `'quote_form'` covers the page's own `quote_form` and the site-wide `quote_form_anywhere` that reaches every listing's quote form from any page.

While the relay lists the target as **available**, and the turn's handoff tool can reach it:

- **The model is not offered those forms.** The only way to a quote is the handoff.
- **A call to one anyway becomes the handoff.** A model can call a tool it was not shown, and the page still has it, so a call to a taken form is replaced, before it is shown or run, by `transfer_to_agent` (or `talk_to_a_person` for a `person` target) with a `reason` ("Wants a quote from McManus Electric") and a `summary` built only from the values the call carried. The visitor confirms it with **Send**, like any handoff, and the transcript records the handoff.
- **A link from the NxisAI app that names the form starts the handoff.** `?nxis_handoff=<the form's action @id>` opens a new conversation with the same start message the form would have used ("Get a quote from McManus Electric"), as a handoff the visitor confirms; `nxis_intent` waits in the composer as before.
- **A resolved hand-back counts as the form sent.** The handoff remembers which form it stands in for: the link's action, the form call it replaced (for a site-wide form, the business the call named), or, when the model handed off directly, the one page form on this page the target takes (none when there are several). When the target hands back with outcome `resolved`, that is reported to the site's server exactly as the form going through would be (`nxis_track_site_action`, outcome `submitted`), with the report token the link brought. `unresolved`, `transferred`, `failed` and ended handoffs report nothing, and a handoff is reported at most once, across reloads: the session keeps what it stands in for, and that it was reported.

Anything short of a clear "available" — the relay down, slow (a turn waits at most 1.5 s for it, and its answer is cached for 30 s), the target away or not listed — leaves the forms exactly as they are: offered, called, and opened by the link.

Headless, give the harness the controller (`new AgentHarness({ ..., handoff: () => controller })`); the element does this itself. `formTakenBy(controller, toolName)` says whether an available target takes a form now.

## The relay

One endpoint on your origin, in whatever runs server code there: a Netlify or Vercel function, a Cloudflare Worker, or a route in your own server.

### `GET {relay}`

The targets the relay will forward to, with their current availability:

```json
{
  "targets": [
    { "name": "booking", "kind": "agent", "label": "Booking", "available": true, "transcript": false },
    { "name": "team", "kind": "person", "label": "Our team", "available": false,
      "hours": "Mon–Fri 8am–6pm ET", "queueLength": 0, "waitMinutes": null, "transcript": false }
  ]
}
```

A target the relay does not list is not offered, whatever the page config or an agent card says.

### `POST {relay}/{name}`

An A2A 1.0 JSON-RPC request, forwarded to that target. The relay accepts `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask` and `SubscribeToTask`, and nothing else. The response is passed through: JSON for the first three, `text/event-stream` for the streaming two.

The relay MUST:

1. **Check the origin and apply limits**: requests from other origins get 403, over-rate requests get 429 with `Retry-After`, and bodies over 64 KB get 413.
2. **Resolve the name from its own allowlist.** An unknown name is 404. A URL in the request is never followed.
3. **Tie tasks to the browser that started them.** The first `SendStreamingMessage` or `SendMessage` of a handoff answers with a `Nxis-Handoff-Key` response header. Every later call about that task carries it back as a request header, and a call without the right key is 403. This stops one visitor reading or cancelling another's handoff by guessing a task id.
4. **Forward with the site's credential** and `A2A-Version: 1.0`, adding `A2A-Extensions: https://nxis.ai/a2a/handoff/v1`.
5. **Add a push-notification config** on the first message when the target supports push (`capabilities.pushNotifications`), pointing at its own webhook, so a reply can reach a visitor who has left.
6. **Record each handoff**: target, task id, context id, the visitor's key, what was shared (the envelope's `consent`), and the contact details if given. Records expire (30 days in the reference).

### `POST {relay}/push`

The webhook targets post A2A push notifications to. When a person replies and the visitor has no stream open, the relay emails the visitor, if the envelope carried an email, with the reply and a link back to the page with the conversation.

## The handoff extension

`https://nxis.ai/a2a/handoff/v1`. Everything it adds travels as A2A `data` parts marked with the extension:

```json
{ "data": { "handoff": "<kind>", "...": "..." }, "mediaType": "application/json",
  "metadata": { "extension": "https://nxis.ai/a2a/handoff/v1" } }
```

A target that ignores the extension still works: the first message also carries the summary as a `text` part.

### `envelope`: the first message

| Field | Required | Holds |
| --- | --- | --- |
| `reason` | yes | Why, in one line: "Wants to book a boiler inspection". |
| `summary` | yes | What the target needs to know. Written by the model, **shown to the visitor before sending**. |
| `page` | yes | `{ url, title, entity? }`. `url` is the page without dynamic parameters (`surface`, `utm_*`, `gclid`, `fbclid`); `entity` is the page's JSON-LD `@id` when there is one. |
| `facts` | no | `[{ name, value }]`: values the visitor gave and agreed to share. |
| `transcript` | no | `[{ role: 'visitor' \| 'assistant', text }]`, the last turns, text only. Sent only when the relay lists the target with `transcript: true`. |
| `contact` | no | `{ email?, phone?, name? }`, only when the visitor entered it to be contacted. |
| `locale` | yes | The visitor's language, `navigator.language`. |
| `ui` | yes | What the page draws of a reply, by version: `{ cards: 2, feedback: 1 }`. `cards` draws an [`answer`](#answer-cards-for-an-answers-sources) part's sources (`1`: as cards under the reply; `2`: as a numbered Sources list in the bubble, with a marker after each claim the part's `claims` places); `feedback: 1` puts thumbs-up and thumbs-down buttons on each answer with an `answerId` and sends them back as [`feedback`](#feedback--and--on-an-answer) parts. A target that finds no `ui.cards` (an older harness) should put its sources in the text instead. Not a shared field: it says what the page can do, not anything about the visitor. |
| `returnTo` | yes | `{ conversationId, origin }`. |
| `consent` | yes | `{ target, shared, at }`: the target's name, the envelope field names sent, and the time the visitor pressed Send. |

### `queue`: while waiting for a person

In a status message while the task is `TASK_STATE_SUBMITTED`: `{ handoff: 'queue', position?, waitMinutes? }`.

### `operator`: who is speaking

On an agent message: `{ handoff: 'operator', name, kind: 'person' | 'agent' }`. The harness labels the message with `name`. A desk sends it on the first message from each operator.

### `answer`: cards for an answer's sources

On an agent message, beside its text part: `{ handoff: 'answer', answerId, cards, cites, claims?, note? }`. The text part is still required; it is the reply's words, drawn in the bubble.

| Field | Holds |
| --- | --- |
| `answerId` | Opaque, per answer. |
| `cards` | Up to 12 records, one per cited source, in citation order: `{ '@id', '@type', name?, headline?, url?, datePublished?, dateModified?, publisher?, author?, image?, thumbnailUrl?, duration?, contentUrl?, embedUrl?, focus?, citation? }`. Any other field is dropped. |
| `cards[].focus` | `{ path, label, startOffset?, url? }`: the passage cited. The card shows `label`, and a clip's `startOffset` (seconds) as its time, "2:14 · Removing the cover". |
| `cards[].citation` | `'typed'` (the default) or `'page'`: a page cited by its description alone, labelled **From the page** with one **Open the page** link. |
| `cites` | `[{ claim, id, path?, record? }]`: which card supports which claim of the text. `id` is the card's `@id`, or a passage's own `@id` (a question, a step) with `record`, the card's `@id`, beside it. A how-to's `path` (`step[2]`) names the steps on its Sources row ("steps 3–5"). |
| `claims` | Optional. `[text, …]`, by claim index: the text each claim is drawn as in the text part, exactly as it appears there (`''` for a claim with none of its own). The page puts the claim's markers after it, before its closing punctuation. Without it, the sources are listed with no markers in the text. Up to 60. |
| `note` | A line for the visitor, drawn above the reply: the language note when the answer is in another language than theirs. When the text's first line is the same note, it is drawn once. |

The harness draws the answer's sources in the reply's bubble, as a **Sources** list: one numbered row per card, with its title, a line saying what it is and the passage cited ("How-to · steps 3–5", "FAQ", "Video · 2:14 · Removing the cover") and an external-link icon. Each claim found in the text (`claims`) gets a marker after it, a button named "Source N" for each card its `cites` name; pressing one moves focus to that row and highlights it.

- **Numbering** follows the order sources first appear in the text. A card no placed claim cites is listed after, with no marker. A one-source answer is numbered too (`1`), so every answer reads the same.
- **A claim** is looked for after the one before it, whitespace aside; one that only appears earlier in the text (a claim that repeats a passage already drawn) is marked there; one not found has no marker, and its cards are still listed. A marker is never put inside a link.
- **A row** opens its card's link, by the renderer spec's archetype: an FAQ, a how-to, an article or a page is `readable` (the passage's `url`, else the page), a video or a clip `media` (the clip's `url`, else the video's, at the clip's time on YouTube and Vimeo (`t=` and `#t=`), else the file), a person or a profile page `profile` and a product or a service `offerable` (its page); `citation: 'page'` is labelled **From the page**. This page's own fragment moves in place, another page of the site opens in this tab with the conversation kept, and another origin in a new tab with no opener and no referrer. Every row asks the guardrails' navigation check first: another origin than the page's and `link-origins` is confirmed, anything but http(s) never opens.
- **Content stays a card.** A video or a clip and a profile are also drawn as their cards under the bubble, wearing their number: **Watch** (with `media="play"`, a video the player may play plays in the chat, from the clip's `focus.startOffset`) or **Their page**. A cited card never carries an action CTA. A record already drawn in the conversation (in a search's results, or an earlier answer) is listed, and its card not drawn again.
- An older target that sends no `claims` gets the list, numbered in card order, and no markers.

Every field is data: set as text, never as markup, and never run. A card's link is drawn only when its address is on an origin the page allows (below); a card with none has no button.

### `feedback`: 👍 and 👎 on an answer

From the page, on the same task: `{ handoff: 'feedback', answerId, value }`, the only part of its message (there is no text part), sent with `SendMessage` and the task's `Nxis-Handoff-Key`. The relay passes it like any other message.

| Field | Holds |
| --- | --- |
| `answerId` | The `answerId` of the [`answer`](#answer-cards-for-an-answers-sources) it is about. |
| `value` | `'up'` or `'down'`. |

The harness draws a thumbs-up and a thumbs-down under every answer that has an `answerId`, cards or not, as toggle buttons named **Helpful** and **Not helpful**. Each shows an icon ([Heroicons](https://heroicons.com) `hand-thumb-up` and `hand-thumb-down`): the outline one until it is pressed, then the solid one. Each answer gets one vote: the one given stays pressed and both are disabled, across reloads. They're disabled as well when the task the answer came on is over. A vote is not a turn: it isn't drawn as the visitor's message, and it never reaches the page's model. What the target answers to it (a task, or a message, as the response to `SendMessage`) is drawn as its reply.

`HandoffController.feedback(conversationId, answerId, value)` sends one from a page of your own. It resolves `true` when the relay took it, and `false` when there is no open task, the answer already has a vote, or the relay refused it. The controller records the vote before sending it, so a failed send is not retried.

### Links in a reply

A remote reply's addresses become links, bare (`https://…`) or as Markdown (`[words](address)`), when the page allows their origin: this page's own, and those listed in the element's `link-origins` attribute (`link-origins="https://help.example.com"`). Another origin is https only, opens in a new tab with no referrer, and a link to another page of this site keeps the conversation, as **Open page** does. Anything else (another origin, `javascript:`, `data:`, an address with credentials) stays as written, as text. A cited video's **Watch** may also link to YouTube or Vimeo.

### `handback`: the last word

In the final status message, or as an artifact: `{ handoff: 'handback', outcome, note, references? }`.

| Field | Holds |
| --- | --- |
| `outcome` | `'resolved'`, `'unresolved'`, or `'transferred'` (the target passes the visitor back to the assistant to carry on). |
| `note` | One or two sentences for the in-page assistant: what happened, what's left. |
| `references` | `[{ label, value }]`: a booking reference, a ticket number. Shown to the visitor. |

The harness adds the hand-back to the conversation as the in-page assistant's own note, so it can carry on: "Your inspection is booked for Tuesday, reference CPL-4821. Anything else?" Nothing else the target said reaches the model: remote messages are shown to the visitor, and never treated as instructions.

## Lifecycle

| Harness state | A2A | The visitor sees |
| --- | --- | --- |
| `connecting` | request sent, no task yet | "Connecting you to Booking…" |
| `queued` | `TASK_STATE_SUBMITTED` | "Waiting for our team, 2nd in line, about 4 minutes" (from `queue`) |
| `active` | `TASK_STATE_WORKING` | The target's messages, by name. |
| `awaiting-visitor` | `TASK_STATE_INPUT_REQUIRED` | The target's question. The next message goes to it. |
| `handed-back` | `TASK_STATE_COMPLETED` with a hand-back | "Back with the assistant", and the references. |
| `ended` | `TASK_STATE_COMPLETED` without one, or `TASK_STATE_CANCELED` | "Booking has finished." |
| `failed` | `TASK_STATE_FAILED`, `TASK_STATE_REJECTED`, `TASK_STATE_AUTH_REQUIRED`, a network or relay error | Why, and the assistant takes over again. |

`TASK_STATE_AUTH_REQUIRED` is treated as failed: a target acting as the visitor is out of scope for now.

A handoff survives page changes and reloads. The controller keeps `{ target, taskId, contextId, key, state }` per conversation in `localStorage`, and on the next page resumes it: `SubscribeToTask` while it is live, `GetTask` once it has finished. A stream the host cuts off (a Netlify function has a time limit) is resumed the same way.

## Writing a target

Any A2A 1.0 server works. What makes one good behind a handoff:

- Read the `envelope` from the first message, and don't ask the visitor for anything it already says.
- Ask with `TASK_STATE_INPUT_REQUIRED`, one question at a time.
- Finish with a `handback`, so the assistant can carry on.
- Declare the extension in the Agent Card's `capabilities.extensions`.

[`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) implements the server side of A2A, so an agent built on it adds only its own work and the handoff parts above.

### A desk for people

A person can't answer within one request, and the request streaming to the visitor is not the one the operator's reply arrives on. So a desk keeps the task in a store both requests can read, and the streaming side polls it. A complete desk has three parts: the A2A face the relay talks to, an API for operators, and a console where they read and reply.

An adapter puts an A2A face on an existing desk. It has to:

1. On a new task, open a conversation in the desk carrying the envelope, and answer `TASK_STATE_SUBMITTED` with a `queue` status.
2. Turn the operator's first reply into `TASK_STATE_WORKING` with an `operator` part, and later replies into agent messages.
3. Turn an operator's question into `TASK_STATE_INPUT_REQUIRED`, and the visitor's answer into a message in the desk.
4. Turn closing the conversation into `TASK_STATE_COMPLETED` with a `handback`.
5. Post push notifications to the relay for every change while no stream is open.

A team chat makes a workable desk: one thread per handoff in a support channel, with the operator's replies in that thread becoming the task's messages.

## Security

- **Consent first.** The visitor sees the target, the summary and what else is shared, and presses Send. Nothing is sent before that.
- **Targets come from configuration.** The tools' `enum` comes from the element's config, and the relay refuses any name not on its list.
- **No credential in the page.** The relay holds them all.
- **Remote replies are data.** They render as text, with links only to origins the page allows, and an `answer` part's cards are drawn from data, never as markup. They never reach the model as instructions, and never run a tool.
- **The visitor can leave at any time.** **Back to the assistant** sends `CancelTask`.
- **Records expire.** The relay deletes handoff records after its retention period.
