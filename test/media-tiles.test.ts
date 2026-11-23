// @vitest-environment happy-dom
/**
 * Media tiles and taps in the answer view: a picture shows its picture, a video the
 * play mark, a broken cover its fallback, and a Listen tap reports what it opened.
 */
import { describe, expect, it, vi } from 'vitest';
import { resultsAnswer, type AnswerCard } from '../src/ui/result-pick';

const SITE = 'https://podcast.example';
const pick = { index: 0, lead: 'This one.', reasons: [] };

const card = (over: Partial<AnswerCard>): AnswerCard => ({ title: 'x', facts: [], archetype: 'media', ...over });

describe('media tiles', () => {
  it('an ImageObject shows its picture', () => {
    const el = resultsAnswer([card({ title: 'Harbour at dusk', media: { title: 'Harbour at dusk' }, kind: 'image', image: 'https://x.example/h.jpg' })], pick, { ask() {} });
    const img = el.querySelector('.ra-head img.ra-art') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://x.example/h.jpg');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('a VideoObject with no picture wears the play mark, not the microphone', () => {
    const el = resultsAnswer([card({ title: 'Clip', media: { title: 'Clip' }, kind: 'video' })], pick, { ask() {} });
    const tile = el.querySelector('.ra-head .ra-art')!;
    expect(tile.querySelector('path')!.getAttribute('d')).toBe('M7 4v16l13-8z');
  });

  it('an episode with no picture keeps the microphone', () => {
    const el = resultsAnswer([card({ title: 'Ep', media: { title: 'Ep' }, kind: 'audio' })], pick, { ask() {} });
    expect(el.querySelectorAll('.ra-head .ra-art path')).toHaveLength(3);
  });

  it('a broken cover gives way to its kind’s tile', () => {
    const el = resultsAnswer([card({ title: 'Ep', media: { title: 'Ep' }, kind: 'audio', image: 'https://x.example/broken.svg' })], pick, { ask() {} });
    const img = el.querySelector('.ra-head img')!;
    img.dispatchEvent(new Event('error'));
    expect(el.querySelector('.ra-head img')).toBeNull();
    expect(el.querySelector('.ra-head span.ra-art svg')).not.toBeNull();
  });

  it('a video in a list gets a tile in its row; an episode’s row stays bare', () => {
    const el = resultsAnswer(
      [card({ title: 'Clip', media: { title: 'Clip' }, kind: 'video' }), card({ title: 'Ep', media: { title: 'Ep' }, kind: 'audio' })],
      undefined,
      { ask() {} },
    );
    const rows = [...el.querySelectorAll('.ra-mrow')];
    expect(rows[0].querySelector('.ra-art')).not.toBeNull();
    expect(rows[1].querySelector('.ra-art')).toBeNull();
  });
});

describe('a tap that opens a page', () => {
  it('reports the button, with its action and token, before the browser follows it', () => {
    const opened = vi.fn();
    const lead = {
      kind: 'open' as const, label: 'Listen', url: `${SITE}/shows/x.html#player`, intent: 'consume' as const,
      actionType: 'ListenAction' as const, actionId: `${SITE}/shows/x.html#listen`, reportToken: 'tok.listen',
    };
    const el = resultsAnswer([card({ title: 'Ep', media: { title: 'Ep', ctas: { lead } }, ctas: { lead } })], undefined, { ask() {}, opened });
    const a = el.querySelector('a.ra-btn') as HTMLAnchorElement;
    a.addEventListener('click', (e) => e.preventDefault()); // happy-dom would navigate
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]).toMatchObject({ actionType: 'ListenAction', actionId: `${SITE}/shows/x.html#listen`, reportToken: 'tok.listen' });
  });
});
