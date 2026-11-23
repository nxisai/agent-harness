/**
 * Registers the site's Actions as tools the agent can see from any page.
 *
 * A site repeats the same form across many pages: the listings demo has one
 * quote form per business, which are 38 actions with the same name and the
 * same fields. Registered one by one they would be 38 indistinguishable tools,
 * so actions that share a name and a field list become a single tool, and the
 * field whose default value differs between them — the site's own name for the
 * target, such as `business` — chooses which one runs.
 *
 * Each is named for the reach it adds: `quote_form_anywhere` beside the page's
 * own `quote_form`. It is a courier rather than a second form — it captures an
 * action's inputs wherever the agent happens to be, carries them to the page
 * that can submit them, and calls the tool there, never filling a field
 * itself. The distinct name also matters mechanically: a WebMCP registry
 * rejects a repeated name as a duplicate, and the page's tool this one
 * delegates to has to stay registered.
 *
 * On the action's own page there is nothing to carry, and it calls the page's
 * tool directly.
 *
 * @module
 */
import { samePage, sameActionPage } from './site-actions.js';
import { savePendingAction, savePendingVisit } from './pending-action.js';
import { journeySteps } from '../steps.js';
import { executeRegistered } from './webmcp.js';
import { toolOrigins } from '../policy.js';
import { ACTION_ID_HINT, type PageFormRun, type SiteActionReport } from './report.js';
import type { JsonSchema, ModelContext, ModelContextTool, ModelContextToolInfo, ModelContextToolResponse } from '../../types.js';
import type { NxisAction, NxisPropertyValueSpecification, NxisValueType } from '../../webmcp-contract.js';

/** Marks a tool this module registered. */
export const SITE_ACTION_HINT = 'ai.nxis/siteAction';
/** The `@id`s a site tool covers. */
export const ACTION_IDS_HINT = 'ai.nxis/actionIds';
/** The pages those actions live on. */
export const PAGE_URLS_HINT = 'ai.nxis/pageUrls';
/** What the page's own script names the same actions. */
export const PAGE_TOOL_NAMES_HINT = 'ai.nxis/pageToolNames';
/**
 * Marks a response that started a page change instead of submitting.
 *
 * Carried in `structuredContent`, where a renderer can find it without
 * parsing prose.
 */
export const HANDOFF_RESULT = 'ai.nxis/handoff';
/** The field whose value says which of the covered actions a call means. */
export const CHOOSER_HINT = 'ai.nxis/chooser';
/** That field's values, one per covered action, in the same order. */
export const CHOICES_HINT = 'ai.nxis/choices';
/**
 * Set when the chooser is one of the page's own constants (the event a pass form is for): it picks the form, and
 * names what the form is for rather than who it goes to.
 */
export const CHOOSER_FIXED_HINT = 'ai.nxis/chooserFixed';
export { ACTION_ID_HINT };

/** Appended to the action's own name, keeping it clear of the page's tool. */
const NAME_SUFFIX = '_anywhere';
/** WebMCP tool names are capped at this length. */
const MAX_NAME = 64;

/** One tool: the actions it covers, and how the caller picks between them. */
export interface SiteActionTool {
  /** The registered tool name. */
  name: string;
  /** The actions this tool can run, in a stable order. */
  actions: NxisAction[];
  /**
   * The field that says which action to run.
   *
   * A real field of the form when one tells the actions apart, otherwise the
   * added `target` field. Absent when the tool covers a single action.
   */
  discriminator?: string;
  /** What each action is called as a choice of {@link discriminator}, in the same order. */
  choices?: string[];
  /**
   * The field's own value on each action, where that differs from its label: the event's code behind its
   * name. Absent when the choices are the values.
   */
  values?: string[];
  /** The discriminator is one of the page's constants: it picks a form and is never sent. */
  fixed?: boolean;
  /** The tool as registered. */
  definition: ModelContextTool;
}

// ── names ───────────────────────────────────────────────────────────────────

/**
 * An action name as a tool name.
 *
 * Mirrors the page script's own sanitiser, so the two agree on what a given
 * action is called.
 */
export function sanitizeToolName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, MAX_NAME) || 'unnamed_action'
  );
}

/**
 * The name a site-wide tool is registered under.
 *
 * The stem is the action's own name, so the model still reads what the form is
 * called and matches it to what the visitor asked for; the suffix says this is
 * the one that reaches the form from any page, and keeps it clear of the
 * page's own tool of the same name.
 *
 * @param actionName - The action's name, as the record gives it.
 * @returns The tool name, within the length a registry accepts.
 */
export function siteToolName(actionName: string): string {
  return sanitizeToolName(actionName).slice(0, MAX_NAME - NAME_SUFFIX.length) + NAME_SUFFIX;
}

/**
 * A tool's name without the site-wide suffix, for showing to a person.
 *
 * `quote_form_anywhere` exists to be told apart from the page's `quote_form`
 * in a registry; to the visitor both are the quote form.
 */
export function withoutSiteSuffix(toolName: string): string {
  // `_anywhere_2` too: the number only keeps two groups' names apart in a registry.
  const m = /_anywhere(?:_\d+)?$/.exec(toolName);
  return m ? toolName.slice(0, m.index) : toolName;
}

/** Words that make a form's own name something a person would call it: "quote form", "booking request". */
const FORM_WORDS =
  /\b(?:form|request|quote|booking|reservation|appointment|application|inquiry|enquiry|message|order|registration|signup|sign up|rsvp|survey|feedback|review|comment|subscription|claim|referral|report)s?\b/;

/**
 * What to call a form in a sentence: its own name when that reads as one ("quote form"), else "form".
 *
 * A form's name is often its HTML id. `filters` or `pass-form` is a label for code, and
 * "I'll send this filters" is what using it as a noun says.
 *
 * @param toolName - The tool's registered name.
 */
export function formNoun(toolName: string): string {
  const name = withoutSiteSuffix(toolName).replace(/[_-]+/g, ' ').trim().toLowerCase();
  return FORM_WORDS.test(name) ? name : 'form';
}

/** Fields only a form that sends something asks for: who you are and how to reach you, a message, a file. */
const SENDS = /e-?mail|phone|\btel\b|mobile|message|comment|password|passw|card_?number|\bcvc\b|\bcvv\b|full_?name|first_?name|last_?name|surname/i;

/**
 * Whether an action only reads: a `method="get"` form, which searches or filters and sends nothing to anyone. Its
 * tool is read-only, so it runs with no confirmation, and what it does is open its results page.
 *
 * GET is also what a form that names no method is recorded as, and a script may still send that one somewhere. So
 * a GET form is read-only when it is a search, or when no script handles it and it asks for nothing a sent form
 * would: an email, a phone number, a name, a message, a file.
 */
