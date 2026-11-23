/**
 * A remote agent's answer, as the thread draws it: its reply with links that open, the language note above it, and
 * the views of its sources, which ./sources.ts draws as the numbered Sources list (and, for a video or a profile,
 * its card).
 *
 * The views are the answer view's own cards ({@link citeCards}), read from the records by the same renderer-spec rules as a
 * search's results: a help article or a how-to is `readable` (Read, and "Their page"), a video `media` (Watch), a
 * person `profile` and a product `offerable` ("Their page"). None carries an action CTA. A page cited by its
 * description alone is labelled "From the page", with one "Open the page" link. A record already drawn in the
 * conversation is marked `compact`: listed, and its card not drawn again.
 *
 * Everything here is data from another server: set as text, never as markup, and a link is drawn only when its
 * address is on an origin the page allows ({@link allowedLink}).
 *
 * @module
 */
import type { CardRecord, HandoffAnswer } from '../handoff/envelope.js';
import { archetype, clock, entityLabel, mediaKind, nameOf, readableType, subtitle, typesOf } from '../harness/entity.js';
import { imageOf, MAX_MEDIA_URL } from '../harness/playable.js';
import type { CardButton, CardCtas, OpenAction } from '../harness/cta.js';
import { RENDERER_SPEC } from '../harness/renderer-spec.js';
import { openWay } from '../harness/tools/open-target.js';
import type { CiteView } from './result-pick.js';

/** Where links may go. */
export interface LinkPolicy {
  /** The page now open; its origin is always allowed. Defaults to the browser's. */
  here?: string;
  /** Other origins the page allows links to (`https://help.example.com`), from the element's `link-origins`. */
  origins?: readonly string[];
}

/** Video sites a cited video's Watch may link out to, when the site hosts its videos there. */
const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com']);

const here = (p: LinkPolicy): string | undefined => p.here ?? (typeof location === 'undefined' ? undefined : location.href);

/**
 * A link's address, when it may be drawn: http(s) on the page's own origin or one it allows (https only for
 * another origin), with no credentials, no unfilled `{}` template, and no longer than a picture's address may be.
 * A relative address (`/help/filters`) is read against the page. Anything else, `javascript:` and `data:` included,
 * is undefined: not a link.
 *
 * @param video - A cited video's Watch: YouTube and Vimeo are allowed too.
 */
export function allowedLink(raw: unknown, policy: LinkPolicy = {}, video = false): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > MAX_MEDIA_URL || /[{}\s<>"\\]/.test(s) || !/^(https?:\/\/|\/(?!\/))/i.test(s)) return undefined;
  const page = here(policy);
  let u: URL;
  let origin: string | undefined;
  try {
    u = new URL(s, page);
    origin = page ? new URL(page).origin : undefined;
  } catch {
    return undefined;
  }
  if (u.username || u.password || (u.protocol !== 'https:' && u.protocol !== 'http:')) return undefined;
  if (u.origin === origin) return u.href;
  if (u.protocol !== 'https:') return undefined;
  if ((policy.origins ?? []).includes(u.origin) || (video && VIDEO_HOSTS.has(u.hostname))) return u.href;
  return undefined;
}

/** A video's address at a time, built for the sites that take one: YouTube's `t=`, Vimeo's `#t=`. Others as they are. */
export function atTime(url: string, seconds: number | undefined): string {
  if (!seconds) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtube.com' || host === 'youtu.be') u.searchParams.set('t', `${seconds}s`);
    else if (host === 'vimeo.com' || host === 'player.vimeo.com') u.hash = `t=${seconds}s`;
    else return url;
    return u.href;
  } catch {
    return url;
  }
}

/** The heading a cited record is drawn under, by its type. */
const HEADINGS: Readonly<Record<string, string>> = {
  FAQPage: 'FAQ',
  HowTo: 'How-to',
  TechArticle: 'Article',
  Article: 'Article',
  BlogPosting: 'Blog post',
  NewsArticle: 'News',
  VideoObject: 'Video',
  Clip: 'Clip',
  ProfilePage: 'Profile',
  WebPage: 'Page',
};

/** "From the page": a page cited by what its description says. */
export const FROM_THE_PAGE = 'From the page';

const bare = (u: string | undefined): string | undefined => u?.split('#')[0];
const open = (label: string, url: string, intent: OpenAction['intent'], actionType?: OpenAction['actionType']): CardButton => ({
  kind: 'open',
  label,
  url,
  intent,
  ...(actionType ? { actionType } : {}),
});

/** A lead and, when it goes somewhere else, "Their page". */
function withPage(lead: CardButton | undefined, page: string | undefined): CardCtas | undefined {
  const their = page ? open('Their page', page, 'navigate') : undefined;
  if (!lead) return their ? { lead: their } : undefined;
  return their && lead.kind === 'open' && bare(lead.url) !== bare(page) ? { lead, secondary: their } : { lead };
}

/** A clip's start as a clock reads it: 134 → "2:14". */
const at = (seconds: number | undefined): string | undefined => (seconds === undefined ? undefined : clock(`PT${seconds}S`));

