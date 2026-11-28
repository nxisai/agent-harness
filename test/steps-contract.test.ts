/**
 * The step surfaces' contract (docs/quote-booking-surfaces.md), without a DOM: what a target may send in a
 * `surface` part and how strictly it is read, how the conversation keeps a surface, and the parts on the wire
 * both ways: the controller reports a reply's surface messages, and sends an `action` part on the task.
 */
import { describe, expect, it, vi } from 'vitest';
import { BASIC_ALLOWED, LIMITS, STEPS_CATALOG, STEP_COMPONENTS, fold, readSurfaceMessages, setPointer, surfaceIdOf, type SurfaceEntry } from '../src/a2ui/steps';
import { toV09 } from '../src/a2ui/to-v09';
import { SLOTS } from './fixtures/surfaces';
import { HANDOFF_EXTENSION, HandoffController, buildEnvelope, type A2AStreamResponse, type HandoffEvent } from '../src/handoff/index';
import { extensionPart, readSurface } from '../src/handoff/envelope';

const BASIC_V1 = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });

describe('readSurfaceMessages: what a target may send', () => {
  it('keeps the four message kinds as v1.0, on the steps catalog', () => {
    const out = readSurfaceMessages([
      SLOTS,
      { version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/window', value: 'win-10' } },
      { version: 'v1.0', updateComponents: { surfaceId: 'booking-slots', components: [{ id: 'hold', component: 'HoldCountdown', expiresAt: '2026-11-25T15:10:00Z' }] } },
      { version: 'v1.0', deleteSurface: { surfaceId: 'booking-slots' } },
    ]);
    expect(out.map((m) => Object.keys(m).filter((k) => k !== 'version')[0])).toEqual(['createSurface', 'updateDataModel', 'updateComponents', 'deleteSurface']);
    expect(out.every((m) => m.version === 'v1.0')).toBe(true);
    expect((out[0].createSurface as any).catalogId).toBe(STEPS_CATALOG);
    expect((out[0].createSurface as any).components).toHaveLength(7);
    expect(out.map(surfaceIdOf)).toEqual(['booking-slots', 'booking-slots', 'booking-slots', 'booking-slots']);
  });

  it('draws a basic-catalog surface with the steps catalog, and refuses any other catalog', () => {
    const basic = readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 'a', catalogId: BASIC_V1, components: [{ id: 'root', component: 'Text', text: 'Hi' }] } }]);
    expect((basic[0].createSurface as any).catalogId).toBe(STEPS_CATALOG);
    expect(readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 'a', catalogId: 'https://elsewhere.example/catalog.json', components: [] } }])).toEqual([]);
  });

  it('drops components it does not draw: media, tabs, modals and sliders, and anything unknown', () => {
    const out = readSurfaceMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 's',
          components: [
            { id: 'root', component: 'Column', children: ['t', 'img', 'vid'] },
            { id: 't', component: 'Text', text: 'ok' },
            { id: 'img', component: 'Image', url: 'https://tracker.example/p.gif' },
            { id: 'vid', component: 'Video', url: 'https://x.example/v.mp4' },
            { id: 'au', component: 'AudioPlayer', url: 'https://x.example/a.mp3' },
            { id: 'tabs', component: 'Tabs', tabs: [] },
            { id: 'modal', component: 'Modal', trigger: 't', content: 't' },
            { id: 'sl', component: 'Slider', value: 1 },
            { id: 'x', component: 'Script' },
          ],
        },
      },
    ]);
    expect((out[0].createSurface as any).components.map((c: any) => c.id)).toEqual(['root', 't']);
    expect(BASIC_ALLOWED).toEqual(['Card', 'Column', 'Row', 'List', 'Text', 'Button', 'ChoicePicker', 'TextField', 'CheckBox', 'DateTimeInput', 'Divider', 'Icon']);
    expect(STEP_COMPONENTS).toEqual(['DayStrip', 'WindowGrid', 'HoldCountdown', 'DateTile', 'EstimateCard', 'ConfirmCard', 'ReceiptCard', 'ChoiceChips', 'StepHeader', 'FieldNote']);
  });

  it('keeps a TextField\'s input type and autofill hint, and drops one with a type or hint it does not know', () => {
    const surface = (components: unknown[]) => readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 's', components } }]);
    const ids = (components: unknown[]) => ((surface(components)[0]?.createSurface as any)?.components ?? []).map((c: any) => c.id);
    const field = (id: string, more: Record<string, unknown>) => ({ id, component: 'TextField', label: 'Email', value: { path: '/form/' + id }, ...more });
    expect(ids([field('a', { inputType: 'email', autocomplete: 'email' }), field('b', { inputType: 'numeric', autocomplete: 'postal-code' }), field('c', { inputType: 'tel', autocomplete: 'shipping tel' })])).toEqual(['a', 'b', 'c']);
    expect(ids([field('d', { inputType: 'password' }), field('e', { autocomplete: 'on"><script>' }), field('f', { inputType: 3 })])).toEqual([]);
  });

  it('keeps the guided intake\'s components, and drops one that is over its limits or misshapen', () => {
    const opt = (i: number) => ({ value: `v${i}`, label: `Choice ${i}` });
    const surface = (components: unknown[]) => readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 's', components } }]);
    const ids = (components: unknown[]) => ((surface(components)[0]?.createSurface as any)?.components ?? []).map((c: any) => c.id);
    expect(
      ids([
        { id: 'a', component: 'ChoiceChips', label: 'Service', options: Array.from({ length: LIMITS.choices }, (_, i) => opt(i)), value: { path: '/v' }, max: 5 },
        { id: 'b', component: 'ChoiceChips', options: '${/opts}', value: '${/v}', multiple: true },
        { id: 'c', component: 'StepHeader', step: 2, of: 3, caption: 'The job', title: { path: '/form/service' } },
        { id: 'd', component: 'StepHeader', step: '${/step}', of: LIMITS.steps },
        { id: 'e', component: 'FieldNote', text: 'Inside the service area', tone: 'ok' },
        { id: 'f', component: 'FieldNote', text: '${/note}', tone: { path: '/tone' } },
      ]),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(
      ids([
        { id: 'over', component: 'ChoiceChips', options: Array.from({ length: LIMITS.choices + 1 }, (_, i) => opt(i)), value: { path: '/v' } },
        { id: 'unbound', component: 'ChoiceChips', options: [opt(1)], value: 'v1' },
        { id: 'novalue', component: 'ChoiceChips', options: [{ label: 'No value' }], value: { path: '/v' } },
        { id: 'longword', component: 'ChoiceChips', options: [{ value: 'v', label: 'x'.repeat(LIMITS.words + 1) }], value: { path: '/v' } },
        { id: 'max0', component: 'ChoiceChips', options: [opt(1)], value: { path: '/v' }, max: 0 },
        { id: 'steps', component: 'StepHeader', step: 1, of: LIMITS.steps + 1 },
        { id: 'past', component: 'StepHeader', step: 4, of: 3 },
        { id: 'half', component: 'StepHeader', step: 1.5, of: 3 },
        { id: 'tone', component: 'FieldNote', text: 'x', tone: 'loud' },
        { id: 'notext', component: 'FieldNote' },
      ]),
    ).toEqual([]);
  });

  it('keeps a field\'s required, optional and error (ui.surfaces 3), and drops one that is misshapen or over its limits', () => {
    const surface = (components: unknown[]) => readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 's', components } }]);
    const ids = (components: unknown[]) => ((surface(components)[0]?.createSurface as any)?.components ?? []).map((c: any) => c.id);
    const chips = { component: 'ChoiceChips', options: [{ value: 'a', label: 'A' }], value: { path: '/v' } };
    expect(
      ids([
        { id: 'zip', component: 'TextField', label: 'ZIP code', value: { path: '/form/zip' }, required: true, error: { path: '/errors/zip' } },
        { id: 'notes', component: 'TextField', label: 'Anything else?', value: { path: '/form/notes' }, optional: true, variant: 'longText' },
        { id: 'when', ...chips, label: 'When', required: true, error: '${/errors/when}' },
        { id: 'said', ...chips, error: 'Pick one.' },
        { id: 'plain', component: 'TextField', label: 'City', value: { path: '/form/city' } },
      ]),
    ).toEqual(['zip', 'notes', 'when', 'said', 'plain']);
    expect(
      ids([
        { id: 'both', component: 'TextField', label: 'x', required: true, optional: true },
        { id: 'word', component: 'TextField', label: 'x', required: 'yes' },
        { id: 'long', component: 'TextField', label: 'x', error: 'x'.repeat(LIMITS.words + 1) },
        { id: 'num', ...chips, error: 3 },
        { id: 'opt', ...chips, optional: 1 },
      ]),
    ).toEqual([]);
  });

  it('drops a component whose action is a function call, or that calls openUrl anywhere', () => {
    const out = readSurfaceMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 's',
          components: [
            { id: 'a', component: 'Button', child: 'l', action: { functionCall: { call: 'openUrl', args: { url: 'https://x.example' } } } },
            { id: 'b', component: 'TextField', label: 'ZIP', value: { path: '/zip' }, checks: [{ condition: { call: 'openUrl', args: { url: 'https://x.example' } }, message: 'x' }] },
            { id: 'c', component: 'TextField', label: 'ZIP', value: { path: '/zip' }, checks: [{ condition: { call: 'regex', args: { value: { path: '/zip' }, pattern: '^\\d{5}$' } }, message: 'Five digits' }] },
            { id: 'l', component: 'Text', text: 'Go' },
          ],
        },
      },
    ]);
    expect((out[0].createSurface as any).components.map((c: any) => c.id)).toEqual(['c', 'l']);
  });

  it('drops prototype keys, bad ids and paths, and messages that are not one kind', () => {
    const raw = JSON.parse(
      '[{"version":"v1.0","createSurface":{"surfaceId":"s","components":[{"id":"t","component":"Text","text":"x","__proto__":{"polluted":true}}],"dataModel":{"a":1,"constructor":{"x":1}}}},' +
        '{"version":"v1.0","updateDataModel":{"surfaceId":"s","path":"/__proto__/polluted","value":true}},' +
        '{"version":"v1.0","updateDataModel":{"surfaceId":"s","path":"no-slash","value":true}},' +
        '{"version":"v1.0","createSurface":{"surfaceId":"bad id!","components":[]}},' +
        '{"version":"v1.0","createSurface":{"surfaceId":"s2","components":[]},"deleteSurface":{"surfaceId":"s2"}},' +
        '{"version":"v1.0","somethingElse":{"surfaceId":"s"}}]',
    );
    const out = readSurfaceMessages(raw);
    expect(out).toHaveLength(1);
    const c = out[0].createSurface as any;
    expect(Object.keys(c.components[0])).toEqual(['id', 'component', 'text']);
    expect(c.dataModel).toEqual({ a: 1 });
    expect(({} as any).polluted).toBeUndefined();
  });

  it('keeps to the limits, dropping what is over rather than cutting it', () => {
    const many = Array.from({ length: LIMITS.messages + 1 }, (_, i) => ({ version: 'v1.0', deleteSurface: { surfaceId: `s${i}` } }));
    expect(readSurfaceMessages(many)).toEqual([]);
    const big = [{ version: 'v1.0', createSurface: { surfaceId: 's', components: [], dataModel: { blob: 'x'.repeat(LIMITS.bytes) } } }];
    expect(readSurfaceMessages(big)).toEqual([]);
    const crowded = [{ version: 'v1.0', createSurface: { surfaceId: 's', components: Array.from({ length: LIMITS.components + 1 }, (_, i) => ({ id: `t${i}`, component: 'Text', text: 'x' })) } }];
    expect(readSurfaceMessages(crowded)).toEqual([]);
    expect(readSurfaceMessages('not a list')).toEqual([]);
    expect(readSurfaceMessages([{ version: 'v1.0', createSurface: { surfaceId: 'x'.repeat(65), components: [] } }])).toEqual([]);
  });

  it('downgrades to what the renderer reads: v0.9, one message per data key, ${…} as bindings', () => {
    const v09 = toV09(readSurfaceMessages([SLOTS]));
    expect(v09[0]).toEqual({ version: 'v0.9', createSurface: { surfaceId: 'booking-slots', catalogId: STEPS_CATALOG, theme: { primaryColor: '#2563EB' } } });
    const days = v09[1].updateComponents.components.find((c: any) => c.id === 'days');
    expect(days.days).toEqual({ path: '/booking/days' });
    expect(v09[2]).toMatchObject({ updateDataModel: { surfaceId: 'booking-slots', path: '/booking' } });
  });
});

