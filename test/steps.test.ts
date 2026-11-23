/**
 * The journey: what the agent is doing, for a surface beside the page.
 *
 * Two things matter beyond the bookkeeping. A step recorded twice updates in
 * place, so `active` becoming `done` does not leave two lines. And the list
 * survives the page change, which is the only reason a copilot surface can
 * explain why it is suddenly on a listing page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginJourney,
  journeySteps,
  onJourneyChange,
  recordStep,
  restoreJourney,
} from '../src/harness/steps';
import { resumePendingAction } from '../src/harness/tools/resume';
import { savePendingAction } from '../src/harness/tools/pending-action';
import { buildSiteActionTools } from '../src/harness/tools/action-tools';
import { LocalModelContext } from '../src/harness/tools/local-context';
import type { NxisAction } from '../src/webmcp-contract';
import type { ModelContextToolInfo } from '../src/types';

const ORIGIN = 'https://listings.example';
const PAGE = `${ORIGIN}/listings/royal-oak.html`;

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

beforeEach(() => beginJourney());
afterEach(() => vi.restoreAllMocks());

describe('the journal', () => {
  it('keeps steps in the order they happened', () => {
    recordStep({ id: 'choose', label: 'Using the quote form', status: 'done' });
    recordStep({ id: 'confirm', label: 'Waiting for you', status: 'active' });
    expect(journeySteps().map((s) => s.id)).toEqual(['choose', 'confirm']);
  });

  it('updates a step in place rather than repeating it', () => {
    recordStep({ id: 'fill', label: 'Filling the form', status: 'active' });
    recordStep({ id: 'fill', label: 'Filled the form', status: 'done' });
    expect(journeySteps()).toHaveLength(1);
    expect(journeySteps()[0]).toMatchObject({ id: 'fill', label: 'Filled the form', status: 'done' });
  });

  it('hands out copies, so a surface cannot edit the journey', () => {
    recordStep({ id: 'choose', label: 'Using the quote form', status: 'done' });
    journeySteps()[0].label = 'something else';
    expect(journeySteps()[0].label).toBe('Using the quote form');
  });

  it('tells listeners what changed, and stops when asked', () => {
    const seen: string[] = [];
    const off = onJourneyChange((step, all) => seen.push(`${step.id}:${all.length}`));
    recordStep({ id: 'choose', label: 'a', status: 'done' });
    recordStep({ id: 'fill', label: 'b', status: 'active' });
    off();
    recordStep({ id: 'submit', label: 'c', status: 'done' });
    expect(seen).toEqual(['choose:1', 'fill:2']);
  });

  it('keeps telling the other listeners when one throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    onJourneyChange(() => {
      throw new Error('a surface blew up');
    });
    onJourneyChange((step) => seen.push(step.id));
    recordStep({ id: 'choose', label: 'a', status: 'done' });
    expect(seen).toEqual(['choose']);
  });

  it('starts clean on a new request', () => {
    recordStep({ id: 'choose', label: 'a', status: 'done' });
    beginJourney();
    expect(journeySteps()).toEqual([]);
  });
});

describe('a journey that crosses a page', () => {
  const quoteForm = (business: string, page: string): NxisAction => ({
    '@type': 'InteractAction',
    '@id': `urn:nxis:action:${business}`,
    name: 'quote-form',
    description: `Request a quote from ${business}.`,
    target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': page },
    input: [
      {
        '@type': 'PropertyValueSpecification',
        valueName: 'business',
        'nxis:valueType': 'string',
        defaultValue: business,
      },
      { '@type': 'PropertyValueSpecification', valueName: 'full_name', 'nxis:valueType': 'string' },
    ],
  });

  const ACTIONS = [
    quoteForm('McGreevy Plumbing', `${ORIGIN}/listings/mcgreevy.html`),
    quoteForm('Royal Oak Remodeling', PAGE),
  ];

  it('carries the steps taken before the navigation', async () => {
    const storage = memoryStorage();
    // What the harness would have recorded before the call travelled.
    recordStep({ id: 'choose', label: 'Using the quote form', status: 'done' });
    recordStep({ id: 'confirm', label: 'You confirmed', status: 'done' });
    recordStep({ id: 'navigate', label: 'Opening Royal Oak Remodeling', status: 'active' });

    const tool = buildSiteActionTools(ACTIONS, new LocalModelContext(), {
      href: `${ORIGIN}/index.html`,
      storage,
      navigate: () => {},
    })[0];
    await tool.definition.execute({ business: 'Royal Oak Remodeling', full_name: 'Dana' });

    // The page changes here: everything in memory is gone.
    beginJourney();
    expect(journeySteps()).toEqual([]);

    const outcome = await resumePendingAction({
      href: PAGE,
      storage,
      timeoutMs: 10,
      registry: async () => new LocalModelContext(),
      pageTool: async () =>
        ({ name: 'quote_form', inputSchema: { type: 'object', properties: {} } }) as ModelContextToolInfo,
      exec: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });

    expect(outcome.status).toBe('submitted');
    const ids = journeySteps().map((s) => s.id);
    // The three from the other page, then this page's own.
    expect(ids).toEqual(['choose', 'confirm', 'navigate', 'arrive', 'fill', 'submit']);
    expect(journeySteps().find((s) => s.id === 'navigate')).toMatchObject({ status: 'done' });
    expect(journeySteps().at(-1)).toMatchObject({ id: 'submit', status: 'done' });
  });

  it('marks the arrival failed when the form is not on the page', async () => {
    const storage = memoryStorage();
    savePendingAction(
      {
        actionId: 'urn:a',
        pageToolName: 'quote_form',
        toolName: 'quote_form_anywhere',
        values: {},
        pageUrl: PAGE,
        steps: [{ id: 'navigate', label: 'Opening Royal Oak Remodeling', status: 'active' }],
      },
      { storage },
    );

    const outcome = await resumePendingAction({
      href: PAGE,
      storage,
      timeoutMs: 10,
      registry: async () => new LocalModelContext(),
      pageTool: async () => null,
    });

    expect(outcome.status).toBe('no-tool');
    expect(journeySteps().at(-1)).toMatchObject({ id: 'arrive', status: 'failed' });
  });
});

describe('what the harness records', () => {
  it('reports each step to the renderer as it happens', async () => {
    const steps: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message() {},
      status() {},
      step: (s: { id: string; status: string }) => steps.push(`${s.id}:${s.status}`),
      confirm: (req: { values: Record<string, unknown>; onSubmit: (v: Record<string, unknown>) => void }) =>
        req.onSubmit(req.values),
      detail() {},
      results() {},
      toolError() {},
    };
    const tool = {
      name: 'quote_form',
      inputSchema: { type: 'object', properties: { full_name: { type: 'string' } } },
      annotations: { readOnlyHint: false },
    };
    const provider = {
      ready: true,
      load: async () => {},
      complete: async () => ({ text: '', call: { name: 'quote_form', args: { full_name: 'Dana' } } }),
    };
    const toolSource = {
      discoverTools: async () => [tool],
      execTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };

    const { AgentHarness } = await import('../src/index');
    const harness = new AgentHarness({ provider, toolSource, renderer } as never);
    await harness.turn('quote please', [] as never);

    expect(steps).toEqual([
      'choose:done',
      'confirm:active',
      'confirm:done',
      'fill:active',
      'fill:done',
      'submit:done',
    ]);
  });

  it('ends the running step when a write fails, and tells the model why', async () => {
    const steps: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message() {},
      status() {},
      step: (s: { id: string; status: string }) => steps.push(`${s.id}:${s.status}`),
      confirm: (req: { values: Record<string, unknown>; onSubmit: (v: Record<string, unknown>) => void }) =>
        req.onSubmit(req.values),
      detail() {},
      results() {},
      toolError() {},
    };
    const tool = {
      name: 'quote_form',
      inputSchema: { type: 'object', properties: { full_name: { type: 'string' } } },
      annotations: { readOnlyHint: false },
    };
    const provider = {
      ready: true,
      load: async () => {},
      complete: async () => ({ text: '', call: { name: 'quote_form', args: { full_name: 'Dana' } } }),
    };
    const toolSource = {
      discoverTools: async () => [tool],
      execTool: async () => ({ content: [{ type: 'text', text: 'The office is closed.' }], isError: true }),
    };
    let seen: { role: string; content: string }[] = [];

    const { AgentHarness } = await import('../src/index');
    const harness = new AgentHarness({ provider, toolSource, renderer, onMessages: (m: never) => (seen = [...m]) } as never);
    await harness.turn('quote please', [] as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(steps.slice(-2)).toEqual(['fill:active', 'fill:failed']);
    expect(seen.at(-1)).toEqual({ role: 'user', content: '[quote_form did not go through]', data: 'The office is closed.' });
  });
});
