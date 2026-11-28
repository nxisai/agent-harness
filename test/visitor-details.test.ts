// @vitest-environment jsdom
/**
 * The visitor's details carry over between agents in one conversation: what the
 * visitor sends on a target's form, and what a target hands back as confirmed, is kept with the conversation and
 * sent as the next agent's envelope `contact`. It survives a reload, goes with "New conversation" and "Delete
 * conversation", reaches the model only as the profile's data, never goes to a person desk, and "Not you? Clear
 * details" clears it.
 */
import './helpers/lit-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepAll, sleep, until } from './helpers/lit-dom';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, buildEnvelope, readContact, readHandBack, type A2AStreamResponse } from '../src/handoff/index';
import type { ModelContextTool } from '../src/types';
import { contactFromProfile, detailOf, detailsFromContact, detailsFromFields } from '../src/ui/details';
import { renderMessages } from '../src/guardrails/context';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const STEPS_CATALOG = 'https://nxis.ai/a2ui/catalogs/steps/v1.json';

/** A "where and who" step: the contact fields, prefilled from the data model, and Continue. */
const WHO = (form: Record<string, string>, extra: unknown[] = []) => ({
  version: 'v1.0',
  createSurface: {
    surfaceId: 'quote-intake',
    catalogId: STEPS_CATALOG,
    components: [
      { id: 'root', component: 'Card', child: 'body' },
      { id: 'body', component: 'Column', children: ['f_name', 'f_email', 'f_phone', 'f_street', 'f_city', 'f_zip', 'go', ...extra.map((c: any) => c.id).filter((id: string) => !id.endsWith('_l'))] },
      ...['name', 'email', 'phone', 'street', 'city', 'zip'].map((n) => ({ id: `f_${n}`, component: 'TextField', label: n, value: { path: `/form/${n}` } })),
      { id: 'go', component: 'Button', child: 'go_l', variant: 'primary', action: { event: { name: 'continue', context: { form: { path: '/form' }, label: 'Continue' } } } },
      { id: 'go_l', component: 'Text', text: 'Continue' },
      ...extra,
    ],
    dataModel: { form },
  },
});
const CLEAR = [
  { id: 'clear', component: 'Button', child: 'clear_l', action: { event: { name: 'clear_details', context: { label: 'Not you? Clear details' } } } },
  { id: 'clear_l', component: 'Text', text: 'Not you? Clear details' },
];

const GIVEN = { name: 'Dana Reyes', email: 'dana@example.com', phone: '312-555-0142', street: '4410 N Milwaukee Ave', city: 'Chicago', zip: '60630' };

let task = 0;
/** A relay with a Quote and a Booking agent and a person desk; each start gets its own task, and its turns. */
function relay(script: Record<string, A2AStreamResponse[][]>) {
  const posts: { target: string; method: string; params: any }[] = [];
  const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (String(u) !== '/api/handoff') return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({
          targets: [
            { name: 'quote', kind: 'agent', label: 'Quote', available: true },
            { name: 'booking', kind: 'agent', label: 'Booking', available: true },
            { name: 'team', kind: 'person', label: 'The team', available: true },
          ],
        }),
      );
    }
    const target = String(u).split('/').pop()!;
    const body = JSON.parse(String(init.body));
    posts.push({ target, method: body.method, params: body.params });
    if (body.method === 'CancelTask') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: 'x', status: { state: 'TASK_STATE_CANCELED' } } }));
    const turns = script[target] ?? [];
    const events = turns.shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': `k-${target}` },
    });
  }) as unknown as typeof fetch;
  const envelopes = () =>
    posts
      .filter((p) => p.method === 'SendStreamingMessage' && !p.params.message.taskId)
      .map((p) => ({ target: p.target, ...p.params.message.parts.find((x: any) => x.data?.handoff === 'envelope')?.data }));
  const actions = () => posts.filter((p) => p.method === 'SendStreamingMessage' && p.params.message.parts.some((x: any) => x.data?.handoff === 'action'));
  return { fetchImpl, posts, envelopes, actions };
}

/** One agent turn on a fresh task. */
function turn(parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] {
  const id = `t${++task}`;
  return [
    { task: { id, contextId: `c${task}`, status: { state: 'TASK_STATE_WORKING' } } },
    { statusUpdate: { taskId: id, contextId: `c${task}`, status: { state, message: { messageId: `m${task}`, role: 'ROLE_AGENT', parts } } } } as any,
  ];
}
/** A later turn on the same task. */
function more(parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] {
  return [{ statusUpdate: { taskId: `t${task}`, contextId: `c${task}`, status: { state, message: { messageId: `m${task}-${Math.random()}`, role: 'ROLE_AGENT', parts } } } } as any];
}

