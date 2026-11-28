/**
 * The handoff extension: what a handoff carries, and how it reads the answers.
 *
 * Everything travels as A2A `data` parts marked with {@link HANDOFF_EXTENSION},
 * so a target that knows nothing of it still works. See `docs/handoff.md`.
 *
 * @module
 */
import { newMessageId, type A2AMessage, type A2APart } from './a2a.js';

/** The extension's URI, announced in `A2A-Extensions` and on every part it adds. */
export const HANDOFF_EXTENSION = 'https://nxis.ai/a2a/handoff/v1';

/** What the first message of a handoff carries. */
export interface HandoffEnvelope {
  /** Why, in one line. */
  reason: string;
  /** What the target needs to know. The visitor has seen it. */
  summary: string;
  /** The page the visitor is on. */
  page: { url: string; title: string; entity?: string };
  /** Values the visitor gave and agreed to share. */
  facts?: { name: string; value: string }[];
  /** The last turns, text only. Only for a target the relay allows it for. */
  transcript?: { role: 'visitor' | 'assistant'; text: string }[];
  /**
   * The visitor's details. To an agent: the ones they gave or confirmed earlier in this conversation, so the target
   * doesn't ask again. To a person: an email address, only when they asked to be contacted.
   */
  contact?: HandoffContact;
  /** The visitor's language. */
  locale: string;
  /**
   * What this page can draw of a target's replies, by version: `cards` draws an
   * {@link HandoffAnswer}'s sources (2: numbered, with a marker on each claim), and `feedback: 1` puts 👍 and 👎 on each answer that
   * has an `answerId`, sent back as a {@link feedbackMessage}. A target that finds no
   * `ui.cards` sends its sources as text instead.
   */
  ui: HandoffUi;
  /** Where a hand-back belongs. */
  returnTo: { conversationId: string; origin: string };
  /** What was agreed to: the target, the fields sent, and when. */
  consent: { target: string; shared: string[]; at: string };
}

/** The visitor's details, as a handoff carries them: every field optional, each a short string. */
export interface HandoffContact {
  name?: string;
  email?: string;
  phone?: string;
  street?: string;
  city?: string;
  zip?: string;
}

/** The fields of {@link HandoffContact}, in the order a card lists them. */
export const CONTACT_FIELDS = ['name', 'email', 'phone', 'street', 'city', 'zip'] as const;

/**
 * A `contact` as sent, read strictly: only the {@link CONTACT_FIELDS}, each a string without control characters,
 * trimmed and at most 200 characters. Null when none is left.
 */
export function readContact(v: unknown): HandoffContact | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: HandoffContact = {};
  for (const k of CONTACT_FIELDS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x !== 'string') continue;
    const t = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** What the page can draw of a target's replies. */
export interface HandoffUi {
  /**
   * The version of {@link HandoffAnswer} cards the page draws. 2: its sources as a numbered list in the reply's
   * bubble, and a marker after each claim whose text the answer gives ({@link HandoffAnswer.claims}).
   */
  cards?: number;
  /** The version of answer feedback the page sends: 👍 and 👎, as a `feedback` part. */
  feedback?: number;
  /**
   * The version of step surfaces the page draws: 1, A2UI v1.0 messages in a `surface` part, on the steps catalog,
   * with the visitor's choices sent back as `action` parts; 2, also the guided intake's `ChoiceChips`, `StepHeader`
   * and `FieldNote`; 3, also a TextField's and a ChoiceChips' `required`, `optional` and `error`. See
   * docs/quote-booking-surfaces.md.
   */
  surfaces?: number;
}

/** What this harness draws: an `answer` part's sources, version 2, feedback on each answer, version 1, and step surfaces, version 3. */
export const HANDOFF_UI: Readonly<HandoffUi> = Object.freeze({ cards: 2, feedback: 1, surfaces: 3 });

/** 👍 or 👎. */
export type FeedbackValue = 'up' | 'down';

/** How a handoff ended, from the target's `handback` part. */
export interface HandBack {
  outcome: 'resolved' | 'unresolved' | 'transferred';
  note: string;
  references: { label: string; value: string }[];
  /**
   * The visitor's details the target took from what they confirmed (its review card, a form they sent): the page
   * keeps them for the conversation, so the next agent doesn't ask again.
   */
  contact?: HandoffContact;
  /**
   * Another agent target the visitor asked for (a receipt's "Book a visit too"): the page offers the handoff to it
   * at once, as its own Hand over card, when it is listed, available, and not the target that handed back.
   */
  next?: { target: string; reason: string; summary: string };
}