/**
 * One cited record as its card: by its archetype, from the renderer spec, with only Read or Watch and "Their page".
 *
 * @param compact - Drawn already in this conversation: listed, its card not drawn again.
 */
export function citeView(card: CardRecord, policy: LinkPolicy = {}, compact = false): CiteView {
  const record = card as unknown as Record<string, unknown>;
  const arch = archetype(record);
  const type = typesOf(record)[0] ?? 'Thing';
  const fromPage = card.citation === 'page';
  const page = allowedLink(card.url, policy);
  const focus = card.focus;
  const time = arch === 'media' ? at(focus?.startOffset) : undefined;
  let ctas: CardCtas | undefined;
  if (fromPage) {
    ctas = page ? { lead: open('Open the page', page, 'navigate') } : undefined;
  } else if (arch === 'media') {
    // The clip's own link, else the video's, at the clip's time on YouTube and Vimeo; else the file itself.
    const video = allowedLink(focus?.url, policy, true) ?? allowedLink(card.url, policy, true);
    const to = video ? atTime(video, focus?.startOffset) : allowedLink(card.contentUrl, policy);
    ctas = withPage(to ? open(RENDERER_SPEC.actions.WatchAction.label, to, 'consume', 'WatchAction') : undefined, page);
  } else if (arch === 'readable') {
    const to = allowedLink(focus?.url, policy) ?? page;
    ctas = withPage(to ? open('Read', to, 'consume') : undefined, page);
  } else {
    ctas = withPage(undefined, page);
  }
  const byline = fromPage
    ? undefined
    : arch === 'media'
    ? [nameOf(card.publisher), clock(card.duration)].filter(Boolean).join(' · ') || undefined
    : subtitle(record, arch);
  const image = imageOf(record, here(policy));
  const kind = mediaKind(record);
  return {
    id: card['@id'],
    type,
    title: entityLabel(record),
    facts: [],
    archetype: arch,
    heading: fromPage ? FROM_THE_PAGE : HEADINGS[type] ?? readableType(type) ?? 'Source',
    citation: fromPage ? 'page' : 'typed',
    ...(byline ? { byline } : {}),
    ...(focus ? { focus: time ? `${time} · ${focus.label}` : focus.label } : {}),
    ...(ctas ? { ctas } : {}),
    ...(image ? { image } : {}),
    ...(kind ? { kind } : {}),
    ...(compact ? { compact: true } : {}),
  };
}

/**
 * An answer's cards, in citation order. A record in `drawn` (drawn earlier in the conversation) or cited twice in
 * this answer is marked `compact` after its first.
 */
export function citeViews(answer: HandoffAnswer, drawn: ReadonlySet<string> = new Set(), policy: LinkPolicy = {}): CiteView[] {
  const seen = new Set(drawn);
  return answer.cards.map((card) => {
    const view = citeView(card, policy, seen.has(card['@id']));
    seen.add(card['@id']);
    return view;
  });
}

/** The reply without the language note on its first line, since the note is drawn above it. */
export function withoutNote(text: string, note: string | undefined): string {
  if (!note) return text;
  const [first, ...rest] = text.split('\n');
  return first.trim() === note.trim() ? rest.join('\n').replace(/^\s*\n/, '') : text;
}

/** A Markdown link, `[words](address)`, or a bare `https://` address. */
const LINK = /\[([^\]\n]{1,300})\]\(([^()\s]{1,2048})\)|\bhttps?:\/\/[^\s<>"'`]+/g;

/**
 * A reply's text as text and links. A link whose address the page allows ({@link allowedLink}) is an anchor; any
 * other stays exactly as written, as text. Punctuation after a bare address ends it.
 *
 * @param visit - Called before this tab follows a link to another page of the site, to keep the conversation.
 */
export function linkNodes(text: string, policy: LinkPolicy = {}, visit?: (url: string, label: string) => void): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    let whole = m[0];
    let label = m[1];
    let raw = m[2];
    if (!raw) {
      whole = whole.replace(/[.,;:!?'")\]]+$/, '');
      raw = label = whole;
    }
    const href = allowedLink(raw, policy);
    if (!href) continue;
    const start = m.index ?? 0;
    if (start > last) out.push(document.createTextNode(text.slice(last, start)));
    out.push(anchor(href, label, policy, visit));
    last = start + whole.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function anchor(href: string, label: string, policy: LinkPolicy, visit?: (url: string, label: string) => void): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'remote-link';
  a.href = href;
  a.textContent = label;
  const way = openWay(href, here(policy));
  if (way === 'new-tab') {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  a.addEventListener('click', (e) => {
    if (way !== 'same-site' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    visit?.(href, label);
  });
  return a;
}

/** Styles for the reply's links and the note, on the widget's tokens. */
export const REMOTE_ANSWER_CSS = `
      .remote-link { color: var(--blue-strong); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
      .remote-link:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .remote-note { align-self: flex-start; max-width: 76%; margin: 2px 0 6px; font-size: 12.5px; color: var(--ink-3); }
`;