export function readsOnly(action: NxisAction): boolean {
  if (action.target.httpMethod?.toUpperCase() !== 'GET') return false;
  if (/(?:^|[/#:])SearchAction$/.test(action['@type'])) return true;
  if (action.target['nxis:jsHandled']) return false;
  return !(action.input ?? []).some((i) => SENDS.test(i.valueName) || i['nxis:valueType'] === 'file');
}

/** The site's own titles for its pages, from its page records. Set once they are read. */
let titles: { url: string; name: string }[] = [];

/**
 * Give the site's page records' titles to the tools, so a destination is named for its title rather than its path.
 *
 * @param pages - The site's page records. Names inferred from a URL do not belong here.
 */
export function setPageTitles(pages: { url: string; name: string }[]): void {
  titles = pages.filter((p) => p.url && p.name?.trim());
}

/** A title without the site's name after it: `Events | Wrenfield` → `Events`. */
const ownTitle = (title: string): string => title.split(/\s+[|—–·-]\s+/)[0].trim();

/**
 * What a page is called: its record's title, or the open page's own. Empty when neither is known, since a path
 * segment is not a name.
 *
 * @param pageUrl - The page.
 * @param href - The current page. Defaults to the browser's.
 */
export function pageTitle(pageUrl: string | undefined, href?: string): string {
  if (!pageUrl) return '';
  const named = titles.find((p) => samePage(p.url, pageUrl));
  if (named) return ownTitle(named.name);
  const here = href ?? (typeof location === 'undefined' ? '' : location.href);
  return samePage(pageUrl, here) && typeof document !== 'undefined' ? ownTitle(document.title) : '';
}

/**
 * Where a GET form's results are: its action URL, with the call's values as the query string, as the browser
 * would build it on submit.
 *
 * @param action - A read-only action.
 * @param values - The form's fields, by name.
 * @returns The URL, or null when the action names none that parses.
 */
export function resultsUrl(action: NxisAction, values: Record<string, unknown>): string | null {
  const page = action.target['nxis:pageUrl'];
  // An RFC 6570 template's expressions are the fields themselves, filled in below.
  const raw = (action.target.urlTemplate ?? action.target['nxis:observedUrl'] ?? '').replace(/\{[^}]*\}/g, '') || page;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, page);
  } catch {
    return null;
  }
  for (const key of [...url.searchParams.keys()]) if (!url.searchParams.get(key)) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) {
    const items = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null && v !== false && String(v).trim() !== '');
    if (!items.length) continue;
    url.searchParams.delete(key);
    for (const v of items) url.searchParams.append(key, v === true ? 'on' : String(v));
  }
  return url.href;
}

/** A page URL's last path segment, as a label: `/listings/royal-oak.html` → `royal oak`. */
function pageLabel(pageUrl: string | undefined): string {
  if (!pageUrl) return 'this page';
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    path = pageUrl;
  }
  const slug = path.split('/').filter(Boolean).pop() ?? '';
  return slug.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ') || 'home';
}

// ── grouping ────────────────────────────────────────────────────────────────

const fieldNames = (action: NxisAction): string[] => (action.input ?? []).map((i) => i.valueName);

/**
 * Where an action's form submits: its URL template, else the URL the crawler saw it go to. Null for a form that
 * names neither, which is told apart only by its fields.
 */
function endpointOf(action: NxisAction): string | null {
  const raw = action.target.urlTemplate ?? action.target['nxis:observedUrl'];
  if (!raw) return null;
  try {
    const url = new URL(raw, action.target['nxis:pageUrl'] || undefined);
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

/**
 * Which actions are one tool: the same name, submitting to the same endpoint with the same method.
 *
 * One form repeated across a site is one tool even when its fields differ from page to page — a pass form whose
 * ticket tiers depend on the event — since it is the same form going to the same place. A form with no endpoint
 * has only its fields to say what it is, so for that one the field list stays part of the key.
 *
 * JSON rather than a joined string, so a separator character cannot appear in
 * a field name and merge two groups that differ.
 */
const groupKey = (action: NxisAction): string => {
  const name = sanitizeToolName(action.name);
  const endpoint = endpointOf(action);
  if (endpoint) return JSON.stringify([name, action.target.httpMethod.toUpperCase(), endpoint]);
  return JSON.stringify([name, [...fieldNames(action)].sort()]);
};

/** A field's value on one action: an input's default, or a constant the page's form submits itself. */
function fieldValue(action: NxisAction, field: string, fixed: boolean): string {
  const list = fixed ? action['nxis:fixedInput'] : action.input;
  return list?.find((i) => i.valueName === field)?.defaultValue?.trim() ?? '';
}

/** What tells the members of a group apart, and how. */
export interface Discriminator {
  /** The field's name: `business`, `event`. */
  field: string;
  /** Its value on each action, in order. */
  values: string[];
  /**
   * The field is one of the page's own constants (`nxis:fixedInput`): the page's form submits it, so a call
   * picks with it but never sends it.
   */
  fixed: boolean;
}

/**
 * Which field distinguishes the members of a group.
 *
 * The crawler records what a form already says about itself: on a per-business
 * quote form, the `business` field carries that business's name as its default;
 * on a per-event pass form, a hidden `event` field carries the event, recorded
 * as one of the page's constants. A field every member fills with a different
 * value is therefore the site's own way of naming the target, and is used in
 * preference to anything invented. A field the visitor could fill comes first.
 *
 * @param actions - The group's actions, in order.
 * @returns The field, each action's value, and whether it is a constant; null
 * when no field separates them.
 */
export function findDiscriminator(actions: NxisAction[]): Discriminator | null {
  if (actions.length < 2) return null;
  const candidates: [string, boolean][] = [
    ...fieldNames(actions[0]).map((f): [string, boolean] => [f, false]),
    ...(actions[0]['nxis:fixedInput'] ?? []).map((f): [string, boolean] => [f.valueName, true]),
  ];
  for (const [field, fixed] of candidates) {
    const values = actions.map((a) => fieldValue(a, field, fixed));
    if (values.some((v) => !v)) continue;
    if (new Set(values).size === actions.length) return { field, values, fixed };
  }
  return null;
}

/** A value written for code rather than people: `low-light-pittsburgh-2027-09-10`, `evt_123`, `42`. */
const looksLikeCode = (value: string): boolean => !/\s/.test(value) && /[-_\d]/.test(value);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A code as words, for when nothing better names it: `low-light-pittsburgh-2027-09-10` → `Low Light Pittsburgh,
 * Sep 10, 2027`.
 */
export function readableCode(value: string): string {
  let rest = value.trim();
  let when = '';
  const date = /[-_](\d{4})[-_](\d{2})[-_](\d{2})$/.exec(rest);
  if (date && Number(date[2]) >= 1 && Number(date[2]) <= 12) {
    when = `${MONTHS[Number(date[2]) - 1]} ${Number(date[3])}, ${date[1]}`;
    rest = rest.slice(0, date.index);
  }
  const words = rest
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return [words.join(' '), when].filter(Boolean).join(', ') || value;
}

/**
 * What to call each choice, in what the visitor reads and the model picks from.
 *
 * A field the form shows a person (a business's name) is its own label. A constant, or a value that reads as a
 * code, is named for its page: the event page's title, else the code in words. Never a path.
 */
function choiceLabels(actions: NxisAction[], found: Discriminator): string[] {
  if (!found.fixed && !found.values.some(looksLikeCode)) return found.values;
  const named = actions.map((a, i) => pageTitle(a.target['nxis:pageUrl']) || readableCode(found.values[i]));
  return distinct(named, (i) => readableCode(found.values[i]));
}

/** Labels for a group whose own fields do not tell its actions apart: each page's title, else its path. */
function pageLabels(actions: NxisAction[]): string[] {
  const titled = actions.map((a) => pageTitle(a.target['nxis:pageUrl']));
  const labels = titled.map((t, i) => t || pageLabel(actions[i].target['nxis:pageUrl']));
  if (new Set(labels).size === labels.length) return labels;
  // Two pages with the same title or last segment: fall back to the whole path.
  return distinct(labels, (i) => actions[i].target['nxis:pageUrl'] ?? labels[i]);
}

/** Labels made unique: one shared with another member is replaced by what `instead` says for it. */
function distinct(labels: string[], instead: (index: number) => string): string[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) ?? 0) + 1);
  const out = labels.map((l, i) => ((counts.get(l.toLowerCase()) ?? 0) > 1 ? instead(i) : l));
  // Still the same: the last resort is a count, never a guess at which is which.
  const seen = new Map<string, number>();
  return out.map((l) => {
    const n = (seen.get(l.toLowerCase()) ?? 0) + 1;
    seen.set(l.toLowerCase(), n);
    return n > 1 ? `${l} (${n})` : l;
  });
}

