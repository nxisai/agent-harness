/**
 * The decision table, which is the whole point of the package.
 *
 * These run headless — no model, no DOM — because they check what the harness
 * decides, not how it draws or what Gemma generates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSlots, decide, policyFor, buildPlan, AgentHarness, extractResult } from '../src/index';
import { narrateCall, countRecords } from '../src/harness/harness';
import { parseToolCall, stripMarkers } from '../src/engine';
import {
  toFieldFilter,
  mapQueryArgs,
  parseLooseObject,
  flattenPaths,
  registerRemoteTools,
} from '../src/harness/tools/bridge';
import { connectTools, LocalModelContext } from '../src/harness/tools/source';
import {
  ACTION_IDS_HINT,
  CHOICES_HINT,
  CHOOSER_HINT,
  PAGE_URLS_HINT,
  SITE_ACTION_HINT,
  isSiteTool,
} from '../src/harness/tools/action-tools';
import type { JsonSchema, ModelContextToolInfo } from '../src/types';

const readTool = { name: 'nxis_query', annotations: { readOnlyHint: true } } as unknown as ModelContextToolInfo;
const writeTool = { name: 'quote-form' } as unknown as ModelContextToolInfo;

const querySchema: JsonSchema = {
  type: 'object',
  properties: { schema_type: { type: 'string' }, text: { type: 'string' } },
  required: ['schema_type'],
};

const formSchema: JsonSchema = {
  type: 'object',
  properties: {
    business: { type: 'string', default: 'Acme' },
    full_name: { type: 'string' },
    email: { type: 'string' },
    service: { type: 'string' },
    project_description: { type: 'string' },
  },
  required: ['full_name', 'email', 'service', 'project_description'],
};

describe('read tools', () => {
  it('runs without any UI when the arguments are there', () => {
    const r = resolveSlots(querySchema, { modelArgs: { schema_type: 'Plumber' } });
    expect(decide(policyFor(readTool), r.missing.length)).toBe('execute');
  });

  it('asks only for what is missing, then runs', () => {
    const r = resolveSlots(querySchema, { modelArgs: { text: 'Royal Oak' } });
    expect(r.missing.map((s) => s.name)).toEqual(['schema_type']);
    expect(decide(policyFor(readTool), r.missing.length)).toBe('ask');
  });

  it('never confirms', () => {
    expect(policyFor(readTool).confirmWhenSatisfied).toBe(false);
  });
});

describe('write tools', () => {
  it('confirms rather than firing silently', () => {
    const r = resolveSlots(formSchema, {
      modelArgs: { full_name: 'A', email: 'a@b.c', service: 'x', project_description: 'y' },
    });
    expect(decide(policyFor(writeTool), r.missing.length)).toBe('confirm');
  });

  it('does not re-ask for values the host already supplied', () => {
    const r = resolveSlots(formSchema, {
      modelArgs: { service: 'x', project_description: 'y' },
      profile: { full_name: 'A', email: 'a@b.c' },
    });
    expect(r.missing).toHaveLength(0);
  });

  it('lets explicit arguments beat stored preferences', () => {
    const r = resolveSlots(formSchema, {
      modelArgs: { email: 'work@example.com' },
      profile: { email: 'home@example.com' },
    });
    expect(r.values.email).toBe('work@example.com');
  });

  it('treats a schema default as provided', () => {
    const r = resolveSlots(formSchema, { modelArgs: {} });
    expect(r.missing.map((s) => s.name)).not.toContain('business');
    expect(r.values.business).toBe('Acme');
  });
});

describe('clarification plan', () => {
  it('steps when several answers are missing', () => {
    const r = resolveSlots(formSchema, { modelArgs: {} });
    const plan = buildPlan(r.missing);
    expect(plan.stepped).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(1);
  });

  it('keeps name and email in one step', () => {
    const r = resolveSlots(formSchema, { modelArgs: {} });
    const step = buildPlan(r.missing).steps.find((s) => s.slots.some((x) => x.name === 'full_name'));
    expect(step!.slots.map((s) => s.name)).toContain('email');
  });

  it('asks one at a time when grouping is off', () => {
    const r = resolveSlots(formSchema, { modelArgs: {} });
    expect(buildPlan(r.missing, false).steps.every((s) => s.slots.length === 1)).toBe(true);
  });

  it('is not a stepper for a single gap', () => {
    const r = resolveSlots(querySchema, { modelArgs: {} });
    expect(buildPlan(r.missing).stepped).toBe(false);
  });
});

describe('a turn that leaves something behind', () => {
  it('writes a line when the model only emitted a tool call', () => {
    // Reads and writes get different sentences, because the person is about to
    // see very different things: records, or a form they have to check.
    expect(narrateCall({ name: 'nxis_query', args: {} }, [readTool])).toBe('Looking that up.');
    expect(narrateCall({ name: 'quote-form', args: {} }, [writeTool])).toBe(
      'Filling in the quote form.',
    );
  });

  it('still says something when the call could not be parsed', () => {
    // The invariant is that the assistant's turn never vanishes. A reply the
    // parser could not read is exactly when a bubble used to disappear.
    expect(narrateCall(null, [readTool])).toBe('Working on that.');
  });

  it('counts records for the trace summary, and admits when it cannot', () => {
    const res = (content: string) => ({ content: [{ type: 'text', text: content }] });
    expect(countRecords(res('{"results":[1,2,3]}'), '{"results":[1,2,3]}')).toBe(3);
    expect(countRecords(res('{"total":12}'), '{"total":12}')).toBe(12);
    expect(countRecords(res('booked'), 'booked')).toBeUndefined();
  });
});

describe('reading what the model emitted', () => {
  const call = (name: string, body = '') => `<|tool_call>call:${name}{${body}}<tool_call|>`;

  it('parses tool names with hyphens and dots', () => {
    // nxis.js synthesises form tools as `quote-form`, `booking-form`. A name
    // class of [A-Za-z0-9_] meant those calls were never made at all.
    expect(parseToolCall(call('quote-form'))?.name).toBe('quote-form');
    expect(parseToolCall(call('nxis.query'))?.name).toBe('nxis.query');
    expect(parseToolCall(call('nxis_query'))?.name).toBe('nxis_query');
  });

  it('strips a hyphenated call block completely', () => {
    // When the block failed to match, it also failed to strip — so the raw
    // `call:booking-form{…}` was shown to the user as the model's reply.
    expect(stripMarkers(call('booking-form', 'window: 1'))).toBe('');
  });

  it('does not leave a bare role word behind', () => {
    // `<|start_of_turn>model` loses its marker to the token sweep, and the
    // leftover "model" read as the assistant having said the word "model".
    expect(stripMarkers('<|start_of_turn>model<end_of_turn>')).toBe('');
  });

  it('keeps prose that happens to accompany a call', () => {
    expect(stripMarkers(`Let me check.\n${call('nxis_query')}`)).toBe('Let me check.');
  });
});

describe('typed retrieval, as the model has to write it', () => {
  it('turns a comparison written into the value into an operator', () => {
    // The user asks for "4.5 or higher"; the model writes ">=4.5"; the server
    // wants {path, operator, value} with a number.
    expect(toFieldFilter('aggregateRating.ratingValue', '>=4.5')).toEqual({
      path: 'aggregateRating.ratingValue',
      operator: 'GREATER_THAN_OR_EQUAL',
      value: 4.5,
    });
    expect(toFieldFilter('price', '<100')).toEqual({
      path: 'price',
      operator: 'LESS_THAN',
      value: 100,
    });
  });

  it('matches exactly when no comparison is given, and coerces numbers', () => {
    expect(toFieldFilter('brand', 'Rheem')).toEqual({
      path: 'brand',
      operator: 'EQUALS',
      value: 'Rheem',
    });
    // A string "4" would never match a numeric field.
    expect(toFieldFilter('stars', '4')).toEqual({ path: 'stars', operator: 'EQUALS', value: 4 });
  });

  it('treats a list as any-of', () => {
    expect(toFieldFilter('areaServed', ['Chicago', 'Oak Park'])).toEqual({
      path: 'areaServed',
      operator: 'IN',
      value: ['Chicago', 'Oak Park'],
    });
  });

  it('builds the whole query the server expects', () => {
    expect(
      mapQueryArgs({
        schema_type: 'Plumber',
        text: 'water heater',
        filters: { 'aggregateRating.ratingValue': '>=4.5' },
        sort: '-aggregateRating.ratingValue',
        limit: 5,
      }),
    ).toEqual({
      filter: {
        schema_type: 'Plumber',
        field_filters: [
          { path: 'aggregateRating.ratingValue', operator: 'GREATER_THAN_OR_EQUAL', value: 4.5 },
        ],
        sort_option: { property: 'aggregateRating.ratingValue', order: 'DESCENDING' },
      },
      text: 'water heater',
      limit: 5,
    });
  });

  it('omits empty filters rather than sending a filter that matches nothing', () => {
    expect(mapQueryArgs({ schema_type: 'Plumber', filters: { rating: '' } })).toEqual({
      filter: { schema_type: 'Plumber' },
    });
  });
});

describe('filters as a small model actually writes them', () => {
  const rating = { path: 'aggregateRating.ratingValue', operator: 'GREATER_THAN_OR_EQUAL', value: 4.5 };

  it('reads the exact string Gemma produced in the wild', () => {
    // Verbatim from a real turn: a string, nested, with bare keys. This used to
    // fail all three checks at once and the constraint vanished — the server
    // received {schema_type, limit} and the user got unfiltered results.
    const args = mapQueryArgs({
      schema_type: 'LocalBusiness',
      filters: '{aggregateRating:{ratingValue:">=4.5"}}',
      limit: 10,
    });
    expect(args).toEqual({
      filter: { schema_type: 'LocalBusiness', field_filters: [rating] },
      limit: 10,
    });
  });

  it('reads the same thing however it is written', () => {
    const forms = [
      { 'aggregateRating.ratingValue': '>=4.5' },
      { aggregateRating: { ratingValue: '>=4.5' } },
      '{"aggregateRating.ratingValue": ">=4.5"}',
      "{aggregateRating: {ratingValue: '>=4.5'}}",
      'aggregateRating.ratingValue >= 4.5',
    ];
    for (const filters of forms) {
      expect(mapQueryArgs({ schema_type: 'Plumber', filters }).filter).toEqual({
        schema_type: 'Plumber',
        field_filters: [rating],
      });
    }
  });

  it('flattens nested paths to the dot-paths the server indexes', () => {
    expect(flattenPaths({ a: { b: { c: 1 } }, d: 2 })).toEqual({ 'a.b.c': 1, d: 2 });
  });

  it('gives up rather than inventing a filter', () => {
    expect(parseLooseObject('not a filter at all')).toBeNull();
    expect(parseLooseObject(42)).toBeNull();
    expect(mapQueryArgs({ schema_type: 'Plumber', filters: 'nonsense' }).filter).toEqual({
      schema_type: 'Plumber',
    });
  });
});

describe('an agent as a slice of the page', () => {
  const provider = { ready: true } as never;
  const renderer = {} as never;

  const harness = (opts: Record<string, unknown>) =>
    new AgentHarness({ provider, renderer, ...opts } as never) as unknown as {
      visibleTools(tools: unknown[]): unknown[];
      applySystemPrompt(messages: { role: string; content: string }[]): void;
    };

  const ALL = [
    { name: 'nxis_query' },
    { name: 'nxis_get' },
    { name: 'booking-form' },
    { name: 'quote-form' },
  ];

  it('shows an agent only its own tools', () => {
    const retrieval = harness({ tools: (t: { name: string }) => t.name.startsWith('nxis_') });
    expect(retrieval.visibleTools(ALL).map((t) => (t as { name: string }).name)).toEqual([
      'nxis_query',
      'nxis_get',
    ]);
  });

  it('shows an agent nothing when nothing is its own', () => {
    // This used to widen the slice to every tool on the page, on the theory
    // that acting on the wrong set beats not acting. It does not: an agent
    // asked to take a booking that reaches for a search tool instead succeeds
    // at the wrong thing, confidently. The turn now says so instead — see the
    // 'unavailable' outcome.
    const misconfigured = harness({ tools: () => false });
    expect(misconfigured.visibleTools(ALL)).toEqual([]);
  });

  it('asserts its own instructions on a shared transcript', () => {
    const booking = harness({ systemPrompt: 'You take bookings.' });
    const messages = [
      { role: 'system', content: 'You look things up.' },
      { role: 'user', content: 'book Thursday' },
    ];
    booking.applySystemPrompt(messages);

    // The role is replaced; the conversation underneath it is not, so "book
    // that one" still resolves against what the previous agent found.
    expect(messages[0]).toEqual({ role: 'system', content: 'You take bookings.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'book Thursday' });
    expect(messages).toHaveLength(2);
  });

  it('adds a system turn when the transcript has none', () => {
    const booking = harness({ systemPrompt: 'You take bookings.' });
    const messages = [{ role: 'user', content: 'hello' }];
    booking.applySystemPrompt(messages);
    expect(messages[0]).toEqual({ role: 'system', content: 'You take bookings.' });
  });

  it('leaves the transcript alone when the agent has no prompt of its own', () => {
    const plain = harness({});
    const messages = [{ role: 'system', content: 'engine default' }];
    plain.applySystemPrompt(messages);
    expect(messages[0].content).toBe('engine default');
  });
});

describe('what the bridge does not bring across', () => {
  const list = async (names: string[], accept?: (n: string) => boolean) => {
    const registered: string[] = [];
    const client = { listTools: async () => ({ tools: names.map((name) => ({ name })) }) };
    const mc = { registerTool: (t: { name: string }) => registered.push(t.name) };
    await registerRemoteTools(client as never, mc as never, { publicTools: [] } as never, { accept });
    return registered;
  };

  it('leaves nxis_action on the server where it belongs', async () => {
    // It writes server-side, by @id, with an API key — the shape an external
    // MCP client wants. In a browser the page's own form tools already cover
    // those actions, visibly and with a confirm step.
    expect(await list(['nxis_query', 'nxis_get', 'nxis_action'])).toEqual(['nxis_query', 'nxis_get']);
  });

  it('keeps the site-action report from the model: it says what happened, it is not something to do', async () => {
    expect(await list(['nxis_query', 'nxis_track_site_action'])).toEqual(['nxis_query']);
  });

  it('brings across everything else it is offered', async () => {
    expect(await list(['nxis_query', 'nxis_get', 'nxis_list_types'])).toHaveLength(3);
  });

  it('lets a host override the exclusion', async () => {
    expect(await list(['nxis_query', 'nxis_action'], () => true)).toContain('nxis_action');
  });
});

describe('bridging into a registry that already holds the tools', () => {
  /** Behaves like a native modelContext: a duplicate name rejects, asynchronously. */
  function nativeRegistry(existing: string[] = []) {
    const names = new Set(existing);
    return {
      names,
      getTools: async () => [...names].map((name) => ({ name })),
      registerTool: (t: { name: string }) =>
        names.has(t.name)
          ? Promise.reject(new DOMException('Duplicate tool name', 'InvalidStateError'))
          : Promise.resolve(void names.add(t.name)),
    };
  }
  const client = (names: string[]) => ({
    listTools: async () => ({ tools: names.map((name) => ({ name })) }),
  });

  it('skips names already registered, and registers the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mc = nativeRegistry(['nxis_query']);
    const registered = await registerRemoteTools(
      client(['nxis_query', 'nxis_get']) as never,
      mc as never,
      { publicTools: [] } as never,
    );
    expect(registered).toEqual(['nxis_get']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('turns a rejected registration into a warning rather than an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mc = nativeRegistry();
    // The registry claims to be empty, so the name check cannot catch it.
    mc.getTools = async () => [];
    mc.names.add('nxis_get');
    const registered = await registerRemoteTools(
      client(['nxis_get', 'nxis_list_types']) as never,
      mc as never,
      { publicTools: [] } as never,
    );
    expect(registered).toEqual(['nxis_list_types']);
    expect(warn.mock.calls[0][0]).toMatch(/could not register nxis_get/);
    warn.mockRestore();
  });
});

