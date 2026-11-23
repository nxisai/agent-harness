/**
 * Arriving from the NxisAI app with a link that names one of the page's forms.
 *
 * A link can be written by anyone, so what matters is what it can and cannot
 * do: choose a form on this page by its action's id, and leave a few words
 * for the person to send. Never speak for them, never stay in the address.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildSiteActionTools, siteFormFor } from '../src/harness/tools/action-tools';
import type { NxisAction } from '../src/webmcp-contract';
import {
  cleanIntent,
  findHandoffForm,
  startFormMessage,
  handoffUrl,
  MAX_INTENT,
  readInboundHandoff,
  startMessage,
  takeInboundHandoff,
  withoutHandoff,
} from '../src/harness/tools/inbound';
import { LocalModelContext } from '../src/harness/tools/local-context';
import type { ModelContextToolInfo } from '../src/types';

const PAGE = 'https://listings.example/listings/mcmanus-electric.html';
const ACTION = 'urn:nxis:action:c06462d35834f59ab47affdc97b6bc54';

describe('reading a handoff', () => {
  it("reads the site's report token, and takes it out of the address with the rest", () => {
    const href = `${handoffUrl(PAGE, ACTION)}&nxis_report=eyJ2IjoxfQ.c2ln-_`;
    expect(readInboundHandoff(href)).toEqual({ actionId: ACTION, reportToken: 'eyJ2IjoxfQ.c2ln-_' }); // gitleaks:allow: a made-up token, base64 of {"v":1} then "sig"
    expect(withoutHandoff(`${PAGE}?ref=ads&nxis_handoff=${encodeURIComponent(ACTION)}&nxis_report=t.s`)).toBe(`${PAGE}?ref=ads`);
  });

  it('ignores a report token that is not one', () => {
    expect(readInboundHandoff(`${handoffUrl(PAGE, ACTION)}&nxis_report=${encodeURIComponent('<script>')}`)).toEqual({ actionId: ACTION });
    expect(readInboundHandoff(`${handoffUrl(PAGE, ACTION)}&nxis_report=${'a'.repeat(1025)}`)).toEqual({ actionId: ACTION });
  });

  it('reads the action and the intent', () => {
    const href = handoffUrl(PAGE, ACTION, 'a quote for a panel upgrade');
    expect(readInboundHandoff(href)).toEqual({ actionId: ACTION, intent: 'a quote for a panel upgrade' });
  });

  it('is absent without the parameter, and refuses a value that is not an id', () => {
    expect(readInboundHandoff(PAGE)).toBeNull();
    expect(readInboundHandoff(`${PAGE}?nxis_handoff=`)).toBeNull();
    expect(readInboundHandoff(`${PAGE}?nxis_handoff=${encodeURIComponent('urn:x two words')}`)).toBeNull();
    expect(readInboundHandoff(`${PAGE}?nxis_handoff=${'a'.repeat(513)}`)).toBeNull();
    expect(readInboundHandoff('not a url')).toBeNull();
  });

  it("leaves the page's own address alone: its parameters' encoding, and its fragment", () => {
    // Some sites route in the fragment, and a page is found by its exact address.
    const routed = 'https://spa.example/?q=a%20b#/listings/mcmanus';
    const href = handoffUrl(routed, ACTION, 'a quote');
    expect(href.startsWith('https://spa.example/?q=a%20b&nxis_handoff=')).toBe(true);
    expect(new URL(href).hash).toBe('#/listings/mcmanus');
    expect(withoutHandoff(href)).toBe(routed);
    // In the fragment it is not a handoff: that is the site's.
    expect(readInboundHandoff(`${PAGE}#nxis_handoff=${ACTION}`)).toBeNull();
  });

  it('keeps the intent to one short line', () => {
    expect(cleanIntent('line one\nline two\t\u0007end')).toBe('line one line two end');
    const long = cleanIntent('x'.repeat(500));
    expect(long.length).toBe(MAX_INTENT);
    expect(long.endsWith('…')).toBe(true);
    expect(readInboundHandoff(`${PAGE}?nxis_handoff=${ACTION}&nxis_intent=%20%0A%20`)).toEqual({ actionId: ACTION });
  });
});

describe('taking a handoff', () => {
  it('takes it out of the address and keeps everything else', () => {
    const replace = vi.fn();
    const href = handoffUrl(`${PAGE}?ref=ads`, ACTION, 'a quote');
    expect(takeInboundHandoff({ href, replace })?.actionId).toBe(ACTION);
    expect(replace).toHaveBeenCalledWith(`${PAGE}?ref=ads`);
  });

  it('leaves an address without one alone', () => {
    const replace = vi.fn();
    expect(takeInboundHandoff({ href: `${PAGE}?ref=ads`, replace })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(withoutHandoff(`${PAGE}?ref=ads`)).toBe(`${PAGE}?ref=ads`);
  });
});

describe('the words that start the form', () => {
  const named = (name: string) => ({ name, inputSchema: { type: 'object' } }) as ModelContextToolInfo;

  it("are the agent's own, from the form's name", () => {
    expect(startMessage(named('quote_form'))).toBe('Start the quote form');
    expect(startMessage(named('booking'))).toBe('Start the booking form');
  });
});

describe('finding the form', () => {
  const tool = (id: string) =>
    ({ name: 'quote_form', inputSchema: { type: 'object' }, annotations: { 'ai.nxis/actionId': id } }) as unknown as ModelContextToolInfo;

  it("finds the page's tool by the action's id", async () => {
    const mc = new LocalModelContext();
    const out = await findHandoffForm(
      { actionId: ACTION },
      { timeoutMs: 50, registry: async () => mc, pageTool: async (_c, ref) => (ref.id === ACTION ? tool(ACTION) : null) },
    );
    expect(out).toEqual({ status: 'ready', tool: tool(ACTION) });
  });

  it('never matches by name: another form of the same name is not this one', async () => {
    const mc = new LocalModelContext();
    const seen: { id: string; name: string }[] = [];
    const out = await findHandoffForm(
      { actionId: ACTION },
      { timeoutMs: 50, registry: async () => mc, pageTool: async (_c, ref) => (seen.push(ref), null) },
    );
    expect(out.status).toBe('no-tool');
    expect(seen).toEqual([{ id: ACTION, name: '' }]);
  });

  it('says so when the page has no agent tools', async () => {
    const out = await findHandoffForm({ actionId: ACTION }, { timeoutMs: 50, registry: async () => null });
    expect(out.status).toBe('no-registry');
  });
});

describe("the site's own form for a linked action", () => {
  // As the listings demo has them: one quote form per business, reached from any page.
  const quote = (business: string, page: string): NxisAction => ({
    '@type': 'QuoteAction',
    '@id': `urn:nxis:action:${page}`,
    name: 'quote-form',
    target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `https://listings.example${page}` },
    input: [
      { '@type': 'PropertyValueSpecification', valueName: 'business', defaultValue: business, 'nxis:valueType': 'string' },
      { '@type': 'PropertyValueSpecification', valueName: 'full_name', valueRequired: true, 'nxis:valueType': 'string' },
    ],
  });

  it('is found by the action id, for the business that action belongs to', () => {
    buildSiteActionTools(
      [quote('McManus Electric', '/listings/mcmanus.html'), quote('Sparkwise Electrical', '/listings/sparkwise.html')],
      new LocalModelContext(),
      { href: 'https://listings.example/listings/mcmanus.html' },
    );
    const form = siteFormFor('urn:nxis:action:/listings/sparkwise.html');
    expect(form?.choice).toBe('Sparkwise Electrical');
    // The call that opens this business's form, made without the model.
    expect(form?.args).toEqual({ business: 'Sparkwise Electrical' });
    expect(form && startFormMessage(form.noun, form.choice)).toBe('Get a quote from Sparkwise Electrical');
    expect(siteFormFor('urn:nxis:action:not-here')).toBeNull();
  });

  it("starts in the words a result card's button uses", () => {
    expect(startFormMessage('quote form', 'McManus Electric')).toBe('Get a quote from McManus Electric');
    expect(startFormMessage('booking', 'Trattoria Rosa')).toBe('Start the booking form for Trattoria Rosa');
    expect(startFormMessage('quote form')).toBe('Start the quote form');
  });
});
