// @vitest-environment happy-dom
/**
 * One form repeated across a site is one tool, even when its fields differ by page.
 *
 * Wrenfield's pass form is the same `<form id="pass-form" method="post" action="/api/checkout">` on every event
 * page, with a hidden `event` and one `qty_{tier}` per ticket tier, and the tiers depend on the event family. It
 * is one tool: grouped by its endpoint, chosen by the hidden `event` (which the crawler records under
 * `nxis:fixedInput`), each event named by its page's title, and each call checked against its own event's tiers.
 * The listings demo's quote forms still group into one tool chosen by business.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSiteActionTools,
  chooserIsFixed,
  findDiscriminator,
  handoffFor,
  readableCode,
  setPageTitles,
  siteCallFit,
  withoutSiteSuffix,
} from '../src/harness/tools/action-tools';
import { parseAction } from '../src/harness/tools/site-actions';
import { LocalModelContext } from '../src/harness/tools/local-context';
import { AgentHarness } from '../src/harness/harness';
import { toolSchema } from '../src/harness/tools/schema';
import '../src/ui/agent';
import type { NxisAction } from '../src/webmcp-contract';
import type { ModelContextToolInfo } from '../src/types';

const ORIGIN = 'https://wrenfield.example';
const S = 'https://schema.org/';
const N = 'https://nxis.ai/ns#';

/** One ticket tier: its field, its label on the page, and the most per order. */
type Tier = [tier: string, label: string, max: number];

const LOW_LIGHT: Tier[] = [
  ['general', 'General passes', 8],
  ['front-rows', 'Front Rows passes', 4],
];
const FIELD_DAYS: Tier[] = [
  ['weekend', 'Weekend passes', 6],
  ['weekend-plus', 'Weekend Plus passes', 4],
  ['saturday', 'Saturday passes', 6],
  ['youth', 'Youth passes', 4],
];
const NIGHT_TABLE: Tier[] = [
  ['supper', 'Supper seats', 4],
  ['pairing', 'Pairing passes', 4],
];

/**
 * The pass form's record as typed retrieval serves it: expanded IRIs, the hidden `event` under `nxis:fixedInput`
 * (a single object, as served, or a list), and the endpoint as `nxis:observedUrl` with its method.
 */
function passRecord(event: string, tiers: Tier[], description: string, fixedAsList = false): Record<string, unknown> {
  const fixed = {
    '@type': `${S}PropertyValueSpecification`,
    [`${S}valueName`]: 'event',
    [`${N}valueType`]: 'string',
    [`${S}readonlyValue`]: true,
    [`${S}defaultValue`]: event,
  };
  return {
    '@type': `${S}InteractAction`,
    '@id': `urn:nxis:action:${event}`,
    [`${S}name`]: 'pass-form',
    [`${S}description`]: description,
    [`${S}target`]: {
      '@type': `${S}EntryPoint`,
      [`${S}httpMethod`]: 'POST',
      [`${S}encodingType`]: 'application/x-www-form-urlencoded',
      [`${N}observedUrl`]: `${ORIGIN}/api/checkout`,
      [`${N}bindingPending`]: true,
      [`${N}targetKind`]: 'selfPage',
      [`${N}pageUrl`]: `${ORIGIN}/events/${event}/`,
    },
    [`${N}input`]: [
      // The honeypot every copy of the form has.
      { '@type': `${S}PropertyValueSpecification`, [`${S}valueName`]: 'website', [`${N}valueType`]: 'string' },
      ...tiers.map(([tier, label, max]) => ({
        '@type': `${S}PropertyValueSpecification`,
        [`${S}valueName`]: `qty_${tier}`,
        [`${S}description`]: `Number of ${label}`,
        [`${N}valueType`]: 'integer',
        [`${S}minValue`]: 0,
        [`${S}maxValue`]: max,
        [`${S}defaultValue`]: '0',
      })),
    ],
    [`${N}fixedInput`]: fixedAsList ? [fixed] : fixed,
  };
}

