// @vitest-environment happy-dom
/**
 * A remote agent's answer drawn as cards: a scripted target sends a text part and an `answer` part, and the thread
 * shows the reply with its links, the language note above it, and its sources from renderer-spec cards (Read or
 * Watch and "Their page", "From the page"), as the numbered Sources list (see inline-cites.test.ts). Card fields are
 * data throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import {
  HANDOFF_EXTENSION,
  HandoffController,
  buildEnvelope,
  readAnswer,
  type A2AStreamResponse,
  type CardRecord,
  type HandoffAnswer,
  type HandoffEvent,
} from '../src/handoff/index';
import { allowedLink, atTime, citeView, citeViews, linkNodes, withoutNote } from '../src/ui/remote-answer';
import { citeCards, resultsAnswer } from '../src/ui/result-pick';
import { openTarget } from '../src/harness/tools/open-target';

const HERE = 'https://help.example/support/filters';
const P = { here: HERE };

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });

const howTo: CardRecord = {
  '@id': 'https://help.example/help/x200-filter#howto',
  '@type': 'HowTo',
  name: 'Replacing the X200 filter',
  url: 'https://help.example/help/x200-filter',
  publisher: { '@type': 'Organization', name: 'Ridgeline' },
};
const faq: CardRecord = {
  '@id': 'https://help.example/help/faq#faq',
  '@type': 'FAQPage',
  name: 'Filter FAQ',
  url: 'https://help.example/help/faq',
  focus: { path: 'mainEntity[2]', label: 'Can I wash the filter?', url: 'https://help.example/help/faq#wash' },
};
const clip: CardRecord = {
  '@id': 'https://help.example/videos/x200#video',
  '@type': 'VideoObject',
  name: 'Replacing the X200 filter',
  url: 'https://www.youtube.com/watch?v=abc123',
  duration: 'PT6M30S',
  thumbnailUrl: 'https://i.ytimg.example/abc123.jpg',
  focus: { path: 'hasPart[1]', label: 'Removing the cover', startOffset: 134 },
};
const page: CardRecord = {
  '@id': 'https://help.example/warranty#webpage',
  '@type': 'WebPage',
  name: 'Warranty',
  url: 'https://help.example/warranty',
  citation: 'page',
};
const profile: CardRecord = { '@id': 'https://help.example/team/patel#profile', '@type': 'ProfilePage', name: 'Dr Asha Patel', url: 'https://help.example/team/patel' };

const answer = (cards: CardRecord[], extra: Partial<HandoffAnswer> = {}): HandoffAnswer => ({ answerId: 'a-1', cards, cites: cards.map((c, i) => ({ claim: i, id: c['@id'] })), ...extra });

const buttons = (el: Element) => [...el.querySelectorAll('.ra-actions a, .ra-actions button, a.ra-btn')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('the answer part', () => {
  it('reads cards and cites, keeping only the fields a card is drawn from', () => {
    const a = readAnswer([
      { text: 'Here is how.' },
      ext({
        handoff: 'answer',
        answerId: 'a-9',
        note: '  This answer is in German.  ',
        cards: [
          { ...howTo, potentialAction: { '@type': 'QuoteAction' }, script: '<script>alert(1)</script>' },
          { '@type': 'HowTo', name: 'No id' },
          { '@id': 'x', '@type': ['FAQPage', 7, 'WebPage'], focus: { label: 'Q', startOffset: -3 }, citation: 'quoted' },
          'not a card',
        ],
        cites: [{ claim: 0, id: howTo['@id'], path: 'step[3]' }, { claim: 'one', id: 'x' }, { claim: 1 }],
      }),
    ])!;
    expect(a.answerId).toBe('a-9');
    expect(a.note).toBe('This answer is in German.');
    expect(a.cards).toHaveLength(2);
    expect(a.cards[0]).toEqual(howTo);
    expect(a.cards[1]).toEqual({ '@id': 'x', '@type': ['FAQPage', 'WebPage'], focus: { path: '', label: 'Q' } });
    expect(a.cites).toEqual([{ claim: 0, id: howTo['@id'], path: 'step[3]' }]);
  });

  it('is read from an unmarked part too, since some servers drop part metadata, and is null without one', () => {
    expect(readAnswer([{ data: { handoff: 'answer', answerId: 'a', cards: [faq] } }])?.cards).toHaveLength(1);
    expect(readAnswer([{ text: 'Just words.' }])).toBeNull();
    expect(readAnswer([ext({ handoff: 'answer', cards: [] })])).toBeNull();
  });

  it('keeps data as data: nested objects small, no prototype keys, no functions', () => {
    const evil = JSON.parse('{"@id":"y","@type":"Article","author":{"__proto__":{"polluted":true},"name":"A","deep":{"a":{"b":{"c":1}}}}}');
    const a = readAnswer([ext({ handoff: 'answer', answerId: 'a', cards: [evil] })])!;
    expect(a.cards[0].author).toEqual({ name: 'A' });
    expect(Object.prototype.hasOwnProperty.call(a.cards[0].author, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the envelope', () => {
  it('declares that this page draws answer cards, and does not list it as shared', () => {
    const env = buildEnvelope({ target: 'support', reason: 'r', summary: 's', conversationId: 'c', page: { url: HERE, title: 'Filters' }, locale: 'en', origin: 'https://help.example' });
    expect(env.ui).toEqual({ cards: 2, feedback: 1 });
    expect(env.consent.shared).not.toContain('ui');
  });
});

describe('a scripted remote agent', () => {
  it('sends its answer part with its reply, and the controller reports both', async () => {
    const events: A2AStreamResponse[] = [
      { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } },
      {
        statusUpdate: {
          taskId: 't1',
          contextId: 'c1',
          status: {
            state: 'TASK_STATE_INPUT_REQUIRED',
            message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: '1. Turn it off.\n2. Lift the cover.' }, ext({ handoff: 'answer', answerId: 'a-1', cards: [howTo], cites: [{ claim: 0, id: howTo['@id'] }] })] },
          },
        },
      },
    ];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ targets: [{ name: 'support', kind: 'agent', label: 'Help', available: true, transcript: false }] }));
      const body = JSON.parse(String(init.body));
      return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const controller = new HandoffController({ relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl, storage: null });
    const got: HandoffEvent[] = [];
    controller.addEventListener('handoff', (e) => got.push((e as CustomEvent<HandoffEvent>).detail));
    await controller.start('conv-1', 'support', buildEnvelope({ target: 'support', reason: 'r', summary: 's', conversationId: 'conv-1', page: { url: HERE, title: 'x' } }));
    for (let i = 0; i < 100 && !got.some((e) => e.type === 'message'); i++) await new Promise((r) => setTimeout(r, 5));
    const message = got.find((e) => e.type === 'message') as Extract<HandoffEvent, { type: 'message' }>;
    expect(message.text).toBe('1. Turn it off.\n2. Lift the cover.');
    expect(message.answer?.cards.map((c) => c['@id'])).toEqual([howTo['@id']]);
    controller.dispose();
  });
});

describe('cited cards', () => {
  it('a how-to is readable: its heading, the line under its name, Read and nothing that asks the agent', () => {
    const v = citeView(howTo, P);
    expect(v).toMatchObject({ archetype: 'readable', heading: 'How-to', title: 'Replacing the X200 filter', byline: 'Ridgeline', citation: 'typed' });
    expect(v.ctas).toEqual({ lead: { kind: 'open', label: 'Read', url: howTo.url, intent: 'consume' } });
  });

  it('an FAQ shows the question it cites, reads at it, and offers its page beside', () => {
    const v = citeView({ ...faq, focus: { ...faq.focus!, url: 'https://help.example/help/faq-print' } }, P);
    expect(v.focus).toBe('Can I wash the filter?');
    expect([v.ctas?.lead, v.ctas?.secondary].map((b) => b && b.kind === 'open' && [b.label, b.url])).toEqual([
      ['Read', 'https://help.example/help/faq-print'],
      ['Their page', 'https://help.example/help/faq'],
    ]);
    // An anchor on the same page is the page: no second button for it.
    expect(citeView(faq, P).ctas?.secondary).toBeUndefined();
  });

  it('a clip shows its time, and Watch links to the video at it', () => {
    const v = citeView(clip, P);
    expect(v).toMatchObject({ archetype: 'media', heading: 'Video', focus: '2:14 · Removing the cover', byline: '6:30', image: 'https://i.ytimg.example/abc123.jpg', kind: 'video' });
    expect(v.ctas?.lead).toMatchObject({ kind: 'open', label: 'Watch', url: 'https://www.youtube.com/watch?v=abc123&t=134s', actionType: 'WatchAction' });
    expect(atTime('https://vimeo.com/42', 75)).toBe('https://vimeo.com/42#t=75s');
    expect(atTime('https://help.example/v.mp4', 75)).toBe('https://help.example/v.mp4');
  });

  it('a page cited by its description is "From the page", with one Open the page', () => {
    const v = citeView(page, P);
    expect(v).toMatchObject({ heading: 'From the page', citation: 'page' });
    expect(v.byline).toBeUndefined();
    expect(v.ctas).toEqual({ lead: { kind: 'open', label: 'Open the page', url: page.url, intent: 'navigate' } });
    const el = citeCards([v], { ask() {} });
    expect(el.querySelector('.ra-cite')!.getAttribute('data-citation')).toBe('page');
    expect(el.querySelector('.ra-eyebrow')!.textContent).toBe('From the page');
    expect(buttons(el)).toEqual([['Open the page', page.url]]);
  });

  it('a profile offers its page only', () => {
    const v = citeView(profile, P);
    expect(v).toMatchObject({ archetype: 'profile', heading: 'Profile' });
    expect(v.ctas).toEqual({ lead: { kind: 'open', label: 'Their page', url: profile.url, intent: 'navigate' } });
  });

  it('draws no link to an origin the page does not allow, and never a script URL', () => {
    expect(citeView({ ...howTo, url: 'https://evil.example/steal' }, P).ctas).toBeUndefined();
    expect(citeView({ ...howTo, url: 'javascript:alert(1)' }, P).ctas).toBeUndefined();
    expect(citeView({ ...howTo, url: 'https://evil.example/x' }, { ...P, origins: ['https://evil.example'] }).ctas?.lead).toMatchObject({ url: 'https://evil.example/x' });
    // YouTube is allowed only for a video's Watch.
    expect(citeView({ ...howTo, url: 'https://www.youtube.com/watch?v=1' }, P).ctas).toBeUndefined();
    expect(allowedLink('https://user:pw@help.example/x', P)).toBeUndefined();
    expect(allowedLink('http://help.example/x', P)).toBeUndefined();
    expect(allowedLink('/help/x', P)).toBe('https://help.example/help/x');
    expect(allowedLink('//evil.example/x', P)).toBeUndefined();
  });

  it('a record drawn before in the conversation, or twice in one answer, is marked compact: listed, its card not drawn again', () => {
    const views = citeViews(answer([howTo, faq, howTo]), new Set([faq['@id']]), P);
    expect(views.map((v) => !!v.compact)).toEqual([false, true, true]);
  });

  it('opens another allowed origin in a new tab with no opener and no referrer, from every button that leaves', () => {
    const shop = { here: HERE, origins: ['https://shop.example'] };
    const views = [
      citeView({ ...howTo, url: 'https://shop.example/guide' }, shop),
      citeView({ ...faq, url: 'https://shop.example/faq', focus: { ...faq.focus!, url: 'https://shop.example/faq-print' } }, shop),
    ];
    const links = [...citeCards(views, { ask() {} }).querySelectorAll<HTMLAnchorElement>('a.ra-btn')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://shop.example/guide', 'https://shop.example/faq-print', 'https://shop.example/faq']);
    for (const a of links) expect([a.target, a.rel]).toEqual(['_blank', 'noopener noreferrer']);
    // A search result's Subscribe or Listen is the same button, so it sends no referrer either.
    const lead = { kind: 'open', label: 'Subscribe', url: 'https://pay.example/subscribe', intent: 'navigate' } as const;
    const results = resultsAnswer([{ title: 'Lantern Hours', facts: [], ctas: { lead } }], undefined, { ask() {} });
    const page = results.querySelector<HTMLAnchorElement>('a.ra-btn[href="https://pay.example/subscribe"]')!;
    expect([page.target, page.rel]).toEqual(['_blank', 'noopener noreferrer']);
  });

  it('a tap that opens another origin itself opens it with no opener and no referrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openTarget('https://shop.example/x', 'Shop', { here: HERE })).toBe('new-tab');
    expect(open).toHaveBeenCalledWith('https://shop.example/x', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('sets every card field as text', () => {
    const el = citeCards([citeView({ ...howTo, name: '<img src=x onerror="alert(1)">', focus: { path: '', label: '<b>bold</b>' } }, P)], { ask() {} });
    expect(el.querySelector('img[src="x"]')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('links in a reply', () => {
  const hrefs = (nodes: Node[]) => nodes.filter((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement).map((a) => [a.textContent, a.getAttribute('href')]);
  const text = (nodes: Node[]) => nodes.map((n) => n.textContent).join('');

  it('opens addresses on the page’s origin, bare or as Markdown, and leaves the rest as written', () => {
    const src = 'See https://help.example/help/faq. Or [the guide](/help/x200). Not https://evil.example/x nor [this](javascript:alert(1)).';
    const nodes = linkNodes(src, P);
    expect(hrefs(nodes)).toEqual([
      ['https://help.example/help/faq', 'https://help.example/help/faq'],
      ['the guide', 'https://help.example/help/x200'],
    ]);
    expect(text(nodes)).toBe('See https://help.example/help/faq. Or the guide. Not https://evil.example/x nor [this](javascript:alert(1)).');
  });

  it('opens an allowed other origin in a new tab, without a referrer', () => {
    const [a] = linkNodes('https://shop.example/x', { ...P, origins: ['https://shop.example'] }) as HTMLAnchorElement[];
    expect([a.target, a.rel]).toEqual(['_blank', 'noopener noreferrer']);
  });

  it('drops the note from the first line, since it is drawn above', () => {
    expect(withoutNote('Diese Antwort ist auf Deutsch.\n\nSchritt 1', 'Diese Antwort ist auf Deutsch.')).toBe('Schritt 1');
    expect(withoutNote('Step 1', 'A note')).toBe('Step 1');
  });
});

describe('in the thread', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('draws the note, the reply with its links, and its sources in the bubble; a record the page drew is listed too', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    const conv = el._active();
    conv.items.push(el._buildResultsItem({ name: 'nxis_query' }, { structuredContent: { results: [{ ...faq, '@type': 'FAQPage' }] } }));
    el._renderThread();
    const here = location.href;
    const origin = new URL(here).origin;
    const local = (c: CardRecord): CardRecord => ({ ...c, url: c.url && c.url.replace('https://help.example', origin) });
    el._appendHandoffItem(conv.id, {
      kind: 'remote',
      from: 'Help',
      fromKind: 'agent',
      text: `Diese Antwort ist auf Deutsch.\nSiehe ${origin}/help/x200 und https://evil.example/x.`,
      answer: answer([local(howTo), local(faq), local(page)], { note: 'Diese Antwort ist auf Deutsch.' }),
    });
    const remote = el.shadowRoot.querySelector('.remote') as HTMLElement;
    expect(remote.dataset.answerId).toBe('a-1');
    expect(remote.querySelector('.remote-note')!.textContent).toBe('Diese Antwort ist auf Deutsch.');
    const bubble = remote.querySelector('.msg')!;
    expect(bubble.textContent!.startsWith('Siehe')).toBe(true);
    expect([...bubble.querySelectorAll('.remote-link')].map((a) => a.getAttribute('href'))).toEqual([`${origin}/help/x200`]);
    const rows = await vi.waitFor(() => {
      const r = [...bubble.querySelectorAll<HTMLElement>('.ra-src .ra-srow')];
      expect(r).toHaveLength(3);
      return r;
    });
    expect(rows.map((r) => [r.dataset.n, r.querySelector('.ra-smeta')!.textContent])).toEqual([
      ['1', 'How-to'],
      ['2', 'FAQ \u00b7 Can I wash the filter?'],
      ['3', 'From the page'],
    ]);
    // None of them is content (a video, a profile), so no card is drawn under the bubble.
    expect(remote.querySelector('.ra-cite')).toBeNull();
    // Drawn again from the saved conversation, the same.
    el._renderThread();
    await vi.waitFor(() => expect(el.shadowRoot.querySelectorAll('.remote .ra-srow')).toHaveLength(3));
  });
});