describe('connecting the same registry twice', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does the work once, and gives both callers the same result', async () => {
    const mc = new LocalModelContext();
    vi.stubGlobal('document', { modelContext: mc });
    vi.stubGlobal('navigator', {});
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetch);

    const [a, b] = await Promise.all([connectTools(), connectTools()]);
    const c = await connectTools();
    expect(b).toBe(a);
    expect(c).toBe(a);
    // Two catalogs tried, once.
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('the tools a surface lists', () => {
  const harness = (tools: { name: string; annotations?: Record<string, unknown> }[], opts = {}) =>
    new AgentHarness({
      renderer: {} as never,
      provider: { ready: true } as never,
      toolSource: { modelContext: () => ({ getTools: async () => tools }) } as never,
      ...opts,
    });

  it('lists what the agent is offered, not everything registered', async () => {
    const offered = await harness([{ name: 'nxis_query' }, { name: 'booking' }], {
      tools: (t: { name: string }) => t.name.startsWith('nxis_'),
    }).offeredTools();
    expect(offered.map((t) => t.name)).toEqual(['nxis_query']);
  });

  it('answers straight away when the page has no registry', async () => {
    const empty = new AgentHarness({
      renderer: {} as never,
      provider: { ready: true } as never,
      toolSource: { modelContext: () => null } as never,
    });
    expect(await empty.offeredTools()).toEqual([]);
  });

  it('shows nothing rather than throwing when the registry fails', async () => {
    const broken = new AgentHarness({
      renderer: {} as never,
      provider: { ready: true } as never,
      toolSource: {
        modelContext: () => ({
          getTools: async () => {
            throw new Error('registry gone');
          },
        }),
      } as never,
    });
    expect(await broken.offeredTools()).toEqual([]);
  });

  it('tells a site-wide tool from a page tool', () => {
    expect(isSiteTool({ name: 'quote_form_anywhere', annotations: { [SITE_ACTION_HINT]: true } } as never)).toBe(true);
    expect(isSiteTool({ name: 'quote_form' } as never)).toBe(false);
  });
});

