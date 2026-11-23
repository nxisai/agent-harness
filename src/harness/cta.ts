/**
 * The action a result card offers, chosen from the record's own `potentialAction`.
 *
 * One map, shared with the Typed Retrieval skill and the NxisAI app's widgets: the action's `@type` alone
 * decides the button, and the button sends the same prompt
 * everywhere ("Get a quote from Hatzel & Sons Plumbing"), so the funnel cannot tell which surface it came
 * from. Commerce, read and search actions get no button here.
 *
 * On the site's own page every mapped action sends the prompt, a self-page form included: the on-page agent
 * is what runs that form. Only the NxisAI app, which cannot reach the page, opens it instead.
 *
 * Media is the exception: Listen and Subscribe are not requests for the agent to
 * carry out but places on the site to go, the episode's player and the subscribe page. {@link mediaCtas} and
 * {@link seriesCtas} give a lead button and a second one, each opening its action's own `target`, worded by
 * access from the renderer spec. {@link cardCtas} picks between the two kinds for any record.
 *
 * @module
 */
import { access, accessAction, archetype, SPEC, worksOf, type Access, type Archetype } from './entity.js';
import { RENDERER_SPEC } from './renderer-spec.js';
import type { MediaModel } from './playable.js';

/** What a card's action button says and sends. */
export interface CardAction {
  label: string;
  /** The message sent as the visitor when the button is pressed. */
  message: string;
}

const MAP: Record<string, { label: string; message: (name: string) => string }> = {
  QuoteAction: { label: 'Get a quote', message: (n) => `Get a quote from ${n}` },
  AskAction: { label: 'Contact', message: (n) => `Contact ${n}` },
  ReserveAction: { label: 'Reserve', message: (n) => `Reserve at ${n}` },
  ScheduleAction: { label: 'Book an appointment', message: (n) => `Book an appointment at ${n}` },
  ApplyAction: { label: 'Apply', message: (n) => `Apply to ${n}` },
};

/** When a record carries several, the first of these wins. */
const ORDER = Object.keys(MAP);

const shortType = (t: unknown): string =>
  typeof t === 'string' ? t.replace(/^https?:\/\/schema\.org\//, '') : '';

const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * The button for a record, or none.
 *
 * @param record - The record as a tool returned it; action `@type`s may be full IRIs.
 * @param name - What to call it in the message; the record's own name by default.
 */
export function actionCta(record: Record<string, unknown>, name?: string): CardAction | undefined {
  const types = list(record.potentialAction)
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .flatMap((a) => list(a['@type']).map(shortType))
    .filter((t) => t in MAP)
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!types.length) return undefined;
  const who = (name ?? (typeof record.name === 'string' ? record.name : '')).trim() || 'them';
  const entry = MAP[types[0]];
  return { label: entry.label, message: entry.message(who) };
}

// ── Media: Listen and Subscribe ─────────────────────────────────────────────

/** A button that opens a place on the site: an episode's player, the subscribe page, the record's page. */
export interface OpenAction {
  label: string;
  /** Where a tap goes: the action's own target, http(s), with nothing left to fill in. */
  url: string;
  /** What the tap is for, as the spec says: play it, pay or sign up for it, or just go and look. */
  intent: 'consume' | 'transact' | 'navigate';
  /** The schema.org action it opens; none for "Their page". A cited video's Watch is a WatchAction. */
  actionType?: 'ListenAction' | 'SubscribeAction' | 'WatchAction';
  /** The action's `@id`, and the token the site signed into it, for reporting the tap as the NxisAI app does. */
  actionId?: string;
  reportToken?: string;
  /** Listening takes paying: drawn with a lock. */
  locked?: boolean;
}

/**
 * A button that plays in the chat's docked player (`media="play"`), and the page it opens instead when it can't:
 * the gate refuses it now, its host is blocked, or the browser can play none of its files.
 */
