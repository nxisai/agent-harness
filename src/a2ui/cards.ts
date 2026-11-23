/**
 * Renders typed-retrieval results as A2UI cards.
 *
 * The component count is fixed regardless of how many results there are: one
 * result and twelve emit the same components, differing only in the data at
 * `/results`. A result arriving late is therefore a data-model patch rather
 * than new components, which keeps rendering incremental.
 *
 * Conditionality lives in the data rather than the components, so an entity
 * with no rating simply has fewer entries. The basic catalog has no conditional
 * rendering and none is needed.
 */

import type { A2uiMessage } from './emit.js';
import { actionCta, type CardAction, type CardButton, type CardCtas } from '../harness/cta.js';
import { imagesOf, type FigureModel } from '../harness/playable.js';
import {
  groupBySeries,
  mediaLineText,
  SERIES_PARTS_SHOWN,
  type MediaRow,
  type SeriesCard,
} from '../harness/media.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

interface Component { id: string; component: string; [prop: string]: unknown }

/** One label and value line on a result card. */
export interface CardRow { label: string; value: string }
/** A short pill shown on a result card. */
export interface CardTag { label: string }
/** One record, in the shape a result card renders. */
export interface ResultCardData {
  title: string;
  sub: string;
  tags: CardTag[];
  rows: CardRow[];
  /** The record's picture, as at most one: `alt` is its caption, else the card's title. */
  images: { url: string; alt: string }[];
  /** The record's own action, as at most one button. A list so a card without one draws nothing. */
  actions: CardAction[];
}

const str = (v: unknown): string => (v == null ? '' : String(Array.isArray(v) ? v[0] : v));

const humanize = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
   .replace(/^\w/, c => c.toUpperCase());

/**
 * Normalise one schema.org entity into flat card data.
 *
 * Mirrors `_entityCard` in agent.ts, with the same
 * title/type/rating rules and 4-row cap, so the A2UI surface and inline card show
 * the same thing. If this ships, the two should share one implementation rather
 * than drift; this copy exists to keep the sketch self-contained.
 */
export function toCardData(entity: Record<string, unknown>): ResultCardData {
  const title = str(entity.name ?? entity.title ?? entity.headline ?? entity['@id'] ?? 'Result');
  const tags: CardTag[] = [];

  const rawType = entity['@type'];
  if (rawType) tags.push({ label: humanize(str(rawType)) });

  const ar = entity.aggregateRating as Record<string, unknown> | undefined;
  if (ar && typeof ar === 'object' && ar.ratingValue != null) {
    const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(Number(ar.ratingValue) || 0))));
    tags.push({
      label: ar.reviewCount != null
        ? `${stars} ${str(ar.ratingValue)} · ${str(ar.reviewCount)}`
        : `${stars} ${str(ar.ratingValue)}`,
    });
  }

  // 24/7 is only ever implied by round-the-clock opening hours.
  const hours = entity.openingHoursSpecification;
  if (Array.isArray(hours) && hours.some(h =>
    h && typeof h === 'object'
    && String((h as Record<string, unknown>).opens) === '00:00'
    && String((h as Record<string, unknown>).closes) === '23:59')) {
    tags.push({ label: '24/7' });
  }

  const desc = str(entity.description).trim();
  const sub = desc.length > 150 ? desc.slice(0, 147) + '…' : desc;

  const rows: CardRow[] = [];
  const push = (label: string, value: unknown) => {
    const v = str(value).trim();
    if (v && rows.length < 4 && !rows.some(r => r.label === label)) {
      rows.push({ label, value: v.length > 90 ? v.slice(0, 87) + '…' : v });
    }
  };

  const addr = entity.address as Record<string, unknown> | undefined;
  if (addr && typeof addr === 'object') {
    const parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion]
      .filter(Boolean).map(str);
    if (parts.length) push('Address', parts.join(', '));
  }
  for (const key of ['telephone', 'email', 'url']) {
    const v = entity[key];
    if (typeof v === 'string' || typeof v === 'number') {
      push(humanize(key === 'url' ? 'website' : key), v);
    }
  }

  const action = actionCta(entity, title);
  const images = imagesOf(entity).slice(0, 1).map((i) => ({ url: i.url, alt: i.alt ?? title }));
  return { title, sub, tags, rows, images, actions: action ? [action] : [] };
}

