/**
 * Each independent case starts on a clean site; a case that `continues` another keeps its conversation. Driven
 * against a fake browser whose page acts as the element does: it saves the conversation to the context's storage,
 * and on load reopens the last one, a handoff still open included, without sending any event for it.
 *
 *   node --test bench/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteItem, remoteTurn, SEND } from '../runner/remote.mjs';
import { caseSessions } from '../runner/sessions.mjs';

/** A browser context: its own storage, shared by its pages, as an origin's localStorage is. */
function fakeContext(log) {
  const context = {
    storage: new Map(),
    closed: false,
    async newPage() {
      return fakePage(context, log);
    },
    async close() {
      context.closed = true;
    },
  };
  log.contexts.push(context);
  return context;
}

/** A page with the element on it. `send` is what the runner does for a turn. */
function fakePage(context, log) {
  const page = {
    context: () => context,
    closed: false,
    __remote: [],
    barOpen: false,
    async close() {
      page.closed = true;
    },
    /** The element loading: the last conversation comes back from storage, its handoff with it. */
    load() {
      page.barOpen = context.storage.get('conversation')?.handoff === 'open';
    },
    /** One turn, routed as the runner routes it. */
    send(caseId, prompt) {
      const remote = remoteTurn(prompt, page.__remote, prompt !== SEND && page.barOpen);
      log.turns.push({ caseId, to: remote ? 'remote' : 'model' });
      if (prompt === SEND) {
        // The handoff opens and the target asks the visitor something: it stays open.
        for (const state of ['connecting', 'active', 'awaiting-visitor']) page.__remote.push(remoteItem({ type: 'state', target: 'support', state }, caseId));
        page.barOpen = true;
        context.storage.set('conversation', { handoff: 'open' });
      } else if (!remote) {
        context.storage.set('conversation', { handoff: 'none' });
      }
    },
  };
  return page;
}

/** The runner's loop, as far as where a case runs and where its prompt goes. */
async function drive(cases, mode = 'contexts') {
  const log = { contexts: [], turns: [], cleared: 0 };
  const shared = mode === 'shared' || mode === 'shared-unclean' ? fakeContext(log) : undefined;
  const sessions = caseSessions({
    cases,
    shared,
    newContext: async () => fakeContext(log),
    clearSite: mode === 'shared'
      ? async (page) => {
          log.cleared += 1;
          page.context().storage.clear();
        }
      : undefined,
    load: async (page) => page.load(),
  });
  const pages = [];
  for (const kase of cases) {
    const { page } = await sessions.pageFor(kase);
    pages.push(page);
    page.send(kase.id, kase.prompt);
    await sessions.done(kase, page);
  }
  await sessions.closeAll();
  return { log, pages };
}

const SUITE = [
  { id: 'route-howto', prompt: 'How do I replace the X200 filter?' },
  { id: 'howto-steps', continues: 'route-howto', prompt: SEND },
  { id: 'howto-thanks', continues: 'howto-steps', prompt: 'Thanks, that worked.' },
  { id: 'book-cleaning', prompt: 'Book a cleaning for Tuesday.' },
];

test('a case after a (Send) that left its handoff open starts clean and goes to the page’s model', async () => {
  const { log, pages } = await drive(SUITE);
  assert.deepEqual(log.turns, [
    { caseId: 'route-howto', to: 'model' },
    { caseId: 'howto-steps', to: 'remote' },
    // Still in the handoff: it continues the case that opened it.
    { caseId: 'howto-thanks', to: 'remote' },
    { caseId: 'book-cleaning', to: 'model' },
  ]);
  // One context for the chain, one for the unrelated case, and every one closed at the end.
  assert.equal(log.contexts.length, 2);
  assert.equal(pages[0], pages[2]);
  assert.notEqual(pages[3].context(), pages[0].context());
  assert.ok(log.contexts.every((c) => c.closed));
  assert.ok(pages.every((p) => p.closed));
});

test('in a shared profile (Lane A) the site’s storage is cleared before each independent case', async () => {
  const { log, pages } = await drive(SUITE, 'shared');
  assert.equal(log.contexts.length, 1);
  assert.equal(log.cleared, 2);
  assert.equal(log.turns.at(-1).to, 'model');
  assert.equal(pages[3].barOpen, false);
});

test('a restored handoff, with no event on the new page, still routes the prompt to the target', async () => {
  // Without the clean start, the second page reopens the open handoff; the bar, not the record, says so.
  const { log, pages } = await drive(SUITE, 'shared-unclean');
  assert.deepEqual(pages[3].__remote, []);
  assert.equal(pages[3].barOpen, true);
  assert.deepEqual(log.turns.at(-1), { caseId: 'book-cleaning', to: 'remote' });
});

test('the page’s own record of a state wins over the bar, and (Send) is always remote', () => {
  const back = [remoteItem({ type: 'state', state: 'active' }, 'x'), remoteItem({ type: 'state', state: 'handed-back' }, 'x')];
  assert.equal(remoteTurn('Hello', back, true), false);
  assert.equal(remoteTurn('Hello', back.slice(0, 1), false), true);
  assert.equal(remoteTurn('Hello', [], true), true);
  assert.equal(remoteTurn('Hello', [], false), false);
  assert.equal(remoteTurn(SEND, [], false), true);
});

test('a case whose continues is not in the run starts clean', async () => {
  const { log } = await drive([{ id: 'howto-thanks', continues: 'howto-steps', prompt: 'Thanks.' }]);
  assert.equal(log.contexts.length, 1);
  assert.deepEqual(log.turns, [{ caseId: 'howto-thanks', to: 'model' }]);
});