// ── schema ──────────────────────────────────────────────────────────────────

const JSON_TYPES: Record<NxisValueType, string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  date: 'string',
  file: 'string',
};

/** One field's schema, following the same rules as the page script. */
function propertySchema(spec: NxisPropertyValueSpecification): JsonSchema {
  const valueType = spec['nxis:valueType'] ?? 'string';
  const prop: JsonSchema = { type: JSON_TYPES[valueType] ?? 'string' };
  if (valueType === 'date') prop.format = 'date';
  if (spec.description) prop.description = spec.description;
  if (spec.defaultValue !== undefined) prop.default = coerce(spec.defaultValue, valueType);
  if (spec.valueMinLength !== undefined) prop.minLength = spec.valueMinLength;
  if (spec.valueMaxLength !== undefined) prop.maxLength = spec.valueMaxLength;
  if (spec.valuePattern) {
    const p = spec.valuePattern;
    prop.pattern = p.startsWith('^') && p.endsWith('$') ? p : `^${p}$`;
  }
  if (spec.minValue !== undefined) prop.minimum = spec.minValue;
  if (spec.maxValue !== undefined) prop.maximum = spec.maxValue;
  if (spec.stepValue !== undefined) prop.multipleOf = spec.stepValue;
  if (spec.readonlyValue) prop.readOnly = true;

  const options = spec['nxis:valueOption'] ?? [];
  if (options.length) {
    prop.enum = options.map((o) => o.value);
    const labelled = options.filter((o) => o.name && o.name !== o.value);
    if (labelled.length) {
      // What each value means, for the model to read in the serialised schema.
      // Deliberately not folded into `description`: every surface renders that
      // as the field's label, and a sentence there becomes a label wide enough
      // to crush the value beside it.
      prop['nxis:valueLabels'] = Object.fromEntries(labelled.map((o) => [o.value, o.name!]));
    }
  }

  if (spec.multipleValues) {
    const items = { ...prop };
    const array: JsonSchema = { type: 'array', items };
    if (spec.valueMinLength !== undefined) {
      array.minItems = spec.valueMinLength;
      delete items.minLength;
    }
    if (spec.valueMaxLength !== undefined) {
      array.maxItems = spec.valueMaxLength;
      delete items.maxLength;
    }
    if (items.description) {
      array.description = items.description;
      delete items.description;
    }
    return array;
  }
  return prop;
}

function coerce(value: string, valueType: NxisValueType): unknown {
  if (valueType === 'number' || valueType === 'integer') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (valueType === 'boolean') return value === 'true' || value === '1';
  return value;
}

/**
 * Merge the group's field schemas, widening each to what any member accepts.
 *
 * Members can differ in their fields (one event's tiers are not another's), so a field is required only where
 * every member requires it; what one chosen form needs is checked against that form, by {@link siteCallFit}.
 */
function mergedSchema(actions: NxisAction[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const requiredBy = new Map<string, number>();
  for (const action of actions) {
    for (const spec of action.input ?? []) {
      const prop = propertySchema(spec);
      const existing = properties[spec.valueName];
      if (!existing) {
        properties[spec.valueName] = prop;
      } else {
        if (Array.isArray(existing.enum) && Array.isArray(prop.enum)) {
          // The same field offers different options per page: accept any of them,
          // since the form on the page decides what is really valid.
          existing.enum = [...new Set([...existing.enum, ...prop.enum])];
        }
        widen(existing, prop);
      }
      if (spec.valueRequired) requiredBy.set(spec.valueName, (requiredBy.get(spec.valueName) ?? 0) + 1);
    }
  }
  const schema: JsonSchema = { type: 'object', properties };
  const required = [...requiredBy].filter(([, n]) => n === actions.length).map(([name]) => name);
  if (required.length) schema.required = required;
  return schema;
}

/** Bounds that admit what either schema does: one page's limit is not every page's. */
function widen(into: JsonSchema, from: JsonSchema): void {
  for (const [key, pick] of [
    ['minimum', Math.min],
    ['maximum', Math.max],
    ['minLength', Math.min],
    ['maxLength', Math.max],
  ] as const) {
    const a = into[key];
    const b = from[key];
    if (typeof a !== 'number') continue;
    if (typeof b === 'number') into[key] = pick(a, b);
    else delete into[key];
  }
}

// ── building ────────────────────────────────────────────────────────────────

/** Where the agent currently is, so a tool can default to this page's action. */
export interface BuildOptions {
  /** The current page URL. Defaults to the browser's. */
  href?: string;
  /** Where a confirmed call waits while the browser moves. Defaults to `sessionStorage`. */
  storage?: Storage | null;
  /** How to go to another page. Defaults to assigning `location`. */
  navigate?: (url: string) => void;
  /** The conversation a travelling call should report back to. */
  conversationId?: string;
  /**
   * Look up a form none of a tool's own actions matched: the site's index may
   * hold it only inside the record it belongs to. See `findEmbeddedAction`.
   */
  findAction?: (query: { actionName: string; field: string; value: string }) => Promise<NxisAction | null>;
}

/**
 * Group the site's actions and build one tool definition for each group.
 *
 * Names are derived from the whole set rather than the order actions arrive
 * in, so a tool is called the same thing on every page of the site.
 *
 * @param actions - The site's actions.
 * @param mc - The registry the tools will run against, used to find the page's
 * own tool when the agent is already on the right page.
 * @param opts - The current page.
 * @returns One entry per group, ordered by tool name.
 */
export function buildSiteActionTools(
  actions: NxisAction[],
  mc: ModelContext,
  opts: BuildOptions = {},
): SiteActionTool[] {
  const groups = new Map<string, NxisAction[]>();
  for (const action of actions) {
    const key = groupKey(action);
    const group = groups.get(key);
    if (group) group.push(action);
    else groups.set(key, [action]);
  }

  const taken = new Set<string>();
  const tools: SiteActionTool[] = [];
  // Sorted so that two groups whose names collide are numbered the same way on
  // every page, whatever order the server returned them in.
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const tool = buildTool(group, mc, taken, opts);
    built.set(tool.name, tool);
    tools.push(tool);
  }
  return tools;
}

/**
 * Every site-wide tool built in this page, by registered name.
 *
 * Annotations are the obvious place to record what a tool covers, and a tool
 * read back from `getTools()` carries them only if the registry kept them: a
 * native one keeps the hints it recognises and drops the rest, which leaves
 * one of these indistinguishable from any other write. The builder and the
 * harness run in the same page, so what was built is remembered here, and
 * annotations are the fallback for anything registered elsewhere.
 */
const built = new Map<string, SiteActionTool>();

/** What a tool covers: its actions, their pages, and how a call picks one. */
interface Coverage {
  ids: string[];
  pages: string[];
  pageToolNames: string[];
  chooser: string;
  choices: string[];
  fixed: boolean;
}