/** Query parameters that only describe how a page was reached or shown, never which page it is. */
const DYNAMIC_PARAMS = /^(surface|utm_.*|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga)$/i;

/**
 * A page's address without the parameters that don't identify it.
 *
 * `?surface=window` says how the agent is shown, and `utm_*` how the visitor
 * arrived; neither is part of the page a target should look up.
 */
export function cleanPageUrl(href: string): string {
  try {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      if (DYNAMIC_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch {
    return href;
  }
}

/** The JSON-LD `@id` of what this page is about, if it declares one for itself. */
export function pageEntity(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string | undefined {
  if (!doc) return undefined;
  const here = cleanPageUrl(doc.location?.href ?? '');
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let json: unknown;
    try {
      json = JSON.parse(script.textContent || '');
    } catch {
      continue;
    }
    const nodes = Array.isArray(json)
      ? json
      : ((json as { '@graph'?: unknown[] })?.['@graph'] ?? [json]);
    for (const node of nodes as { '@id'?: unknown }[]) {
      const id = typeof node?.['@id'] === 'string' ? node['@id'] : '';
      // The entity the page is about is named `<page url>#…` by the NxisAI crawler.
      if (id && here && id.startsWith(here.split('#')[0] + '#')) return id;
    }
  }
  return undefined;
}

/** What {@link buildEnvelope} needs beyond the page. */
export interface EnvelopeInput {
  target: string;
  reason: string;
  summary: string;
  conversationId: string;
  facts?: { name: string; value: string }[];
  transcript?: { role: 'visitor' | 'assistant'; text: string }[];
  contact?: HandoffContact;
  /** Overrides, for tests and for hosts outside a browser. */
  page?: { url: string; title: string; entity?: string };
  locale?: string;
  origin?: string;
  now?: () => Date;
}

/** The envelope for a handoff, with its consent record filled from what is actually sent. */
export function buildEnvelope(input: EnvelopeInput): HandoffEnvelope {
  const doc = typeof document === 'undefined' ? undefined : document;
  const page = input.page ?? {
    url: cleanPageUrl(doc?.location?.href ?? ''),
    title: doc?.title ?? '',
    entity: pageEntity(doc),
  };
  if (!page.entity) delete page.entity;
  const envelope: HandoffEnvelope = {
    reason: input.reason.trim(),
    summary: input.summary.trim(),
    page,
    locale: input.locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'),
    ui: { ...HANDOFF_UI },
    returnTo: {
      conversationId: input.conversationId,
      origin: input.origin ?? (typeof location === 'undefined' ? '' : location.origin),
    },
    consent: { target: input.target, shared: [], at: (input.now?.() ?? new Date()).toISOString() },
  };
  if (input.facts?.length) envelope.facts = input.facts;
  if (input.transcript?.length) envelope.transcript = input.transcript;
  const contact = readContact(input.contact);
  if (contact) envelope.contact = contact;
  envelope.consent.shared = Object.keys(envelope).filter((k) => k !== 'consent' && k !== 'returnTo' && k !== 'locale' && k !== 'ui');
  return envelope;
}

/** A data part marked with the extension. */
export function extensionPart(data: Record<string, unknown>): A2APart {
  return { data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } };
}

/** The first message of a handoff: the summary as text, for any target, and the envelope as data. */
export function envelopeMessage(envelope: HandoffEnvelope): A2AMessage {
  const lines = [envelope.summary];
  if (envelope.page.url) lines.push(`Page: ${envelope.page.title ? `${envelope.page.title} (${envelope.page.url})` : envelope.page.url}`);
  return {
    messageId: newMessageId(),
    role: 'ROLE_USER',
    parts: [{ text: lines.join('\n\n') }, extensionPart({ handoff: 'envelope', ...envelope })],
    extensions: [HANDOFF_EXTENSION],
  };
}

/** A message the visitor typed during a handoff. */
export function visitorMessage(text: string, ids: { taskId?: string; contextId?: string }): A2AMessage {
  const message: A2AMessage = { messageId: newMessageId(), role: 'ROLE_USER', parts: [{ text }] };
  if (ids.taskId) message.taskId = ids.taskId;
  if (ids.contextId) message.contextId = ids.contextId;
  return message;
}

/**
 * 👍 or 👎 on one of the target's answers, on the same task: a `feedback` part and nothing else. It is not
 * something the visitor said, so it has no text part.
 */
export function feedbackMessage(answerId: string, value: FeedbackValue, ids: { taskId?: string; contextId?: string }): A2AMessage {
  const message = visitorMessage('', ids);
  message.parts = [extensionPart({ handoff: 'feedback', answerId, value })];
  return message;
}

/** The extension data in a part, and which kind it is, or null for any other part. */
export function extensionData(part: A2APart): (Record<string, unknown> & { handoff: string }) | null {
  const data = part.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || typeof data.handoff !== 'string') return null;
  // Marked parts are ours; an unmarked one with the same shape is accepted too, since some servers
  // drop part metadata, but only for the kinds we define.
  const marked = part.metadata?.extension === HANDOFF_EXTENSION;
  if (!marked && !['queue', 'operator', 'handback', 'answer', 'surface'].includes(data.handoff)) return null;
  return data as Record<string, unknown> & { handoff: string };
}

