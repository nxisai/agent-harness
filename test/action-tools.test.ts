/**
 * Site action tools: how the site's actions become tools, and what runs them.
 *
 * The registry is the package's own {@link LocalModelContext}, so registration,
 * `getTools` and delegation behave as they do on a page with no native WebMCP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSiteActionTools,
  siteToolName,
  findDiscriminator,
  formOptions,
  handoffFor,
  registerSiteActionTools,
  sanitizeToolName,
  selectSiteTools,
  withoutShadowedTools,
  ACTION_ID_HINT,
  SITE_ACTION_HINT,
} from '../src/harness/tools/action-tools';
import { LocalModelContext } from '../src/harness/tools/local-context';
import type { NxisAction, NxisPropertyValueSpecification } from '../src/webmcp-contract';
import type { ModelContextToolInfo } from '../src/types';

const ORIGIN = 'https://listings.example';

const field = (
  valueName: string,
  extra: Partial<NxisPropertyValueSpecification> = {},
): NxisPropertyValueSpecification => ({
  '@type': 'PropertyValueSpecification',
  valueName,
  'nxis:valueType': 'string',
  ...extra,
});

/** A per-business quote form, as the listings demo has one of per page. */
function quoteForm(
  business: string,
  page: string,
  services: string[] = ['General Plumbing Repair'],
): NxisAction {
  return {
    '@type': 'InteractAction',
    '@id': `urn:nxis:action:${page}`,
    name: 'quote-form',
    description: `Request a quote from ${business}.`,
    target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}${page}` },
    input: [
      field('business', { defaultValue: business }),
      field('full_name', { description: 'Full Name', valueRequired: true }),
      field('service', {
        'nxis:valueOption': services.map((value) => ({ '@type': 'nxis:ValueOption' as const, value })),
      }),
    ],
  };
}

const mcgreevy = quoteForm('McGreevy Plumbing', '/listings/mcgreevy-plumbing.html');
const royalOak = quoteForm('Royal Oak Remodeling', '/listings/royal-oak.html', ['Kitchen & Bath']);

/** A newsletter form: a different name and different fields, so its own tool. */
const newsletter: NxisAction = {
  '@type': 'SubscribeAction',
  '@id': 'urn:nxis:action:newsletter',
  name: 'newsletter signup',
  target: { '@type': 'EntryPoint', httpMethod: 'POST', 'nxis:pageUrl': `${ORIGIN}/index.html` },
  input: [field('email', { valueRequired: true })],
};

const build = (actions: NxisAction[], href?: string) =>
  buildSiteActionTools(actions, new LocalModelContext(), { href });

/** Somewhere for a travelling call to wait; node has no sessionStorage. */
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

/** Everything a storage holds, by key. */
function storageDump(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) out[storage.key(i)!] = storage.getItem(storage.key(i)!)!;
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('naming', () => {
  it('matches the page script, under a prefix that cannot collide with it', () => {
    expect(sanitizeToolName('quote-form')).toBe('quote_form');
    expect(sanitizeToolName('Newsletter Signup!')).toBe('newsletter_signup');
    expect(sanitizeToolName('  ')).toBe('unnamed_action');
    expect(build([mcgreevy])[0].name).toBe('quote_form_anywhere');
  });

  it('names tools the same however the server ordered the actions', () => {
    const forward = build([mcgreevy, royalOak, newsletter]).map((t) => t.name);
    const reversed = build([newsletter, royalOak, mcgreevy]).map((t) => t.name);
    expect(forward).toEqual(reversed);
  });

  it('numbers two different forms that share a name, deterministically', () => {
    // Same name, different fields: one tool each, and both need a name.
    const other: NxisAction = {
      ...mcgreevy,
      '@id': 'urn:nxis:action:other',
      input: [field('phone')],
      target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}/other.html` },
    };
    const names = build([mcgreevy, other]).map((t) => t.name);
    expect(names).toEqual(['quote_form_anywhere', 'quote_form_anywhere_2']);
    expect(build([other, mcgreevy]).map((t) => t.name)).toEqual(names);
  });
});

