/**
 * Defaults for the packaged UI.
 *
 * Nothing here is specific to any site. Every value is a starting point the
 * host overrides through the element's properties or attributes.
 *
 * @module
 */
import { NXIS_LOGO_SVG } from '../engine.js';

/**
 * The default system prompt, used when the host sets none.
 *
 * Two instructions should survive any rewrite. Calling the tool with partial
 * arguments is what allows the harness to collect the rest as fields, since a
 * model told to ask in prose will do so. And insisting on the schema's exact
 * parameter names keeps a model from renaming them, which would leave the
 * arguments unmatched.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are an assistant embedded in a web page.',
  "Use the available tools to answer the user's questions and to fill and submit forms on this page.",
  "To find, list or show things (what's on, events, products, places), search the site's records with nxis_query,",
  'with when set for a time such as "this weekend", "tonight" or "in July".',
  'Use a page form only to do something the records cannot, such as sending a request.',
  'Use parameter names EXACTLY as defined in the tool schema — do not rename, translate, or add suffixes.',
  'Only include fields the user provided or that are clearly implied; never invent emails, names, or dates.',
  'Call the tool as soon as you know which one is right, even if some required fields are still unknown —',
  'include the fields you do have and simply omit the rest.',
  'Never ask the user to supply a missing field in prose. Leave it out of the call; the page will collect it.',
  'Answer only from tool results — never invent facts the tools did not return.',
  'Call at most one tool per turn.',
].join(' ');

/** Empty-state chips. Replace with prompts that suit the host's tools. */
export const DEFAULT_SUGGESTIONS: string[] = [
  'What can you do on this page?',
  'What information is available here?',
];

/**
 * The line shown above the suggestions before a conversation starts.
 *
 * Only the host knows what the agent can do on their site, so the default
 * describes the mechanism rather than the subject.
 */
export const DEFAULT_EMPTY_STATE =
  'Ask a question about this page — the agent answers with typed records and ' +
  'can fill forms for you, right here in the chat.';

/**
 * The agent's name.
 *
 * Shown in the header, and used in the launcher's title and the dialog's
 * accessible name, so it is announced by a screen reader.
 */
export const DEFAULT_AGENT_NAME = 'Nxis Agent';

/**
 * The mark shown on the launcher, in both headers, above the empty state, and
 * on result cards.
 *
 * Either inline SVG markup (any value starting with `<`) or an image URL.
 *
 * Markup is injected as written, at the same trust level as the rest of the
 * host page, so never pass a value a visitor can influence.
 */
export const DEFAULT_LOGO = NXIS_LOGO_SVG;

/**
 * Brand overrides, applied as custom properties on the host element.
 *
 * Every key is optional and anything omitted keeps its default. Colours accept
 * any CSS colour; fonts accept a full font stack.
 */
export interface AgentTheme {
  /** Primary action colour — buttons, focus rings, links. */
  accent?: string;
  /** Pressed/hover state for `accent`. */
  accentStrong?: string;
  /** Faint wash of `accent` behind tags and chips. */
  accentTint?: string;
  /** Body text. */
  ink?: string;
  /** Secondary text. */
  inkSoft?: string;
  /** Labels, timestamps, placeholders. */
  inkMuted?: string;
  /** The surface the agent's own panels sit on. */
  bg?: string;
  /** Panels raised off `bg` — assistant bubbles, chips. */
  surface?: string;
  /** Hairlines. */
  border?: string;
  /** Corner radius of cards, as a CSS length. */
  radius?: string;
  /** Headings. */
  fontDisplay?: string;
  /** Body copy and controls. */
  fontSans?: string;
  /** Status lines, labels, code. */
  fontMono?: string;
}

/**
 * The custom properties each {@link AgentTheme} key writes.
 *
 * Each key writes two names: the element's hand-written CSS resolves the short
 * form, while its Tailwind utilities resolve the theme form. Both style parts
 * of the same surface, so writing only one would leave the element partly
 * unbranded.
 */
export const THEME_TOKENS: Record<keyof AgentTheme, readonly string[]> = {
  accent: ['--blue', '--color-blue'],
  accentStrong: ['--blue-strong', '--color-blue-strong'],
  accentTint: ['--blue-tint', '--color-blue-tint'],
  ink: ['--ink', '--color-ink'],
  inkSoft: ['--ink-2', '--color-ink-2'],
  inkMuted: ['--ink-3', '--color-ink-3'],
  bg: ['--bg', '--color-bg'],
  surface: ['--surface', '--color-surface'],
  border: ['--border', '--color-border-hair'],
  radius: ['--radius', '--radius-card'],
  fontDisplay: ['--display', '--font-display'],
  fontSans: ['--sans', '--font-sans'],
  fontMono: ['--mono', '--font-mono'],
};

/**
 * How stored preference keys map onto schema field names.
 *
 * Schemas name the same field differently (`full_name`, `fullname`, `name`), so
 * each preference lists the aliases it satisfies. Extend this to add a new
 * stored preference.
 */
export const PROFILE_ALIASES: Record<string, string[]> = {
  name: ['full_name', 'name', 'fullname'],
  email: ['email', 'email_address', 'emailaddress'],
  phone: ['phone', 'phone_number', 'phonenumber', 'tel', 'mobile'],
  address: ['address', 'street_address', 'streetaddress', 'street'],
  city: ['city', 'town', 'locality', 'address_locality', 'addresslocality'],
  zip: ['zip', 'zip_code', 'zipcode', 'postal_code', 'postalcode', 'postcode'],
};