describe('fold: what the conversation keeps', () => {
  const entry = (): SurfaceEntry => ({ id: 'booking-slots', create: readSurfaceMessages([SLOTS])[0] });

  it('writes a data update at its path, and replaces a component sent again, properties and all', () => {
    const e = entry();
    fold(e, { version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/hold', value: '2026-11-25T15:10:00Z' } });
    fold(e, { version: 'v1.0', updateComponents: { surfaceId: 'booking-slots', components: [{ id: 'hold', component: 'HoldCountdown', expiresAt: '${/booking/hold}', label: 'Held' }, { id: 'extra', component: 'Text', text: 'New' }] } });
    const c = e.create.createSurface as any;
    expect(c.dataModel.booking.hold).toBe('2026-11-25T15:10:00Z');
    expect(c.components.find((x: any) => x.id === 'hold')).toEqual({ id: 'hold', component: 'HoldCountdown', expiresAt: '${/booking/hold}', label: 'Held' });
    expect(c.components.map((x: any) => x.id)).toContain('extra');
  });

  it('a component update clears done: the target sent the card again', () => {
    const e = { ...entry(), done: true };
    fold(e, { version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/window', value: 'win-10' } });
    expect(e.done).toBe(true);
    fold(e, { version: 'v1.0', updateComponents: { surfaceId: 'booking-slots', components: [{ id: 'go_label', component: 'Text', text: 'Continue' }] } });
    expect(e.done).toBe(false);
  });

  it('setPointer: creates the way, unescapes ~1 and ~0, deletes on undefined, replaces the root', () => {
    expect(setPointer({}, '/a/b~1c/d~0e', 1)).toEqual({ a: { 'b/c': { 'd~e': 1 } } });
    expect(setPointer({ a: { b: 1, c: 2 } }, '/a/b', undefined)).toEqual({ a: { c: 2 } });
    expect(setPointer({ a: 1 }, '/', { b: 2 })).toEqual({ b: 2 });
  });
});

describe('the parts on the wire', () => {
  it('readSurface: every surface part of a message, marked, or unmarked as some servers send it', () => {
    expect(readSurface([{ text: 'Pick a window.' }, ext({ handoff: 'surface', messages: [SLOTS] }), { data: { handoff: 'surface', messages: [{ version: 'v1.0', deleteSurface: { surfaceId: 'x' } }] } }])).toHaveLength(2);
    expect(readSurface([{ text: 'Hi' }])).toBeNull();
    expect(readSurface([ext({ handoff: 'surface', messages: 'nope' })])).toBeNull();
  });

  function relay(turns: A2AStreamResponse[][]) {
    const posts: { method: string; params: any; key: string | null }[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ targets: [{ name: 'booking', kind: 'agent', label: 'Book a visit', available: true }] }));
      const body = JSON.parse(String(init.body));
      posts.push({ method: body.method, params: body.params, key: new Headers(init.headers).get('Nxis-Handoff-Key') });
      const events = turns.shift() ?? [];
      return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': 'k-1' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, posts };
  }
  const turn = (messageId: string, parts: unknown[]): A2AStreamResponse[] => [
    { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } },
    { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId, role: 'ROLE_AGENT', parts } } } } as any,
  ];
  const until = async (ok: () => unknown) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('the controller reports a reply with its surface messages, words or none', async () => {
    const r = relay([turn('m1', [{ text: 'Pick a day and a window.' }, ext({ handoff: 'surface', messages: [SLOTS] })]), turn('m2', [ext({ handoff: 'surface', messages: [{ version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/hold', value: 'x' } }] })])]);
    const c = new HandoffController({ relay: '/api/handoff', targets: { booking: { kind: 'agent', label: 'Book a visit' } }, fetchImpl: r.fetchImpl, storage: null });
    const seen: HandoffEvent[] = [];
    c.addEventListener('handoff', (e) => seen.push((e as CustomEvent<HandoffEvent>).detail));
    await c.start('conv', 'booking', buildEnvelope({ target: 'booking', reason: 'r', summary: 's', conversationId: 'conv', page: { url: 'https://fixture.example/', title: 'x' } }));
    await until(() => seen.some((e) => e.type === 'message'));
    const first = seen.find((e) => e.type === 'message') as Extract<HandoffEvent, { type: 'message' }>;
    expect(first.text).toBe('Pick a day and a window.');
    expect(first.surface).toEqual([SLOTS]);

    // A choice on the surface: the visitor's words and an action part, on the task, with the relay's key.
    const action = { handoff: 'action', surfaceId: 'booking-slots', name: 'pick_window', component: 'windows', context: { date: '2026-11-25', window: 'win-10', label: '10 am – 12 pm' } };
    await c.send('conv', '10 am – 12 pm', [extensionPart(action)]);
    const sent = r.posts.at(-1)!;
    expect(sent.method).toBe('SendStreamingMessage');
    expect(sent.key).toBe('k-1');
    expect(sent.params.message).toMatchObject({ role: 'ROLE_USER', taskId: 't1', contextId: 'c1' });
    expect(sent.params.message.parts).toEqual([{ text: '10 am – 12 pm' }, { data: action, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } }]);
    await until(() => seen.filter((e) => e.type === 'message').length > 1);
    const second = seen.filter((e) => e.type === 'message')[1] as Extract<HandoffEvent, { type: 'message' }>;
    expect(second.text).toBe('');
    expect(second.surface).toHaveLength(1);
    c.dispose();
  });
});
