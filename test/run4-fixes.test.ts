// @vitest-environment happy-dom
/**
 * A fourth real test run of the page's assistant (scripted models: no real model is called).
 *
 * - "Do you service Norridge?" drew a Hand over offer: the agent handoff tool now says a question about the business
 *   is answered from the site's records, not handed over.
 * - After the visitor pressed Not now, the next reply said "Earlier I also passed a note to our quote team": a
 *   declined card is now written into the conversation, so the model reads that nothing was sent.
 * - The retried service-area answer had no citation: the turn read no records, as the model answered from those it
 *   read earlier in the conversation. Those now cite it.
 * - A reload closed the panel: it opens again when it was open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHarness } from '../src/index';
import type { Completion, ModelProvider } from '../src/index';
import type { ChatMessage } from '../src/types';
import { handoffToolInfo } from '../src/handoff/tools';
import '../src/ui/agent';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const AGENTS = [
  { name: 'quote', kind: 'agent', label: 'Get a quote', brief: 'Takes a quote request. Collects the address.', available: true },
  { name: 'booking', kind: 'agent', label: 'Book a visit', available: true },
] as any[];

describe('the agent handoff tool', () => {
  it('is for doing something a specialist does, never for a question about the business', () => {
    const { description } = handoffToolInfo('agent', AGENTS);
    expect(description).toContain('Use only when the visitor asks to do something one of these does:');
    expect(description).toContain("Not for a question about the business (whether it serves a place, its services, prices or hours): answer that from the site's records.");
    expect(description).not.toMatch(/needs something one of these handles/);
  });
});

describe('a handoff the visitor declines', () => {
  it('is written into the conversation as not sent, so the next turn cannot say it was', async () => {
    const tool = { ...handoffToolInfo('agent', AGENTS), execute: vi.fn() };
    const calls: Completion[] = [{ text: '', call: { name: 'transfer_to_agent', args: { target: 'quote', reason: 'Asks about the service area', summary: 'Do you service Norridge?' } } } as any];
    const provider: ModelProvider = { name: 'scripted', local: false, ready: true, loading: false, complete: async () => calls.shift() ?? ({ text: 'Yes, both.' } as any) };
    let cancel!: () => void;
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message() {},
      status() {},
      results() {},
      detail() {},
      toolError() {},
      dismissPrompt() {},
      stoppable() {},
      confirm: (r: { onCancel: () => void }) => (cancel = r.onCancel),
      ask: (r: { onCancel: () => void }) => (cancel = r.onCancel),
    } as never;
    const harness = new AgentHarness({ provider, renderer, toolSource: { discoverTools: async () => [tool] } as never });
    const messages: ChatMessage[] = [];
    await harness.turn('Do you service Norridge? What about Evanston?', messages);
    expect(cancel).toBeTypeOf('function');
    cancel();
    const note = messages.find((m) => m.content === '[transfer_to_agent was not sent]');
    expect(note?.data).toMatch(/pressed Not now \(or Cancel\) on the card, so nothing was sent or handed over\. Never say it was\./);
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe('an answer from records read earlier in the conversation', () => {
  const SITE = 'https://copperline.example';
  const AREA = ['Chicago', 'Oak Park', 'Evanston', 'Norridge'];
  const RECORDS = [{ '@id': `${SITE}/services/drains#offer`, '@type': 'Offer', name: 'Drain and sewer rodding', areaServed: AREA }];

  it('is cited from them when the turn reads none', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    // The first turn reads the records.
    el._turnSources = [];
    el._noteSources({ content: [{ type: 'text', text: JSON.stringify({ results: RECORDS }) }], structuredContent: { results: RECORDS } });
    // A later turn reads nothing: what it answers from is what the conversation read.
    el._turnSources = [];
    expect(el._earlierSources().map((s: any) => s.card['@id'])).toEqual([`${SITE}/services/drains#offer`]);
    // Another conversation has read nothing.
    el._newConversation?.(false);
    expect(el._earlierSources()).toEqual([]);
  });
});

describe('a reload', () => {
  const make = () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };

  it('opens the panel again when it was open, and not when it was closed', () => {
    const first = make();
    expect(first.isOpen).toBe(false);
    first.open();
    first.remove();
    const again = make();
    expect(again.isOpen).toBe(true);
    again.close();
    again.remove();
    expect(make().isOpen).toBe(false);
  });

  it('a contained preview never does', () => {
    sessionStorage.setItem('nxis-agent-open', '1');
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('contained', '');
    el.setAttribute('preload', 'none');
    document.body.append(el);
    expect(el.isOpen).toBe(false);
  });
});