/**
 * Whether a tool is a site-wide one, reaching a form from any page.
 *
 * Checked against what this page built, then the tool's annotations, so it
 * holds even where a native registry has stripped them.
 */
export function isSiteTool(tool: ModelContextToolInfo): boolean {
  return coverageOf(tool) !== null;
}

/**
 * The field that says which of a site tool's forms a call means: `business`,
 * or the added `target`. Null for a tool that covers one form, or is not a
 * site tool.
 */
export function chooserOf(tool: ModelContextToolInfo): string | null {
  return coverageOf(tool)?.chooser || null;
}

/**
 * Whether a site tool's chooser is one of the page's constants (the event a pass form is for), so it names what
 * the form is for rather than who it goes to.
 */
export function chooserIsFixed(tool: ModelContextToolInfo): boolean {
  return !!coverageOf(tool)?.fixed;
}

/** A tool's coverage, from what this page built or from what it carries. */
function coverageOf(tool: ModelContextToolInfo): Coverage | null {
  const local = built.get(tool.name);
  if (local) {
    return {
      ids: local.actions.map((a) => a['@id']),
      pages: local.actions.map((a) => a.target['nxis:pageUrl'] ?? ''),
      pageToolNames: [...new Set(local.actions.map((a) => sanitizeToolName(a.name)))],
      chooser: local.discriminator ?? '',
      choices: local.choices ?? [],
      fixed: !!local.fixed,
    };
  }
  const notes = tool.annotations;
  if (!notes?.[SITE_ACTION_HINT]) return null;
  return {
    ids: (notes[ACTION_IDS_HINT] as string[] | undefined) ?? [],
    pages: (notes[PAGE_URLS_HINT] as string[] | undefined) ?? [],
    pageToolNames: (notes[PAGE_TOOL_NAMES_HINT] as string[] | undefined) ?? [],
    chooser: (notes[CHOOSER_HINT] as string | undefined) ?? '',
    choices: (notes[CHOICES_HINT] as string[] | undefined) ?? [],
    fixed: notes[CHOOSER_FIXED_HINT] === true,
  };
}