export interface PlayAction {
  label: string;
  /** The item it plays: its media object's `@id`, or, for "Listen to the latest" while its episode is fetched, the
   * episode's. */
  mediaId: string;
  /** What it plays; absent until "Listen to the latest" has fetched its episode. */
  media?: MediaModel;
  fallback?: { kind: 'open' } & OpenAction;
}

/** One button on a card: ask the agent (the funnel actions), open a page (media), or play in the chat. */
export type CardButton = ({ kind: 'ask' } & CardAction) | ({ kind: 'open' } & OpenAction) | ({ kind: 'play' } & PlayAction);

/** A card's buttons: the lead, drawn filled, and at most one beside it. */
export interface CardCtas {
  lead: CardButton;
  secondary?: CardButton;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const get = (o: unknown, key: string): unknown => (isObj(o) ? o[key] ?? o[`https://schema.org/${key}`] : undefined);
const nx = (o: unknown, key: string): unknown => (isObj(o) ? o[`nxis:${key}`] ?? o[`https://nxis.ai/ns#${key}`] : undefined);
const actionsOf = (record: Obj): Obj[] => list(record.potentialAction).filter(isObj);
const typeOfAction = (a: Obj): string => shortType(first(a['@type']));
const no = (v: unknown) => v === false || v === 'false' || v === 'False';
const bare = (u: string | undefined): string | undefined => u?.split('#')[0];

/** Where an action's target opens: a URL, or an EntryPoint's `urlTemplate` or `url`, http(s) only and with nothing
 * left to fill in. Anything else opens nothing, so its button is not drawn. */
export function targetUrl(action: unknown): string | undefined {
  const t = first(get(action, 'target'));
  const u = typeof t === 'string' ? str(t) : str(get(t, 'urlTemplate') ?? get(t, 'url'));
  return u && /^https?:\/\//i.test(u) && !/[{}]/.test(u) ? u : undefined;
}

// Read from the generated spec itself, so a sync that drops a label fails the build rather than drawing "undefined".
const LISTEN = RENDERER_SPEC.actions.ListenAction;
const SUBSCRIBE = RENDERER_SPEC.actions.SubscribeAction;

function opener(a: Obj, type: 'ListenAction' | 'SubscribeAction', label: string, intent: OpenAction['intent']): { kind: 'open' } & OpenAction {
  const id = str(a['@id']);
  const token = str(nx(a, 'reportToken'));
  return { kind: 'open', label, url: targetUrl(a)!, intent, actionType: type, ...(id ? { actionId: id } : {}), ...(id && token ? { reportToken: token } : {}) };
}

const theirPage = (url: string): { kind: 'open' } & OpenAction => ({ kind: 'open', label: 'Their page', url, intent: 'navigate' });

/** The two buttons a card draws, from a list in the order they lead: a page button only where no other opens it. */
function pair(buttons: CardButton[], page: string | undefined): CardCtas | undefined {
  const opensPage = buttons.some((b) => b.kind === 'open' && bare(b.url) === bare(page));
  const all = page && !opensPage ? [...buttons, theirPage(page)] : buttons;
  return all.length ? { lead: all[0], ...(all[1] ? { secondary: all[1] } : {}) } : undefined;
}

/**
 * Listen and Subscribe for a media item (or a series that doesn't list its parts), each opening its own target on
 * the site, worded by access as the NxisAI app words them:
 *
 * - free, or nothing known: **Listen** · Subscribe
 * - a free preview: **Listen to preview** · Subscribe
 * - a subscription: **Subscribe to listen** (Subscribe's target, or Listen's with no Subscribe) · Their page
 * - a free sign-up: **Sign up to listen** · Their page
 *
 * "Their page" is left out when a button already opens the record's page (Listen opening its `#player`).
 *
 * @param acc - Its access; read from the record and its Listen when not given.
 */
export function mediaCtas(record: Obj, acc: Access | undefined = access(record, accessAction(record)), arch: Archetype = archetype(record)): CardCtas | undefined {
  const find = (type: string) => actionsOf(record).find((a) => typeOfAction(a) === type && targetUrl(a));
  const listen = find('ListenAction');
  const subscribe = find('SubscribeAction');
  const page = str(record.url);
  const state = acc?.state;
  if (listen && (state === 'subscription' || state === 'registration')) {
    const label = state === 'registration' ? LISTEN.registrationLabel : LISTEN.paidLabel;
    const lead = subscribe ? opener(subscribe, 'SubscribeAction', label, 'transact') : opener(listen, 'ListenAction', label, 'transact');
    return pair([{ ...lead, ...(state === 'subscription' ? { locked: true } : {}) }], page);
  }
  const out: CardButton[] = [];
  if (listen) out.push(opener(listen, 'ListenAction', state === 'preview' && arch !== 'series' ? LISTEN.previewLabel : LISTEN.label, 'consume'));
  if (subscribe) out.push(opener(subscribe, 'SubscribeAction', SUBSCRIBE.label, 'transact'));
  return out.length ? pair(out, page) : undefined;
}

/**
 * A series' parts as episodes of their own: each named as part of the series, and one that isn't free and names
 * no Subscribe of its own subscribing through the series'. Google's paywall sections are not parts.
 */
export function seriesParts(record: Obj): Obj[] {
  const subscribe = actionsOf(record).find((a) => typeOfAction(a) === 'SubscribeAction' && targetUrl(a));
  const name = str(record.name);
  return worksOf(record).map((p) => {
    const own = actionsOf(p);
    const subscribes = own.some((a) => typeOfAction(a) === 'SubscribeAction');
    return {
      ...p,
      '@type': p['@type'] ?? 'PodcastEpisode',
      partOfSeries: p.partOfSeries ?? (name ? { name } : undefined),
      // Only one that isn't free: a free episode's own lead is Listen, never Subscribe.
      potentialAction: subscribe && !subscribes && no(get(p, 'isAccessibleForFree')) ? [...own, subscribe] : own,
    };
  });
}

/** A series' badge, said from its parts' access: all free, some, or none. */
export function seriesAccess(parts: Obj[]): { state: 'free' | 'mixed' | 'subscription'; label: string } | undefined {
  if (!parts.length) return undefined;
  const free = parts.filter((p) => access(p, accessAction(p))?.state === 'free').length;
  const A = SPEC.seriesAccess;
  return !free ? { state: 'subscription', label: A.none } : free === parts.length ? { state: 'free', label: A.all } : { state: 'mixed', label: A.some };
}

/**
 * A series' buttons (the Podcast board): with a free episode, **Listen to the latest**
 * (the latest free one's Listen, by `datePublished`, then `episodeNumber`) · Subscribe; with none, **Subscribe to
 * listen** (the series' Subscribe, else a part's) · Their page. A series that doesn't list its parts gets
 * {@link mediaCtas}.
 */
export function seriesCtas(record: Obj): CardCtas | undefined {
  const parts = seriesParts(record);
  if (!parts.length) return mediaCtas(record, undefined, 'series');
  const rows = parts.map((p) => {
    const acc = access(p, accessAction(p));
    return { acc, ctas: mediaCtas(p, acc, 'media'), published: str(p.datePublished) ?? '', episode: num(p.episodeNumber) ?? -1 };
  });
  const listens = rows
    .filter((r) => r.acc?.state === 'free')
    .map((r) => ({ ...r, listen: [r.ctas?.lead, r.ctas?.secondary].find((b) => b?.kind === 'open' && b.actionType === 'ListenAction' && b.intent === 'consume') }))
    .filter((r) => r.listen);
  const newer = (a: (typeof listens)[number], b: (typeof listens)[number]) =>
    a.published !== b.published ? a.published > b.published : a.episode >= b.episode;
  const latest = listens.reduce<(typeof listens)[number] | undefined>((best, r) => (!best || newer(r, best) ? r : best), undefined);
  const own = mediaCtas(record, undefined, 'series');
  const sub = [own?.lead, own?.secondary].find((b) => b?.kind === 'open' && b.actionType === 'SubscribeAction');
  if (latest?.listen) {
    return { lead: { ...latest.listen, label: LISTEN.latestLabel }, ...(sub ? { secondary: { ...sub, label: SUBSCRIBE.label } } : {}) };
  }
  const paid = sub ?? rows.map((r) => r.ctas?.lead).find((b) => b?.kind === 'open' && b.intent === 'transact');
  const page = str(record.url);
  if (!paid) return page ? { lead: theirPage(page) } : undefined;
  const lead: CardButton = { ...paid, label: LISTEN.paidLabel, intent: 'transact', locked: true } as CardButton;
  return { lead, ...(page ? { secondary: theirPage(page) } : {}) };
}

type Open = { kind: 'open' } & OpenAction;
const isListen = (b: CardButton | undefined): b is Open => b?.kind === 'open' && b.intent === 'consume' && /^(Listen|Watch)Action$/.test(b.actionType ?? '');

/** A Listen as a play button: same words, its own action reported, its page kept as the fallback. */
const toPlay = (b: Open, media?: MediaModel, mediaId = media?.id ?? ''): { kind: 'play' } & PlayAction => ({
  kind: 'play',
  label: b.label,
  mediaId,
  ...(media ? { media: { ...media, ...(b.actionType ? { actionType: b.actionType } : {}), ...(b.actionId ? { actionId: b.actionId } : {}), ...(b.reportToken ? { reportToken: b.reportToken } : {}) } } : {}),
  fallback: b,
});

/**
 * A card's buttons with in-chat playback on: its Listen (or "Listen to preview") plays `media` in the docked player,
 * its page kept as the fallback. A record that plays but has no Listen leads with one of its own, **Listen** or
 * **Watch**, opening its page when it can't play. Everything else is as it was.
 */
export function playCtas(ctas: CardCtas | undefined, media: MediaModel): CardCtas {
  if (ctas && isListen(ctas.lead)) return { ...ctas, lead: toPlay(ctas.lead, media) };
  if (ctas && isListen(ctas.secondary)) return { ...ctas, secondary: toPlay(ctas.secondary, media) };
  const spec = media.kind === 'video' ? RENDERER_SPEC.actions.WatchAction : LISTEN;
  const page: Open | undefined = media.page ? { kind: 'open', label: spec.label, url: media.page, intent: 'consume' } : undefined;
  const lead: CardButton = { kind: 'play', label: spec.label, mediaId: media.id, media, ...(page ? { fallback: page } : {}) };
  return { lead, ...(ctas ? { secondary: ctas.lead } : {}) };
}

/** A series' "Listen to the latest" as a play button whose episode is fetched when the card is drawn (a series' parts
 * carry no media): it plays once that arrives, and opens the episode until then. */
export function playLatestCtas(ctas: CardCtas, episodeId: string): CardCtas {
  return isListen(ctas.lead) ? { ...ctas, lead: toPlay(ctas.lead, undefined, episodeId) } : ctas;
}

/** The play button on a card for an item, if any: what a tap in the A2UI view, which carries only its id, plays. */
export function playButtonFor(ctasList: (CardCtas | undefined)[], mediaId: string): ({ kind: 'play' } & PlayAction) | undefined {
  for (const c of ctasList) for (const b of [c?.lead, c?.secondary]) if (b?.kind === 'play' && b.mediaId === mediaId) return b;
  return undefined;
}

/**
 * The buttons for any record: a media item's or a series' Listen and Subscribe, or the funnel action that asks the
 * agent ({@link actionCta}) as the only one. Quote, Reserve and the rest are exactly what {@link actionCta} gives.
 */
export function cardCtas(record: Obj, name?: string): CardCtas | undefined {
  const arch = archetype(record);
  if (arch === 'media') return mediaCtas(record, undefined, arch);
  if (arch === 'series') return seriesCtas(record);
  const ask = actionCta(record, name);
  return ask ? { lead: { kind: 'ask', ...ask } } : undefined;
}
