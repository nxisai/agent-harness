/**
 * A handoff target that takes a site form's place (`takes` in docs/handoff.md).
 *
 * A site whose quote agent can take a quote wants quotes to go to it, not into
 * the page's quote form: for a typed request, a call to the form the model
 * makes anyway, and a link from the NxisAI app that names the form. And when
 * the agent resolves it, the site's analytics should count it as the form
 * being sent. When the agent is away, nothing changes.
 *
 * The harness runs headless here, against a fake relay that answers as A2A
 * 1.0 does, the real handoff tools, and a model that answers from a script.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_EXTENSION,
  HANDOFF_KEY_HEADER,
  HandoffController,
  TRANSFER_TO_AGENT_TOOL,
  buildHandoffTools,
  formTakenBy,
  handoffCallFor,
  pageFormTakenBy,
  takesForm,
  type A2AStreamResponse,
  type HandoffTargetConfig,
} from '../src/handoff/index';
import { AgentHarness } from '../src/harness/harness';
import {
  ACTION_IDS_HINT,
  ACTION_ID_HINT,
  CHOICES_HINT,
  CHOOSER_HINT,
  SITE_ACTION_HINT,
} from '../src/harness/tools/action-tools';
import { rememberReportToken, setSiteActionReporter, takeReportToken, type PageFormRun } from '../src/harness/tools/report';
import type { Completion, CompletionRequest } from '../src/providers/types';
import type { ModelContextTool, ModelContextToolInfo } from '../src/types';

const RELAY = '/api/handoff';
const MCMANUS = 'https://listings.example/listings/mcmanus-electric.html#quote';
const SPARKWISE = 'https://listings.example/listings/sparkwise.html#quote';
const HERE = 'https://listings.example/listings/hatzel.html#quote';

/** A Storage that lives in memory, as `localStorage` would across page loads. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const agentSays = (id: string, text: string, extra: object[] = []) => ({ messageId: id, role: 'ROLE_AGENT' as const, parts: [{ text }, ...extra] });
const status = (state: string, message?: object): A2AStreamResponse => ({
  statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: state as never, ...(message ? { message: message as never } : {}) } },
});
const handBack = (outcome: string) =>
  status('TASK_STATE_COMPLETED', agentSays('m9', 'Sent.', [ext({ handoff: 'handback', outcome, note: 'Quote sent.', references: [{ label: 'Quote reference', value: 'QR-1' }] })]));

/**
 * A relay listing `quote` (and `booking`, which takes nothing), whose quote
 * agent answers from a script: one stream per message.
 */