function buildTool(
  actions: NxisAction[],
  mc: ModelContext,
  taken: Set<string>,
  opts: BuildOptions,
): SiteActionTool {
  const first = actions[0];
  const name = uniqueName(siteToolName(first.name), taken);
  taken.add(name);

  const schema = mergedSchema(actions);
  const found = findDiscriminator(actions);
  const discriminator = actions.length > 1 ? (found?.field ?? 'target') : undefined;
  const choices = actions.length > 1 ? (found ? choiceLabels(actions, found) : pageLabels(actions)) : undefined;
  // The values behind the labels, where a label is not the value: a real field is sent with its value.
  const values = found && choices && choices.some((c, i) => c !== found.values[i]) ? found.values : undefined;
  const fixed = !!found?.fixed;

  if (discriminator && choices) {
    const here = actions.findIndex((a) => sameActionPage(a, opts.href));
    schema.properties ??= {};
    const existing: JsonSchema = { ...(schema.properties[discriminator] ?? { type: 'string' }) };
    // The merged schema carries the first action's own default — the first
    // business's name. Left there, a call that named no business would submit
    // to that one, so the choice starts empty unless this page settles it.
    delete existing.default;
    // A label, not an instruction: what this field is for belongs in the
    // tool's description, which the model reads and no surface renders as a
    // field name. A real field keeps whatever the form called it, and an
    // added one is named after what it selects.
    const label = found
      ? ((existing.description as string | undefined) ?? (fixed ? upperFirst(humanize(found.field)) : undefined))
      : 'Page';
    schema.properties[discriminator] = {
      ...existing,
      type: 'string',
      ...(label ? { description: label } : {}),
      enum: choices,
      // On a page this tool covers, that page's action is the obvious one.
      ...(here >= 0 ? { default: choices[here] } : {}),
    };
    schema.required = [...new Set([...(schema.required ?? []), discriminator])];
  }

  // A GET form searches or filters: it sends nothing, so it reads. Every other action submits a form, and never
  // runs without a human pressing Send.
  const reads = actions.every(readsOnly);
  const definition: ModelContextTool = {
    name,
    description: describe(actions, discriminator, choices),
    inputSchema: schema,
    annotations: {
      readOnlyHint: reads,
      [SITE_ACTION_HINT]: true,
      [ACTION_IDS_HINT]: actions.map((a) => a['@id']),
      [PAGE_URLS_HINT]: actions.map((a) => a.target['nxis:pageUrl'] ?? ''),
      [PAGE_TOOL_NAMES_HINT]: [...new Set(actions.map((a) => sanitizeToolName(a.name)))],
      // Enough for a caller that holds only the registered tool — the harness,
      // drawing a confirmation — to work out where a call is bound for.
      [CHOOSER_HINT]: discriminator ?? '',
      [CHOICES_HINT]: choices ?? [],
      ...(fixed ? { [CHOOSER_FIXED_HINT]: true } : {}),
    },
    execute: (input) => runSiteAction({ name, actions, discriminator, choices, values, fixed, inputSchema: schema }, mc, input, opts),
  };

  return { name, actions, discriminator, choices, ...(values ? { values } : {}), ...(fixed ? { fixed } : {}), definition };
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function describe(
  actions: NxisAction[],
  discriminator?: string,
  choices?: string[],
): string {
  const reads = actions.every(readsOnly);
  const own = new Set(actions.map((a) => a.description ?? ''));
  // One form on many pages: each page's description names its own page ("…to attend Field Days Denver"), so only
  // one they all share speaks for the tool, and otherwise it is described as the form it is.
  const shared = own.size === 1 ? actions[0].description : undefined;
  const thing = discriminator && discriminator !== 'target' ? humanize(discriminator).toLowerCase() : 'page';
  // `||`: an empty description is refused by a registry, and says nothing to the model either.
  let base =
    shared ||
    (actions.length > 1
      ? `The site's ${humanize(withoutSiteSuffix(sanitizeToolName(actions[0].name))).toLowerCase()}, on the page of each ${thing}.`
      : reads
        ? `Search or filter with the site's "${actions[0].name}" form.`
        : `Submit the "${actions[0].name}" form.`);
  // A search form and the site's records answer the same questions, and only the records come back as answers.
  if (reads) base += ` Opens the page of results and sends nothing. ${READ_FORM_LAST}`;
  if (!discriminator || !choices) return base;
  // Semicolons when a choice has commas of its own: "Low Light Pittsburgh, Fri, Sep 10".
  const sep = choices.some((c) => c.includes(',')) ? '; ' : ', ';
  const shown = choices.slice(0, 8).join(sep);
  const rest = choices.length > 8 ? `${sep}and ${choices.length - 8} more` : '';
  const differ = new Set(actions.map((a) => JSON.stringify([...fieldNames(a)].sort()))).size > 1;
  return (
    `${base} Set ${discriminator} to choose which: ${shown}${rest}.` +
    (differ ? ` Each ${thing} takes only its own fields; give only those, and leave out the rest.` : '')
  );
}

/**
 * What a read-only form's description tells the model about when to use it. Kept general: it reaches the model on
 * every site.
 */
export const READ_FORM_LAST =
  "To find, list or show things (what's on, events, products, places), search the site's records with nxis_query " +
  'first. Use this form only when the visitor asks to open its page of results, or the records cannot answer.';

// ── running ─────────────────────────────────────────────────────────────────

const text = (body: string, isError = false): ModelContextToolResponse => ({
  content: [{ type: 'text', text: body }],
  isError,
});

/**
 * Which choice a value names: a label exactly, then ignoring case, then the value behind a label (the event's
 * code, which a model may have read on the page). -1 when none.
 */
function choiceIndex(choices: string[], values: string[] | undefined, wanted: string): number {
  if (!wanted) return -1;
  const exact = choices.indexOf(wanted);
  if (exact >= 0) return exact;
  const lower = wanted.toLowerCase();
  const loose = choices.findIndex((c) => c.toLowerCase() === lower);
  if (loose >= 0) return loose;
  return values ? values.findIndex((v) => v.toLowerCase() === lower) : -1;
}

/** The action a call refers to, by the value of the deciding field. */
function pickAction(
  tool: Pick<SiteActionTool, 'actions' | 'discriminator' | 'choices' | 'values'>,
  input: Record<string, unknown>,
): NxisAction | null {
  if (tool.actions.length === 1) return tool.actions[0];
  if (!tool.discriminator || !tool.choices) return null;
  const index = choiceIndex(tool.choices, tool.values, String(input[tool.discriminator] ?? '').trim());
  return index >= 0 ? tool.actions[index] : null;
}

/** Whether a field's members disagree on which fields there are. */
const fieldsDiffer = (actions: NxisAction[]): boolean =>
  new Set(actions.map((a) => JSON.stringify([...fieldNames(a)].sort()))).size > 1;

/** A value that asks for something: not empty, not zero, not unticked. */
const asksFor = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  v !== false &&
  !(typeof v === 'string' && v.trim() === '') &&
  !(Array.isArray(v) && !v.length) &&
  !(typeof v !== 'boolean' && String(v).trim() !== '' && Number(v) === 0);

/** What a field is called to a person: its label, without "Number of": `qty_front-rows` → "Front rows". */
function fieldWords(spec: NxisPropertyValueSpecification | undefined, key: string): string {
  const label = spec?.description?.trim() || humanize(key.replace(/^(?:qty|quantity|num|count)[_-]/i, ''));
  return upperFirst(label.replace(/^(?:the\s+)?(?:number|quantity|count)\s+of\s+/i, '').trim());
}

/** A field's limits in words: "up to 8", "2 to 6". Empty when it has none. */
function limits(spec: NxisPropertyValueSpecification): string {
  const { minValue: min, maxValue: max } = spec;
  if (max !== undefined && (min === undefined || min <= 0)) return `up to ${max}`;
  if (max !== undefined) return `${min} to ${max}`;
  if (min !== undefined && min > 0) return `at least ${min}`;
  return '';
}

/** "a, b and c". */
function listed(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How a call fits the one form it picked, among a site tool's forms whose fields differ. */
export interface SiteCallFit {
  /**
   * The schema to resolve, ask and confirm the call against: the chosen form's own fields and the chooser. The
   * tool's own when the call has not chosen yet.
   */
  schema: JsonSchema;
  /** Whether the call says which form it is for. */
  chosen: boolean;
  /**
   * Why the call cannot go as it is — a field the chosen form does not have, a value past its limit — told to
   * the visitor in words and to the model with the field names. Absent when it fits.
   */
  problem?: { visitor: string; model: string };
}

/**
 * Check a call to a site tool against the form it picked.
 *
 * One tool covers a form on many pages, and its schema accepts every field any of them has: every ticket tier of
 * every event. Once the call says which event, only that event's tiers mean anything, and a quantity for a tier
 * it doesn't sell is a mistake to catch before the visitor is asked to confirm it, not after.
 *
 * @param tool - The tool called.
 * @param values - The call's values, resolved against the tool's schema: they say which form.
 * @param given - What the call itself asked for, without defaults: checked against that form.
 * @returns The fit, or null when the tool's forms all take the same fields (nothing to narrow), or it is not a
 * site tool built on this page.
 */
export function siteCallFit(
  tool: ModelContextToolInfo,
  values: Record<string, unknown>,
  given: Record<string, unknown> = values,
): SiteCallFit | null {
  const local = built.get(tool.name);
  if (!local || local.actions.length < 2 || !fieldsDiffer(local.actions)) return null;
  const action = pickAction(local, values ?? {});
  if (!action) return { schema: local.definition.inputSchema ?? { type: 'object', properties: {} }, chosen: false };
  return fitFor({ ...local, inputSchema: local.definition.inputSchema ?? { type: 'object' } }, action, given);
}

/** How a call fits one of a tool's forms. See {@link siteCallFit}. */
function fitFor(
  local: Pick<RunTool, 'name' | 'actions' | 'discriminator' | 'choices' | 'inputSchema'>,
  action: NxisAction,
  given: Record<string, unknown>,
): SiteCallFit {
  const whole = local.inputSchema;
  const chooser = local.discriminator!;
  const own = action.input ?? [];
  const properties: Record<string, JsonSchema> = {};
  for (const spec of own) properties[spec.valueName] = propertySchema(spec);
  const chooserProp = whole.properties?.[chooser];
  if (chooserProp) properties[chooser] = chooserProp;
  const required = [...new Set([...own.filter((i) => i.valueRequired).map((i) => i.valueName), chooser])];
  const schema: JsonSchema = { type: 'object', properties, required };

  const label = local.choices?.[local.actions.indexOf(action)] ?? '';
  const other = (key: string): NxisPropertyValueSpecification | undefined =>
    local.actions.flatMap((a) => a.input ?? []).find((i) => i.valueName === key);
  const unknown = Object.keys(given ?? {}).filter((k) => k !== chooser && !(k in properties) && asksFor(given[k]));
  const past = own.filter((spec) => {
    const n = Number(given?.[spec.valueName]);
    if (given?.[spec.valueName] === undefined || given[spec.valueName] === '' || Number.isNaN(n)) return false;
    return (spec.maxValue !== undefined && n > spec.maxValue) || (spec.minValue !== undefined && n < spec.minValue);
  });
  if (!unknown.length && !past.length) return { schema, chosen: true };

  // What this form takes that the others may not (this event's tiers), with its limits: what to choose from
  // instead. A field every copy of the form has (a name, a honeypot) is not news.
  const everywhere = (key: string) => local.actions.every((a) => fieldNames(a).includes(key));
  const varying = own.filter((i) => i.valueName !== chooser && !everywhere(i.valueName));
  const offered = varying.length ? varying : own.filter((i) => i.valueName !== chooser);
  const offer = (spec: NxisPropertyValueSpecification, named = fieldWords(spec, spec.valueName)): string => {
    const l = limits(spec);
    return l ? `${named} (${l})` : named;
  };
  const visitor: string[] = [];
  const model: string[] = [];
  if (unknown.length) {
    const names = unknown.map((k) => fieldWords(other(k), k));
    visitor.push(`${listed(names.map((n) => `"${n}"`))} ${names.length > 1 ? "aren't" : "isn't"} available for ${label}.`);
    model.push(`${label} has no field ${listed(unknown)}.`);
  }
  for (const spec of past) {
    visitor.push(`${fieldWords(spec, spec.valueName)} for ${label} is ${limits(spec)}.`);
    model.push(`${spec.valueName} for ${label} is ${limits(spec)}.`);
  }
  if (offered.length) {
    visitor.push(`It offers ${listed(offered.map((spec) => offer(spec)))}.`);
    model.push(`Its fields are ${listed(offered.map((spec) => offer(spec, spec.valueName)))}.`);
  }
  model.push(`Call ${local.name} again with only those, or ask the visitor.`);
  return { schema, chosen: true, problem: { visitor: visitor.join(' '), model: model.join(' ') } };
}

/**
 * The options each field offers on the one form a call means.
 *
 * A site tool's schema accepts any option the same field offers on any of its
 * pages, which for a per-business quote form is every service of every
 * business. Once the call says which business, only that form's options mean
 * anything, and a prompt should offer only those.
 *
 * @returns Option values by field name; empty when the tool is not a site
 * tool built on this page, or the call does not yet say which form.
 */
export function formOptions(tool: ModelContextToolInfo, values: Record<string, unknown>): Record<string, string[]> {
  const local = built.get(tool.name);
  const action = local ? pickAction(local, values ?? {}) : null;
  const out: Record<string, string[]> = {};
  for (const spec of action?.input ?? []) {
    const options = (spec['nxis:valueOption'] ?? []).map((o) => o.value).filter((v) => !isPlaceholder(v));
    if (options.length) out[spec.valueName] = options;
  }
  return out;
}

/**
 * The site forms that can be sent to a business, by its name: the site tools
 * on this page whose choices include it.
 *
 * @returns Each form's tool name and what it is called ("quote form").
 */
export function formsFor(name: string): { tool: string; noun: string }[] {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return [];
  const out: { tool: string; noun: string }[] = [];
  for (const [toolName, t] of built) {
    if (t.choices?.some((c) => c.toLowerCase() === wanted)) {
      out.push({ tool: toolName, noun: withoutSiteSuffix(toolName).replace(/[_-]+/g, ' ').trim().toLowerCase() });
    }
  }
  return out;
}

/**
 * The site form that runs an action, by the action's `@id`: the site-wide tool
 * built on this page that covers it, and which business it is for.
 *
 * @returns The tool's name, what the form is called ("quote form"), the
 * choice that picks this action when the tool covers several, and the
 * arguments that make a call to it this action; null when no site tool built
 * here covers it.
 */
export function siteFormFor(
  actionId: string,
): { tool: string; noun: string; choice?: string; args: Record<string, unknown> } | null {
  for (const [toolName, t] of built) {
    const index = t.actions.findIndex((a) => a['@id'] === actionId);
    if (index < 0) continue;
    const noun = withoutSiteSuffix(toolName).replace(/[_-]+/g, ' ').trim().toLowerCase();
    const choice = t.choices?.[index];
    const args = choice && t.discriminator ? { [t.discriminator]: choice } : {};
    return choice ? { tool: toolName, noun, choice, args } : { tool: toolName, noun, args };
  }
  return null;
}

/**
 * The `@id` of the action a call to a form tool means.
 *
 * A page's own tool records its action under {@link ACTION_ID_HINT}. A
 * site-wide tool covers several, and the call's choice ("McManus Electric")
 * says which: read from what this page built, else from the tool's
 * annotations, as {@link chooserOf} reads them.
 *
 * @param tool - The form tool called.
 * @param values - The call's arguments.
 * @returns The action's `@id`; undefined when the tool records none, or the
 * call does not yet say which of a site tool's actions it means.
 */
export function actionIdFor(tool: ModelContextToolInfo, values: Record<string, unknown> | undefined): string | undefined {
  const own = tool.annotations?.[ACTION_ID_HINT];
  if (typeof own === 'string' && own) return own;
  const local = built.get(tool.name);
  if (local) return pickAction(local, values ?? {})?.['@id'];
  const cover = coverageOf(tool);
  if (!cover) return undefined;
  if (cover.ids.length === 1) return cover.ids[0];
  const wanted = String(values?.[cover.chooser] ?? '').trim().toLowerCase();
  const index = wanted ? cover.choices.findIndex((c) => c.toLowerCase() === wanted) : -1;
  return index >= 0 ? cover.ids[index] : undefined;
}

/** An option that only asks to choose: "Select…", "Choose a service…". */
export const isPlaceholder = (value: string): boolean => /^\s*(select|choose|pick)\b/i.test(value) || /…\s*$|\.\.\.\s*$/.test(value);

/** Which page tool to look for: the action's id, and the name it would have. */
export interface PageToolRef {
  /** The action's `@id`. */
  id: string;
  /** The name the page's script derives from the action's name. */
  name: string;
}

/** The reference for an action. */
export const pageToolRef = (action: NxisAction): PageToolRef => ({
  id: action['@id'],
  name: sanitizeToolName(action.name),
});

/** The page's own tool for an action: by recorded `@id`, else by name. */
export async function findPageTool(
  mc: ModelContext,
  ref: PageToolRef,
): Promise<ModelContextToolInfo | null> {
  let tools: ModelContextToolInfo[];
  try {
    tools = await mc.getTools();
  } catch {
    return null;
  }
  const byId = tools.find((t) => t.annotations?.[ACTION_ID_HINT] === ref.id);
  if (byId) return byId;
  // Only on the action's own page: elsewhere a tool of the same name belongs
  // to a different form.
  return tools.find((t) => t.name === ref.name && !t.annotations?.[SITE_ACTION_HINT]) ?? null;
}

/**
 * Wait for the page's own tool to register.
 *
 * After a page change the agent is running before the page's script has read
 * its JSON-LD, so the tool a resumed call needs does not exist yet.
 *
 * @param mc - The page's registry.
 * @param ref - The tool to wait for.
 * @param timeoutMs - How long to wait before giving up.
 * @returns The tool, or null if it never appears.
 */
export async function awaitPageTool(
  mc: ModelContext,
  ref: PageToolRef,
  timeoutMs = 8000,
): Promise<ModelContextToolInfo | null> {
  const found = await findPageTool(mc, ref);
  if (found) return found;

  return new Promise((resolve) => {
    let done = false;
    const finish = (tool: ModelContextToolInfo | null) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      mc.removeEventListener('toolchange', onChange);
      resolve(tool);
    };
    const check = async () => {
      const tool = await findPageTool(mc, ref);
      if (tool) finish(tool);
    };
    const onChange = () => void check();
    mc.addEventListener('toolchange', onChange);
    // Polled as well as event-driven: a native registry need not announce a
    // registration that happened before this listener was attached.
    const poll = setInterval(() => void check(), 300);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Where a call is bound for, when that is not the page the agent is on. */
export interface Handoff {
  /** The action that will run. */
  actionId: string;
  /** The page it will run on. */
  pageUrl: string;
  /** What to call that destination in a sentence. */
  label: string;
  /** The name the page's own tool is expected to have. */
  pageToolName: string;
}

/**
 * Where a call to a site tool will have to go, if not here.
 *
 * Needs nothing but the tool, so a caller holding only what the registry
 * reported — the harness, labelling a confirmation — can tell that pressing
 * submit also means a page change.
 *
 * @param tool - The tool about to be called.
 * @param values - The arguments resolved so far.
 * @param href - The current page. Defaults to the browser's.
 * @returns The destination, or null when the call runs here, when the tool is
 * not one of these, or when the values do not yet say which action is meant.
 */
export function handoffFor(
  tool: ModelContextToolInfo,
  values: Record<string, unknown>,
  href?: string,
): Handoff | null {
  const cover = coverageOf(tool);
  if (!cover) return null;

  let index = 0;
  if (cover.ids.length > 1) {
    if (!cover.chooser) return null;
    const wanted = String(values?.[cover.chooser] ?? '').trim();
    index = choiceIndex(cover.choices, built.get(tool.name)?.values, wanted);
    if (index < 0) return null;
  }

  const pageUrl = cover.pages[index];
  if (!pageUrl || samePage(pageUrl, href ?? (typeof location === 'undefined' ? '' : location.href))) {
    return null;
  }
  return {
    actionId: cover.ids[index],
    pageUrl,
    label: destinationName(cover.chooser, cover.choices[index], pageUrl),
    // One name covers the group: these actions share the name they came from.
    pageToolName: cover.pageToolNames[0] ?? '',
  };
}

/**
 * What to call where a form is, in a sentence: what the form itself names (the business a quote goes to), else the
 * page's title. Empty when neither is known: the `target` choices are page paths, and a path is not a name.
 */
function destinationName(chooser: string | undefined, choice: string | undefined, pageUrl: string): string {
  return (chooser && chooser !== 'target' && choice) || pageTitle(pageUrl);
}

/**
 * Run a read-only form: open its results page, as submitting it would, with the conversation kept.
 *
 * Nothing is sent to anyone, so nothing waits for a press and nothing is carried but the visit.
 */
function openResults(
  tool: RunTool,
  action: NxisAction,
  input: Record<string, unknown>,
  opts: BuildOptions,
): ModelContextToolResponse {
  const here = opts.href ?? (typeof location === 'undefined' ? '' : location.href);
  const url = resultsUrl(action, argsFor(tool, action, input));
  if (!url || !sameOrigin(url, here)) return text(`"${action.name}" belongs to another site, so I did not open it.`, true);
  const label = pageTitle(action.target['nxis:pageUrl'], opts.href);
  savePendingVisit(
    { pageUrl: url, label, conversationId: opts.conversationId, steps: journeySteps() },
    { storage: opts.storage },
  );
  (opts.navigate ?? ((to: string) => location.assign(to)))(url);
  return {
    content: [{ type: 'text', text: label ? `Opening ${label}…` : 'Opening the results…' }],
    structuredContent: { [HANDOFF_RESULT]: { pageUrl: url, label } },
  };
}

/** What running a site tool needs of it. */
type RunTool = Pick<SiteActionTool, 'name' | 'actions' | 'discriminator' | 'choices' | 'values' | 'fixed'> & {
  /** The tool's whole schema. */
  inputSchema: JsonSchema;
};

async function runSiteAction(
  tool: RunTool,
  mc: ModelContext,
  input: Record<string, unknown>,
  opts: BuildOptions,
): Promise<ModelContextToolResponse> {
  const wanted = tool.discriminator ? String(input?.[tool.discriminator] ?? '').trim() : '';
  const action = pickAction(tool, input ?? {}) ?? (await lookUp(tool, wanted, opts));
  if (!action) {
    // Said to the visitor as well as the model: the renderer shows a failed call's result.
    if (!wanted) return text(`Say which one this is for: ${summarize(tool.choices ?? [])}.`, true);
    return text(`I couldn't find a ${humanize(tool.actions[0].name)} for "${wanted}" on this site. It covers ${summarize(tool.choices ?? [])}.`, true);
  }
  // Checked here too, for a call that came some other way than through the harness's own check.
  if (fieldsDiffer(tool.actions) && tool.actions.includes(action)) {
    const fit = fitFor(tool, action, input ?? {});
    if (fit.problem) return text(fit.problem.visitor, true);
  }

  const pageUrl = action.target['nxis:pageUrl'] ?? '';
  // A search form's answer is its results page, wherever the agent is. One the page's own script handles (filtering
  // in place) is filled on its page instead, as any form is: it may not read a query string.
  if (readsOnly(action) && !action.target['nxis:jsHandled']) {
    return openResults(tool, action, input ?? {}, opts);
  }
  if (!sameActionPage(action, opts.href)) {
    // Filling the form means being on its page, so the confirmed call travels:
    // held in this tab, submitted once the browser arrives.
    const index = tool.actions.indexOf(action);
    const label = destinationName(tool.discriminator, tool.choices?.[index] || wanted, pageUrl);
    const here = opts.href ?? (typeof location === 'undefined' ? '' : location.href);
    if (!sameOrigin(pageUrl, here)) {
      return text(`"${action.name}" belongs to another site, so I did not open it.`, true);
    }

    const held = savePendingAction(
      {
        actionId: action['@id'],
        pageToolName: sanitizeToolName(action.name),
        toolName: siteToolName(action.name),
        values: argsFor(tool, action, input ?? {}),
        pageUrl,
        conversationId: opts.conversationId,
        // The steps that led here happened on a page that is about to stop
        // existing. Carried, so the surface on the other side can show why
        // it is there rather than starting mid-journey.
        steps: journeySteps(),
      },
      { storage: opts.storage },
    );
    if (!held) {
      return text(
        `This form is on ${pageUrl}. I could not carry the details there, ` +
          'so open that page and I will fill it in.',
        true,
      );
    }

    (opts.navigate ?? ((url: string) => location.assign(url)))(pageUrl);
    // Not a submission: the form has not been filled, and the page is about to
    // change under us. Marked so a renderer reports a journey rather than
    // drawing the "submitted" card that every other write earns.
    return {
      content: [{ type: 'text', text: label ? `Opening ${label} to submit this…` : 'Opening the page that can submit this…' }],
      structuredContent: { [HANDOFF_RESULT]: { pageUrl, label } },
    };
  }

  const pageTool = await findPageTool(mc, pageToolRef(action));
  if (!pageTool) {
    return text(
      `The form for "${action.name}" is not registered on this page yet. Reload and try again.`,
      true,
    );
  }

  return executeRegistered(mc, pageTool, pageTool.name, argsFor(tool, action, input ?? {}));
}

/**
 * The action a call names that is not among the tool's own: found in the
 * site's index, inside the record it belongs to. Null when there is nothing
 * to look up, nobody to ask, or nothing found.
 */
async function lookUp(
  tool: Pick<SiteActionTool, 'actions' | 'discriminator'>,
  wanted: string,
  opts: BuildOptions,
): Promise<NxisAction | null> {
  if (!wanted || !tool.discriminator || !opts.findAction) return null;
  try {
    return await opts.findAction({ actionName: tool.actions[0].name, field: tool.discriminator, value: wanted });
  } catch (err) {
    console.warn(`[nxis] could not look up "${wanted}":`, err);
    return null;
  }
}

/** A list of choices short enough to read: the first few, and how many more. */
function summarize(choices: string[]): string {
  if (!choices.length) return 'nothing yet';
  const shown = choices.slice(0, 5).join(', ');
  return choices.length > 5 ? `${shown}, and ${choices.length - 5} more` : shown;
}

/** `quote-form` → `quote form`. */
const humanize = (name: string): string => name.replace(/[-_]+/g, ' ').trim();

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The arguments the form itself takes.
 *
 * A `target` field is the group's own invention, for choosing between pages;
 * a real field such as `business` belongs to the form and stays.
 */
function withoutChooser(
  tool: Pick<SiteActionTool, 'discriminator' | 'fixed'>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...input };
  if (tool.discriminator === 'target') delete args.target;
  // A constant is the page's to submit: its form already holds the event it is for.
  else if (tool.fixed && tool.discriminator) delete args[tool.discriminator];
  return args;
}

/**
 * The arguments one form takes: {@link withoutChooser}, with a labelled choice sent as the value the form holds
 * (the code behind an event's name), and, where the tool's forms differ, only this form's own fields.
 */
function argsFor(tool: RunTool, action: NxisAction, input: Record<string, unknown>): Record<string, unknown> {
  const args = withoutChooser(tool, input);
  const d = tool.discriminator;
  const index = tool.actions.indexOf(action);
  if (d && !tool.fixed && d !== 'target' && tool.values && index >= 0 && d in args) args[d] = tool.values[index];
  if (index >= 0 && action.input?.length && fieldsDiffer(tool.actions)) {
    const own = new Set(fieldNames(action));
    for (const key of Object.keys(args)) if (!own.has(key)) delete args[key];
  }
  return args;
}

/** Same origin, so a stale or tampered record cannot send a visitor away. */
function sameOrigin(url: string, here: string): boolean {
  try {
    return new URL(url, here).origin === new URL(here).origin;
  } catch {
    return false;
  }
}

// ── registering ─────────────────────────────────────────────────────────────

/**
 * Register a tool for each of the site's actions.
 *
 * @param mc - The registry to register into.
 * @param actions - The site's actions.
 * @param opts - The current page.
 * @returns The names registered. A name the registry already holds is left
 * alone, and a registration it refuses is warned about rather than thrown.
 */
export async function registerSiteActionTools(
  mc: ModelContext,
  actions: NxisAction[],
  opts: BuildOptions = {},
): Promise<string[]> {
  if (!actions.length) return [];
  const tools = buildSiteActionTools(actions, mc, opts);
  let present: Set<string>;
  try {
    present = new Set((await mc.getTools()).map((t) => t.name));
  } catch {
    present = new Set();
  }

  const registered: string[] = [];
  for (const tool of tools) {
    if (present.has(tool.name)) continue;
    try {
      await mc.registerTool(tool.definition);
    } catch (err) {
      console.warn(`[nxis] could not register ${tool.name}:`, err);
      continue;
    }
    toolOrigins.set(tool.name, 'site');
    registered.push(tool.name);
  }
  return registered;
}

// ── what reaches the prompt ─────────────────────────────────────────────────

/** How many site-wide tools a turn may carry, before relevance decides. */
export const DEFAULT_SITE_TOOL_LIMIT = 8;

/** Words too common to say anything about which form is meant. */
const STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'need', 'want', 'would',
  'like', 'please', 'can', 'you', 'get', 'got', 'have', 'has', 'about', 'out',
  'she', 'her', 'his', 'him', 'they', 'them', 'their', 'some', 'any', 'here',
]);

const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));