/** Fixed component set — independent of how many results there are. */
function cardComponents(heading: string): Component[] {
  return [
    { id: 'root', component: 'Column', children: ['heading', 'results'] },
    { id: 'heading', component: 'Text', text: heading, variant: 'body' },

    // Outer list: one Card per entry in /results
    { id: 'results', component: 'List',
      children: { path: '/results', componentId: 'card_tpl' }, direction: 'vertical' },
    { id: 'card_tpl', component: 'Card', child: 'card_body' },
    { id: 'card_body', component: 'Column', children: ['card_images', 'card_title', 'card_tags', 'card_sub', 'card_rows', 'card_actions'] },
    // The record's picture, at most one. The Lit renderer doesn't reserve its space before it loads (a known gap).
    { id: 'card_images', component: 'List',
      children: { path: 'images', componentId: 'img_tpl' }, direction: 'horizontal' },
    { id: 'img_tpl', component: 'Image', url: '${url}', description: '${alt}', fit: 'cover', variant: 'smallFeature' },
    // No bold: `weight` in this catalog is a flex weight (number), and Text
    // offers only variant caption/body. Title emphasis is not expressible in
    // the basic catalog: it needs a custom catalog or renderer styling.
    { id: 'card_title', component: 'Text', text: '${title}', variant: 'body' },

    // Relative paths resolve inside the current item's scope.
    { id: 'card_tags', component: 'List',
      children: { path: 'tags', componentId: 'tag_tpl' }, direction: 'horizontal' },
    { id: 'tag_tpl', component: 'Text', text: '${label}', variant: 'caption' },

    { id: 'card_sub', component: 'Text', text: '${sub}', variant: 'caption' },

    { id: 'card_rows', component: 'List',
      children: { path: 'rows', componentId: 'row_tpl' }, direction: 'vertical' },
    { id: 'row_tpl', component: 'Row', children: ['row_label', 'row_value'] },
    { id: 'row_label', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'row_value', component: 'Text', text: '${value}', variant: 'caption' },

    // The record's action: zero or one per card, so a card without one draws nothing. Pressing it
    // dispatches nxis.ask with the message to send as the visitor; it never submits anything itself.
    { id: 'card_actions', component: 'List',
      children: { path: 'actions', componentId: 'action_tpl' }, direction: 'horizontal' },
    { id: 'action_tpl', component: 'Button', child: 'action_label', variant: 'primary',
      action: { event: { name: 'nxis.ask', context: { message: '${message}' } } } },
    { id: 'action_label', component: 'Text', text: '${label}', variant: 'body' },
  ];
}

/**
 * Build a surface from card data that has already been normalised.
 *
 * agent.ts has its own `_entityCard`, and it is the one that decides
 * what a card shows. Taking its output rather than re-deriving from entities
 * keeps the A2UI surface and the legacy inline card identical by construction.
 */
export function emitCardsSurface(
  heading: string,
  results: ResultCardData[],
  surfaceId = 'results'
): A2uiMessage[] {
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG,
      components: cardComponents(heading),
      dataModel: { results: results.slice(0, 12) },
    },
  }];
}

/** A late-arriving result appends to the list; no components are re-sent. */
export function emitAppendResult(
  surfaceId: string, index: number, entity: Record<string, unknown>
): A2uiMessage {
  return {
    version: 'v1.0',
    updateDataModel: { surfaceId, path: `/results/${index}`, value: toCardData(entity) },
  };
}

// ── Media: episode rows and the series card (the Podcast board) ──────────────────────────────────────────────────────

/** A button as the media surfaces bind it: what it says, and what a tap opens. */
export interface MediaButtonData {
  label: string;
  url: string;
  /** What it opens is called: the episode's or show's name, for the conversation to say where it went. */
  name: string;
  /** The tap reports these, so the host can say which action it was. Empty when the button is "Their page". */
  actionType: string;
  actionId: string;
  /** With in-chat playback on (`media="play"`): the item a tap plays, empty for a button that opens a page, and
   * the words to go back to when it stops ({@link pressMessages}). */
  mediaId?: string;
  rest?: string;
}

/** Whether a play button may play now; given only with in-chat playback on. */
export type CanPlay = (b: Extract<CardButton, { kind: 'play' }>) => boolean;

/** One episode row: its title, its line, and its lead (a list of at most one, so a row without one draws none). */
export interface MediaRowData {
  title: string;
  line: string;
  lead: MediaButtonData[];
}

/** A group of rows, with its heading as a list of at most one. */
export interface MediaGroupData {
  heading: { label: string }[];
  rows: MediaRowData[];
}

