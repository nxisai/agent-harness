/**
 * Story 1 of in-chat media: a record's pictures, a picture record as its figure, and
 * addresses that are never drawn.
 */
import { describe, expect, it } from 'vitest';
import M from './fixtures/media-shapes.json';
import { compact } from '../src/harness/entity';
import { figureOf, imageOf, imagesOf, MAX_MEDIA_URL, pixels, safeMediaUrl } from '../src/harness/playable';
import { emitFigureSurface, toCardData } from '../src/a2ui/cards';
import { emitResultsSurface } from '../src/a2ui/results';
import { cardCtas } from '../src/harness/cta';

type Obj = Record<string, any>;
const R = M as unknown as Record<string, Obj>;
const HERE = 'https://podcast.example/shows/x.html';

describe('safeMediaUrl()', () => {
  it('takes https, and this page’s own origin over http', () => {
    expect(safeMediaUrl('https://media.example/a.jpg', HERE)).toBe('https://media.example/a.jpg');
    expect(safeMediaUrl('http://localhost:4173/covers/a.svg', 'http://localhost:4173/')).toBe('http://localhost:4173/covers/a.svg');
  });

  it('refuses every hostile address', () => {
    for (const u of M.hostile) expect(safeMediaUrl(u, HERE), u).toBeUndefined();
    expect(safeMediaUrl(`https://media.example/${'a'.repeat(MAX_MEDIA_URL)}.jpg`, HERE)).toBeUndefined();
    expect(safeMediaUrl(undefined)).toBeUndefined();
    expect(safeMediaUrl({ url: 'https://x' })).toBeUndefined();
  });
});

describe('pixels()', () => {
  it('reads 640, "640", "640 px" and a QuantitativeValue in pixels', () => {
    expect([640, '640', '640 px', ' 640px ', { value: 640, unitCode: 'E37' }, { value: '640', unitText: 'px' }].map(pixels)).toEqual([640, 640, 640, 640, 640, 640]);
  });
  it('and nothing else', () => {
    expect([0, -3, '12 cm', { value: 4, unitCode: 'CMT' }, 'wide', undefined].map(pixels)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('imagesOf()', () => {
  it('a product’s image array: strings and ImageObjects, each address once, data: dropped, sizes kept', () => {
    expect(imagesOf(R.product, HERE)).toEqual([
      { url: 'https://media.example/p/runner-1.jpg' },
      { url: 'https://media.example/p/runner-2.jpg', width: 640, height: 480, alt: 'The runner, waxed' },
      { url: 'https://media.example/p/runner-thumb.jpg' },
    ]);
    expect(imageOf(R.product, HERE)).toBe('https://media.example/p/runner-1.jpg');
  });

  it('a place’s photo, then its logo; a product’s logo is no picture of it', () => {
    expect(imagesOf(R.place, HERE).map((i) => i.url)).toEqual(['https://media.example/place/front.jpg', 'https://media.example/place/logo.png']);
    expect(imagesOf(R.productWithLogo, HERE)).toEqual([]);
  });

  it('an ImageObject’s own file first; a paid one only its thumbnail', () => {
    expect(imagesOf(R.imageObject, HERE)[0]).toEqual({ url: 'https://media.example/photos/harbour.jpg', width: 1600, height: 900, alt: 'The estuary at low tide, looking east' });
    expect(imagesOf(R.paidImage, HERE).map((i) => i.url)).toEqual(['https://media.example/photos/herons-thumb.jpg']);
  });

  it('reads expanded JSON-LD', () => {
    expect(imagesOf(R.expandedImage, HERE)[0]).toMatchObject({ url: 'https://media.example/photos/gulls.jpg', width: 800, height: 600 });
    expect(imagesOf(compact(R.expandedImage), HERE)[0]).toMatchObject({ url: 'https://media.example/photos/gulls.jpg', width: 800, height: 600 });
  });
});

describe('figureOf()', () => {
  it('a free ImageObject: its picture, caption, credit, licence and where to get one', () => {
    expect(figureOf(R.imageObject, HERE)).toEqual({
      image: { url: 'https://media.example/photos/harbour.jpg', width: 1600, height: 900, alt: 'The estuary at low tide, looking east' },
      caption: 'The estuary at low tide, looking east',
      credit: 'Photo: Wren Abernathy-Solis',
      licensePage: 'https://media.example/photos/license',
      license: 'https://creativecommons.org/licenses/by/4.0/',
      page: 'https://media.example/photos/harbour.html',
    });
  });

  it('a paid one shows only its thumbnail, and credits its author', () => {
    expect(figureOf(R.paidImage, HERE)).toEqual({ image: { url: 'https://media.example/photos/herons-thumb.jpg' }, credit: 'Pell Ruskin' });
    expect(figureOf({ ...R.paidImage, thumbnailUrl: undefined }, HERE)).toEqual({ credit: 'Pell Ruskin' });
  });

  it('is only for pictures', () => {
    expect(figureOf(R.product, HERE)).toBeUndefined();
    expect(figureOf(R.freeVideo, HERE)).toBeUndefined();
  });
});

describe('the A2UI view', () => {
  const comps = (m: any) => m[0].createSurface.components as Obj[];
  it('a card carries its picture as a catalog Image, alt from its caption or title', () => {
    const data = toCardData(R.product);
    expect(data.images).toEqual([{ url: 'https://media.example/p/runner-1.jpg', alt: 'Walnut drawer runner' }]);
    expect(toCardData({ name: 'No picture' }).images).toEqual([]);
    const img = comps(emitResultsSurface('q', [R.product, R.place])).find((c) => c.id === 'img_tpl')!;
    expect(img).toMatchObject({ component: 'Image', fit: 'cover', variant: 'smallFeature', description: '${alt}' });
  });

  it('a lone ImageObject draws as its figure: the picture at feature size, caption, credit, License', () => {
    const m = emitResultsSurface('nxis_get', [R.imageObject]);
    expect(comps(m).find((c) => c.id === 'fig_img')).toMatchObject({ component: 'Image', variant: 'mediumFeature', fit: 'cover' });
    const data = m[0].createSurface!.dataModel as Obj;
    expect(data.title).toBe('Harbour at dusk');
    expect(data.caption).toBe('The estuary at low tide, looking east');
    expect(data.credit).toBe('Photo: Wren Abernathy-Solis');
    expect(data.image).toEqual([{ url: 'https://media.example/photos/harbour.jpg', alt: 'The estuary at low tide, looking east' }]);
    expect(data.buttons.map((b: Obj) => b.label)).toEqual(['License', 'Their page']);
    expect(emitFigureSurface('x', {}, cardCtas({ '@type': 'ImageObject', name: 'x' }))[0].createSurface!.dataModel).toMatchObject({ image: [], buttons: [] });
  });
});
