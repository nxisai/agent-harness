// @vitest-environment jsdom
/**
 * A seventh real test run of the page's assistant (scripted: no real model is called).
 *
 * - The results card said "Open now · 24/7" for the business while its owner's opening hours say Monday to Friday
 *   7 a.m. to 6 p.m., Saturday 7 a.m. to 1 p.m., closed Sunday. A site's proxy now sends those hours with its policy
 *   copy; the card's status for the business reads them, in the business's time zone. Its emergency service keeps
 *   its own 24/7.
 * - Asked to pass something to the team, an agent handed back and nothing offered the team. A hand-back's `next`
 *   for a person target now draws the team's Hand over card at once, as it does for an agent.
 */
import './helpers/lit-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepAll, until } from './helpers/lit-dom';
import '../src/ui/agent';
import { attach } from '../src/guardrails/remote';
import { createGuardrails } from '../src/guardrails/index';
import { settingsFor } from '../src/guardrails/defaults';
import { glob } from '../src/guardrails/tools';
import { hoursStatus, isEmergencyRecord, readOpeningHours, type OpeningHours } from '../src/harness/opening-hours';
import { HANDOFF_EXTENSION, type A2AStreamResponse } from '../src/handoff/index';
import type { ModelContextTool } from '../src/types';

const HOURS: OpeningHours = {
  timeZone: 'America/Chicago',
  weekly: { mon: [['07:00', '18:00']], tue: [['07:00', '18:00']], wed: [['07:00', '18:00']], thu: [['07:00', '18:00']], fri: [['07:00', '18:00']], sat: [['07:00', '13:00']] },
  closed: ['2026-11-26'],
};
/** Round the clock every day: what the site's records give the business. */
const ALL_DAY = [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' }];
const SITE = 'https://copperline.example';
const BIZ = { '@id': `${SITE}/#business`, '@type': 'HVACBusiness', name: 'Copperline Home Services', address: { '@type': 'PostalAddress', addressLocality: 'Chicago' }, openingHoursSpecification: ALL_DAY };
const SOS = { '@id': `${SITE}/#emergency`, '@type': 'EmergencyService', name: 'Copperline Home Services — 24-hour emergency service', address: { '@type': 'PostalAddress', addressLocality: 'Chicago', streetAddress: '1 Main St' }, openingHoursSpecification: ALL_DAY };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe("the owner's opening hours", () => {
  it('are read strictly from the copy', () => {
    expect(readOpeningHours(HOURS)).toEqual(HOURS);
    for (const bad of [null, 'x', { timeZone: 'Nowhere/Else', weekly: HOURS.weekly }, { timeZone: 'America/Chicago', weekly: { mon: [['18:00', '07:00']] } }, { timeZone: 'America/Chicago', weekly: {} }])
      expect(readOpeningHours(bad)).toBeNull();
  });

  it("say open or not in the business's time zone, whatever the visitor's", () => {
    // Tuesday 11:00 a.m. in Chicago is 17:00 UTC, and Wednesday 2 a.m. in Tokyo.
    expect(hoursStatus(HOURS, new Date('2026-11-24T17:00:00Z')).label).toBe('Open now · until 6pm');
    // Tuesday 7 p.m. in Chicago: opens Wednesday 7 a.m.
    expect(hoursStatus(HOURS, new Date('2026-11-25T01:00:00Z'))).toEqual({ open: false, label: 'Opens 7am', always: false });
    // Saturday 2 p.m.: closed Sunday, so Monday.
    expect(hoursStatus(HOURS, new Date('2026-11-28T20:00:00Z')).label).toBe('Opens Mon 7am');
    // Wednesday 7 p.m.: Thursday is a closed date, so Friday.
    expect(hoursStatus(HOURS, new Date('2026-11-26T01:00:00Z')).label).toBe('Opens Fri 7am');
  });

  it('come from the proxy’s policy copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 1, version: 'v1', prompt: 'proxy', openingHours: HOURS }), { headers: { ETag: '"a"' } })));
    const g = createGuardrails({});
    await attach(g, '/api/agent', { settingsFor, glob });
    expect(g.remote?.openingHours).toEqual(HOURS);
    expect(g.remote?.held).toBe(true);
  });

  it('set the results card’s status for the business; its emergency service keeps 24/7', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T17:00:00Z'), toFake: ['Date'] });
    try {
      vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const el = document.createElement('nxis-agent') as any;
      el.setAttribute('preload', 'none');
      el.setAttribute('discover', 'false');
      document.body.append(el);
      const show = () => {
        const body = { results: [BIZ, SOS] };
        el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body });
        return el._active().items.at(-1).cards as { title: string; status?: { label: string }; emergency?: boolean }[];
      };
      // Without them: the records' 24/7, as before.
      expect(show()[0].status?.label).toBe('Open now · 24/7');
      el._g = { remote: { merge: (c: unknown) => c, openingHours: HOURS } };
      const [biz, sos] = show();
      expect(biz.status?.label).toBe('Open now · until 6pm');
      expect(biz.emergency).toBe(false);
      expect(sos.status?.label).toBe('Open now · 24/7');
      expect(isEmergencyRecord(SOS)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The team, offered from a hand-back ──────────────────────────────────────

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const NEXT = { target: 'team', reason: 'Wants to talk to a person', summary: 'The visitor asked: "Please pass this to your team."' };
let task = 0;
function turn(parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] {
  const id = `t${++task}`;
  return [
    { task: { id, contextId: `c${task}`, status: { state: 'TASK_STATE_WORKING' } } },
    { statusUpdate: { taskId: id, contextId: `c${task}`, status: { state, message: { messageId: `m${task}`, role: 'ROLE_AGENT', parts } } } } as any,
  ];
}

function relay(script: Record<string, A2AStreamResponse[][]>, available = true) {
  const posts: { target: string; method: string; params: any }[] = [];
  const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (String(u) !== '/api/handoff') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ targets: [{ name: 'support', kind: 'agent', label: 'Copperline Support', available: true }, { name: 'team', kind: 'person', label: 'Our team', available }] }));
    }
    const target = String(u).split('/').pop()!;
    const body = JSON.parse(String(init.body));
    posts.push({ target, method: body.method, params: body.params });
    const events = (script[target] ?? []).shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': `k-${target}` } });
  }) as unknown as typeof fetch;
  const envelopes = () => posts.filter((p) => p.method === 'SendStreamingMessage' && !p.params.message.taskId).map((p) => ({ target: p.target, ...p.params.message.parts.find((x: any) => x.data?.handoff === 'envelope')?.data }));
  return { fetchImpl, envelopes };
}

