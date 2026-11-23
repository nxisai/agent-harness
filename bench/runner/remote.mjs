/**
 * What a remote agent said after a handoff, and what it handed back.
 *
 * Once the page hands a conversation to a target (`transfer_to_agent`), the
 * target's replies never pass through the bench proxy: the page talks to the
 * site's relay, and the relay to the target. The element reports each step as
 * an `nxis-handoff` event (a state, a message with its `answer` part, the
 * hand-back), and the runner keeps them on its own side through a binding, so a
 * turn that changes page keeps its record.
 *
 * Pure apart from {@link recordRemote}, {@link pressSend}, {@link waitForRemote},
 * {@link handoffBarOpen} and {@link clickFeedback}, which drive the page.
 *
 * @module
 */

/** A case whose prompt is this presses the handoff's Send instead of typing. */
export const SEND = '(Send)';

/**
 * One recorded step, as the element reported it, with the case it happened in.
 *
 * @typedef {object} RemoteItem
 * @property {string} caseId
 * @property {'state'|'message'|'handback'} type
 * @property {string} [target]
 * @property {string} [state]
 * @property {string} [text]
 * @property {{ answerId: string, cards: Record<string, any>[], cites: { claim: number, id: string, path?: string }[], note?: string }} [answer]
 * @property {string} [outcome]
 * @property {string} [note]
 */

/**
 * What a case saw of the remote agent: its words, the cards and cites of its
 * `answer` parts, and the hand-back.
 *
 * @typedef {object} RemoteView
 * @property {string} text            Every remote message's text, in order.
 * @property {number} messages
 * @property {Record<string, any>[]} cards  Every answer's cards, in order.
 * @property {string[]} cardKeys      `Type@id` for each card, every type it has.
 * @property {{ claim: number, id: string, path?: string }[]} cites
 * @property {string[]} answerIds
 * @property {{ outcome: string, note: string } | null} handback
 */

const types = (card) => (Array.isArray(card?.['@type']) ? card['@type'] : [card?.['@type']]).filter((t) => typeof t === 'string');

/** `Type@id` for every type a card has: `HowTo@https://fixture.example/help/x200-filter`. */
export const cardKeys = (card) => types(card).map((t) => `${t}@${card['@id']}`);

/**
 * One element event as a recorded item, tagged with its case. Unknown types
 * are dropped.
 *
 * @param {Record<string, any>} detail - An `nxis-handoff` event's detail.
 * @param {string} caseId
 * @returns {RemoteItem | null}
 */
export function remoteItem(detail, caseId) {
  if (!detail || typeof detail !== 'object') return null;
  if (detail.type === 'state') return { caseId, type: 'state', target: detail.target, state: String(detail.state) };
  if (detail.type === 'handback') return { caseId, type: 'handback', target: detail.target, outcome: String(detail.outcome), note: String(detail.note ?? '') };
  if (detail.type === 'message') {
    const a = detail.answer;
    return {
      caseId,
      type: 'message',
      target: detail.target,
      text: String(detail.text ?? ''),
      ...(a && Array.isArray(a.cards)
        ? { answer: { answerId: String(a.answerId ?? ''), cards: a.cards, cites: Array.isArray(a.cites) ? a.cites : [], ...(a.note ? { note: String(a.note) } : {}) } }
        : {}),
    };
  }
  return null;
}

/**
 * Everything one case saw of the remote agent.
 *
 * @param {RemoteItem[]} items
 * @param {string} caseId
 * @returns {RemoteView}
 */
export function remoteView(items, caseId) {
  const mine = items.filter((i) => i.caseId === caseId);
  const messages = mine.filter((i) => i.type === 'message');
  const answers = messages.map((m) => m.answer).filter(Boolean);
  const cards = answers.flatMap((a) => a.cards);
  const back = mine.find((i) => i.type === 'handback');
  return {
    text: messages.map((m) => m.text).join('\n\n'),
    messages: messages.length,
    cards,
    cardKeys: cards.flatMap(cardKeys),
    cites: answers.flatMap((a) => a.cites),
    answerIds: answers.map((a) => a.answerId).filter(Boolean),
    handback: back ? { outcome: back.outcome, note: back.note } : null,
  };
}

/**
 * Whether the conversation is with a remote target now: its last state is one
 * a handoff is still open in.
 *
 * @param {RemoteItem[]} items
 */
export function handedOff(items) {
  const last = [...items].reverse().find((i) => i.type === 'state');
  return !!last && !['handed-back', 'ended', 'failed'].includes(last.state);
}

/**
 * Whether the next prompt goes to the remote target, not the page's model.
 *
 * `(Send)` always does. Otherwise the page's own record decides when it has
 * seen a state; a page that has seen none may still be handed off, by a
 * conversation it restored from storage, which sends no event. Then the
 * element's handoff bar, which shows while a handoff is open, says.
 *
 * @param {string} prompt
 * @param {RemoteItem[]} items - This page's recorded items.
 * @param {boolean} barOpen - Whether the page shows its handoff bar.
 */
export function remoteTurn(prompt, items, barOpen) {
  if (prompt === SEND) return true;
  return items.some((i) => i.type === 'state') ? handedOff(items) : barOpen;
}