/** How well a tool answers what was asked. */
function relevance(tool: ModelContextToolInfo, cover: Coverage, goal: string, asked: Set<string>): number {
  let score = 0;
  for (const word of words(`${tool.name} ${tool.description ?? ''}`)) {
    if (asked.has(word)) score += 1;
  }
  // A choice named in the request is the strongest signal there is: these are
  // the site's own names for what each action acts on.
  const lower = goal.toLowerCase();
  if (cover.choices.some((c) => c && lower.includes(c.toLowerCase()))) score += 3;
  return score;
}

/** Options for {@link selectSiteTools}. */
export interface SelectOptions {
  /** How many site-wide tools to keep. Defaults to {@link DEFAULT_SITE_TOOL_LIMIT}. */
  limit?: number;
  /** The current page. Defaults to the browser's. */
  href?: string;
}

/**
 * Narrow the site-wide tools to those this turn could plausibly need.
 *
 * Every registered tool's schema is written into every prompt, and a site
 * with many distinct forms would fill the context with forms nobody asked
 * about. Tools belonging to the page the agent is on are always kept — they
 * are what "this form" means — and the rest compete on how well they answer
 * what was asked.
 *
 * Only site-wide tools are ever dropped. The page's own tools and the
 * retrieval tools are few, and losing one of those loses a capability rather
 * than trimming a list.
 *
 * @param tools - The tools on offer this turn.
 * @param goal - What the user asked for.
 * @param opts - The budget and the current page.
 * @returns The tools to show, in the order they arrived.
 */
