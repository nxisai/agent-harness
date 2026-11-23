/**
 * Remote assertions against a scripted remote target: the element's `nxis-handoff` events for a handoff to a
 * Support Agent, recorded as the runner records them, then scored. Each assertion is shown passing and failing.
 *
 *   node --test bench/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardKeys, defaultScopeOf, FEEDBACK_SELECTOR, handedOff, remoteItem, remoteSettled, remoteView, SEND } from '../runner/remote.mjs';
import { assertCase, assertRemote } from '../runner/score.mjs';

const HOWTO = { '@id': 'https://fixture.example/help/x200-filter', '@type': 'HowTo', name: 'Replacing the X200 filter', url: 'https://fixture.example/help/x200-filter' };
const FAQ = { '@id': 'https://fixture.example/help/faq#q3', '@type': ['FAQPage', 'WebPage'], name: 'Filter FAQ' };
const ACME = (id) => ({ '@id': `https://fixture.example/acme/${id}`, '@type': 'FAQPage', publisher: { '@id': 'https://fixture.example/acme#org', name: 'Acme' } });
const BOLT = (id) => ({ '@id': `https://fixture.example/bolt/${id}`, '@type': 'FAQPage', publisher: { '@id': 'https://fixture.example/bolt#org', name: 'Bolt' } });

/**
 * A scripted remote target: what the element reports while it answers. `answers` are its messages, each a text
 * and the cards it cites; `back` the hand-back it ends with, if any.
 */
function scripted(caseId, answers, back) {
  const details = [{ type: 'state', target: 'support', state: 'connecting' }, { type: 'state', target: 'support', state: 'active' }];
  answers.forEach(([text, cards], i) =>
    details.push({ type: 'message', target: 'support', from: 'Help', fromKind: 'agent', text, ...(cards ? { answer: { answerId: `a-${i}`, cards, cites: cards.map((c, n) => ({ claim: n, id: c['@id'] })) } } : {}) }),
  );
  if (back) details.push({ type: 'handback', target: 'support', outcome: back, note: 'Answered from the help centre.', references: [] }, { type: 'state', target: 'support', state: 'handed-back' });
  else details.push({ type: 'state', target: 'support', state: 'awaiting-visitor' });
  return details.map((d) => remoteItem(d, caseId)).filter(Boolean);
}

const kase = (assert_) => ({ id: 'howto-steps', continues: 'route-howto', prompt: SEND, measures: '', assert: assert_ });
const run = (assert_, items, state = {}) => assertCase(kase(assert_), null, { actionCard: false, transcript: '', remote: remoteView(items, 'howto-steps'), ...state });
const failed = (v) => v.checks.filter((c) => !c.pass).map((c) => c.name);

const steps = scripted('howto-steps', [['1. Turn the unit off.\n2. Lift the cover.\n3. Slide the filter out.\n4. Fit the new one.', [HOWTO]]]);

test('records the text, the answer part’s cards and cites, and the hand-back, by case', () => {
  const items = [...scripted('other', [['Hello', null]]), ...scripted('howto-steps', [['Steps…', [HOWTO, FAQ]]], 'resolved')];
  const v = remoteView(items, 'howto-steps');
  assert.equal(v.text, 'Steps…');
  assert.equal(v.messages, 1);
  assert.deepEqual(v.cardKeys, ['HowTo@https://fixture.example/help/x200-filter', 'FAQPage@https://fixture.example/help/faq#q3', 'WebPage@https://fixture.example/help/faq#q3']);
  assert.deepEqual(v.cites.map((c) => c.id), [HOWTO['@id'], FAQ['@id']]);
  assert.deepEqual(v.answerIds, ['a-0']);
  assert.deepEqual(v.handback, { outcome: 'resolved', note: 'Answered from the help centre.' });
  assert.equal(remoteItem({ type: 'other' }, 'x'), null);
  assert.deepEqual(cardKeys(FAQ), ['FAQPage@https://fixture.example/help/faq#q3', 'WebPage@https://fixture.example/help/faq#q3']);
});

test('remoteMatches passes on the remote text and fails without a match', () => {
  assert.equal(run({ remoteMatches: ['1\\.', '4\\.'] }, steps).pass, true);
  const v = run({ remoteMatches: ['1\\.', '5\\.'] }, steps);
  assert.equal(v.pass, false);
  assert.deepEqual(failed(v), ['remote:5\\.']);
  assert.equal(run({ remoteMatches: ['(?i)TURN THE UNIT'] }, steps).pass, true);
});

test('remoteExcludes fails when the text says what it must not', () => {
  const notFound = scripted('howto-steps', [["I couldn't find anything about solar panels in our help.", null]]);
  assert.equal(run({ remoteMatches: ["(?i)couldn.t find"], remoteExcludes: ['(?i)generally|typically|usually'] }, notFound).pass, true);
  const guess = scripted('howto-steps', [["I couldn't find it, but it typically works with solar.", null]]);
  const v = run({ remoteExcludes: ['(?i)generally|typically|usually'] }, guess);
  assert.equal(v.pass, false);
  assert.match(v.checks.find((c) => !c.pass).detail, /typically/);
});

