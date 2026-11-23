// @vitest-environment happy-dom
/**
 * Inline citations on a remote answer: a numbered marker after each claim (from the answer part's `claims`), and a
 * Sources list in the bubble, numbered by first appearance. A marker highlights its row; a row opens its source
 * through the guardrails' navigation check. Without `claims` (an older target) the list is drawn with no markers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, readAnswer, type CardRecord, type HandoffAnswer } from '../src/handoff/index';
import { citeViews } from '../src/ui/remote-answer';
import { citeCards, type AnswerHandlers } from '../src/ui/result-pick';
import { openWay } from '../src/harness/tools/open-target';
import { paintSources, sourceOrder, stepsCited, type SourcesHost } from '../src/ui/sources';

const ORIGIN = new URL(location.href).origin;
const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });

const howTo: CardRecord = { '@id': `${ORIGIN}/help/x200#howto`, '@type': 'HowTo', name: 'How to replace the X200 filter', url: `${ORIGIN}/help/x200` };
const faq: CardRecord = { '@id': `${ORIGIN}/help/faq#faq`, '@type': 'FAQPage', name: 'How often should I replace the X200 filter?', url: `${ORIGIN}/help/faq` };
const clip: CardRecord = {
  '@id': `${ORIGIN}/videos/x200#video`,
  '@type': 'VideoObject',
  name: 'Replacing the X200 filter',
  url: `${ORIGIN}/videos/x200`,
  focus: { path: 'hasPart[1]', label: 'Removing the cover', startOffset: 134 },
};
const shop: CardRecord = { '@id': 'https://shop.example/x200#product', '@type': 'Product', name: 'X200-F filter', url: 'https://shop.example/x200' };

const TEXT = 'Pull the old filter out by its fabric tab, and slide the new one in. It takes about 10 minutes. Replace the filter every three months.';
const CLAIMS = ['Pull the old filter out by its fabric tab, and slide the new one in.', 'It takes about 10 minutes.', 'Replace the filter every three months.'];

/** The design's answer: the FAQ is the first card, but the how-to is cited first in the text. */
const answer = (extra: Partial<HandoffAnswer> = {}): HandoffAnswer => ({
  answerId: 'a-1',
  cards: [faq, howTo],
  cites: [
    { claim: 0, id: howTo['@id'], path: 'step[2]' },
    { claim: 1, id: howTo['@id'], path: 'step[4]' },
    { claim: 1, id: howTo['@id'], path: 'step[3]' },
    { claim: 2, id: faq['@id'], path: 'mainEntity[0]' },
  ],
  claims: CLAIMS,
  ...extra,
});

function draw(a: HandoffAnswer, text = TEXT, host: Partial<SourcesHost> = {}) {
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  bubble.textContent = text;
  const wrap = document.createElement('div');
  wrap.append(bubble);
  document.body.append(wrap);
  const handlers: AnswerHandlers = { ask() {}, visit: vi.fn() };
  const allow = vi.fn(() => true);
  paintSources(bubble, a, { views: citeViews(a), handlers, allow, openWay, citeCards, ...host });
  const marks = [...bubble.querySelectorAll<HTMLButtonElement>('.ra-mark')];
  const rows = [...bubble.querySelectorAll<HTMLElement>('.ra-srow')];
  return { bubble, wrap, marks, rows, handlers, allow };
}