async function element(r: ReturnType<typeof relay>) {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  const complete = vi.fn(async () => ({ text: 'From the model.' }));
  el.modelProvider = { name: 'Stub', local: false, ready: true, loading: false, load: async () => {}, complete };
  document.body.append(el);
  const registered: ModelContextTool[] = [];
  const mc = { getTools: async () => registered, registerTool: async (t: ModelContextTool) => void registered.push(t), addEventListener() {}, removeEventListener() {}, executeTool: (t: any, args: any) => registered.find((x) => x.name === (t?.name ?? t))!.execute(args, undefined as never) };
  el.toolSource.modelContext = () => mc;
  el.handoff = { relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Copperline Support' }, team: { kind: 'person', label: 'Our team' } }, fetchImpl: r.fetchImpl };
  await el._registerHandoff();
  const handTo = (target: string) => registered.find((t) => t.name === 'transfer_to_agent')!.execute({ target, reason: 'r', summary: 's' } as never, undefined as never);
  return { el, root: el.shadowRoot as ShadowRoot, handTo, complete };
}
const buttons = (root: ShadowRoot, label: string) => deepAll<HTMLButtonElement>(root, 'button').filter((b) => b.textContent?.trim() === label);
const handBack = () => [turn([{ text: "I'll pass you back to the assistant, who can put you in touch with the team." }, ext({ handoff: 'handback', outcome: 'transferred', note: 'Visitor wants a person.', next: NEXT })], 'TASK_STATE_COMPLETED')];

describe("a hand-back's next for the team", () => {
  beforeEach(() => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).CSS ??= { escape: (s: string) => s };
  });

  it("draws the team's hand-over card (Connect me) at once, without the model, and hands over to the team on the press", async () => {
    const r = relay({ support: handBack(), team: [turn([{ text: 'Thanks, someone will be with you shortly.' }])] });
    const { root, handTo, complete } = await element(r);
    await handTo('support');
    await until(() => buttons(root, 'Connect me').length, 3000);
    expect(complete).not.toHaveBeenCalled();
    const card = buttons(root, 'Connect me')[0].closest('[data-action]')!;
    expect(card.textContent).toMatch(/team/);
    buttons(root, 'Connect me')[0].click();
    await until(() => r.envelopes().length > 1, 2000);
    expect(r.envelopes()[1]).toMatchObject({ target: 'team', reason: NEXT.reason, summary: NEXT.summary });
  }, 15000);

  it('offers nothing while the team is away: the assistant reads the note', async () => {
    const r = relay({ support: handBack() }, false);
    const { el, root, handTo } = await element(r);
    await handTo('support');
    await until(() => !el._handoff.active(el._activeId));
    await new Promise((res) => setTimeout(res, 100));
    expect(buttons(root, 'Connect me')).toHaveLength(0);
  });
});