async function element(r: ReturnType<typeof relay>) {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  document.body.append(el);
  const registered: ModelContextTool[] = [];
  const mc = { getTools: async () => registered.map((t) => ({ name: t.name })), registerTool: async (t: ModelContextTool) => void registered.push(t), addEventListener() {} };
  el.toolSource.modelContext = () => mc;
  el.handoff = {
    relay: '/api/handoff',
    targets: { quote: { kind: 'agent', label: 'Quote' }, booking: { kind: 'agent', label: 'Booking' }, team: { kind: 'person', label: 'The team' } },
    fetchImpl: r.fetchImpl,
  };
  await el._registerHandoff();
  const tool = (name: string) => registered.find((t) => t.name === name)!;
  const handTo = (target: string) => tool(target === 'team' ? 'talk_to_a_person' : 'transfer_to_agent').execute({ target, reason: 'r', summary: 's' } as never, undefined as never);
  return { el, root: el.shadowRoot as ShadowRoot, handTo };
}

const button = (root: ShadowRoot, label: string) => deepAll<HTMLButtonElement>(root, 'button').filter((b) => b.textContent?.trim() === label).pop()!;

describe('details, read strictly', () => {
  it('maps fields onto profile keys only by an exact alias, and keeps only short strings', () => {
    expect(detailOf('full_name')).toBe('name');
    expect(detailOf('street')).toBe('address');
    expect(detailOf('postal_code')).toBe('zip');
    expect(detailOf('email_address')).toBe('email');
    expect(detailOf('business_name')).toBeNull();
    expect(detailOf('notes')).toBeNull();
    expect(detailsFromFields({ name: ' Dana ', street: '1 Main', zip: ['60630'], notes: 'leak', city: '', phone: 'a\u0000b' })).toEqual({ name: 'Dana', address: '1 Main', phone: 'a b' });
    expect(detailsFromFields('nope')).toEqual({});
  });

  it("turns a profile into a handoff's contact, and a contact back, street as the profile's address", () => {
    expect(contactFromProfile({ name: 'Dana', address: '1 Main', zip: '60630', color: 'blue' })).toEqual({ name: 'Dana', street: '1 Main', zip: '60630' });
    expect(contactFromProfile({})).toBeUndefined();
    expect(detailsFromContact({ street: '1 Main', city: 'Chicago', role: 'admin' })).toEqual({ address: '1 Main', city: 'Chicago' });
    expect(readContact({ name: 'x'.repeat(300), extra: 'y', email: 3 })).toEqual({ name: 'x'.repeat(200) });
  });

  it("reads a hand-back's contact, and an envelope carries only the contact's fields", () => {
    const hb = readHandBack([ext({ handoff: 'handback', outcome: 'transferred', note: 'n', contact: { ...GIVEN, ssn: '1' } }) as any]);
    expect(hb?.contact).toEqual(GIVEN);
    expect(readHandBack([ext({ handoff: 'handback', outcome: 'resolved', note: 'n' }) as any])).not.toHaveProperty('contact');
    const env = buildEnvelope({ target: 'booking', reason: 'r', summary: 's', conversationId: 'c', contact: { ...GIVEN, extra: 'z' } as never, page: { url: 'https://x.example/', title: 'x' } });
    expect(env.contact).toEqual(GIVEN);
    expect(env.consent.shared).toContain('contact');
  });
});