function fakeRelay(opts: { available?: boolean; down?: boolean; streams?: A2AStreamResponse[][] } = {}) {
  const streams = [...(opts.streams ?? [[{ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED' } } }]])];
  const posted: { method: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (opts.down) return new Response('nope', { status: 502 });
      const targets = [
        { name: 'quote', kind: 'agent', label: 'Quotes', available: opts.available !== false, transcript: false },
        { name: 'booking', kind: 'agent', label: 'Booking', available: true, transcript: false },
      ];
      return new Response(JSON.stringify({ targets }), { headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(String(init.body));
    posted.push({ method: body.method, params: body.params });
    const events = streams.shift() ?? [];
    const sse = events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join('');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream', [HANDOFF_KEY_HEADER]: 'k1' } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, posted };
}
const TARGETS: Record<string, HandoffTargetConfig> = {
  quote: { kind: 'agent', label: 'Quotes', description: 'takes a quote request in conversation', takes: ['quote_form'] },
  booking: { kind: 'agent', label: 'Booking' },
};

const formSchema = {
  type: 'object',
  properties: { business: { type: 'string' }, full_name: { type: 'string' }, email: { type: 'string' }, project_description: { type: 'string' } },
  required: ['full_name', 'email', 'project_description'],
};

/** This page's own quote form, recording its action as the site's script does. */
const pageForm = { name: 'quote_form', description: 'Request a quote', inputSchema: formSchema, annotations: { [ACTION_ID_HINT]: HERE } } as unknown as ModelContextToolInfo;

/** The site-wide quote form, reaching every listing's form from any page. */
const siteForm = {
  name: 'quote_form_anywhere',
  description: 'Request a quote from a contractor.',
  inputSchema: { ...formSchema, properties: { ...formSchema.properties, business: { type: 'string', enum: ['McManus Electric', 'Sparkwise'] } }, required: ['business', ...formSchema.required] },
  annotations: {
    readOnlyHint: false,
    [SITE_ACTION_HINT]: true,
    [ACTION_IDS_HINT]: [MCMANUS, SPARKWISE],
    [CHOOSER_HINT]: 'business',
    [CHOICES_HINT]: ['McManus Electric', 'Sparkwise'],
  },
} as unknown as ModelContextToolInfo;

const contactForm = { name: 'contact_form', description: 'Contact us', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } } as unknown as ModelContextToolInfo;

interface Confirm {
  tool: ModelContextToolInfo;
  values: Record<string, unknown>;
  submitLabel?: string;
  onSubmit(values: Record<string, unknown>): void;
}

/**
 * The harness on a page with these forms, the handoff tools for the relay, and
 * a model that makes the given calls in turn.
 */
async function page(opts: {
  relay?: ReturnType<typeof fakeRelay>;
  forms?: ModelContextToolInfo[];
  calls?: (Completion['call'] | null)[];
  storage?: Storage | null;
  withHandoff?: boolean;
} = {}) {
  const relay = opts.relay ?? fakeRelay();
  const controller = new HandoffController({ relay: RELAY, targets: TARGETS, fetchImpl: relay.fetchImpl, storage: opts.storage ?? null, resumeDelayMs: 60_000 });
  const handoffTools = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
  const tools: (ModelContextToolInfo | ModelContextTool)[] = [...(opts.forms ?? [pageForm, siteForm, contactForm]), ...handoffTools];
  const offered: string[][] = [];
  const script = [...(opts.calls ?? [])];
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    offered.push(req.tools.map((t) => t.name));
    const call = script.shift();
    return call ? { text: 'I will fill in the quote form for you.', call } : { text: 'Sure.' };
  });
  const confirms: Confirm[] = [];
  const asked: { tool: string; values: Record<string, unknown> }[] = [];
  const renderer = {
    streaming: () => ({ thinking() {}, update() {}, finalize() {} }),
    message() {},
    status() {},
    ask: (req: { tool: ModelContextToolInfo; resolution: { values: Record<string, unknown> } }) => asked.push({ tool: req.tool.name, values: req.resolution.values }),
    confirm: (req: Confirm) => confirms.push(req),
    results() {},
    detail() {},
  };
  const execTool = vi.fn(async (tool: ModelContextToolInfo, name: string, values: Record<string, unknown>) => {
    const found = tools.find((t) => t.name === name) as ModelContextTool | undefined;
    return found?.execute ? found.execute(values, {}) : { content: [{ type: 'text', text: 'Sent.' }] };
  });
  const toolSource = { discoverTools: async () => tools as ModelContextToolInfo[], execTool, modelContext: () => null };
  const harness = new AgentHarness({
    provider: { name: 'script', label: 'Script', local: false, ready: true, loading: false, complete },
    toolSource: toolSource as never,
    renderer: renderer as never,
    recommend: false,
    ...(opts.withHandoff === false ? {} : { handoff: () => controller }),
  });
  return { harness, controller, relay, offered, confirms, asked, complete, execTool };
}

let reported: PageFormRun[] = [];
function recordReports() {
  reported = [];
  setSiteActionReporter((run) => void reported.push(run));
}

afterEach(() => setSiteActionReporter(null));

const send = async (c: Confirm) => {
  c.onSubmit(c.values);
  // The handoff tool reads the relay's list, then starts the handoff.
  await new Promise((r) => setTimeout(r, 20));
};

describe('which forms a target takes', () => {
  it('matches a form by its name without the site-wide suffix, either way round', () => {
    expect(takesForm({ takes: ['quote_form'] }, 'quote_form')).toBe(true);
    expect(takesForm({ takes: ['quote_form'] }, 'quote_form_anywhere')).toBe(true);
    expect(takesForm({ takes: ['quote_form_anywhere'] }, 'quote_form')).toBe(true);
    expect(takesForm({ takes: ['quote_form'] }, 'quote_formula')).toBe(false);
    expect(takesForm({ takes: ['quote_form'] }, 'contact_form')).toBe(false);
    expect(takesForm({}, 'quote_form')).toBe(false);
  });

  it('is told to the page only for an available target, and is carried into what the relay offers', async () => {
    const { controller } = await page();
    expect((await controller.targets()).find((t) => t.name === 'quote')?.takes).toEqual(['quote_form']);
    expect((await formTakenBy(controller, 'quote_form_anywhere'))?.name).toBe('quote');
    expect(await formTakenBy(controller, 'contact_form')).toBeNull();

    const away = await page({ relay: fakeRelay({ available: false }) });
    expect(await formTakenBy(away.controller, 'quote_form')).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await page({ relay: fakeRelay({ down: true }) });
    expect(await formTakenBy(down.controller, 'quote_form')).toBeNull();
    vi.restoreAllMocks();
  });

  it('builds the handoff from the call alone, inventing nothing', () => {
    const call = handoffCallFor({ name: 'quote', kind: 'agent' }, siteForm, {
      business: 'McManus Electric',
      full_name: 'Pat Kowalski',
      email: '',
      project_description: ' Panel upgrade ',
      extra: { nested: true },
    });
    expect(call).toEqual({
      name: TRANSFER_TO_AGENT_TOOL,
      args: {
        target: 'quote',
        reason: 'Wants a quote from McManus Electric',
        summary: 'Wants a quote from McManus Electric. full name: Pat Kowalski; project description: Panel upgrade.',
      },
    });
    expect(handoffCallFor({ name: 'team', kind: 'person' }, pageForm, {}).args).toEqual({ target: 'team', reason: 'Wants a quote', summary: 'Wants a quote.' });
    expect(handoffCallFor({ name: 'team', kind: 'person' }, pageForm, {}).name).toBe('talk_to_a_person');
  });
});

describe('a: the model is not offered the forms an available target takes', () => {
  it('leaves out the page form and the site-wide one, and keeps everything else', async () => {
    const { harness, offered } = await page();
    await harness.turn('Get a quote from McManus Electric', []);
    expect(offered[0]).toEqual(expect.arrayContaining(['contact_form', TRANSFER_TO_AGENT_TOOL]));
    expect(offered[0]).not.toContain('quote_form');
    expect(offered[0]).not.toContain('quote_form_anywhere');
  });

  it('offers them as before when the target is away, the relay is down, or the page gave the harness no controller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const setup of [{ relay: fakeRelay({ available: false }) }, { relay: fakeRelay({ down: true }) }, { withHandoff: false }]) {
      const { harness, offered } = await page(setup);
      await harness.turn('Get a quote', []);
      expect(offered[0]).toEqual(expect.arrayContaining(['quote_form', 'quote_form_anywhere']));
    }
    vi.restoreAllMocks();
  });

  it('keeps the forms when the turn cannot hand off to the target', async () => {
    const { controller, offered, complete } = await page();
    // An agent whose slice leaves out transfer_to_agent has no way to the target.
    const harness = new AgentHarness({
      provider: { name: 's', label: 's', local: false, ready: true, loading: false, complete },
      toolSource: { discoverTools: async () => [pageForm, siteForm], execTool: vi.fn() } as never,
      renderer: { streaming: () => ({ thinking() {}, update() {}, finalize() {} }), message() {}, status() {}, ask() {}, confirm() {} } as never,
      handoff: () => controller,
    });
    await harness.turn('Get a quote', []);
    expect(offered[0]).toEqual(['quote_form', 'quote_form_anywhere']);
  });
});

describe('b: a call to a taken form becomes the handoff', () => {
  it('asks the visitor to send the handoff, built from the call, and records the handoff in the transcript', async () => {
    const { harness, confirms, asked, execTool, controller } = await page({
      calls: [{ name: 'quote_form_anywhere', args: { business: 'McManus Electric', project_description: 'Panel upgrade' } }],
    });
    const messages: { role: string; content: string }[] = [];
    const result = await harness.turn('Get a quote from McManus Electric for a panel upgrade', messages as never);
    expect(result.decision).toBe('confirm');
    expect(result.tool?.name).toBe(TRANSFER_TO_AGENT_TOOL);
    expect(asked).toEqual([]);
    expect(confirms).toHaveLength(1);
    expect(confirms[0].submitLabel).toBe('Send');
    expect(confirms[0].values).toEqual({
      target: 'quote',
      reason: 'Wants a quote from McManus Electric',
      summary: 'Wants a quote from McManus Electric. project description: Panel upgrade.',
    });
    // Nothing leaves before Send.
    expect(execTool).not.toHaveBeenCalled();
    expect(messages.at(-1)!.content).toMatch(/^\[called transfer_to_agent with /);
    expect(messages.map((m) => m.content).join('\n')).not.toContain('quote form for you');

    await send(confirms[0]);
    expect(execTool).toHaveBeenCalledWith(expect.objectContaining({ name: TRANSFER_TO_AGENT_TOOL }), TRANSFER_TO_AGENT_TOOL, confirms[0].values);
    // The handoff knows which business's form it stands in for.
    expect(controller.session('conv-1')).toMatchObject({ target: 'quote', standsFor: { toolName: 'quote_form_anywhere', actionId: MCMANUS } });
    controller.dispose();
  });

  it('runs the form as before when the target is away', async () => {
    const { harness, confirms, asked } = await page({
      relay: fakeRelay({ available: false }),
      calls: [{ name: 'quote_form_anywhere', args: { business: 'McManus Electric' } }],
    });
    const result = await harness.turn('Get a quote from McManus Electric', []);
    expect(result.tool?.name).toBe('quote_form_anywhere');
    expect(asked).toEqual([{ tool: 'quote_form_anywhere', values: { business: 'McManus Electric' } }]);
    expect(confirms).toEqual([]);
  });

  it('notes the one page form a direct handoff replaces, and none when the page has several', async () => {
    const direct = { name: TRANSFER_TO_AGENT_TOOL, args: { target: 'quote', reason: 'Wants a quote', summary: 'Wants a quote for a panel upgrade.' } };
    const one = await page({ calls: [direct] });
    await one.harness.turn('I want a quote', []);
    await send(one.confirms[0]);
    expect(one.controller.session('conv-1')?.standsFor).toEqual({ toolName: 'quote_form', actionId: HERE });
    one.controller.dispose();

    const second = { ...pageForm, name: 'quote_form_2' } as ModelContextToolInfo;
    expect(pageFormTakenBy({ takes: ['quote_form', 'quote_form_2'] }, [pageForm, second, siteForm])).toBeNull();
    expect(pageFormTakenBy({ takes: ['quote_form'] }, [siteForm])).toBeNull();
    const none = await page({ calls: [direct], forms: [siteForm] });
    await none.harness.turn('I want a quote', []);
    await send(none.confirms[0]);
    expect(none.controller.session('conv-1')?.standsFor).toBeUndefined();
    none.controller.dispose();
  });

  it('notes nothing for a handoff to a target that takes no form', async () => {
    const { harness, confirms, controller } = await page({
      relay: fakeRelay(),
      calls: [{ name: TRANSFER_TO_AGENT_TOOL, args: { target: 'booking', reason: 'Book', summary: 'Wants a visit.' } }],
    });
    await harness.turn('Book a visit', []);
    await send(confirms[0]);
    expect(controller.session('conv-1')).toMatchObject({ target: 'booking' });
    expect(controller.session('conv-1')?.standsFor).toBeUndefined();
    controller.dispose();
  });
});

describe('c: a link that names a taken form starts the handoff', () => {
  it('begins the handoff without the model, with the start message as the request', async () => {
    const { harness, confirms, asked, complete, controller } = await page();
    const messages: { role: string; content: string }[] = [];
    const result = await harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, messages as never);
    expect(complete).not.toHaveBeenCalled();
    expect(result.tool?.name).toBe(TRANSFER_TO_AGENT_TOOL);
    expect(asked).toEqual([]);
    expect(confirms[0].values).toEqual({ target: 'quote', reason: 'Wants a quote from McManus Electric', summary: 'Wants a quote from McManus Electric.' });
    const said = messages.filter((m) => m.role !== 'system');
    expect(said[0]).toEqual({ role: 'user', content: 'Get a quote from McManus Electric' });
    expect(said[1].content).toMatch(/^\[called transfer_to_agent with /);
    await send(confirms[0]);
    expect(controller.session('conv-1')?.standsFor).toEqual({ toolName: 'quote_form_anywhere', actionId: MCMANUS });
    controller.dispose();
  });

  it('opens the form as before when the target is away', async () => {
    const { harness, confirms, asked } = await page({ relay: fakeRelay({ available: false }) });
    const result = await harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, []);
    expect(result.decision).toBe('ask');
    expect(asked).toEqual([{ tool: 'quote_form_anywhere', values: { business: 'McManus Electric' } }]);
    expect(confirms).toEqual([]);
  });
});

describe('d: a resolved hand-back is reported as the form it stood in for', () => {
  const resolvedQuote = (outcome = 'resolved') =>
    fakeRelay({
      streams: [
        [{ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED' } } }, status('TASK_STATE_INPUT_REQUIRED', agentSays('m1', 'Shall I send it?'))],
        [status('TASK_STATE_WORKING'), handBack(outcome)],
      ],
    });

  it('reports once, through the site reporter, with the token the link brought for that action', async () => {
    const tokens = memoryStorage();
    rememberReportToken(MCMANUS, 'tok.signed-by-the-site', tokens); // gitleaks:allow: a made-up token
    const sent: { action_id?: string; report_token?: string }[] = [];
    // As the site's server reporter does (source.ts): the token held for the action goes with its report.
    setSiteActionReporter((run) => {
      const token = run.actionId ? takeReportToken(run.actionId, tokens) : undefined;
      sent.push({ action_id: run.actionId, ...(token ? { report_token: token } : {}) });
    });
    const { harness, confirms, controller } = await page({ relay: resolvedQuote() });
    await harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, []);
    await send(confirms[0]);
    await vi.waitFor(() => expect(controller.session('conv-1')?.state).toBe('awaiting-visitor'));
    expect(sent).toEqual([]);
    await controller.send('conv-1', 'yes');
    await vi.waitFor(() => expect(controller.session('conv-1')?.state).toBe('handed-back'));
    expect(sent).toEqual([{ action_id: MCMANUS, report_token: 'tok.signed-by-the-site' }]); // gitleaks:allow: a made-up token
    expect(controller.session('conv-1')?.reported).toBe(true);
    controller.dispose();
  });

  it('never reports a hand-back that is not resolved', async () => {
    for (const outcome of ['unresolved', 'transferred']) {
      recordReports();
      const { harness, confirms, controller } = await page({ relay: resolvedQuote(outcome) });
      await harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, []);
      await send(confirms[0]);
      await vi.waitFor(() => expect(controller.session('conv-1')?.state).toBe('awaiting-visitor'));
      await controller.send('conv-1', 'yes');
      await vi.waitFor(() => expect(controller.session('conv-1')?.state).toBe('handed-back'));
      expect(reported).toEqual([]);
      controller.dispose();
    }
  });

  it('never reports a failed handoff, or one that stands in for no form', async () => {
    recordReports();
    const failed = await page({ relay: fakeRelay({ streams: [[status('TASK_STATE_FAILED')]] }) });
    await failed.harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, []);
    await send(failed.confirms[0]);
    await vi.waitFor(() => expect(failed.controller.session('conv-1')?.state).toBe('failed'));

    const plain = await page({ relay: resolvedQuote(), calls: [{ name: TRANSFER_TO_AGENT_TOOL, args: { target: 'booking', reason: 'r', summary: 's' } }] });
    await plain.harness.turn('Book', []);
    await send(plain.confirms[0]);
    await vi.waitFor(() => expect(plain.controller.session('conv-1')?.state).toBe('awaiting-visitor'));
    await plain.controller.send('conv-1', 'yes');
    await vi.waitFor(() => expect(plain.controller.session('conv-1')?.state).toBe('handed-back'));
    expect(reported).toEqual([]);
    failed.controller.dispose();
    plain.controller.dispose();
  });

  it('survives a reload mid-handoff, reports when it resolves on the next page, and not again after', async () => {
    recordReports();
    const storage = memoryStorage();
    const first = await page({ relay: resolvedQuote(), storage });
    await first.harness.begin('Get a quote from McManus Electric', 'quote_form_anywhere', { business: 'McManus Electric' }, []);
    await send(first.confirms[0]);
    await vi.waitFor(() => expect(first.controller.session('conv-1')?.state).toBe('awaiting-visitor'));
    first.controller.dispose(); // the page goes away

    // The next page: the reporter connects after the hand-back arrives.
    setSiteActionReporter(null);
    const relay = fakeRelay({ streams: [[status('TASK_STATE_WORKING'), handBack('resolved')]] });
    const next = new HandoffController({ relay: RELAY, targets: TARGETS, fetchImpl: relay.fetchImpl, storage, resumeDelayMs: 60_000 });
    expect(next.session('conv-1')?.standsFor).toEqual({ toolName: 'quote_form_anywhere', actionId: MCMANUS });
    await next.send('conv-1', 'yes');
    await vi.waitFor(() => expect(next.session('conv-1')?.state).toBe('handed-back'));
    expect(reported).toEqual([]);
    recordReports();
    expect(reported).toEqual([{ toolName: 'quote_form_anywhere', actionId: MCMANUS }]);
    next.dispose();

    // And the page after that reads the finished task again: counted once already.
    recordReports();
    const again = new HandoffController({
      relay: RELAY,
      targets: TARGETS,
      fetchImpl: fakeRelay({ streams: [[handBack('resolved')]] }).fetchImpl,
      storage,
    });
    expect(again.session('conv-1')?.reported).toBe(true);
    await again.resume('conv-1');
    expect(reported).toEqual([]);
    again.dispose();
  });
});
