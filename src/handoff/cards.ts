/**
 * The handoff targets, read from the relay and from A2A Agent Cards.
 *
 * A relay that is NxisAI's (`<edge>/v1/s/<site>/handoff`) serves the site's
 * specialists as cards beside it, at `<edge>/v1/s/<site>/agents`. Each card
 * names its target in the handoff extension's `params`, and its `url` is the
 * relay's own endpoint for that target. A card whose `url` is anywhere else is
 * not trusted, so neither a stale nor a tampered card can point a handoff,
 * which carries the visitor's conversation, at an endpoint the relay doesn't
 * front.
 *
 * A site that runs its own relay publishes its own cards
 * (`/a2a/<agent>/agent-card.json`) and names one per target in the page's
 * config (`card`). Those are read with the same parser, from the relay's
 * origin only.
 *
 * Loaded with a dynamic `import()` the first time the targets are read (at the
 * first open), so none of this is in what a page downloads on load.
 *
 * @module
 */
import type { AgentSkill, HandoffKind, HandoffTarget, HandoffTargetConfig } from './controller.js';

/**
 * The NxisAI handoff extension, as envelope.ts's `HANDOFF_EXTENSION`. Written out rather than imported, so this
 * chunk shares no module with the page-load graph (a shared module would be split into a chunk of its own).
 */
const HANDOFF_EXTENSION = 'https://nxis.ai/a2a/handoff/v1';

/** A2A Agent Card fields this reads. Anything else on a card is ignored. */
export interface AgentCard {
  name?: string;
  description?: string;
  url?: string;
  version?: string;
  supportedInterfaces?: { url?: string }[];
  capabilities?: { extensions?: { uri?: string; params?: Record<string, unknown> }[] };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: { id?: string; name?: string; description?: string; examples?: string[] }[];
}

/** A card as a target: what the handoff extension names, and what a model reads. */
export interface CardInfo {
  /** The name the relay knows it by, from the handoff extension. */
  target?: string;
  kind?: HandoffKind;
  label: string;
  description?: string;
  skills: AgentSkill[];
  /** Its A2A endpoint, resolved. */
  url: URL | null;
}

/** What the controller keeps between reads: the ETag each card source was last read with. */
export interface CardCache {
  list?: { etag: string; cards: unknown[] };
  /** The relay has no card list (a 404): not asked again. */
  noList?: boolean;
  own?: Map<string, { etag: string; card: unknown }>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const baseHref = (): string => (typeof location === 'undefined' ? 'http://localhost/' : location.href);

function resolve(url: unknown, base: string | URL): URL | null {
  try {
    return str(url) ? new URL(str(url)!, base) : null;
  } catch {
    return null;
  }
}

/**
 * Read an A2A Agent Card: the one place cards are parsed, for the relay's and
 * a self-deployed site's alike.
 *
 * @param raw - The card, as parsed JSON.
 * @param base - What a relative `url` is resolved against: where the card came from.
 * @returns Null when it isn't a card.
 */
export function readAgentCard(raw: unknown, base: string | URL): CardInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as AgentCard;
  const ext = card.capabilities?.extensions?.find((e) => e?.uri === HANDOFF_EXTENSION);
  const params = ext?.params ?? {};
  const label = str(params.label) ?? str(card.name);
  if (!label) return null;
  const kind = params.kind === 'agent' || params.kind === 'person' ? params.kind : undefined;
  const skills: AgentSkill[] = [];
  for (const s of Array.isArray(card.skills) ? card.skills : []) {
    const name = str(s?.name);
    if (!name) continue;
    const examples = (Array.isArray(s.examples) ? s.examples : []).map(str).filter((e): e is string => !!e).slice(0, 2);
    skills.push({ id: str(s.id) ?? name, name, ...(str(s.description) ? { description: str(s.description) } : {}), ...(examples.length ? { examples } : {}) });
  }
  return {
    target: str(params.target),
    kind,
    label,
    description: str(card.description),
    skills,
    url: resolve(card.url ?? card.supportedInterfaces?.[0]?.url, base),
  };
}

/** Where a relay's cards are: `…/handoff` → `…/agents`. Null for a relay with no such sibling. */
export function cardsUrl(relay: URL): URL | null {
  if (!/\/handoff\/?$/.test(relay.pathname)) return null;
  const url = new URL(relay.href);
  url.pathname = relay.pathname.replace(/\/handoff\/?$/, '/agents');
  url.search = url.hash = '';
  return url;
}

/** Whether a card from the relay's list names a target and points at the relay's own endpoint for it. */
export function trustedRelayCard(card: CardInfo, relay: URL): card is CardInfo & { target: string } {
  if (!card.target || !card.url || card.url.search || card.url.hash) return false;
  const path = relay.pathname.replace(/\/$/, '');
  return card.url.origin === relay.origin && card.url.pathname === `${path}/${encodeURIComponent(card.target)}`;
}

/** GET JSON with the ETag it was last read with. Null on a 304 (`cached` stands). */
async function getJson(
  doFetch: typeof fetch,
  url: URL,
  etag: string | undefined,
): Promise<{ status: number; etag: string; body: unknown } | null> {
  const res = await doFetch(url.href, {
    headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
    credentials: 'same-origin',
    cache: 'no-cache',
  });
  if (res.status === 304 && etag) return null;
  if (!res.ok) return { status: res.status, etag: '', body: null };
  return { status: res.status, etag: res.headers.get('ETag') ?? '', body: await res.json() };
}

