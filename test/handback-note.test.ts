// @vitest-environment jsdom
/**
 * A person's hand-back note reaches the visitor. In a real test run the team closed a thread with a note ("!close
 * Quick close test") and the page showed only the target's fixed goodbye and "Back with the assistant": the note went
 * to the model only. Now a person target's note is drawn for the visitor, as text, before the references and
 * "Back with the assistant", and still reaches the model as data.
 */
import './helpers/lit-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from './helpers/lit-dom';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, type A2AStreamResponse } from '../src/handoff/index';
import type { ModelContextTool } from '../src/types';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });

let task = 0;
function turn(parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] {
  const id = `n${++task}`;
  return [
    { task: { id, contextId: `c${task}`, status: { state: 'TASK_STATE_WORKING' } } },
    { statusUpdate: { taskId: id, contextId: `c${task}`, status: { state, message: { messageId: `m${task}`, role: 'ROLE_AGENT', parts } } } } as any,
  ];
}

function relay(script: Record<string, A2AStreamResponse[][]>) {
  const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (String(u) !== '/api/handoff') return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({
          targets: [
            { name: 'quote', kind: 'agent', label: 'Get a quote', available: true },
            { name: 'team', kind: 'person', label: 'Our team', available: true },
          ],
        }),
      );
    }
    const target = String(u).split('/').pop()!;
    const body = JSON.parse(String(init.body));
    const events = (script[target] ?? []).shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': `k-${target}` },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

async function handBack(target: 'team' | 'quote', handback: Record<string, unknown>, goodbye = "Thanks for your patience.") {
  const r = relay({ [target]: [turn([{ text: goodbye }, ext({ handoff: 'handback', ...handback })], 'TASK_STATE_COMPLETED')] });
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  el.modelProvider = { name: 'Stub', local: false, ready: true, loading: false, load: async () => {}, complete: vi.fn(async () => ({ text: 'From the model.' })) };
  document.body.append(el);
  const registered: ModelContextTool[] = [];
  const mc = { getTools: async () => registered, registerTool: async (t: ModelContextTool) => void registered.push(t), addEventListener() {}, removeEventListener() {}, executeTool: (t: any, args: any) => registered.find((x) => x.name === (t?.name ?? t))!.execute(args, undefined as never) };
  el.toolSource.modelContext = () => mc;
  el.handoff = { relay: '/api/handoff', targets: { quote: { kind: 'agent', label: 'Get a quote' }, team: { kind: 'person', label: 'Our team' } }, fetchImpl: r.fetchImpl };
  await el._registerHandoff();
  const tool = registered.find((t) => t.name === (target === 'team' ? 'talk_to_a_person' : 'transfer_to_agent'))!;
  await tool.execute({ target, reason: 'r', summary: 's' } as never, undefined as never);
  const root = el.shadowRoot as ShadowRoot;
  await until(() => [...root.querySelectorAll('.handoff-note')].some((n) => n.textContent?.includes('Back with the assistant')), 3000);
  const notes = [...root.querySelectorAll<HTMLElement>('.handoff-note')].map((n) => n.textContent);
  const conv = el._active();
  const data = conv.messages.find((m: any) => /handed the conversation back/.test(m.content))?.data;
  return { root, notes: notes.slice(notes.findIndex((t) => !/Connecting|talking with/.test(t ?? ''))), data };
}

describe("a person's hand-back note, for the visitor", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).CSS ??= { escape: (s: string) => s };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows a close note, then the references, then Back with the assistant; the model still reads it as data', async () => {
    const { notes, data } = await handBack('team', { outcome: 'resolved', note: 'Booked for 2pm', references: [{ label: 'Reference', value: 'CL-42' }] });
    expect(notes).toEqual(['Our team closed this conversation: Booked for 2pm', 'Reference: CL-42', 'Back with the assistant']);
    expect(data).toBe('resolved\nBooked for 2pm\nReference: CL-42');
  }, 15000);

  it('has its own wording for a pass', async () => {
    const { notes } = await handBack('team', { outcome: 'transferred', note: 'Try the returns page', references: [] });
    expect(notes).toEqual(['Our team passed you back: Try the returns page', 'Back with the assistant']);
  }, 15000);

  it('keeps the wording it had when there is no note', async () => {
    for (const note of ['', '   ', undefined]) {
      const { notes } = await handBack('team', { outcome: 'resolved', note, references: [] });
      expect(notes).toEqual(['Back with the assistant']);
      document.body.innerHTML = '';
      localStorage.clear();
    }
  }, 15000);

  it('draws the note as text, never as markup', async () => {
    const note = '<img src=x onerror="alert(1)"><b>Booked</b>';
    const { root, notes } = await handBack('team', { outcome: 'resolved', note, references: [] });
    expect(notes[0]).toBe(`Our team closed this conversation: ${note}`);
    expect(root.querySelector('.handoff-note img, .handoff-note b')).toBeNull();
  }, 15000);

  it("leaves an agent's note to the model: it is written for the assistant", async () => {
    const { notes, data } = await handBack('quote', { outcome: 'resolved', note: 'Quote sent. The visitor may book later.', references: [] }, 'Your quote is on its way.');
    expect(notes).toEqual(['Back with the assistant']);
    expect(data).toContain('Quote sent.');
  }, 15000);
});