export function selectSiteTools(
  tools: ModelContextToolInfo[],
  goal: string,
  opts: SelectOptions = {},
): ModelContextToolInfo[] {
  const limit = opts.limit ?? DEFAULT_SITE_TOOL_LIMIT;
  const here = opts.href ?? (typeof location === 'undefined' ? '' : location.href);
  const asked = words(goal ?? '');

  const ranked: { name: string; onPage: boolean; score: number }[] = [];
  for (const tool of tools) {
    const cover = coverageOf(tool);
    if (!cover) continue;
    ranked.push({
      name: tool.name,
      onPage: cover.pages.some((p) => samePage(p, here)),
      score: relevance(tool, cover, goal ?? '', asked),
    });
  }
  if (ranked.length <= limit) return tools;

  ranked.sort((a, b) => Number(b.onPage) - Number(a.onPage) || b.score - a.score);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.name));
  return tools.filter((tool) => !coverageOf(tool) || keep.has(tool.name));
}

// ── one route per action ────────────────────────────────────────────────────

/**
 * Drop page tools that a site tool already covers.
 *
 * On the page an action belongs to, the page's script registers its own tool
 * and the site tool delegates to it. Both in the prompt would offer the model
 * two ways to do one thing, and the second is chosen half the time.
 *
 * @param tools - Every tool the registry reported.
 * @param href - The current page. Defaults to the browser's.
 * @returns The tools to show the model.
 */