/** The relay's cards, trusted ones only, by target. Empty when it has none or can't be read. */
async function relayCards(doFetch: typeof fetch, relay: URL, cache: CardCache): Promise<Map<string, CardInfo>> {
  const out = new Map<string, CardInfo>();
  const url = cardsUrl(relay);
  if (!url || cache.noList) return out;
  try {
    const got = await getJson(doFetch, url, cache.list?.etag);
    if (got?.status === 404) cache.noList = true;
    if (got) {
      const agents = (got.body as { agents?: unknown } | null)?.agents;
      cache.list = Array.isArray(agents) && got.etag ? { etag: got.etag, cards: agents } : undefined;
      if (!Array.isArray(agents)) return out;
      for (const raw of agents) addTrusted(out, raw, url, relay);
    } else {
      for (const raw of cache.list!.cards) addTrusted(out, raw, url, relay);
    }
  } catch (err) {
    console.warn('[nxis-handoff] could not read the agent cards:', err);
  }
  return out;
}

function addTrusted(out: Map<string, CardInfo>, raw: unknown, from: URL, relay: URL): void {
  const card = readAgentCard(raw, from);
  if (card && trustedRelayCard(card, relay)) out.set(card.target, card);
  else if (card) console.warn(`[nxis-handoff] ignored the agent card for "${card.label}": it isn't the relay's.`);
}

/**
 * A self-deployed site's own card for a target, named by the page's config:
 * read only from the relay's origin, and only when its endpoint is there too.
 */
async function ownCard(doFetch: typeof fetch, href: string, relay: URL, name: string, cache: CardCache): Promise<CardInfo | null> {
  const url = resolve(href, relay);
  if (!url || url.origin !== relay.origin) return null;
  const own = (cache.own ??= new Map());
  try {
    const hit = own.get(url.href);
    const got = await getJson(doFetch, url, hit?.etag);
    const raw = got ? got.body : hit!.card;
    if (got?.etag && raw) own.set(url.href, { etag: got.etag, card: raw });
    const card = readAgentCard(raw, url);
    if (!card || (card.url && card.url.origin !== relay.origin) || (card.target && card.target !== name)) return null;
    return card;
  } catch {
    return null;
  }
}

/**
 * What a card says a target handles and can do, for the model choosing where to hand a visitor: its description,
 * then each skill with its description and up to two examples.
 */
export function briefOf(card: Pick<CardInfo, 'description' | 'skills'>): string {
  const skills = card.skills
    .map((s) => `${s.name}${s.description ? `: ${s.description}` : ''}${s.examples?.length ? ` (e.g. ${s.examples.map((e) => `"${e}"`).join(', ')})` : ''}`)
    .join('; ');
  return [card.description, skills && `Skills: ${skills}`].filter(Boolean).join('. ').replace(/\.\. /g, '. ');
}

/** One target the relay lists, as it reports it. */
type Listed = Partial<HandoffTarget> & { name?: string };

/**
 * The targets that can be offered: each one the relay lists that the page
 * names or the relay's cards describe, with the relay's availability.
 *
 * The page's config, where it names a target, decides its kind, label and
 * visitor-facing description; a card adds what a model reads (its
 * description and skills). A target the relay doesn't list is never offered.
 *
 * @throws When the relay's target list can't be read.
 */
export async function loadTargets(
  opts: { relay: string; targets?: Record<string, HandoffTargetConfig>; fetchImpl?: typeof fetch },
  cache: CardCache,
): Promise<HandoffTarget[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const relay = new URL(opts.relay, baseHref());
  const config = opts.targets ?? {};
  const [listed, cards] = await Promise.all([
    (async () => {
      const res = await doFetch(opts.relay, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`GET ${opts.relay} → ${res.status}`);
      return ((await res.json()) as { targets?: Listed[] }).targets ?? [];
    })(),
    relayCards(doFetch, relay, cache),
  ]);
  const listedNames = new Set(listed.map((t) => String(t.name ?? '')));
  const own = new Map<string, CardInfo>();
  await Promise.all(
    Object.entries(config)
      .filter(([name, t]) => t.card && !cards.has(name) && listedNames.has(name))
      .map(async ([name, t]) => {
        const card = await ownCard(doFetch, t.card!, relay, name, cache);
        if (card) own.set(name, card);
      }),
  );

  const out: HandoffTarget[] = [];
  for (const t of listed) {
    const name = String(t.name ?? '');
    const mine = config[name];
    const relayCard = cards.get(name);
    // The page, or the relay's own card, decides what is offered; the relay's list decides what is reachable.
    if (!mine && !relayCard) continue;
    const card = relayCard ?? own.get(name);
    out.push({
      name,
      kind: mine?.kind ?? card?.kind ?? 'agent',
      label: mine?.label ?? card!.label,
      description: mine?.description ?? t.description,
      ...(card && briefOf(card) ? { brief: briefOf(card) } : {}),
      ...(card?.skills.length ? { skills: card.skills } : {}),
      available: t.available !== false,
      hours: t.hours,
      queueLength: t.queueLength,
      waitMinutes: t.waitMinutes ?? null,
      transcript: t.transcript === true,
      ...(mine?.takes?.length ? { takes: [...mine.takes] } : {}),
    });
  }
  return out;
}