describe('grouping the same form repeated across pages', () => {
  it('makes one tool for the repeats, and a separate one for a different form', () => {
    const tools = build([mcgreevy, royalOak, newsletter]);
    expect(tools).toHaveLength(2);
    const quote = tools.find((t) => t.name === 'quote_form_anywhere')!;
    expect(quote.actions).toHaveLength(2);
    expect(tools.find((t) => t.name === 'newsletter_signup_anywhere')!.actions).toHaveLength(1);
  });

  it("uses the form's own field to tell them apart, not an invented one", () => {
    expect(findDiscriminator([mcgreevy, royalOak])).toEqual({
      field: 'business',
      values: ['McGreevy Plumbing', 'Royal Oak Remodeling'],
      fixed: false,
    });
    const quote = build([mcgreevy, royalOak])[0];
    expect(quote.discriminator).toBe('business');
    const business = (quote.definition.inputSchema!.properties as Record<string, never>)['business'];
    expect(business).toMatchObject({ enum: ['McGreevy Plumbing', 'Royal Oak Remodeling'] });
    expect(quote.definition.inputSchema!.required).toContain('business');
    expect(quote.definition.description).toMatch(/McGreevy Plumbing, Royal Oak Remodeling/);
  });

  it('falls back to a field named after the page when no field differs', () => {
    const plain = (page: string): NxisAction => ({
      ...mcgreevy,
      '@id': `urn:nxis:action:${page}`,
      input: [field('full_name')],
      target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}${page}` },
    });
    const tool = build([plain('/listings/one.html'), plain('/listings/two.html')])[0];
    expect(tool.discriminator).toBe('target');
    expect(tool.choices).toEqual(['one', 'two']);
  });

  it('adds no chooser to a form that appears once', () => {
    const tool = build([newsletter])[0];
    expect(tool.discriminator).toBeUndefined();
    expect(tool.definition.inputSchema!.required).toEqual(['email']);
  });

  it('keeps what values mean out of the field label', () => {
    // Surfaces render `description` as the label, so the value map lives in a
    // key of its own — the model still reads it in the serialised schema.
    const labelled: NxisAction = {
      ...newsletter,
      input: [
        field('timeline', {
          description: 'Timeline',
          'nxis:valueOption': [
            { '@type': 'nxis:ValueOption', value: 'this-week', name: 'This week' },
            { '@type': 'nxis:ValueOption', value: 'flexible', name: 'Flexible' },
          ],
        }),
      ],
    };
    const props = build([labelled])[0].definition.inputSchema!.properties as Record<string, never>;
    expect(props['timeline']).toMatchObject({
      description: 'Timeline',
      enum: ['this-week', 'flexible'],
      'nxis:valueLabels': { 'this-week': 'This week', flexible: 'Flexible' },
    });
  });

  it('labels the chooser with the form field it already is', () => {
    const quote = build([mcgreevy, royalOak])[0];
    const business = (quote.definition.inputSchema!.properties as Record<string, never>)['business'];
    // The live data gives `business` no description, so the surface humanises
    // the field name rather than printing a sentence.
    expect(business).not.toHaveProperty('description');
  });

  it('accepts any option the same field offers on any page', () => {
    const tool = build([mcgreevy, royalOak])[0];
    const service = (tool.definition.inputSchema!.properties as Record<string, never>)['service'];
    expect(service).toMatchObject({ enum: ['General Plumbing Repair', 'Kitchen & Bath'] });
  });

  it("defaults to this page's action when the agent is already on one", () => {
    const here = build([mcgreevy, royalOak], `${ORIGIN}/listings/royal-oak.html?utm=x`)[0];
    const business = (here.definition.inputSchema!.properties as Record<string, never>)['business'];
    expect(business).toMatchObject({ default: 'Royal Oak Remodeling' });

    const away = build([mcgreevy, royalOak], `${ORIGIN}/about.html`)[0];
    const noDefault = (away.definition.inputSchema!.properties as Record<string, never>)['business'];
    expect(noDefault).not.toHaveProperty('default');
  });
});

describe('registering', () => {
  it('registers one tool per group and always asks for a confirmation', async () => {
    const mc = new LocalModelContext();
    const names = await registerSiteActionTools(mc, [mcgreevy, royalOak, newsletter]);
    expect(names).toEqual(['newsletter_signup_anywhere', 'quote_form_anywhere']);
    const registered = await mc.getTools();
    expect(registered.every((t) => t.annotations?.readOnlyHint === false)).toBe(true);
  });

  it('leaves a name the registry already holds alone', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool({ name: 'quote_form_anywhere', description: 'Already here', execute: async () => ({ content: [] }) });
    expect(await registerSiteActionTools(mc, [mcgreevy])).toEqual([]);
  });

  it('warns rather than throwing when a registry refuses a tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mc = new LocalModelContext();
    mc.registerTool = () => Promise.reject(new DOMException('Duplicate tool name'));
    expect(await registerSiteActionTools(mc, [mcgreevy])).toEqual([]);
    expect(warn.mock.calls[0][0]).toMatch(/could not register quote_form_anywhere/);
  });

  it('does nothing when the site has no actions', async () => {
    expect(await registerSiteActionTools(new LocalModelContext(), [])).toEqual([]);
  });
});

describe('running one', () => {
  /** A registry holding the page's own tool for an action, as nxis.js registers it. */
  function pageRegistry(name = 'quote_form', annotations?: Record<string, unknown>) {
    const mc = new LocalModelContext();
    const calls: Record<string, unknown>[] = [];
    mc.registerTool({
      name,
      description: 'The page form',
      annotations,
      execute: async (args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: '{"submitted":true}' }] };
      },
    });
    return { mc, calls };
  }

  const run = (mc: LocalModelContext, href: string, args: Record<string, unknown>) =>
    buildSiteActionTools([mcgreevy, royalOak], mc, { href })[0].definition.execute(args);

  it("hands the call to the page's own tool when the form is here", async () => {
    const { mc, calls } = pageRegistry();
    const here = `${ORIGIN}/listings/mcgreevy-plumbing.html`;
    const res = await run(mc, here, { business: 'McGreevy Plumbing', full_name: 'Dana' });
    expect(res.isError).toBeFalsy();
    expect(calls[0]).toEqual({ business: 'McGreevy Plumbing', full_name: 'Dana' });
  });

  it('matches a renamed page tool by action id, where the registry keeps annotations', async () => {
    // An extension or an older polyfill passes custom annotations through; the action id then
    // finds a tool the page registered under a different name.
    const calls: Record<string, unknown>[] = [];
    const keepsAnnotations = {
      getTools: async () => [
        { name: 'renamed_by_the_page', description: 'q', annotations: { [ACTION_ID_HINT]: mcgreevy['@id'] } },
      ],
      executeTool: async (_t: unknown, args: Record<string, unknown>) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as LocalModelContext;
    await run(keepsAnnotations, `${ORIGIN}/listings/mcgreevy-plumbing.html`, { business: 'McGreevy Plumbing' });
    expect(calls).toHaveLength(1);
  });

  it('on a spec registry, which drops custom annotations, a renamed page tool is not found — and says so', async () => {
    // Chrome keeps only the hints it knows. The action id never reaches getTools, so the name is
    // the only link between an action and its page tool, and a page that renames the tool breaks it.
    const { mc, calls } = pageRegistry('renamed_by_the_page', { [ACTION_ID_HINT]: mcgreevy['@id'] });
    const res = await run(mc, `${ORIGIN}/listings/mcgreevy-plumbing.html`, { business: 'McGreevy Plumbing' });
    expect(calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not registered/);
  });

  it('leaves for the right page rather than filling the wrong form', async () => {
    const { mc, calls } = pageRegistry();
    const visited: string[] = [];
    const tool = buildSiteActionTools([mcgreevy, royalOak], mc, {
      href: `${ORIGIN}/listings/mcgreevy-plumbing.html`,
      storage: memoryStorage(),
      navigate: (url) => visited.push(url),
    })[0];

    const res = await tool.definition.execute({ business: 'Royal Oak Remodeling' });
    expect(res.isError).toBeFalsy();
    expect(visited).toEqual([`${ORIGIN}/listings/royal-oak.html`]);
    // The form on this page belongs to a different business.
    expect(calls).toHaveLength(0);
  });

  it('asks which one when the call does not say', async () => {
    const { mc } = pageRegistry();
    const res = await run(mc, `${ORIGIN}/about.html`, { full_name: 'Dana' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('McGreevy Plumbing, Royal Oak Remodeling');
  });

  describe('a choice the tool does not list', () => {
    const hatzel = quoteForm('Hatzel & Sons Plumbing', '/listings/hatzel.html');
    const tool = (findAction: (q: { actionName: string; field: string; value: string }) => Promise<NxisAction | null>) => {
      const visited: string[] = [];
      const storage = memoryStorage();
      const built = buildSiteActionTools([mcgreevy, royalOak], new LocalModelContext(), {
        href: `${ORIGIN}/about.html`,
        storage,
        navigate: (url) => visited.push(url),
        findAction,
      })[0];
      return { built, visited, storage };
    };

    it("looks it up, and carries the call to the page of the form it finds", async () => {
      const asked: unknown[] = [];
      const { built, visited, storage } = tool(async (q) => (asked.push(q), hatzel));
      const res = await built.definition.execute({ business: 'Hatzel & Sons Plumbing', full_name: 'Dana' });
      expect(asked).toEqual([{ actionName: 'quote-form', field: 'business', value: 'Hatzel & Sons Plumbing' }]);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe('Opening Hatzel & Sons Plumbing to submit this…');
      expect(visited).toEqual([`${ORIGIN}/listings/hatzel.html`]);
      // Held for the page it opens, with the values the visitor confirmed.
      const held = JSON.parse(Object.values(storageDump(storage))[0] as string);
      expect(held).toMatchObject({ actionId: hatzel['@id'], values: { business: 'Hatzel & Sons Plumbing', full_name: 'Dana' } });
    });

    it('says plainly when the site has no such form', async () => {
      const { built, visited } = tool(async () => null);
      const res = await built.definition.execute({ business: 'Hatzel & Sons Plumbing' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        'I couldn\'t find a quote form for "Hatzel & Sons Plumbing" on this site. It covers McGreevy Plumbing, Royal Oak Remodeling.',
      );
      expect(visited).toEqual([]);
    });

    it('says the same when the lookup itself fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { built } = tool(async () => {
        throw new Error('rate limited');
      });
      const res = await built.definition.execute({ business: 'Hatzel & Sons Plumbing' });
      expect(res.content[0].text).toMatch(/couldn't find a quote form/);
      warn.mockRestore();
    });
  });

  it('accepts the choice in any casing', async () => {
    const { mc, calls } = pageRegistry();
    await run(mc, `${ORIGIN}/listings/mcgreevy-plumbing.html`, { business: 'mcgreevy plumbing' });
    expect(calls).toHaveLength(1);
  });

  it('reports a page whose own tool has not registered yet', async () => {
    const mc = new LocalModelContext();
    const res = await run(mc, `${ORIGIN}/listings/mcgreevy-plumbing.html`, {
      business: 'McGreevy Plumbing',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not registered on this page yet/);
  });

  it('keeps an added chooser out of the form it fills', async () => {
    const plain = (page: string): NxisAction => ({
      ...mcgreevy,
      '@id': `urn:nxis:action:${page}`,
      input: [field('full_name')],
      target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}${page}` },
    });
    const { mc, calls } = pageRegistry();
    const tool = buildSiteActionTools([plain('/one.html'), plain('/two.html')], mc, {
      href: `${ORIGIN}/one.html`,
    })[0];
    await tool.definition.execute({ target: 'one', full_name: 'Dana' });
    expect(calls[0]).toEqual({ full_name: 'Dana' });
  });
});