/** The bubble's text with each marker as [n]. */
const shown = (bubble: HTMLElement) => {
  const copy = bubble.cloneNode(true) as HTMLElement;
  copy.querySelector('.ra-src')?.remove();
  for (const m of copy.querySelectorAll('.ra-mark')) m.replaceWith(`[${m.textContent}]`);
  return copy.textContent;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the answer part', () => {
  it('keeps the claims as text, and a cite’s record', () => {
    const a = readAnswer([
      { text: TEXT },
      ext({ handoff: 'answer', answerId: 'a-1', cards: [howTo], cites: [{ claim: 0, id: `${howTo['@id']}-step-3`, record: howTo['@id'], path: 'step[2]' }], claims: ['  One.  ', 7, null, '<b>Two</b>'] }),
    ])!;
    expect(a.claims).toEqual(['One.', '', '', '<b>Two</b>']);
    expect(a.cites).toEqual([{ claim: 0, id: `${howTo['@id']}-step-3`, record: howTo['@id'], path: 'step[2]' }]);
  });

  it('an older target, with no claims, has none', () => {
    expect(readAnswer([ext({ handoff: 'answer', answerId: 'a', cards: [howTo], cites: [] })])!.claims).toBeUndefined();
    expect(readAnswer([ext({ handoff: 'answer', answerId: 'a', cards: [howTo], cites: [], claims: ['', 3] })])!.claims).toBeUndefined();
  });
});

describe('where markers go, and the numbers', () => {
  it('puts a marker after each claim, before its full stop, numbered by first appearance in the text', () => {
    const o = sourceOrder(answer(), TEXT);
    // The how-to (card 1) is cited first, so it is 1; the FAQ (card 0) is 2.
    expect(o.order).toEqual([1, 0]);
    expect(o.numbers).toEqual([2, 1]);
    expect(o.marks.map((m) => [TEXT.slice(0, m.at).split(' ').slice(-2).join(' '), TEXT[m.at], m.cards])).toEqual([
      ['one in', '.', [1]],
      ['10 minutes', '.', [1]],
      ['three months', '.', [0]],
    ]);
  });

  it('a claim with several sources gets a marker for each', () => {
    const a = answer({ cites: [...answer().cites, { claim: 0, id: faq['@id'] }] });
    expect(sourceOrder(a, TEXT).marks[0].cards).toEqual([1, 0]);
  });

  it('finds a claim whose whitespace differs, and one repeated earlier in the text', () => {
    const text = 'Pull the old filter out by its fabric tab,\nand slide the new one in. It takes about 10 minutes.';
    const a = answer({ claims: [CLAIMS[0], CLAIMS[1], 'Pull the old filter out'], cites: [{ claim: 0, id: howTo['@id'] }, { claim: 1, id: howTo['@id'] }, { claim: 2, id: faq['@id'] }] });
    const o = sourceOrder(a, text);
    // The first claim across a line break; the third only earlier in the text, so its marker goes there.
    expect(o.marks.map((m) => m.at)).toEqual(['Pull the old filter out'.length, text.indexOf('in.') + 2, text.length - 1]);
    expect(o.marks[0].cards).toEqual([0]);
  });

  it('lists a card no claim cites after the cited ones; a claim not in the text has no marker', () => {
    const a = answer({ cards: [faq, howTo, shop], claims: [CLAIMS[0], 'Words the reply does not have.', CLAIMS[2]] });
    const o = sourceOrder(a, TEXT);
    expect(o.marks).toHaveLength(2);
    expect(o.order).toEqual([1, 0, 2]);
  });

  it('matches a cite to its card by its record, or by the document its own @id is in', () => {
    const a = answer({ cites: [{ claim: 0, id: `${ORIGIN}/help/x200#step-3` }, { claim: 2, id: 'https://elsewhere/q', record: faq['@id'] }] });
    expect(sourceOrder(a, TEXT).marks.map((m) => m.cards)).toEqual([[1], [0]]);
  });

  it('without claims, numbers the cards in their order and places no marker', () => {
    const o = sourceOrder(answer({ claims: undefined }), TEXT);
    expect(o).toEqual({ marks: [], order: [0, 1], numbers: [1, 2] });
  });

  it('names the steps a how-to is cited for', () => {
    expect(stepsCited(answer(), 1)).toBe('steps 3–5');
    expect(stepsCited(answer({ cites: [{ claim: 0, id: howTo['@id'], path: 'step[1]' }, { claim: 0, id: howTo['@id'], path: 'step[5]' }] }), 1)).toBe('steps 2, 6');
    expect(stepsCited(answer({ cites: [{ claim: 0, id: howTo['@id'], path: 'step[0]' }] }), 1)).toBe('step 1');
    expect(stepsCited(answer(), 0)).toBeUndefined();
  });
});