/** Six events in three families, each family with its own tiers: the six tools of before. */
const EVENTS: [event: string, title: string, tiers: Tier[], description: string][] = [
  ['low-light-pittsburgh-2027-09-10', 'Low Light Pittsburgh: Furnace Songs, Fri, Sep 10', LOW_LIGHT, 'Select general or front-row passes for Low Light Pittsburgh.'],
  ['low-light-denver-2027-03-12', 'Low Light Denver: Thin Air, Fri, Mar 12', LOW_LIGHT, 'Select general or front-row passes for Low Light Denver.'],
  ['field-days-denver-2027', 'Field Days Denver', FIELD_DAYS, 'Select ticket quantities for weekend, single-day, or youth passes to attend Field Days Denver.'],
  ['field-days-austin-2027', 'Field Days Austin', FIELD_DAYS, 'Select ticket quantities for weekend, single-day, or youth passes to attend Field Days Austin.'],
  ['night-table-savannah-2027-03-20', 'Night Table Savannah: Low Country, High Tide', NIGHT_TABLE, 'Select the quantity of supper seats or pairing passes to purchase for this event'],
  ['open-signal-denver-2027', 'Open Signal Denver', [['day', 'Day passes', 4]], 'Select day passes for Open Signal Denver.'],
];

const actions = (): NxisAction[] => EVENTS.map(([e, , tiers, d], i) => parseAction(passRecord(e, tiers, d, i % 2 === 1))!);
const pageOf = (event: string) => `${ORIGIN}/events/${event}/`;
const titles = () => setPageTitles(EVENTS.map(([e, title]) => ({ url: pageOf(e), name: `${title} | Wrenfield` })));

const LOW_LIGHT_PGH = 'Low Light Pittsburgh: Furnace Songs, Fri, Sep 10';

/** Words a visitor should never read: the registry's suffix, a tool number, a path or an event's code. */
const INTERNAL = /anywhere|_\d\b|form \d|\/events\/|[a-z]+-[a-z]+-\d{4}|pass_form/i;

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

afterEach(() => {
  setPageTitles([]);
  vi.restoreAllMocks();
});

describe("the record's constants", () => {
  it('reads nxis:fixedInput, as an object or a list, apart from the inputs', () => {
    const [one, two] = actions();
    for (const a of [one, two]) {
      expect(a['nxis:fixedInput']).toEqual([
        expect.objectContaining({ valueName: 'event', readonlyValue: true, defaultValue: expect.stringMatching(/^low-light-/) }),
      ]);
      expect(a.input!.map((i) => i.valueName)).not.toContain('event');
    }
    expect(one.target['nxis:observedUrl']).toBe(`${ORIGIN}/api/checkout`);
  });

  it('lets a constant with a different value on each page be the chooser', () => {
    const found = findDiscriminator(actions());
    expect(found).toEqual({ field: 'event', fixed: true, values: EVENTS.map(([e]) => e) });
  });
});