/** Listen and anything that plays wears the play mark; the rest are their words. With `canPlay` (in-chat playback
 * on), a play button that may play carries its item, and every button says which item it plays, if any; a play
 * button that may not is its fallback link. */
function buttonData(b: CardButton | undefined, name: string, canPlay?: CanPlay): MediaButtonData[] {
  if (b?.kind === 'play') {
    if (canPlay?.(b)) {
      const label = `▶ ${b.label}`;
      return [{ label, url: b.fallback?.url ?? '', name, actionType: b.fallback?.actionType ?? '', actionId: b.fallback?.actionId ?? '', mediaId: b.mediaId, rest: label }];
    }
    b = b.fallback;
  }
  if (!b || b.kind !== 'open') return [];
  const play = b.intent === 'consume' && b.actionType === 'ListenAction';
  const label = play ? `▶ ${b.label}` : b.label;
  return [{ label, url: b.url, name, actionType: b.actionType ?? '', actionId: b.actionId ?? '', ...(canPlay ? { mediaId: '', rest: label } : {}) }];
}

const rowData = (r: MediaRow, opts: { withSeries?: boolean; inSeries?: boolean }, canPlay?: CanPlay): MediaRowData => ({
  title: r.title,
  line: mediaLineText(r, opts),
  lead: buttonData(r.ctas?.lead, r.title, canPlay),
});

/** A tap on a media button. The host opens `url` (see `harness/tools/open-target.ts`); it never asks the agent. */
const OPEN_EVENT = {
  event: { name: 'nxis.open', context: { url: '${url}', name: '${name}', actionType: '${actionType}', actionId: '${actionId}' } },
};
/** With in-chat playback on, every media button sends this instead: a tap with a `mediaId` plays it, one without
 * opens `url` as {@link OPEN_EVENT} does. */
const PLAY_EVENT = {
  event: { name: 'nxis.play', context: { mediaId: '${mediaId}', url: '${url}', name: '${name}', actionType: '${actionType}', actionId: '${actionId}' } },
};
const tapEvent = (canPlay?: CanPlay) => (canPlay ? PLAY_EVENT : OPEN_EVENT);

/** "Show all episodes": the host swaps `/groups` (or `/parts`) for the full set (see {@link showAllMessages}). */
const MORE_EVENT = { event: { name: 'nxis.more', context: {} } };

/** The row every media surface draws: title over its line, the lead on the right, always on show. */
function rowComponents(prefix: string, canPlay?: CanPlay): Component[] {
  return [
    { id: `${prefix}_row`, component: 'Row', children: [`${prefix}_who`, `${prefix}_lead`], align: 'center', justify: 'spaceBetween' },
    { id: `${prefix}_who`, component: 'Column', children: [`${prefix}_title`, `${prefix}_line`], weight: 1 },
    { id: `${prefix}_title`, component: 'Text', text: '${title}', variant: 'body' },
    { id: `${prefix}_line`, component: 'Text', text: '${line}', variant: 'caption' },
    { id: `${prefix}_lead`, component: 'List', children: { path: 'lead', componentId: `${prefix}_btn` }, direction: 'horizontal' },
    { id: `${prefix}_btn`, component: 'Button', child: `${prefix}_btn_label`, action: tapEvent(canPlay) },
    { id: `${prefix}_btn_label`, component: 'Text', text: '${label}', variant: 'body' },
  ];
}

const moreComponents = (): Component[] => [
  { id: 'more', component: 'List', children: { path: '/more', componentId: 'more_btn' }, direction: 'vertical' },
  { id: 'more_btn', component: 'Button', child: 'more_label', variant: 'borderless', action: MORE_EVENT },
  { id: 'more_label', component: 'Text', text: '${label}', variant: 'body' },
];

/** Rows shown before "Show all", as the NxisAI app's list shows them. */
const MEDIA_ROWS_SHOWN = 5;

/**
 * Episodes as rows: no initials avatar, "Lantern Hours · Episode 2 · 0:10 · Free", the lead button always on show.
 * Episodes from more than one show are grouped by show under "Lantern Hours · 2", and the row then leaves the show
 * out. Past five rows, the rest wait behind "Show all N episodes".
 */