describe('reading what a tool returned', () => {
  const wrapped = JSON.stringify({
    content: [{ type: 'text', text: 'Opening Detroit Roof Doctors to submit this…' }],
    structuredContent: { 'ai.nxis/handoff': { label: 'Detroit Roof Doctors' } },
  });

  it('unwraps a response the registry handed back as JSON', () => {
    // A native registry may stringify a response object into one text block,
    // which would otherwise reach the thread as `{"content":[{"type":…`.
    expect(extractResult(wrapped)).toBe('Opening Detroit Roof Doctors to submit this…');
    expect(extractResult({ content: [{ type: 'text', text: wrapped }] })).toBe(
      'Opening Detroit Roof Doctors to submit this…',
    );
  });

  it("leaves a tool's own JSON result alone", () => {
    const own = '{"success":true,"submitted":true,"filled":["full_name"]}';
    expect(extractResult(own)).toBe(own);
  });
});

describe('a write that leaves for another page', () => {
  it('reports the journey rather than claiming the form was submitted', async () => {
    // Annotations only. A registry is free to hand back nothing but the
    // response's text, so nothing here may depend on what the tool returned.
    const tool = {
      name: 'quote_form_anywhere',
      inputSchema: { type: 'object', properties: { business: { type: 'string' } } },
      annotations: {
        readOnlyHint: false,
        [SITE_ACTION_HINT]: true,
        [ACTION_IDS_HINT]: ['urn:nxis:action:mcgreevy', 'urn:nxis:action:royal-oak'],
        [PAGE_URLS_HINT]: ['https://site.example/mcgreevy', 'https://site.example/royal-oak'],
        [CHOOSER_HINT]: 'business',
        [CHOICES_HINT]: ['McGreevy Plumbing', 'Royal Oak Remodeling'],
      },
    };
    const said: string[] = [];
    const details: string[] = [];
    const labels: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message: (_role: string, text: string) => said.push(text),
      status() {},
      // The person presses the button that said it would open that page.
      confirm: (req: {
        values: Record<string, unknown>;
        submitLabel?: string;
        destination?: string;
        onSubmit: (v: Record<string, unknown>) => void;
      }) => {
        labels.push(`${req.submitLabel ?? 'Submit'} → ${req.destination ?? 'here'}`);
        req.onSubmit(req.values);
      },
      detail: (_t: unknown, _v: unknown, text: string) => details.push(text),
      results() {},
      toolError() {},
    };
    const provider = {
      ready: true,
      load: async () => {},
      complete: async () => ({
        text: '',
        call: { name: 'quote_form_anywhere', args: { business: 'Royal Oak Remodeling' } },
      }),
    };
    const toolSource = {
      discoverTools: async () => [tool],
      // No structuredContent: the marker the tool sets does not survive every
      // registry, so the decision cannot rest on it.
      execTool: async () => ({
        content: [{ type: 'text', text: 'Opening Royal Oak Remodeling to submit this…' }],
      }),
    };

    const messages: unknown[] = [];
    const harness = new AgentHarness({ provider, toolSource, renderer } as never);
    await harness.turn('quote from Royal Oak Remodeling', messages as never);

    // The button said where pressing it would lead.
    // Short enough for a narrow card; the destination travels on its own.
    expect(labels).toEqual(['Open & submit → Royal Oak Remodeling']);
    expect(said.some((s) => /Opening Royal Oak Remodeling/.test(s))).toBe(true);
    expect(details).toEqual([]);
    // Nothing may enter the transcript as sent: the form has not been filled.
    expect(JSON.stringify(messages)).not.toMatch(/submitted with/);
  });
});