describe('one route per action', () => {
  const siteTool = (): ModelContextToolInfo =>
    build([mcgreevy, royalOak])[0].definition as unknown as ModelContextToolInfo;
  const pageTool = (name: string, annotations?: Record<string, unknown>): ModelContextToolInfo =>
    ({ name, annotations }) as ModelContextToolInfo;

  it("hides the page's tool on a page the site tool covers", () => {
    const tools = [siteTool(), pageTool('quote_form'), pageTool('nxis_query')];
    const shown = withoutShadowedTools(tools, `${ORIGIN}/listings/royal-oak.html`);
    expect(shown.map((t) => t.name)).toEqual(['quote_form_anywhere', 'nxis_query']);
  });

  it('keeps a same-named tool on a page the site tool does not cover', () => {
    // Another page's form happens to be called quote_form too: it is not the
    // one the site tool delegates to, so hiding it would lose it.
    const shown = withoutShadowedTools([siteTool(), pageTool('quote_form')], `${ORIGIN}/other.html`);
    expect(shown.map((t) => t.name)).toContain('quote_form');
  });

  it('hides by action id wherever the page records one', () => {
    const tools = [siteTool(), pageTool('anything', { [ACTION_ID_HINT]: royalOak['@id'] })];
    expect(withoutShadowedTools(tools, `${ORIGIN}/other.html`)).toHaveLength(1);
  });

  it('leaves a page with no site tools untouched', () => {
    const tools = [pageTool('quote_form'), pageTool('nxis_query')];
    expect(withoutShadowedTools(tools, `${ORIGIN}/x.html`)).toEqual(tools);
  });

  it('never hides a site tool', () => {
    const shown = withoutShadowedTools([siteTool()], `${ORIGIN}/listings/royal-oak.html`);
    expect(shown[0].annotations?.[SITE_ACTION_HINT]).toBe(true);
  });
});

