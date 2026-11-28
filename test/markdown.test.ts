// @vitest-environment happy-dom
/**
 * Replies drawn as a safe markdown subset (paragraphs, bold and italic, lists, inline code, headings, links), never
 * as raw HTML, with links only where the page allows and past the guardrails' navigation check. The element is the
 * markdown renderer A2UI Text asks its Lit context for. And the page assistant's record-based answers get numbered
 * markers and a Sources list, as a remote answer does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mdHtml, mdNodes } from '../src/ui/markdown';
import { anchor, allowedLink } from '../src/ui/remote-answer';
import { localAnswer, sourceOrder, type LocalSource } from '../src/ui/sources';
import '../src/ui/agent';

const ORIGIN = new URL(location.href).origin;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => unknown) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(5);
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const html = (text: string, link?: (l: string, h: string) => Node | null) => {
  const box = document.createElement('div');
  box.append(mdNodes(document, text, { link }));
  return box.innerHTML;
};

describe('the markdown subset', () => {
  it('draws lists, bold, italic and inline code, and a lone paragraph inline', () => {
    expect(html('Plain words, no markup.')).toBe('Plain words, no markup.');
    expect(html('Its **listed** services are *these*, see `nxis_query`:\n\n- Drain rodding\n- **Sewer** camera\n\n1. One\n2. Two')).toBe(
      '<p>Its <strong>listed</strong> services are <em>these</em>, see <code>nxis_query</code>:</p>\n' +
        '<ul><li>Drain rodding</li>\n<li><strong>Sewer</strong> camera</li></ul>\n<ol><li>One</li>\n<li>Two</li></ol>',
    );
    expect(html('3. Third\n4. Fourth')).toBe('<ol start="3"><li>Third</li>\n<li>Fourth</li></ol>');
    expect(html('Line one\nline two')).toBe('Line one<br>\nline two');
  });

  it('leaves snake_case, a lone star and arithmetic alone', () => {
    expect(html('Call nxis_query_types and 5 * 3 * 2.')).toBe('Call nxis_query_types and 5 * 3 * 2.');
    expect(html('_quiet_ and __loud__')).toBe('<em>quiet</em> and <strong>loud</strong>');
  });

  it('a heading is a bold line in a bubble, and a heading in A2UI Text', () => {
    expect(html('## Hours\nOpen 24/7.')).toBe('<p><strong>Hours</strong></p>\n<p>Open 24/7.</p>');
    expect(mdHtml('## Hours')).toBe('<h2>Hours</h2>');
  });

  it('never draws raw HTML: tags and entities are text', () => {
    const out = html('<img src=x onerror="alert(1)"> **<b>bold</b>** &amp;');
    expect(out).toBe('&lt;img src=x onerror="alert(1)"&gt; <strong>&lt;b&gt;bold&lt;/b&gt;</strong> &amp;amp;');
    expect(mdHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('draws a link only as the page makes it; anything else stays as written', () => {
    const policy = { origins: [] };
    const link = (label: string, href: string) => {
      const url = allowedLink(href, policy);
      return url ? anchor(url, label, policy) : null;
    };
    const box = document.createElement('div');
    box.append(mdNodes(document, `See [the FAQ](/help/faq), ${ORIGIN}/hours. and [evil](javascript:alert(1)) or [away](https://evil.example/x).`, { link }));
    const as = [...box.querySelectorAll('a')];
    expect(as.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['the FAQ', `${ORIGIN}/help/faq`],
      [`${ORIGIN}/hours`, `${ORIGIN}/hours`],
    ]);
    expect(box.textContent).toContain('[evil](javascript:alert(1))');
    expect(box.textContent).toContain('[away](https://evil.example/x)');
  });

  it('a link opens only past the guardrails\' navigation check', () => {
    const allow = vi.fn(() => false);
    const a = anchor(`${ORIGIN}/help`, 'Help', { allow });
    const e = new MouseEvent('click', { cancelable: true, bubbles: true });
    a.dispatchEvent(e);
    expect(allow).toHaveBeenCalledWith(`${ORIGIN}/help`);
    expect(e.defaultPrevented).toBe(true);
  });

  it('a remote answer\'s claim with markdown in it still finds its place in the drawn text', () => {
    const answer = { answerId: 'a', cards: [{ '@id': 'x#1', '@type': 'HowTo' }], cites: [{ claim: 0, id: 'x#1' }], claims: ['Turn the **main valve** off.'] };
    expect(sourceOrder(answer, 'First:\nTurn the main valve off.\nThen wait.').marks).toEqual([{ at: 30, cards: [0] }]);
  });
});

describe('the page assistant\'s citations', () => {
  const card = (id: string, name: string) => ({ '@id': `${ORIGIN}/#${id}`, '@type': 'Service', name, url: `${ORIGIN}/services/${id}` });
  const SOURCES: LocalSource[] = [
    { card: card('main', 'Copperline Home Services'), keys: ['Copperline Home Services', '(773) 555-0142', '5217 N. Elston Ave'] },
    { card: card('pr', 'Copperline Home Services — Park Ridge'), keys: ['Copperline Home Services — Park Ridge', '(773) 555-0142', '7412 W. Lawrence Ave'] },
    { card: card('drain', 'Drain and sewer rodding'), keys: ['Drain and sewer rodding'] },
    { card: card('heat', 'Water heater replacement'), keys: ['Water heater replacement'] },
  ];

  it('cites a record on each line or sentence that names it, by name, phone or address', () => {
    const text =
      'Copperline Home Services is a plumber in Chicago. Call 773-555-0142.\nDrain and sewer rodding\nPark Ridge branch (7412 W. Lawrence Ave): 7 am to 6 pm.\nNothing else here.';
    const a = localAnswer(text, SOURCES)!;
    expect(a.claims).toEqual(['Copperline Home Services is a plumber in Chicago.', 'Call 773-555-0142.', 'Drain and sewer rodding', 'Park Ridge branch (7412 W. Lawrence Ave): 7 am to 6 pm.']);
    expect(a.cards.map((c) => c.name)).toEqual(['Copperline Home Services', 'Drain and sewer rodding', 'Copperline Home Services — Park Ridge']);
    expect(a.cites).toEqual([
      { claim: 0, id: `${ORIGIN}/#main` },
      { claim: 1, id: `${ORIGIN}/#main` },
      { claim: 2, id: `${ORIGIN}/#drain` },
      { claim: 3, id: `${ORIGIN}/#pr` },
    ]);
    // The longer name wins over the one inside it.
    expect(localAnswer('Copperline Home Services — Park Ridge opens at 7.', SOURCES)!.cards.map((c) => c.name)).toEqual(['Copperline Home Services — Park Ridge']);
    expect(localAnswer('We fix boilers.', SOURCES)).toBeNull();
  });

  const agent = (): any => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };
  const reply = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body });
  const RECORDS = {
    results: [
      { '@id': `${ORIGIN}/#drain`, '@type': 'Service', name: 'Drain and sewer rodding', url: `${ORIGIN}/services/drain` },
      { '@id': `${ORIGIN}/#heat`, '@type': 'Service', name: 'Water heater replacement', url: `${ORIGIN}/services/heat` },
      { '@id': `${ORIGIN}/#cam`, '@type': 'Service', name: 'Sewer camera inspection' },
    ],
  };
  const ANSWER = 'Its listed services are:\n\n- **Drain and sewer rodding**\n- Water heater replacement\n\nCall to book.';

  it('draws the answer as markdown, with a marker after each record it names and a Sources list', async () => {
    const el = agent();
    el._turnSources = [];
    el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, reply(RECORDS));
    const bubble = el._appendStreaming();
    bubble.update('Its listed services are:\n\n- **Drain');
    bubble.finalize(ANSWER);
    const root = el.shadowRoot as ShadowRoot;
    await until(() => root.querySelector('.ra-src'));
    const msg = [...root.querySelectorAll('.msg.assistant')].at(-1)!;
    expect(msg.classList.contains('md')).toBe(true);
    expect(msg.querySelectorAll('ul > li')).toHaveLength(2);
    expect(msg.querySelector('li strong')?.textContent).toBe('Drain and sewer rodding');
    expect(msg.textContent).not.toMatch(/\*\*|^- /m);
    expect([...msg.querySelectorAll('ul > li .ra-mark')].map((m) => m.textContent)).toEqual(['1', '2']);
    expect([...msg.querySelectorAll('.ra-srow .ra-stitle')].map((t) => t.textContent)).toEqual(['Drain and sewer rodding', 'Water heater replacement']);
    // Kept with the message, so a stored conversation draws them again.
    const item = el._active().items.at(-1);
    expect(item.sources.map((s: LocalSource) => s.card.name)).toEqual(['Drain and sewer rodding', 'Water heater replacement', 'Sewer camera inspection']);
  });

  it('a reply that names no record it read is drawn as before, with no Sources', async () => {
    const el = agent();
    el._turnSources = [];
    el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, reply(RECORDS));
    el._appendStreaming().finalize('I can help you book a visit.');
    await sleep(30);
    const msg = [...(el.shadowRoot as ShadowRoot).querySelectorAll('.msg.assistant')].at(-1)!;
    expect(msg.textContent).toBe('I can help you book a visit.');
    expect(msg.querySelector('.ra-src')).toBeNull();
  });
});

describe('the markdown renderer A2UI Text asks for', () => {
  it('is provided by the element: markdown as HTML, plain text escaped', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    document.body.append(el);
    const inner = document.createElement('div');
    (el.shadowRoot as ShadowRoot).append(inner);
    let renderer: ((t: string) => Promise<string>) | undefined;
    const e = new Event('context-request', { bubbles: true, composed: true }) as any;
    e.context = Symbol('A2UIMarkdown');
    e.callback = (r: typeof renderer) => (renderer = r);
    inner.dispatchEvent(e);
    expect(renderer).toBeTypeOf('function');
    expect(await renderer!('Plain <b>')).toBe('Plain &lt;b&gt;');
    expect(await renderer!('A **bold** step\n\n- one\n- two')).toBe('<p>A <strong>bold</strong> step</p>\n<ul><li>one</li>\n<li>two</li></ul>');
    // Another context is not this element's to answer.
    const other = new Event('context-request', { bubbles: true, composed: true }) as any;
    other.context = Symbol('something-else');
    other.callback = vi.fn();
    inner.dispatchEvent(other);
    expect(other.callback).not.toHaveBeenCalled();
  });
});