describe('an agent that cannot help', () => {
  const run = async (opts: Record<string, unknown>, pageTools: { name: string }[]) => {
    const said: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message: (_role: string, text: string) => said.push(text),
      status() {},
    };
    const provider = { ready: true, load: async () => {}, complete: async () => ({ text: '' }) };
    const toolSource = { discoverTools: async () => pageTools };
    const harness = new AgentHarness({ provider, toolSource, renderer, ...opts } as never);
    const result = await harness.turn('book me a visit', []);
    return { result, said };
  };

  const PAGE = [{ name: 'nxis_query' }, { name: 'nxis_get' }];

  it('says it cannot, rather than answering with another agent’s tools', async () => {
    const { result, said } = await run(
      {
        name: 'booking',
        tools: (t: { name: string }) => /book/.test(t.name),
        unavailable: 'I cannot book visits from this page.',
      },
      PAGE,
    );
    expect(result).toEqual({ decision: 'unavailable' });
    expect(said).toEqual(['I cannot book visits from this page.']);
  });

  it('has something to say even when the host wrote no message', async () => {
    const { said } = await run({ name: 'booking', tools: () => false }, PAGE);
    expect(said[0]).toMatch(/cannot do that from this page/i);
  });

  it('still reports an empty page as an empty page', async () => {
    // Nothing registered at all is the host's bug, and reads differently from
    // "this agent's tools are elsewhere".
    const { result, said } = await run({ name: 'booking', tools: () => false }, []);
    expect(result).toEqual({ decision: 'none' });
    expect(said[0]).toMatch(/no tools are registered/i);
  });
});