describe('the Sources in the bubble', () => {
  it('draws the markers in the text and the numbered rows, as the design does', () => {
    const { bubble, marks, rows } = draw(answer());
    expect(shown(bubble)).toBe(
      'Pull the old filter out by its fabric tab, and slide the new one in[1]. It takes about 10 minutes[1]. Replace the filter every three months[2].',
    );
    expect(marks.map((m) => [m.tagName, m.type, m.getAttribute('aria-label')])).toEqual([
      ['BUTTON', 'button', 'Source 1'],
      ['BUTTON', 'button', 'Source 1'],
      ['BUTTON', 'button', 'Source 2'],
    ]);
    expect(bubble.querySelector('.ra-src-h')!.textContent).toBe('Sources');
    expect(bubble.querySelector('.ra-src')!.getAttribute('aria-labelledby')).toBe(bubble.querySelector('.ra-src-h')!.id);
    expect(rows.map((r) => [r.tagName, r.dataset.n, r.querySelector('.ra-stitle')!.textContent, r.querySelector('.ra-smeta')!.textContent])).toEqual([
      ['A', '1', 'How to replace the X200 filter', 'How-to · steps 3–5'],
      ['A', '2', 'How often should I replace the X200 filter?', 'FAQ'],
    ]);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([howTo.url, faq.url]);
    expect(rows[0].querySelector('svg.ra-sicon')!.getAttribute('aria-hidden')).toBe('true');
    expect(bubble.classList.contains('has-sources')).toBe(true);
  });

  it('a marker moves focus to its row and highlights it', () => {
    vi.useFakeTimers();
    const { marks, rows } = draw(answer());
    marks[2].click();
    expect(rows[1].ownerDocument.activeElement).toBe(rows[1]);
    expect(rows[1].classList.contains('ra-hl')).toBe(true);
    expect(rows[0].classList.contains('ra-hl')).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(rows[1].classList.contains('ra-hl')).toBe(false);
    vi.useRealTimers();
  });

  it('an older target’s answer: the Sources list, and no markers in the text', () => {
    const { bubble, marks, rows } = draw(answer({ claims: undefined }));
    expect(marks).toHaveLength(0);
    expect(shown(bubble)).toBe(TEXT);
    expect(rows.map((r) => r.dataset.n)).toEqual(['1', '2']);
    expect(rows[0].querySelector('.ra-stitle')!.textContent).toBe(faq.name);
  });

  it('a one-source answer is numbered too', () => {
    const a: HandoffAnswer = { answerId: 'a', cards: [faq], cites: [{ claim: 0, id: faq['@id'] }], claims: [CLAIMS[2]] };
    const { bubble, rows } = draw(a, CLAIMS[2]);
    expect(shown(bubble)).toBe('Replace the filter every three months[1].');
    expect(rows).toHaveLength(1);
  });

  it('never puts a marker inside a link in the reply', () => {
    const bubble = document.createElement('div');
    bubble.append('See ', Object.assign(document.createElement('a'), { className: 'remote-link', href: faq.url!, textContent: 'the FAQ' }));
    document.body.append(bubble);
    const a: HandoffAnswer = { answerId: 'a', cards: [faq], cites: [{ claim: 0, id: faq['@id'] }], claims: ['See the FAQ'] };
    paintSources(bubble, a, { views: citeViews(a), handlers: { ask() {} }, allow: () => true, openWay, citeCards });
    const link = bubble.querySelector('a.remote-link')!;
    expect(link.querySelector('.ra-mark')).toBeNull();
    expect(link.nextElementSibling!.querySelector('.ra-mark')).not.toBeNull();
  });

  it('sets every string as text', () => {
    const evil: CardRecord = { ...faq, name: '<img src=x onerror="alert(1)">' };
    const a: HandoffAnswer = { answerId: 'a', cards: [evil], cites: [{ claim: 0, id: evil['@id'] }], claims: ['<b>bold</b>'] };
    const { bubble } = draw(a, '<b>bold</b> it is.');
    expect(bubble.querySelector('img[src="x"], b')).toBeNull();
    expect(bubble.querySelector('.ra-stitle')!.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('keeps a video as its card, under the bubble with its number; an article or a how-to is its row alone', () => {
    const a: HandoffAnswer = { answerId: 'a', cards: [howTo, clip], cites: [{ claim: 0, id: howTo['@id'] }, { claim: 1, id: clip['@id'] }], claims: [CLAIMS[0], CLAIMS[1]] };
    const { bubble, wrap, rows } = draw(a);
    expect(rows.map((r) => r.querySelector('.ra-smeta')!.textContent)).toEqual(['How-to', 'Video · 2:14 · Removing the cover']);
    const cards = [...wrap.querySelectorAll('.ra-cite')];
    expect(cards.map((c) => c.getAttribute('data-type'))).toEqual(['VideoObject']);
    expect(bubble.nextElementSibling!.classList.contains('ra-cites')).toBe(true);
    expect(cards[0].querySelector('.ra-eyebrow')!.textContent).toBe('2Video');
    expect(cards[0].querySelector('a.ra-btn')!.textContent).toBe('Watch');
  });
});

describe('opening a source', () => {
  it('asks the navigation check first, inside the tap; refused, nothing opens', () => {
    const refuse = vi.fn(() => false);
    const { rows, handlers } = draw(answer(), TEXT, { allow: refuse });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    rows[0].dispatchEvent(click);
    expect(refuse).toHaveBeenCalledWith(howTo.url);
    expect(click.defaultPrevented).toBe(true);
    expect(handlers.visit).not.toHaveBeenCalled();
  });

  it('allowed, another page of the site goes there in this tab, the conversation kept', () => {
    const { rows, allow, handlers } = draw(answer());
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    // happy-dom would navigate; the link's own default is the browser's, so only the hooks are checked.
    rows[0].addEventListener('click', (e) => e.preventDefault());
    rows[0].dispatchEvent(click);
    expect(allow).toHaveBeenCalledWith(howTo.url);
    expect(handlers.visit).toHaveBeenCalledWith(howTo.url, howTo.name);
  });

  it('another origin opens in a new tab, with no opener and no referrer', () => {
    const a: HandoffAnswer = { answerId: 'a', cards: [shop], cites: [], claims: undefined };
    const bubble = document.createElement('div');
    document.body.append(bubble);
    paintSources(bubble, a, { views: citeViews(a, new Set(), { origins: ['https://shop.example'] }), handlers: { ask() {} }, allow: () => true, openWay, citeCards });
    const row = bubble.querySelector<HTMLAnchorElement>('a.ra-srow')!;
    expect([row.href, row.target, row.rel]).toEqual([shop.url, '_blank', 'noopener noreferrer']);
    expect(row.textContent).toContain('(opens in a new tab)');
  });

  it('in the element, a row goes through the guardrails’ navigation check', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    const nav = vi.fn(() => false);
    el._g = { nav };
    el._appendHandoffItem(el._activeId, { kind: 'remote', from: 'Help', fromKind: 'agent', text: TEXT, answer: answer() });
    const row = await vi.waitFor(() => {
      const r = el.shadowRoot.querySelector('.remote .ra-srow') as HTMLAnchorElement | null;
      if (!r) throw new Error('not drawn yet');
      return r;
    });
    expect(el.shadowRoot.querySelectorAll('.remote .msg .ra-mark')).toHaveLength(3);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    row.dispatchEvent(click);
    expect(nav).toHaveBeenCalledWith(howTo.url);
    expect(click.defaultPrevented).toBe(true);
    // The thumbs stay under the bubble.
    const remote = el.shadowRoot.querySelector('.remote')!;
    await vi.waitFor(() => expect(remote.lastElementChild!.classList.contains('fb')).toBe(true));
  });
});