describe('when the registry keeps only the annotations it recognises', () => {
  // A native modelContext hands back readOnlyHint and drops the rest, so a
  // tool read from getTools() arrives looking like any other write. What this
  // page built is remembered by name, which is what these rely on.
  const stripped = (name: string): ModelContextToolInfo =>
    ({ name, annotations: { readOnlyHint: false } }) as ModelContextToolInfo;

  it('still knows the call is bound for another page', () => {
    const here = `${ORIGIN}/listings/mcgreevy-plumbing.html`;
    const tool = build([mcgreevy, royalOak], here)[0];
    expect(handoffFor(stripped(tool.name), { business: 'Royal Oak Remodeling' }, here)).toMatchObject({
      pageUrl: `${ORIGIN}/listings/royal-oak.html`,
      label: 'Royal Oak Remodeling',
    });
  });

  it('still says nothing when the form is already here', () => {
    const here = `${ORIGIN}/listings/mcgreevy-plumbing.html`;
    const tool = build([mcgreevy, royalOak], here)[0];
    expect(handoffFor(stripped(tool.name), { business: 'McGreevy Plumbing' }, here)).toBeNull();
  });

  it('still hides the page tool it delegates to', () => {
    const here = `${ORIGIN}/listings/royal-oak.html`;
    const tool = build([mcgreevy, royalOak], here)[0];
    const shown = withoutShadowedTools(
      [stripped(tool.name), { name: 'quote_form' } as ModelContextToolInfo],
      here,
    );
    expect(shown.map((t) => t.name)).toEqual([tool.name]);
  });

  it('leaves a tool this page never built alone', () => {
    expect(handoffFor(stripped('something_else'), {}, ORIGIN)).toBeNull();
  });
});