describe('one tool per form', () => {
  it('makes one tool of the six, chosen by event, with no number on it', () => {
    titles();
    const tools = buildSiteActionTools(actions(), new LocalModelContext(), { href: `${ORIGIN}/` });
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe('pass_form_anywhere');
    expect(tool.discriminator).toBe('event');
    expect(tool.fixed).toBe(true);
    expect(chooserIsFixed(tool.definition)).toBe(true);
    // Each event by its page's title, without the site's name; never the URL or the code.
    expect(tool.choices).toEqual(EVENTS.map(([, title]) => title));
    const chooser = toolSchema(tool.definition).properties!.event;
    expect(chooser.enum).toEqual(tool.choices);
    expect(chooser.description).toBe('Event');
    // Every tier of every event is a field, and none of them is required of every event.
    const props = Object.keys(toolSchema(tool.definition).properties!);
    expect(props).toEqual(expect.arrayContaining(['qty_general', 'qty_weekend', 'qty_supper', 'qty_day']));
    expect(toolSchema(tool.definition).required).toEqual(['event']);
  });

  it('describes the whole form, not one event, and names the tiers as per event', () => {
    titles();
    const [tool] = buildSiteActionTools(actions(), new LocalModelContext());
    const description = tool.definition.description!;
    const first = description.split(/(?<=[.!?])\s/)[0];
    expect(first).toBe("The site's pass form, on the page of each event.");
    expect(description).not.toMatch(/Select|passes for|to attend/);
    expect(description).toContain(`Set event to choose which: ${LOW_LIGHT_PGH}; `);
    expect(description).toMatch(/Each event takes only its own fields/);
    expect(first).not.toMatch(INTERNAL);
  });

  it('names an event in words when its page has no title on record', () => {
    const [tool] = buildSiteActionTools(actions(), new LocalModelContext());
    expect(tool.choices![0]).toBe('Low Light Pittsburgh, Sep 10, 2027');
    expect(tool.choices![2]).toBe('Field Days Denver 2027');
    for (const c of tool.choices!) expect(c).not.toMatch(/[a-z]-[a-z]|\//);
    expect(readableCode('night-table-savannah-2027-03-20')).toBe('Night Table Savannah, Mar 20, 2027');
  });

  it('defaults to the open page’s event, and accepts the code a model read off the page', () => {
    titles();
    const href = pageOf('field-days-denver-2027');
    const [tool] = buildSiteActionTools(actions(), new LocalModelContext(), { href });
    expect(toolSchema(tool.definition).properties!.event.default).toBe('Field Days Denver');
    expect(handoffFor(tool.definition, { event: 'low-light-pittsburgh-2027-09-10' }, href)?.label).toBe(LOW_LIGHT_PGH);
  });

  it('still makes two tools of two different forms that share a name and an endpoint’s absence', () => {
    const a = actions()[0];
    const other: NxisAction = { ...a, '@id': 'urn:x', target: { '@type': 'EntryPoint', httpMethod: 'POST', 'nxis:pageUrl': `${ORIGIN}/x/` } };
    const plain: NxisAction = { ...a, '@id': 'urn:y', input: [{ valueName: 'email' }], target: { '@type': 'EntryPoint', httpMethod: 'POST', 'nxis:pageUrl': `${ORIGIN}/y/` } };
    const tools = buildSiteActionTools([other, plain], new LocalModelContext());
    expect(tools.map((t) => t.name)).toEqual(['pass_form_anywhere', 'pass_form_anywhere_2']);
    // Numbered in the registry only: what anyone reads is the form's name.
    expect(withoutSiteSuffix('pass_form_anywhere_2')).toBe('pass_form');
  });
});

describe("each call is checked against its own event's fields", () => {
  const tool = () => {
    titles();
    return buildSiteActionTools(actions(), new LocalModelContext(), { href: `${ORIGIN}/` })[0];
  };

  it('narrows the schema to the chosen event: its tiers, and the choice', () => {
    const t = tool();
    const fit = siteCallFit(t.definition, { event: LOW_LIGHT_PGH, qty_general: 2 })!;
    expect(fit.chosen).toBe(true);
    expect(fit.problem).toBeUndefined();
    expect(Object.keys(fit.schema.properties!).sort()).toEqual(['event', 'qty_front-rows', 'qty_general', 'website']);
    expect(fit.schema.properties!['qty_front-rows'].maximum).toBe(4);
  });

  it("turns down a tier the event doesn't sell, with that event's tiers and limits", () => {
    const t = tool();
    const fit = siteCallFit(t.definition, { event: LOW_LIGHT_PGH, qty_weekend: 2 })!;
    expect(fit.problem!.visitor).toBe(
      `"Weekend passes" isn't available for ${LOW_LIGHT_PGH}. ` +
        'It offers General passes (up to 8) and Front Rows passes (up to 4).',
    );
    expect(fit.problem!.model).toMatch(/has no field qty_weekend\. Its fields are .*qty_general \(up to 8\) and qty_front-rows \(up to 4\)/);
  });

  it('turns down more than the event allows', () => {
    const t = tool();
    const fit = siteCallFit(t.definition, { event: LOW_LIGHT_PGH, 'qty_front-rows': 9 })!;
    expect(fit.problem!.visitor).toMatch(/^Front Rows passes for Low Light Pittsburgh: Furnace Songs, Fri, Sep 10 is up to 4\./);
  });

  it('lets a zero for another event’s tier pass, since it asks for nothing', () => {
    const t = tool();
    expect(siteCallFit(t.definition, { event: LOW_LIGHT_PGH, qty_general: 2, qty_weekend: 0 })!.problem).toBeUndefined();
  });

  it('waits for the event before checking anything', () => {
    const t = tool();
    expect(siteCallFit(t.definition, { qty_general: 2 })).toEqual({ schema: t.definition.inputSchema, chosen: false });
  });

  it('carries only the event’s own fields to its page, and never the constant', async () => {
    titles();
    const storage = memoryStorage();
    const navigate = vi.fn();
    const [t] = buildSiteActionTools(actions(), new LocalModelContext(), { href: `${ORIGIN}/`, storage, navigate });
    const res = await t.definition.execute({ event: LOW_LIGHT_PGH, qty_general: 2, qty_weekend: 0 });
    expect(navigate).toHaveBeenCalledWith(pageOf('low-light-pittsburgh-2027-09-10'));
    expect(res.content[0].text).toBe(`Opening ${LOW_LIGHT_PGH} to submit this…`);
    const held = JSON.parse(Object.values(Object.fromEntries([...Array(storage.length)].map((_, i) => [i, storage.getItem(storage.key(i)!)!])))[0]);
    expect(held.values).toEqual({ qty_general: 2 });
  });

  it("fills the page's own form on its page with that event's fields", async () => {
    titles();
    const href = pageOf('low-light-pittsburgh-2027-09-10');
    const mc = new LocalModelContext();
    const pageExecute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const action = actions()[0];
    await mc.registerTool({
      name: 'pass_form',
      description: 'pass form',
      inputSchema: { type: 'object' },
      annotations: { 'ai.nxis/actionId': action['@id'] },
      execute: pageExecute,
    });
    const [t] = buildSiteActionTools(actions(), mc, { href });
    await t.definition.execute({ event: LOW_LIGHT_PGH, qty_general: 2, qty_saturday: 0 });
    expect(pageExecute).toHaveBeenCalledWith({ qty_general: 2 }, expect.anything());
  });

  it('turns a bad tier down even when called directly', async () => {
    const t = tool();
    const res = await t.definition.execute({ event: LOW_LIGHT_PGH, qty_youth: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/"Youth passes" isn't available/);
  });
});

describe('in a turn', () => {
  const run = async (replies: { text: string; call?: { name: string; args: Record<string, unknown> } }[]) => {
    titles();
    const [t] = buildSiteActionTools(actions(), new LocalModelContext(), { href: `${ORIGIN}/` });
    const tool: ModelContextToolInfo = t.definition;
    const errors: string[] = [];
    const confirms: { slots: { name: string }[]; values: Record<string, unknown> }[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message() {},
      status() {},
      results() {},
      detail() {},
      step() {},
      toolError: (_t: unknown, m: string) => errors.push(m),
      confirm: (req: (typeof confirms)[number]) => confirms.push(req),
      ask() {},
    };
    let n = 0;
    const provider = { ready: true, load: async () => {}, complete: async () => replies[Math.min(n++, replies.length - 1)] };
    const toolSource = { discoverTools: async () => [tool], execTool: vi.fn() };
    const messages: { role: string; content: string; data?: string }[] = [];
    const harness = new AgentHarness({ provider, toolSource, renderer, recommend: false } as never);
    await harness.turn('Two weekend passes for Low Light Pittsburgh', messages as never);
    return { errors, confirms, messages, toolSource };
  };

  it("rejects a tier the event doesn't sell before the card, and the model tries again with the right one", async () => {
    const { errors, confirms, messages, toolSource } = await run([
      { text: '', call: { name: 'pass_form_anywhere', args: { event: LOW_LIGHT_PGH, qty_weekend: 2 } } },
      { text: '', call: { name: 'pass_form_anywhere', args: { event: LOW_LIGHT_PGH, qty_general: 2 } } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/isn't available for Low Light Pittsburgh: Furnace Songs, Fri, Sep 10\. It offers .*General passes \(up to 8\)/);
    expect(errors[0]).not.toMatch(INTERNAL);
    expect(messages).toContainEqual(expect.objectContaining({ content: '[pass_form_anywhere did not go through]', data: expect.stringMatching(/qty_general/) }));
    // The card for the corrected call shows only that event's fields.
    expect(confirms).toHaveLength(1);
    expect(confirms[0].slots.map((s) => s.name).sort()).toEqual(['event', 'qty_front-rows', 'qty_general']);
    expect(confirms[0].values).toEqual({ event: LOW_LIGHT_PGH, qty_general: 2, 'qty_front-rows': 0 });
    expect(toolSource.execTool).not.toHaveBeenCalled();
  });
});

describe('what the visitor reads', () => {
  const agent = (): any => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };

  it('reads "Get passes for" the event on the card', () => {
    titles();
    document.title = 'Home | Wrenfield';
    const el = agent();
    const [t] = buildSiteActionTools(actions(), new LocalModelContext(), { href: `${ORIGIN}/` });
    const { view, hidden } = el._describeAction(t.definition, { event: LOW_LIGHT_PGH, qty_general: 2 });
    expect(view.sentence).toBe(`Get passes for ${LOW_LIGHT_PGH}.`);
    expect(view.identity.name).toBe(LOW_LIGHT_PGH);
    expect(hidden.has('event')).toBe(true);
    for (const text of [view.sentence, view.identity.name, view.identity.sub, view.note ?? '']) expect(text).not.toMatch(INTERNAL);
  });

  it('lists the form once in the tools menu, by its own name', () => {
    titles();
    const el = agent();
    const [t] = buildSiteActionTools(actions(), new LocalModelContext());
    const row: HTMLElement = el._toolRow(t.definition);
    expect(row.textContent).toMatch(/^Pass form · any page/);
    expect(row.title).toBe("Pass form · any page — The site's pass form, on the page of each event.");
    expect(row.textContent).not.toMatch(INTERNAL);
  });
});

describe("the listings demo's quote forms", () => {
  const quote = (business: string, slug: string, services: string[], endpoint?: string): NxisAction => ({
    '@type': 'InteractAction',
    '@id': `urn:nxis:action:${slug}`,
    name: 'quote-form',
    description: `Request a quote from ${business}.`,
    target: {
      '@type': 'EntryPoint',
      httpMethod: 'POST',
      'nxis:pageUrl': `https://listings.example/listings/${slug}.html`,
      ...(endpoint ? { 'nxis:observedUrl': endpoint } : {}),
    },
    input: [
      { valueName: 'business', defaultValue: business },
      { valueName: 'full_name', valueRequired: true },
      { valueName: 'service', 'nxis:valueOption': services.map((value) => ({ value })) },
    ],
  });

  for (const endpoint of [undefined, 'https://listings.example/api/quote']) {
    it(`still group into one tool chosen by business (${endpoint ? 'with' : 'without'} an endpoint)`, async () => {
      const list = [
        quote('McGreevy Plumbing', 'mcgreevy-plumbing', ['General Plumbing Repair'], endpoint),
        quote('Royal Oak Remodeling', 'royal-oak', ['Kitchen & Bath'], endpoint),
      ];
      const storage = memoryStorage();
      const [t, ...rest] = buildSiteActionTools(list, new LocalModelContext(), { href: 'https://listings.example/', storage, navigate() {} });
      expect(rest).toHaveLength(0);
      expect(t.name).toBe('quote_form_anywhere');
      expect(t.discriminator).toBe('business');
      expect(t.fixed).toBeFalsy();
      expect(t.choices).toEqual(['McGreevy Plumbing', 'Royal Oak Remodeling']);
      expect(siteCallFit(t.definition, { business: 'Royal Oak Remodeling' })).toBeNull();
      await t.definition.execute({ business: 'Royal Oak Remodeling', full_name: 'Ada' });
      const held = JSON.parse(storage.getItem(storage.key(0)!)!);
      expect(held.values).toEqual({ business: 'Royal Oak Remodeling', full_name: 'Ada' });
    });
  }
});