export function emitMediaSurface(heading: string, rows: MediaRow[], surfaceId = 'results', canPlay?: CanPlay): A2uiMessage[] {
  const groups = groupBySeries(rows);
  const bySeries = groups.length > 1;
  const all: MediaGroupData[] = groups.map((g) => ({
    heading: g.heading ? [{ label: g.heading }] : [],
    rows: g.rows.map((r) => rowData(r, { withSeries: !bySeries }, canPlay)),
  }));
  const fits = rows.length <= MEDIA_ROWS_SHOWN + 1;
  let left = MEDIA_ROWS_SHOWN;
  const shown = fits
    ? all
    : all
        .map((g) => {
          const take = g.rows.slice(0, Math.max(0, left));
          left -= take.length;
          return { ...g, rows: take };
        })
        .filter((g) => g.rows.length);
  const components: Component[] = [
    { id: 'root', component: 'Column', children: ['heading', 'groups', 'more'] },
    { id: 'heading', component: 'Text', text: heading, variant: 'body' },
    { id: 'groups', component: 'List', children: { path: '/groups', componentId: 'group' }, direction: 'vertical' },
    { id: 'group', component: 'Column', children: ['group_heading', 'group_rows'] },
    { id: 'group_heading', component: 'List', children: { path: 'heading', componentId: 'group_label' }, direction: 'vertical' },
    { id: 'group_label', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'group_rows', component: 'List', children: { path: 'rows', componentId: 'ep_row' }, direction: 'vertical' },
    ...rowComponents('ep', canPlay),
    ...moreComponents(),
  ];
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG, components,
      dataModel: { groups: shown, more: fits ? [] : [{ label: `Show all ${rows.length} episodes` }], all: { groups: all } },
    },
  }];
}

/**
 * A series as the Podcast board draws it: its art (when it has an https image), name, "Podcast · publisher · N
 * episodes" and badge; "▶ Listen to the latest" (filled) and Subscribe; then "Episodes", each a row with its own
 * button, three of them until "Show all episodes".
 */
export function emitSeriesSurface(series: SeriesCard, surfaceId = 'results', canPlay?: CanPlay): A2uiMessage[] {
  const parts = series.parts.map((r) => rowData(r, { inSeries: true }, canPlay));
  const fits = parts.length <= SERIES_PARTS_SHOWN;
  const components: Component[] = [
    { id: 'root', component: 'Card', child: 'series' },
    { id: 'series', component: 'Column', children: ['series_head', 'series_actions', 'series_eyebrow', 'parts', 'more'] },
    { id: 'series_head', component: 'Row', children: ['series_art', 'series_who', 'series_badge'], align: 'center' },
    { id: 'series_art', component: 'List', children: { path: '/art', componentId: 'series_art_img' }, direction: 'horizontal' },
    { id: 'series_art_img', component: 'Image', url: '${url}', description: '${alt}', fit: 'cover', variant: 'avatar' },
    { id: 'series_who', component: 'Column', children: ['series_title', 'series_sub'], weight: 1 },
    { id: 'series_title', component: 'Text', text: '${/title}', variant: 'body' },
    { id: 'series_sub', component: 'Text', text: '${/subtitle}', variant: 'caption' },
    { id: 'series_badge', component: 'Text', text: '${/badge}', variant: 'caption' },
    { id: 'series_actions', component: 'Row', children: ['series_lead', 'series_second'] },
    { id: 'series_lead', component: 'List', children: { path: '/lead', componentId: 'series_lead_btn' }, direction: 'horizontal' },
    { id: 'series_lead_btn', component: 'Button', child: 'series_lead_label', variant: 'primary', action: tapEvent(canPlay) },
    { id: 'series_lead_label', component: 'Text', text: '${label}', variant: 'body' },
    { id: 'series_second', component: 'List', children: { path: '/secondary', componentId: 'series_second_btn' }, direction: 'horizontal' },
    { id: 'series_second_btn', component: 'Button', child: 'series_second_label', action: tapEvent(canPlay) },
    { id: 'series_second_label', component: 'Text', text: '${label}', variant: 'body' },
    { id: 'series_eyebrow', component: 'Text', text: 'Episodes', variant: 'caption' },
    { id: 'parts', component: 'List', children: { path: '/parts', componentId: 'part_row' }, direction: 'vertical' },
    ...rowComponents('part', canPlay),
    ...moreComponents(),
  ];
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG, components,
      dataModel: {
        title: series.title,
        subtitle: series.subtitle ?? '',
        badge: series.badge?.label ?? '',
        art: series.art ? [{ url: series.art, alt: series.title }] : [],
        // "Listen to the latest" opens an episode, but the visitor tapped the show.
        lead: buttonData(series.ctas?.lead, series.latest ?? series.title, canPlay),
        secondary: buttonData(series.ctas?.secondary, series.title, canPlay),
        parts: fits ? parts : parts.slice(0, SERIES_PARTS_SHOWN),
        more: fits ? [] : [{ label: 'Show all episodes' }],
        all: { parts },
      },
    },
  }];
}

