// @vitest-environment happy-dom
/**
 * The bench's remote assertions against a scripted remote target, end to end on the page's side: a relay whose
 * Support Agent answers from a script, the real handoff controller reading it, the element reporting each step as an
 * `nxis-handoff` event, and the bench's recorder and scorer reading those events as the runner does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, HandoffController, buildEnvelope, handoffActivity, type A2AStreamResponse, type HandoffActivity, type HandoffEvent } from '../src/handoff/index';
// @ts-expect-error The bench is plain JavaScript, with no declarations.
import { remoteItem, remoteView, SEND } from '../bench/runner/remote.mjs';
// @ts-expect-error As above.
import { assertCase } from '../bench/runner/score.mjs';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const HOWTO = { '@id': 'https://fixture.example/help/x200-filter', '@type': 'HowTo', name: 'Replacing the X200 filter', url: 'https://fixture.example/help/x200-filter' };

/** The Support Agent, scripted: an answer with its card, then, asked again, a hand-back. */
function supportAgent(steps: string) {
  const turns: A2AStreamResponse[][] = [
    [
      { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } },
      {
        statusUpdate: {
          taskId: 't1',
          contextId: 'c1',
          status: {
            state: 'TASK_STATE_INPUT_REQUIRED',
            message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: steps }, ext({ handoff: 'answer', answerId: 'a-1', cards: [HOWTO], cites: [{ claim: 0, id: HOWTO['@id'] }] })] },
          },
        },
      },
    ],
    [
      {
        statusUpdate: {
          taskId: 't1',
          contextId: 'c1',
          status: {
            state: 'TASK_STATE_COMPLETED',
            message: { messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text: 'Glad that helped.' }, ext({ handoff: 'handback', outcome: 'resolved', note: 'Answered from the X200 guide.' })] },
          },
        },
      },
    ],
  ];
  return vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ targets: [{ name: 'support', kind: 'agent', label: 'Help', available: true, transcript: false }] }));
    const body = JSON.parse(String(init.body));
    const events = turns.shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/** Drive a handoff and a follow-up, recording as the runner records: every activity filed under the case it fell in. */
async function bench(steps: string) {
  const controller = new HandoffController({ relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl: supportAgent(steps), storage: null });
  const items: unknown[] = [];
  let caseId = 'howto-steps';
  controller.addEventListener('handoff', (e) => {
    const item = remoteItem(handoffActivity((e as CustomEvent<HandoffEvent>).detail), caseId);
    if (item) items.push(item);
  });
  const settled = async (state: string) => {
    for (let i = 0; i < 200 && !items.some((x: any) => x.caseId === caseId && x.type === 'state' && x.state === state); i++) await new Promise((r) => setTimeout(r, 5));
  };
  await controller.start('conv-1', 'support', buildEnvelope({ target: 'support', reason: 'r', summary: 's', conversationId: 'conv-1', page: { url: 'https://fixture.example/', title: 'x' } }));
  await settled('awaiting-visitor');
  caseId = 'thanks';
  await controller.send('conv-1', 'Thanks, that worked.');
  await settled('handed-back');
  controller.dispose();
  return items;
}

const score = (id: string, assert_: Record<string, unknown>, items: unknown[]) =>
  assertCase({ id, prompt: id === 'howto-steps' ? SEND : 'Thanks, that worked.', continues: 'route-howto', measures: '', assert: assert_ }, null, { actionCard: false, transcript: '', remote: remoteView(items, id) });

describe('the bench against a scripted Support Agent', () => {
  it('passes every remote assertion the answer meets', async () => {
    const items = await bench('1. Turn the unit off.\n2. Lift the cover.\n3. Slide the filter out.\n4. Fit the new one.');
    expect(score('howto-steps', { remoteMatches: ['1\\.', '4\\.'], remoteExcludes: ['evil\\.example'], remoteCards: ['HowTo@https://fixture.example/help/x200-filter'], remoteCardsFromOneScope: true }, items)).toMatchObject({ pass: true });
    expect(score('thanks', { handback: 'resolved', remoteMatches: ['(?i)glad'] }, items)).toMatchObject({ pass: true });
  });

  it('fails each one the answer misses', async () => {
    const items = await bench('1. Turn the unit off. See https://evil.example/x200 for more.');
    const v = score('howto-steps', { remoteMatches: ['4\\.'], remoteExcludes: ['evil\\.example'], remoteCards: ['Article@https://fixture.example/help/x200-filter'] }, items);
    expect(v.pass).toBe(false);
    expect(v.checks.filter((c: { pass: boolean }) => !c.pass).map((c: { name: string }) => c.name)).toEqual(['remote:4\\.', 'remote-excludes:evil\\.example', 'remote-card:Article@https://fixture.example/help/x200-filter']);
    expect(score('thanks', { handback: 'transferred' }, items)).toMatchObject({ pass: false });
    // The hand-back belongs to the case it happened in, not the one before.
    expect(score('howto-steps', { handback: 'resolved' }, items)).toMatchObject({ pass: false });
  });
});

describe('the element', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('reports each handoff step as an nxis-handoff event, without the session or its key', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    const seen: HandoffActivity[] = [];
    document.addEventListener('nxis-handoff', (e) => seen.push((e as CustomEvent<HandoffActivity>).detail));
    const session = { conversationId: el._activeId, target: 'support', label: 'Help', kind: 'agent', state: 'active', key: 'secret-key', startedAt: 0, updatedAt: 0, seen: [] };
    const answer = { answerId: 'a-1', cards: [HOWTO], cites: [] };
    el._onHandoffEvent({ type: 'message', conversationId: el._activeId, session, from: 'Help', fromKind: 'agent', text: 'Steps', answer });
    el._onHandoffEvent({ type: 'handback', conversationId: el._activeId, session, handBack: { outcome: 'resolved', note: 'Done', references: [] } });
    expect(seen.map((d) => d.type)).toEqual(['message', 'handback']);
    expect(seen[0]).toMatchObject({ target: 'support', label: 'Help', text: 'Steps', answer: { answerId: 'a-1' } });
    expect(seen[1]).toMatchObject({ outcome: 'resolved', note: 'Done' });
    expect(JSON.stringify(seen)).not.toContain('secret-key');
    // A copy: a listener can't change what the thread keeps.
    (seen[0] as any).answer.cards.length = 0;
    expect(el._active().items.find((it: any) => it.kind === 'remote').answer.cards).toHaveLength(1);
  });
});