export function withoutShadowedTools(
  tools: ModelContextToolInfo[],
  href?: string,
): ModelContextToolInfo[] {
  const coveredIds = new Set<string>();
  const coveredNames = new Set<string>();
  const here = href ?? (typeof location === 'undefined' ? '' : location.href);

  for (const tool of tools) {
    const cover = coverageOf(tool);
    if (!cover) continue;
    for (const id of cover.ids) coveredIds.add(id);
    // Names are only ambiguous evidence, so they count only where this tool
    // actually covers the page the agent is on.
    if (cover.pages.some((p) => samePage(p, here))) {
      for (const name of cover.pageToolNames) coveredNames.add(name);
    }
  }
  if (!coveredIds.size && !coveredNames.size) return tools;

  return tools.filter((tool) => {
    // The site-wide tool is never hidden: it is the route, not the duplicate.
    if (coverageOf(tool)) return true;
    const id = tool.annotations?.[ACTION_ID_HINT];
    if (typeof id === 'string' && coveredIds.has(id)) return false;
    return !coveredNames.has(tool.name);
  });
}

/**
 * The report a page form's run makes, or none when it was no action of the
 * site's. Matched the way {@link findPageTool} finds the form: by `@id` where
 * the registry kept it, else by name, and then only on the action's own page —
 * elsewhere a tool of the same name belongs to a different form.
 *
 * @param actions - The site's actions.
 * @param run - The page tool that went through.
 * @param href - The current page. Defaults to the browser's.
 */
export function reportFor(actions: NxisAction[], run: PageFormRun, href?: string): SiteActionReport | null {
  const action = run.actionId
    ? actions.find((a) => a['@id'] === run.actionId)
    : actions.find((a) => sanitizeToolName(a.name) === run.toolName && sameActionPage(a, href));
  const actionId = action?.['@id'] ?? run.actionId;
  if (!actionId) return null;
  const type = shortActionType(action?.['@type']);
  return { outcome: 'submitted', action_id: actionId, ...(type ? { action_type: type } : {}), source: 'on_page_agent' };
}

/** `QuoteAction`, however the record spelled it. */
function shortActionType(type: string | undefined): string | undefined {
  const name = typeof type === 'string' ? type.split(/[/:#]/).pop() : undefined;
  return name && /^[A-Z][A-Za-z]*Action$/.test(name) ? name : undefined;
}