/**
 * The agent element, under its name or its deprecated old one (`<nxis-agent-fullscreen>`), so a site that has not
 * renamed its tag yet still benches.
 */
export const AGENT_HOST = ':is(nxis-agent, nxis-agent-fullscreen)';

/** The element's handoff bar, while a handoff is open (it is `hidden` otherwise). */
export const HANDOFF_BAR = `${AGENT_HOST} .handoff-bar:not([hidden])`;

/**
 * Whether the page shows its handoff bar now.
 *
 * @param {Pick<import('playwright').Page, 'locator'>} page
 */
export async function handoffBarOpen(page) {
  return (await page.locator(HANDOFF_BAR).count().catch(() => 0)) > 0;
}

/**
 * Whether a remote turn is over: since `from`, the target asked the visitor
 * something (`awaiting-visitor`) or the handoff ended.
 *
 * @param {RemoteItem[]} items
 * @param {number} from - How many items there were before the turn.
 */
export function remoteSettled(items, from) {
  return items.slice(from).some((i) => i.type === 'state' && ['awaiting-visitor', 'handed-back', 'ended', 'failed'].includes(i.state));
}

/**
 * The business (or `site`) a card belongs to, as the Support Agent's scope
 * check reads it: the business its `publisher` names, by `@id`, `url` or name.
 * A suite on a directory site can export its own `scopeOf`, reading the
 * card's `url` under the business's page path, say.
 *
 * @param {Record<string, any>} card
 * @returns {string}
 */
export function defaultScopeOf(card) {
  const p = Array.isArray(card?.publisher) ? card.publisher[0] : card?.publisher;
  if (typeof p === 'string' && p.trim()) return p.trim();
  if (p && typeof p === 'object') return String(p['@id'] ?? p.url ?? p.name ?? 'site');
  return 'site';
}

// ── Driving the page ────────────────────────────────────────────────────────

/**
 * Record the page's remote items on the runner's side, from now on and on every
 * page this tab opens. `page.__remote` holds them; `page.__benchCaseId` is the
 * case they are filed under.
 *
 * @param {import('playwright').Page} page
 */
export async function recordRemote(page) {
  if (page.__remote) return;
  page.__remote = [];
  await page.exposeBinding('__benchRemote', (_source, detail) => {
    const item = remoteItem(detail, page.__benchCaseId ?? 'ad-hoc');
    if (item) page.__remote.push(item);
  });
  // A document-level listener, added before any of the page's scripts: the
  // element's events bubble out of its shadow root, and this survives the
  // element being redefined or the page changing.
  await page.addInitScript(() => {
    window.__benchRemoteOn = true;
    document.addEventListener('nxis-handoff', (e) => window.__benchRemote?.(e.detail));
  });
  await page.evaluate(() => {
    if (window.__benchRemoteOn) return;
    window.__benchRemoteOn = true;
    document.addEventListener('nxis-handoff', (e) => window.__benchRemote?.(e.detail));
  });
}

/**
 * Press Send on the handoff the page proposed: the last action card's primary
 * button, as a visitor would.
 *
 * @param {import('playwright').Page} page
 */
export async function pressSend(page) {
  const button = page.locator(`${AGENT_HOST} .action-card button.ac-btn.primary`).last();
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.click();
}

/**
 * Wait for a remote turn: until the target asks the visitor something or the
 * handoff ends, or `timeout`.
 *
 * @param {import('playwright').Page} page
 * @param {number} from - `page.__remote.length` before the turn.
 * @param {number} timeout
 * @returns {Promise<boolean>} Whether it settled in time.
 */
export async function waitForRemote(page, from, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (remoteSettled(page.__remote ?? [], from)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Where the feedback controls are: a 👍 or 👎 inside the last remote message
 * that carries an answer id.
 */
export const FEEDBACK_SELECTOR = (value) => `.remote[data-answer-id] [data-feedback="${value}"]`;

/** How long the controls may take to appear: the page loads them on the first answer that has an id. */
const FEEDBACK_WAIT_MS = 5000;

/**
 * Click 👍 or 👎 on the last answer, as a visitor would, and check that it took:
 * the control is pressed afterwards. A control that is disabled (the task is
 * over, or the answer has a vote already) is not clicked.
 *
 * @param {Pick<import('playwright').Page, 'locator'>} page
 * @param {'up'|'down'} value
 * @returns {Promise<{ clicked: boolean, detail: string }>}
 */
export async function clickFeedback(page, value) {
  const control = page.locator(`${AGENT_HOST} ${FEEDBACK_SELECTOR(value)}`).last();
  await control.waitFor({ state: 'attached', timeout: FEEDBACK_WAIT_MS }).catch(() => {});
  if (!(await control.count())) return { clicked: false, detail: `no ${value} control on the last answer` };
  if (await control.isDisabled()) return { clicked: false, detail: `the ${value} control is disabled (the handoff is over, or the answer has a vote)` };
  await control.click();
  const deadline = Date.now() + FEEDBACK_WAIT_MS;
  while ((await control.getAttribute('aria-pressed')) !== 'true') {
    if (Date.now() > deadline) return { clicked: false, detail: `the ${value} control was clicked but is not pressed` };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { clicked: true, detail: '' };
}