test('remoteCards passes when an answer cites the card and the page drew it, and fails otherwise', () => {
  const key = 'HowTo@https://fixture.example/help/x200-filter';
  assert.equal(run({ remoteCards: [key] }, steps).pass, true);
  assert.equal(run({ remoteCards: [key] }, steps, { remoteDrawn: [key] }).pass, true);
  const notDrawn = run({ remoteCards: [key] }, steps, { remoteDrawn: [] });
  assert.equal(notDrawn.pass, false);
  assert.match(notDrawn.checks[0].detail, /not drawn/);
  const wrongType = run({ remoteCards: ['Article@https://fixture.example/help/x200-filter'] }, steps);
  assert.equal(wrongType.pass, false);
  assert.match(wrongType.checks[0].detail, /not cited; cards: HowTo@/);
});

test('remoteCardsFromOneScope passes for one business with site-wide help beside it, and fails for two', () => {
  const site = { '@id': 'https://fixture.example/help/warranty', '@type': 'FAQPage' };
  const one = scripted('howto-steps', [['Two years.', [ACME('w'), ACME('x'), site]]]);
  assert.equal(run({ remoteCardsFromOneScope: true }, one, { scopeOf: defaultScopeOf }).pass, true);
  const two = scripted('howto-steps', [['Two years at one, three at the other.', [ACME('w'), BOLT('w')]]]);
  const v = run({ remoteCardsFromOneScope: true }, two, { scopeOf: defaultScopeOf });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /acme#org and https:\/\/fixture.example\/bolt#org/);
  // Asking which business, with no cards, cites nobody's.
  assert.equal(run({ remoteCardsFromOneScope: true }, scripted('howto-steps', [['Which business do you mean?', null]]), { scopeOf: defaultScopeOf }).pass, true);
  // A suite's own rule: the business by the card's path.
  const byPath = (c) => /\/(acme|bolt)\//.exec(c['@id'])?.[1] ?? 'site';
  assert.equal(run({ remoteCardsFromOneScope: true }, scripted('howto-steps', [['x', [{ '@id': 'https://fixture.example/acme/a', '@type': 'FAQPage' }, { '@id': 'https://fixture.example/bolt/a', '@type': 'FAQPage' }]]]), { scopeOf: byPath }).pass, false);
});

test('handback passes on the outcome, or any of several, and fails on another or none', () => {
  const back = scripted('howto-steps', [['Glad that helped.', null]], 'resolved');
  assert.equal(run({ handback: 'resolved' }, back).pass, true);
  assert.equal(run({ handback: ['resolved', 'transferred'] }, back).pass, true);
  const wrong = run({ handback: 'transferred' }, back);
  assert.equal(wrong.pass, false);
  assert.match(wrong.checks[0].detail, /expected transferred, got resolved/);
  const none = run({ handback: 'resolved' }, steps);
  assert.equal(none.pass, false);
  assert.equal(none.checks[0].detail, 'no hand-back');
});

test('a remote case where the remote agent said nothing fails, and a model case keeps its own checks', () => {
  const v = run({ remoteMatches: ['.'] }, []);
  assert.equal(v.pass, false);
  assert.deepEqual(failed(v), ['remote']);
  // A routing case is still a model turn: no proxy record is still a failure.
  const route = assertCase({ id: 'route-howto', prompt: 'How do I replace the filter?', measures: '', assert: { tool: 'transfer_to_agent' } }, null, { actionCard: false, transcript: '' });
  assert.deepEqual(failed(route), ['transcript']);
  // Both: the model's call and what the remote agent then said.
  const record = { ok: true, response: { text: '', call: { name: 'transfer_to_agent', args: { target: 'support' } } } };
  const both = assertCase(kase({ tool: 'transfer_to_agent', argMatches: ['target=/^support$/'], remoteMatches: ['1\\.'] }), record, { actionCard: false, transcript: '', remote: remoteView(steps, 'howto-steps') });
  assert.equal(both.pass, true);
  assert.deepEqual(both.checks.map((c) => c.name), ['completed', 'tool', 'arg:target', 'remote:1\\.']);
  assert.deepEqual(assertRemote({ tool: 'x' }, null), []);
});

test('a remote turn is over when the target asks the visitor or hands back', () => {
  const items = scripted('c', [['Which model?', null]]);
  assert.equal(remoteSettled(items, 0), true);
  assert.equal(remoteSettled(items.slice(0, 3), 0), false);
  assert.equal(handedOff(items), true);
  assert.equal(handedOff(scripted('c', [['Done', null]], 'resolved')), false);
  assert.equal(handedOff([]), false);
});

test('feedback controls are looked for on the answer, by value', () => {
  assert.equal(FEEDBACK_SELECTOR('up'), '.remote[data-answer-id] [data-feedback="up"]');
});