describe('details across agents in the element', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('asks once: what the visitor sends Quote goes to Booking as contact, kept across a reload, and data only for the model', async () => {
    const r = relay({
      quote: [
        turn([{ text: 'Where is the job, and how can they reach you?' }, ext({ handoff: 'surface', messages: [WHO({ name: '', email: '', phone: '', street: '', city: '', zip: '' })] })]),
        more([{ text: 'Sent.' }, ext({ handoff: 'handback', outcome: 'transferred', note: 'Sent a quote. The visitor would like to book a visit too.', contact: { phone: '312-555-0199' } })], 'TASK_STATE_COMPLETED'),
      ],
      booking: [turn([{ text: 'Pick a day.' }])],
    });
    const { el, root, handTo } = await element(r);
    await handTo('quote');
    expect(r.envelopes()[0]).not.toHaveProperty('contact');
    await until(() => deepAll(root, 'input').length >= 6);

    // The visitor types their details on the step and presses Continue.
    const inputs = deepAll<HTMLInputElement>(root, 'input');
    Object.values(GIVEN).forEach((v, i) => {
      inputs[i].value = v;
      inputs[i].dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    await sleep(5);
    button(root, 'Continue').click();
    await until(() => r.actions().length);
    const conv = el._active();
    // What the visitor typed, from the form; then Quote hands back what was confirmed: the phone they changed on its
    // review card updates it.
    await until(() => !el._handoff.active(el._activeId));
    expect(r.actions()[0].params.message.parts[1].data.context.form).toEqual(GIVEN);
    expect(conv.details).toEqual({ name: GIVEN.name, email: GIVEN.email, phone: '312-555-0199', address: GIVEN.street, city: GIVEN.city, zip: GIVEN.zip });

    // The model reads the details only inside the saved profile's data block, never in the system prompt itself.
    expect(conv.messages[0].content).not.toContain('Dana');
    const sent = renderMessages(conv.messages, 'B0UNDARY', { origin: () => 'page', hinted: () => false });
    expect(sent[0].content).toContain('saved profile');
    expect(sent[0].content).toContain('Dana Reyes');
    expect(sent[0].content.indexOf('Dana Reyes')).toBeGreaterThan(sent[0].content.indexOf('B0UNDARY'));

    // Booking, next, is told everything: it asks for none of it again.
    await handTo('booking');
    expect(r.envelopes()[1]).toMatchObject({ target: 'booking', contact: { ...GIVEN, phone: '312-555-0199' } });

    // A reload of the page keeps them with the conversation.
    const saved = JSON.parse(localStorage.getItem('nxis-listings-agent-conversations')!);
    expect(saved.find((c: any) => c.id === conv.id).details.city).toBe('Chicago');
    document.body.innerHTML = '';
    const again = document.createElement('nxis-agent') as any;
    again.setAttribute('preload', 'none');
    document.body.append(again);
    expect(again._active().id).toBe(conv.id);
    expect(again._profileNow()).toMatchObject({ name: 'Dana Reyes', zip: '60630' });
    // And nothing went to the element's own preferences, or their storage.
    expect(again.preferences.get()).toEqual({});
    expect(localStorage.getItem('nxis-listings-agent-profile')).toBeNull();
  });

  it('starts a new conversation without them, and keeps each conversation its own', async () => {
    const r = relay({ booking: [turn([{ text: 'Hi.' }], 'TASK_STATE_COMPLETED'), turn([{ text: 'Hi.' }], 'TASK_STATE_COMPLETED')] });
    const { el, handTo } = await element(r);
    const first = el._active();
    el._rememberDetails(first, { name: 'Dana Reyes', zip: '60630' });
    el._newConversation(false);
    expect(el._active().details).toBeUndefined();
    expect(el._profileNow()).toEqual({});
    expect(el._active().messages[0].data).toBe('');
    await handTo('booking');
    expect(r.envelopes()[0]).not.toHaveProperty('contact');

    // Back to the first: its details again, and they go to its handoff.
    el._switchConversation(first.id);
    await sleep(5);
    expect(el._active().messages[0].data).toContain('Dana Reyes');
    el._deleteConversation(first.id);
    const saved = JSON.parse(localStorage.getItem('nxis-listings-agent-conversations')!);
    expect(JSON.stringify(saved)).not.toContain('Dana');
  });

  it("sends the host's preferences too, with the conversation's details over them, and never to a person desk", async () => {
    const r = relay({ booking: [turn([{ text: 'Hi.' }], 'TASK_STATE_COMPLETED')], team: [turn([{ text: 'Hello.' }], 'TASK_STATE_COMPLETED')] });
    const { el, handTo } = await element(r);
    el.preferences.set({ name: 'Host Name', email: 'host@example.com' });
    el._rememberDetails(el._active(), { name: 'Dana Reyes' });
    await handTo('booking');
    expect(r.envelopes()[0].contact).toEqual({ name: 'Dana Reyes', email: 'host@example.com' });
    await until(() => !el._handoff.active(el._activeId));
    await handTo('team');
    expect(r.envelopes()[1]).not.toHaveProperty('contact');
  });

  it('"Not you? Clear details" clears them before the press goes to the target', async () => {
    const r = relay({ quote: [turn([{ text: 'Check your details.' }, ext({ handoff: 'surface', messages: [WHO(GIVEN, CLEAR)] })]), more([{ text: 'Cleared.' }])] });
    const { el, root, handTo } = await element(r);
    el._rememberDetails(el._active(), detailsFromContact(GIVEN));
    await handTo('quote');
    expect(r.envelopes()[0].contact).toEqual(GIVEN);
    await until(() => button(root, 'Not you? Clear details'));
    button(root, 'Not you? Clear details').click();
    await until(() => r.actions().length);
    expect(r.actions()[0].params.message.parts[1].data.name).toBe('clear_details');
    expect(el._active().details).toBeUndefined();
    expect(el._active().messages[0].data).toBe('');
  });

  it("keeps what the visitor sends on a page's own form, for the next agent", async () => {
    const r = relay({});
    const { el } = await element(r);
    const conv = el._active();
    el._live = { item: { fields: [] }, tool: { name: 'contact_form' }, sent: false, run: async () => {} };
    // The send path of a page's action card, as the card calls it.
    el._actionHandlers().send({ full_name: 'Dana Reyes', message: 'hi', zip_code: '60630' });
    expect(conv.details).toEqual({ name: 'Dana Reyes', zip: '60630' });
  });
});