/**
 * A hand-back's `next`, read strictly: `target`, `reason` and `summary`, each a string, trimmed, without control
 * characters, not empty, and at most 64, 200 and 1,000 characters. Null when any of them isn't.
 */
function readNext(v: unknown): HandBack['next'] | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, max] of [['target', 64], ['reason', 200], ['summary', 1000]] as const) {
    const x = (v as Record<string, unknown>)[k];
    const t = typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
    if (!t || t.length > max) return null;
    out[k] = t;
  }
  return out as HandBack['next'];
}

/** A `handback` part's contents, tidied, or null. */
export function readHandBack(parts: A2APart[] = []): HandBack | null {
  for (const part of parts) {
    const data = extensionData(part);
    if (data?.handoff !== 'handback') continue;
    const outcome = data.outcome === 'unresolved' || data.outcome === 'transferred' ? data.outcome : 'resolved';
    const references = Array.isArray(data.references)
      ? (data.references as { label?: unknown; value?: unknown }[])
          .filter((r) => r && r.value !== undefined && r.value !== null && String(r.value).trim())
          .map((r) => ({ label: String(r.label ?? 'Reference'), value: String(r.value) }))
      : [];
    const contact = readContact(data.contact);
    const next = readNext(data.next);
    return { outcome, note: String(data.note ?? '').trim(), references, ...(contact ? { contact } : {}), ...(next ? { next } : {}) };
  }
  return null;
}

/**
 * The A2UI messages of a message's `surface` parts, as sent: the step surfaces chunk reads them strictly
 * (`a2ui/steps.ts`) before anything is kept or drawn. Null when there are none.
 */
export function readSurface(parts: A2APart[] = []): unknown[] | null {
  const out = parts.flatMap((p) => {
    const data = extensionData(p);
    return data?.handoff === 'surface' && Array.isArray(data.messages) ? data.messages : [];
  });
  return out.length ? out : null;
}

/** A `queue` part's position and wait, or null. */
export function readQueue(parts: A2APart[] = []): { position?: number; waitMinutes?: number } | null {
  for (const part of parts) {
    const data = extensionData(part);
    if (data?.handoff !== 'queue') continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { position: num(data.position), waitMinutes: num(data.waitMinutes) };
  }
  return null;
}

/** An `operator` part's name and kind, or null. */
export function readOperator(parts: A2APart[] = []): { name: string; kind: 'person' | 'agent' } | null {
  for (const part of parts) {
    const data = extensionData(part);
    if (data?.handoff !== 'operator' || typeof data.name !== 'string' || !data.name.trim()) continue;
    return { name: data.name.trim(), kind: data.kind === 'agent' ? 'agent' : 'person' };
  }
  return null;
}

/** The text a visitor should read from some parts: text parts, and files by name. Data parts are not shown. */
export function readableText(parts: A2APart[] = []): string {
  return parts
    .map((p) => {
      if (typeof p.text === 'string') return p.text;
      if (p.url) return p.filename ? `${p.filename}: ${p.url}` : p.url;
      return '';
    })
    .filter((t) => t.trim())
    .join('\n\n')
    .trim();
}

// ── The answer part ─────────────────────────────────────────────────────────

/** The passage a card cites: a question's name, a step, a clip and its time. */
export interface CardFocus {
  path: string;
  label: string;
  /** Where a clip starts, in seconds. */
  startOffset?: number;
  url?: string;
}

/**
 * One cited record, as a target copies it from what it fetched. Every field is data:
 * the harness draws it as text and links, and never as markup.
 */
export interface CardRecord {
  '@id': string;
  '@type': string | string[];
  name?: string;
  headline?: string;
  url?: string;
  datePublished?: string;
  dateModified?: string;
  publisher?: unknown;
  author?: unknown;
  image?: unknown;
  thumbnailUrl?: unknown;
  duration?: string;
  contentUrl?: string;
  embedUrl?: string;
  focus?: CardFocus;
  /** `page` for a page cited by its description alone: drawn as "From the page". */
  citation?: 'typed' | 'page';
}

