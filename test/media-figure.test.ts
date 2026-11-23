// @vitest-environment happy-dom
/**
 * Pictures in the answer view: a figure keeps its space before it loads, a product's
 * tile is its photo, and a broken picture gives way.
 */
import { describe, expect, it } from 'vitest';
import M from './fixtures/media-shapes.json';
import { resultsAnswer, type AnswerCard } from '../src/ui/result-pick';
import { figureOf, imageOf } from '../src/harness/playable';
import { cardCtas } from '../src/harness/cta';

type Obj = Record<string, any>;
const R = M as unknown as Record<string, Obj>;

const figureCard = (r: Obj): AnswerCard => ({ title: r.name, facts: [], archetype: 'media', figure: figureOf(r, 'https://site.example/'), ctas: cardCtas(r) });

describe('a picture record', () => {
  it('draws as a figure with its size reserved, its caption and credit, License and its page', () => {
    const el = resultsAnswer([figureCard(R.imageObject)], undefined, { ask() {} });
    const img = el.querySelector('figure img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://media.example/photos/harbour.jpg');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['1600', '900']);
    expect(img.style.aspectRatio).toBe('1600 / 900');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(img.hasAttribute('crossorigin')).toBe(false);
    expect(img.getAttribute('alt')).toBe('The estuary at low tide, looking east');
    expect(el.querySelector('figcaption')!.textContent).toContain('Photo: Wren Abernathy-Solis');
    expect([...el.querySelectorAll('.ra-actions a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['License', 'https://media.example/photos/license'],
      ['Their page', 'https://media.example/photos/harbour.html'],
    ]);
  });

  it('with no size given keeps a 4:3 frame; a broken one becomes a frame of the same shape', () => {
    const el = resultsAnswer([figureCard({ '@type': 'ImageObject', name: 'Gulls', contentUrl: 'https://media.example/g.jpg' })], undefined, { ask() {} });
    const img = el.querySelector('figure img') as HTMLImageElement;
    expect(img.style.aspectRatio).toBe('4 / 3');
    img.dispatchEvent(new Event('error'));
    const frame = el.querySelector('figure .ra-noimg') as HTMLElement;
    expect(frame.getAttribute('role')).toBe('img');
    expect(frame.style.aspectRatio).toBe('4 / 3');
  });

  it('a paid picture with no thumbnail draws its words and no picture', () => {
    const el = resultsAnswer([figureCard({ ...R.paidImage, thumbnailUrl: undefined })], undefined, { ask() {} });
    expect(el.querySelector('figure img')).toBeNull();
    expect(el.querySelector('figcaption')!.textContent).toContain('Pell Ruskin');
  });
});

describe('any record’s tile', () => {
  it('is its first https picture, decorative, falling back to its initials', () => {
    const product: AnswerCard = { title: 'Walnut drawer runner', facts: [], archetype: 'offerable', image: imageOf(R.product), page: { url: 'https://site.example/p', label: 'p' } };
    const el = resultsAnswer([product, { title: 'Other', facts: [], archetype: 'offerable' }], { index: 0, lead: 'This.', reasons: [] }, { ask() {} });
    const img = el.querySelector('.ra-head img.ra-avatar') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://media.example/p/runner-1.jpg');
    expect(img.getAttribute('alt')).toBe('');
    img.dispatchEvent(new Event('error'));
    expect(el.querySelector('.ra-head span.ra-avatar')!.textContent).toBe('WD');
  });
});
