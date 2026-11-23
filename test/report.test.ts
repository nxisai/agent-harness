/**
 * Counting the site's forms the agent sends, in the site's Agent Analytics.
 *
 * Every page form runs through `executeRegistered`, so that is where a report
 * starts; which action it was, and when it stays quiet, is checked here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { executeRegistered } from '../src/harness/tools/webmcp';
import { LocalModelContext } from '../src/harness/tools/local-context';
import { reportFor } from '../src/harness/tools/action-tools';
import { rememberReportToken, reportSubmitted, setSiteActionReporter, takeReportToken, type PageFormRun } from '../src/harness/tools/report';
import type { ModelContextToolInfo, ModelContextToolResponse } from '../src/types';
import type { NxisAction } from '../src/webmcp-contract';

const PAGE = 'https://listings.example/listings/royal-oak.html';
const QUOTE_ID = 'https://listings.example/#quote-form';

const quote: NxisAction = {
  '@type': 'https://schema.org/QuoteAction',
  '@id': QUOTE_ID,
  name: 'Quote Form',
  target: { '@type': 'EntryPoint', 'nxis:pageUrl': PAGE } as NxisAction['target'],
};

async function pageTool(opts: { result?: ModelContextToolResponse; fail?: boolean } = {}) {
  const mc = new LocalModelContext();
  mc.registerTool({
    name: 'quote_form',
    description: 'Request a quote',
    inputSchema: { type: 'object', properties: { email: { type: 'string' } } },
    annotations: { 'ai.nxis/actionId': QUOTE_ID },
    execute: async () => {
      if (opts.fail) throw new Error('network down');
      return opts.result ?? { content: [{ type: 'text', text: 'Thanks, we will be in touch.' }] };
    },
  });
  const tool = (await mc.getTools()).find((t) => t.name === 'quote_form') as ModelContextToolInfo;
  return { mc, tool };
}

function recording() {
  const runs: PageFormRun[] = [];
  setSiteActionReporter((r) => void runs.push(r));
  return runs;
}

afterEach(() => setSiteActionReporter(null));

describe('noticing a page form that went through', () => {
  it('reports the run once, by the tool that ran, with nothing the visitor typed', async () => {
    const runs = recording();
    const { mc, tool } = await pageTool();
    await executeRegistered(mc, tool, tool.name, { email: 'pat@example.com' });
    // A spec registry keeps only the standard hints, so the action's id is gone and the name is what's left.
    expect(runs).toEqual([{ toolName: 'quote_form' }]);
    expect(JSON.stringify(runs)).not.toContain('pat@example.com');
  });

  it("carries the action's id when the registry kept it", () => {
    const runs = recording();
    const tool = { name: 'quote_form', annotations: { 'ai.nxis/actionId': QUOTE_ID } } as unknown as ModelContextToolInfo;
    reportSubmitted(tool, tool.name, { content: [] });
    expect(runs).toEqual([{ toolName: 'quote_form', actionId: QUOTE_ID }]);
  });

  it('stays quiet when the form refused the input', async () => {
    const runs = recording();
    const { mc, tool } = await pageTool({ result: { content: [{ type: 'text', text: 'Email is required' }], isError: true } });
    await executeRegistered(mc, tool, tool.name, {});
    expect(runs).toEqual([]);
  });

  it('stays quiet when the form failed outright', async () => {
    const runs = recording();
    const { mc, tool } = await pageTool({ fail: true });
    await expect(executeRegistered(mc, tool, tool.name, {})).rejects.toThrow();
    expect(runs).toEqual([]);
  });

  it('a report that fails never changes the result the visitor sees', async () => {
    setSiteActionReporter(() => Promise.reject(new Error('Tool nxis_track_site_action not found')));
    const { mc, tool } = await pageTool();
    expect((await executeRegistered(mc, tool, tool.name, {})).isError).toBeFalsy();
    setSiteActionReporter(() => {
      throw new Error('not connected');
    });
    await expect(executeRegistered(mc, tool, tool.name, {})).resolves.toBeTruthy();
  });
});

describe('which action a run was', () => {
  it('by id, with its short schema.org type, as the on-page agent', () => {
    expect(reportFor([quote], { toolName: 'anything', actionId: QUOTE_ID }, 'https://listings.example/')).toEqual({
      outcome: 'submitted',
      action_id: QUOTE_ID,
      action_type: 'QuoteAction',
      source: 'on_page_agent',
    });
  });

  it("by name, on the action's own page", () => {
    expect(reportFor([quote], { toolName: 'quote_form' }, PAGE)?.action_id).toBe(QUOTE_ID);
  });

  it('not by name on another page, where the same name is a different form', () => {
    expect(reportFor([quote], { toolName: 'quote_form' }, 'https://listings.example/contact.html')).toBeNull();
  });

  it('a tool with no action behind it is no report', () => {
    expect(reportFor([quote], { toolName: 'search_listings' }, PAGE)).toBeNull();
  });

  it("an id the site's records don't hold still reports, without a type", () => {
    expect(reportFor([], { toolName: 'x', actionId: 'urn:nxis:action:1' })).toEqual({
      outcome: 'submitted',
      action_id: 'urn:nxis:action:1',
      source: 'on_page_agent',
    });
  });
});

describe("the site's token from a handoff link", () => {
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

  it('is held for its action and goes with one report', () => {
    const storage = memoryStorage();
    rememberReportToken(QUOTE_ID, 'tok.sig', storage);
    rememberReportToken('urn:other', 'other.sig', storage);
    expect(takeReportToken(QUOTE_ID, storage)).toBe('tok.sig');
    expect(takeReportToken(QUOTE_ID, storage)).toBeUndefined();
    expect(takeReportToken('urn:other', storage)).toBe('other.sig');
    expect(storage.length).toBe(0);
  });

  it('is simply absent when the session cannot hold it', () => {
    rememberReportToken(QUOTE_ID, 'tok.sig', null);
    expect(takeReportToken(QUOTE_ID, null)).toBeUndefined();
  });
});