/** Which card supports which claim of the text. */
export interface AnswerCite {
  claim: number;
  id: string;
  path?: string;
  /** The card's `@id`, when `id` is a passage's own (a question or a step with an `@id` of its own). */
  record?: string;
}

/** An `answer` part: the cards for an answer's sources, and the claims they support. */
export interface HandoffAnswer {
  /** Opaque, per answer: what feedback on it names. */
  answerId: string;
  cards: CardRecord[];
  cites: AnswerCite[];
  /**
   * The text each claim is drawn as in the reply, by claim index (`''` for one with none of its own): where the
   * page puts the claim's markers. Optional; without it the sources are listed with no markers in the text.
   */
  claims?: string[];
  /** A line for the visitor above the answer: the language it is in, when it isn't theirs. */
  note?: string;
}

/** At most this many cards per answer, and cites. */
export const MAX_ANSWER_CARDS = 12;
const MAX_CITES = 60;
const MAX_TEXT = 2048;

const text = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

/**
 * A value as plain data, and small: strings, finite numbers, booleans, and lists and
 * objects of them a few levels deep. Anything else is dropped.
 */
function plain(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return text(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (!v || typeof v !== 'object' || depth >= 3) return undefined;
  if (Array.isArray(v)) {
    const out = v.slice(0, 8).map((x) => plain(x, depth + 1)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 16)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const y = plain(x, depth + 1);
    if (y !== undefined) out[k] = y;
  }
  return Object.keys(out).length ? out : undefined;
}

const STRING_FIELDS = ['name', 'headline', 'url', 'datePublished', 'dateModified', 'duration', 'contentUrl', 'embedUrl'] as const;
const DATA_FIELDS = ['publisher', 'author', 'image', 'thumbnailUrl'] as const;

/** One card as sent, tidied, or null when it has no `@id` or `@type`. */
export function readCard(v: unknown): CardRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = text(o['@id']);
  const types = (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).map((t) => text(t, 200)).filter((t): t is string => !!t).slice(0, 4);
  if (!id || !types.length) return null;
  const card: CardRecord = { '@id': id, '@type': types.length === 1 ? types[0] : types };
  for (const k of STRING_FIELDS) {
    const s = text(o[k]);
    if (s) card[k] = s;
  }
  for (const k of DATA_FIELDS) {
    const d = plain(o[k]);
    if (d !== undefined) card[k] = d;
  }
  const f = o.focus as Record<string, unknown> | undefined;
  const label = f && typeof f === 'object' ? text(f.label, 300) : undefined;
  if (f && label) {
    const at = typeof f.startOffset === 'number' && Number.isFinite(f.startOffset) && f.startOffset >= 0 ? Math.floor(f.startOffset) : undefined;
    const url = text(f.url);
    card.focus = { path: text(f.path, 300) ?? '', label, ...(at !== undefined ? { startOffset: at } : {}), ...(url ? { url } : {}) };
  }
  if (o.citation === 'page' || o.citation === 'typed') card.citation = o.citation;
  return card;
}

/**
 * An `answer` part's contents, tidied, or null. Cards without an `@id` or a type are
 * dropped, every string is trimmed and capped, and fields outside {@link CardRecord}
 * are left behind: what remains is data to draw, never markup or code.
 */
export function readAnswer(parts: A2APart[] = []): HandoffAnswer | null {
  for (const part of parts) {
    const data = extensionData(part);
    if (data?.handoff !== 'answer') continue;
    const cards = (Array.isArray(data.cards) ? data.cards : []).map(readCard).filter((c): c is CardRecord => !!c).slice(0, MAX_ANSWER_CARDS);
    const cites = (Array.isArray(data.cites) ? data.cites : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ claim: c.claim, id: text(c.id), path: text(c.path, 300), record: text(c.record) }))
      .filter((c): c is { claim: number; id: string; path: string | undefined; record: string | undefined } => typeof c.claim === 'number' && Number.isInteger(c.claim) && c.claim >= 0 && !!c.id)
      .slice(0, MAX_CITES)
      .map((c) => ({ claim: c.claim, id: c.id, ...(c.path ? { path: c.path } : {}), ...(c.record ? { record: c.record } : {}) }));
    const claims = (Array.isArray(data.claims) ? data.claims : []).slice(0, MAX_CITES).map((c) => text(c) ?? '');
    const note = text(data.note, 500);
    if (!cards.length && !note) continue;
    return { answerId: text(data.answerId, 200) ?? '', cards, cites, ...(claims.some(Boolean) ? { claims } : {}), ...(note ? { note } : {}) };
  }
  return null;
}