describe('what reaches the prompt', () => {
  /** A distinct form, so each becomes a tool of its own. */
  const form = (name: string, page: string): NxisAction => ({
    '@type': 'InteractAction',
    '@id': `urn:nxis:action:${name}`,
    name,
    description: `The ${name.replace(/-/g, ' ')}.`,
    target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}${page}` },
    input: [field('full_name')],
  });

  const many = [
    form('booking-form', '/services/booking.html'),
    form('contact-form', '/contact.html'),
    form('newsletter-form', '/news.html'),
    form('careers-form', '/careers.html'),
    form('feedback-form', '/feedback.html'),
  ];
  const defs = (actions: NxisAction[], href: string) =>
    buildSiteActionTools(actions, new LocalModelContext(), { href }).map(
      (t) => t.definition as unknown as ModelContextToolInfo,
    );

  it('keeps everything when the site fits in the budget', () => {
    const tools = defs(many, `${ORIGIN}/`);
    expect(selectSiteTools(tools, 'anything', { limit: 8, href: `${ORIGIN}/` })).toEqual(tools);
  });

  it('drops the forms nobody asked about', () => {
    const tools = defs(many, `${ORIGIN}/`);
    const shown = selectSiteTools(tools, 'I want to leave feedback', { limit: 2, href: `${ORIGIN}/` });
    expect(shown).toHaveLength(2);
    expect(shown.map((t) => t.name)).toContain('feedback_form_anywhere');
  });

  it("keeps this page's own form whatever was asked", () => {
    const here = `${ORIGIN}/careers.html`;
    const shown = selectSiteTools(defs(many, here), 'book a visit', { limit: 1, href: here });
    expect(shown.map((t) => t.name)).toEqual(['careers_form_anywhere']);
  });

  it('matches a business named in the request against the choices', () => {
    // The chooser's values are the site's own names for what each action acts
    // on, and naming one is the strongest signal a request can carry.
    const tools = [
      ...defs([mcgreevy, royalOak], `${ORIGIN}/`),
      ...defs(many, `${ORIGIN}/`),
    ];
    const shown = selectSiteTools(tools, 'quote from Royal Oak Remodeling', {
      limit: 1,
      href: `${ORIGIN}/`,
    });
    expect(shown.map((t) => t.name)).toEqual(['quote_form_anywhere']);
  });

  it('never drops a page tool or a retrieval tool', () => {
    const others = [
      { name: 'nxis_query', annotations: { readOnlyHint: true } },
      { name: 'quote_form' },
    ] as ModelContextToolInfo[];
    const shown = selectSiteTools([...others, ...defs(many, `${ORIGIN}/`)], 'hello', {
      limit: 1,
      href: `${ORIGIN}/`,
    });
    expect(shown.slice(0, 2)).toEqual(others);
    expect(shown).toHaveLength(3);
  });

  it('leaves the tools in the order they arrived', () => {
    const tools = defs(many, `${ORIGIN}/`);
    const shown = selectSiteTools(tools, 'contact', { limit: 3, href: `${ORIGIN}/` });
    const order = tools.filter((t) => shown.includes(t));
    expect(shown).toEqual(order);
  });
});

describe('site-wide tool names', () => {
  it("keeps the action's own name in front, so the model can still match it", () => {
    expect(siteToolName('quote-form')).toBe('quote_form_anywhere');
    expect(siteToolName('Newsletter Signup!')).toBe('newsletter_signup_anywhere');
  });

  it('stays within the length a registry accepts', () => {
    expect(siteToolName('a'.repeat(80)).length).toBeLessThanOrEqual(64);
    expect(siteToolName('a'.repeat(80)).endsWith('_anywhere')).toBe(true);
  });
});

describe('the options of the form a call means', () => {
  it("offers only the chosen business's own options, without the form's placeholder", () => {
    const withPlaceholder = quoteForm('McGreevy Plumbing', '/listings/mcgreevy-plumbing.html', ['Choose a service…', 'Drain cleaning', 'Water heaters']);
    const tool = build([withPlaceholder, royalOak])[0].definition as unknown as ModelContextToolInfo;
    expect(formOptions(tool, { business: 'McGreevy Plumbing' })).toEqual({ service: ['Drain cleaning', 'Water heaters'] });
    expect(formOptions(tool, { business: 'Royal Oak Remodeling' })).toEqual({ service: ['Kitchen & Bath'] });
  });

  it('offers nothing to narrow before the call says which form', () => {
    const tool = build([mcgreevy, royalOak])[0].definition as unknown as ModelContextToolInfo;
    expect(formOptions(tool, {})).toEqual({});
  });
});