/**
 * A picture (an ImageObject) as its figure: the picture at feature size (`description` is its alt text), its
 * caption and credit, then License (its `acquireLicensePage`) and its page, each opening as Listen does.
 */
export function emitFigureSurface(title: string, figure: FigureModel, ctas?: CardCtas, surfaceId = 'results'): A2uiMessage[] {
  const buttons = [
    ...(figure.licensePage ? [{ label: 'License', url: figure.licensePage, name: title, actionType: '', actionId: '' }] : []),
    ...(ctas
      ? [...buttonData(ctas.lead, title), ...buttonData(ctas.secondary, title)]
      : figure.page ? [{ label: 'Their page', url: figure.page, name: title, actionType: '', actionId: '' }] : []),
  ];
  const components: Component[] = [
    { id: 'root', component: 'Card', child: 'figure' },
    { id: 'figure', component: 'Column', children: ['fig_image', 'fig_title', 'fig_caption', 'fig_credit', 'fig_actions'] },
    { id: 'fig_image', component: 'List', children: { path: '/image', componentId: 'fig_img' }, direction: 'vertical' },
    { id: 'fig_img', component: 'Image', url: '${url}', description: '${alt}', fit: 'cover', variant: 'mediumFeature' },
    { id: 'fig_title', component: 'Text', text: '${/title}', variant: 'body' },
    { id: 'fig_caption', component: 'Text', text: '${/caption}', variant: 'caption' },
    { id: 'fig_credit', component: 'Text', text: '${/credit}', variant: 'caption' },
    { id: 'fig_actions', component: 'List', children: { path: '/buttons', componentId: 'fig_btn' }, direction: 'horizontal' },
    { id: 'fig_btn', component: 'Button', child: 'fig_btn_label', action: OPEN_EVENT },
    { id: 'fig_btn_label', component: 'Text', text: '${label}', variant: 'body' },
  ];
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG, components,
      dataModel: {
        title,
        caption: figure.caption && figure.caption !== title ? figure.caption : '',
        credit: figure.credit ?? '',
        image: figure.image ? [{ url: figure.image.url, alt: figure.image.alt ?? figure.caption ?? title }] : [],
        buttons: buttons.slice(0, 3),
      },
    },
  }];
}

/**
 * The labels a surface's play buttons change to as playback starts and stops: the playing item's "❚❚ Pause", every
 * other its own words. Walks the data the media surfaces hold (`/groups`, `/parts`, `/lead`, `/secondary` and their
 * `/all` copies); a surface with no play buttons gets nothing.
 *
 * @param read - The live surface's data-model reader (`MountedSurface.read`).
 */
export function pressMessages(surfaceId: string, read: (key: string) => unknown, id: string | null, playing: boolean): A2uiMessage[] {
  const out: A2uiMessage[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}/${i}`));
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.mediaId === 'string' && o.mediaId && typeof o.rest === 'string') {
      const label = playing && o.mediaId === id ? '❚❚ Pause' : o.rest;
      if (label !== o.label) out.push({ version: 'v1.0', updateDataModel: { surfaceId, path: `${path}/label`, value: label } });
      return;
    }
    for (const [k, x] of Object.entries(o)) if (typeof x === 'object') walk(x, `${path}/${k}`);
  };
  for (const key of ['groups', 'parts', 'lead', 'secondary', 'all']) walk(read(key), `/${key}`);
  return out;
}

/**
 * What "Show all" sends: every row the surface holds under `/all`, in place of the few shown, and the button gone.
 *
 * @param read - The live surface's data-model reader (`MountedSurface.read`).
 */
export function showAllMessages(surfaceId: string, read: (key: string) => unknown): A2uiMessage[] {
  const all = read('all') as Record<string, unknown> | undefined;
  if (!all || typeof all !== 'object') return [];
  return [
    ...Object.entries(all).map(([key, value]): A2uiMessage => ({ version: 'v1.0', updateDataModel: { surfaceId, path: `/${key}`, value } })),
    { version: 'v1.0', updateDataModel: { surfaceId, path: '/more', value: [] } },
  ];
}
