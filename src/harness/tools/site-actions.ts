/**
 * Fetches every Schema.org Action on the site through typed retrieval.
 *
 * The page's own script registers tools only for the actions in the current
 * page's JSON-LD. The site's MCP server holds them all, so an agent opened on
 * any page can learn what the rest of the site offers. This module fetches and
 * normalises that list; turning it into tools is a separate step.
 *
 * Records arrive with expanded IRI keys (`https://schema.org/name`) where a
 * page carries compact ones (`name`), so both spellings are read, as the
 * page's script does.
 *
 * @module
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServerInfo } from '../../types.js';
import { withRetry } from './retry.js';
import type {
  NxisAction,
  NxisEntryPoint,
  NxisPropertyValueSpecification,
  NxisValueOption,
  NxisValueType,
} from '../../webmcp-contract.js';

const SCHEMA_NS = 'https://schema.org/';
const NXIS_NS = 'https://nxis.ai/ns#';

/** The server caps a page of results at this many. */
const PAGE_LIMIT = 100;
/** A guard against a server that keeps returning page tokens. */
const MAX_PAGES = 10;
/** How long a fetched list is reused across page loads in the same tab. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_PREFIX = 'nxis:site-actions:v1:';
/** Set once the skipped actions have been logged in this tab, so the note isn't repeated on every page. */
const SKIPPED_PREFIX = 'nxis:site-actions-skipped:';

const VALUE_TYPES: readonly NxisValueType[] = ['string', 'number', 'integer', 'boolean', 'date', 'file'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A schema.org property, by compact term or expanded IRI. */
const schemaValue = (o: Obj, prop: string): unknown => o[prop] ?? o[SCHEMA_NS + prop];
/** An nxis extension property, by compact term or expanded IRI. */
const nxisValue = (o: Obj, prop: string): unknown => o[`nxis:${prop}`] ?? o[NXIS_NS + prop];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** `https://schema.org/InteractAction` → `InteractAction`. */
const bareType = (t: string): string => t.replace(/^.*[/#]/, '');

/**
 * Read one typed-retrieval record as an action.
 *
 * @param raw - A record as returned by `nxis_query`.
 * @returns The action with bare types and compact keys, or null when the record
 * is not an Action or lacks an `@id`, a name, or a target with an HTTP method.
 */
export function parseAction(raw: unknown): NxisAction | null {
  if (!isObj(raw)) return null;
  const rawType = str(raw['@type']);
  if (!rawType) return null;
  const type = bareType(rawType);
  if (!type.endsWith('Action')) return null;

  const id = str(raw['@id']);
  const name = str(schemaValue(raw, 'name'));
  const target = parseEntryPoint(schemaValue(raw, 'target'));
  if (!id || !name || !target) return null;

  // Inputs live under `nxis:input`: schema.org has no `input` on Action.
  const rawInput = nxisValue(raw, 'input');
  const input = (Array.isArray(rawInput) ? rawInput : [])
    .map(parseInput)
    .filter((i): i is NxisPropertyValueSpecification => i !== null);

  // The page's own constants (a hidden `event`), which its form submits itself: not inputs, but what tells
  // one page's form from another's. A single one may arrive as an object rather than a list.
  const rawFixed = nxisValue(raw, 'fixedInput');
  const fixed = (Array.isArray(rawFixed) ? rawFixed : rawFixed === undefined ? [] : [rawFixed])
    .map(parseInput)
    .filter((i): i is NxisPropertyValueSpecification => i !== null && i.defaultValue !== undefined);

  const action: NxisAction = { '@type': type, '@id': id, name, target };
  const description = str(schemaValue(raw, 'description'));
  if (description) action.description = description;
  if (input.length) action.input = input;
  if (fixed.length) action['nxis:fixedInput'] = fixed;
  const extractedAt = str(nxisValue(raw, 'extractedAt'));
  if (extractedAt) action['nxis:extractedAt'] = extractedAt;
  return action;
}

function parseEntryPoint(raw: unknown): NxisEntryPoint | null {
  if (!isObj(raw)) return null;
  const httpMethod = str(schemaValue(raw, 'httpMethod'))?.toUpperCase();
  if (!httpMethod) return null;

  const target: NxisEntryPoint = { '@type': 'EntryPoint', httpMethod };
  const urlTemplate = str(schemaValue(raw, 'urlTemplate'));
  if (urlTemplate) target.urlTemplate = urlTemplate;
  const encodingType = str(schemaValue(raw, 'encodingType'));
  if (encodingType) target.encodingType = encodingType;
  const kind = nxisValue(raw, 'targetKind');
  if (kind === 'selfPage' || kind === 'clientSide') target['nxis:targetKind'] = kind;
  const pageUrl = str(nxisValue(raw, 'pageUrl'));
  if (pageUrl) target['nxis:pageUrl'] = pageUrl;
  if (nxisValue(raw, 'jsHandled') === true) target['nxis:jsHandled'] = true;
  const observedUrl = str(nxisValue(raw, 'observedUrl'));
  if (observedUrl) target['nxis:observedUrl'] = observedUrl;
  return target;
}

function parseInput(raw: unknown): NxisPropertyValueSpecification | null {
  if (!isObj(raw)) return null;
  const valueName = str(schemaValue(raw, 'valueName'));
  if (!valueName) return null;

  const declared = str(nxisValue(raw, 'valueType')) as NxisValueType | undefined;
  const spec: NxisPropertyValueSpecification = {
    '@type': 'PropertyValueSpecification',
    valueName,
    'nxis:valueType': declared && VALUE_TYPES.includes(declared) ? declared : 'string',
  };

  const description = str(schemaValue(raw, 'description'));
  if (description) spec.description = description;
  if (schemaValue(raw, 'valueRequired') === true) spec.valueRequired = true;
  const defaultValue = str(schemaValue(raw, 'defaultValue'));
  if (defaultValue !== undefined) spec.defaultValue = defaultValue;
  for (const key of ['valueMinLength', 'valueMaxLength', 'minValue', 'maxValue', 'stepValue'] as const) {
    const v = num(schemaValue(raw, key));
    if (v !== undefined) spec[key] = v;
  }
  const valuePattern = str(schemaValue(raw, 'valuePattern'));
  if (valuePattern) spec.valuePattern = valuePattern;
  if (schemaValue(raw, 'multipleValues') === true) spec.multipleValues = true;
  if (schemaValue(raw, 'readonlyValue') === true) spec.readonlyValue = true;

  const rawOptions = nxisValue(raw, 'valueOption');
  const options: NxisValueOption[] = [];
  for (const o of Array.isArray(rawOptions) ? rawOptions : []) {
    if (!isObj(o)) continue;
    const value = str(schemaValue(o, 'value'));
    if (value === undefined) continue;
    const label = str(schemaValue(o, 'name'));
    options.push(label ? { '@type': 'nxis:ValueOption', value, name: label } : { '@type': 'nxis:ValueOption', value });
  }
  if (options.length) spec['nxis:valueOption'] = options;
  return spec;
}

/**
 * Whether two URLs name the same page, ignoring the query and fragment.
 *
 * A form is the same form whether it was reached with tracking parameters or
 * without.
 */
export function samePage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a, b);
    const y = new URL(b, a);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/**
 * Whether an action's form is on the page currently open.
 *
 * @param action - The action to place.
 * @param href - The current page. Defaults to the browser's.
 */
export function sameActionPage(action: NxisAction, href?: string): boolean {
  const here = href ?? (typeof location === 'undefined' ? undefined : location.href);
  return samePage(action.target['nxis:pageUrl'], here);
}

/**
 * Whether an action can be carried out from this site.
 *
 * Actions run by filling the form on their own page, so the harness may later
 * navigate to `nxis:pageUrl`. A record naming another origin, whether stale or
 * tampered with, must never send the visitor there.
 */
function onOrigin(action: NxisAction, origin: string): boolean {
  const pageUrl = action.target['nxis:pageUrl'];
  if (!pageUrl) return false;
  try {
    return new URL(pageUrl, origin).origin === origin;
  } catch {
    return false;
  }
}

/** The origin of an action's page, or '' when it names none or one that can't be read. */
function pageOrigin(action: NxisAction): string {
  try {
    return new URL(action.target['nxis:pageUrl'] ?? '').origin;
  } catch {
    return '';
  }
}

/**
 * Say, once a tab session, at debug level, which site actions this origin can't run. It is expected, not a fault: a
 * site's records can hold actions whose form is on another host, or that have no page (one a hosted agent answers).
 */
function noteSkipped(storage: Storage | null, key: string, skipped: string[]): void {
  const told = SKIPPED_PREFIX + key;
  try {
    if (storage?.getItem(told)) return;
    storage?.setItem(told, '1');
  } catch {
    // Blocked storage: said on each load, at debug level still.
  }
  const elsewhere = [...new Set(skipped.filter(Boolean))];
  const pageless = skipped.filter((o) => !o).length;
  console.debug(
    `[nxis] skipped ${skipped.length} site action(s) this page can't run: ` +
      [elsewhere.length ? `a page on ${elsewhere.join(', ')}` : '', pageless ? `${pageless} with no page` : ''].filter(Boolean).join('; '),
  );
}

/**
 * The records in a tool result, whether structured or JSON text.
 *
 * Typed loosely because the SDK's result type also admits the legacy
 * `{ toolResult }` shape, which carries neither.
 */
function readResults(result: Obj): { results: unknown[]; nextPageToken?: string; total?: number } {
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
    .join('');
  if (result.isError) throw new Error(text || 'nxis_query failed');
  let body: unknown = result.structuredContent;
  if (!isObj(body)) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('nxis_query returned a response that is not JSON');
    }
  }
  const b = body as Obj;
  return {
    results: Array.isArray(b.results) ? b.results : [],
    nextPageToken: str(b.next_page_token) || undefined,
    total: num(b.total),
  };
}

/**
 * Query every record whose `@type` contains `fragment`.
 *
 * `schema_type: "Action"` does not yet expand to subtypes on the server, so
 * this matches on `@type` instead and the caller filters the results. When the
 * server supports the type hierarchy, only this function needs to change.
 *
 * @param client - A connected client for the site's MCP server.
 * @param fragment - Part of the type name: `Action`, `Page`.
 * @returns Every matching record, across the server's result pages.
 */
export async function queryTypedRecords(client: Client, fragment: string): Promise<unknown[]> {
  const records: unknown[] = [];
  let pageToken: string | undefined;
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await withRetry(() => client.callTool({
      name: 'nxis_query',
      arguments: {
        filter: {
          schema_type: '',
          field_filters: [{ path: '@type', operator: 'CONTAINS', value: fragment }],
        },
        limit: PAGE_LIMIT,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }));
    const read = readResults(result);
    records.push(...read.results);
    total = read.total ?? total;
    pageToken = read.nextPageToken;
    if (!pageToken) break;
  }
  if (total !== undefined && records.length < total) {
    console.warn(
      `[nxis] site ${fragment} records truncated: fetched ${records.length} of ${total} — ` +
        'the server returned no further pages',
    );
  }
  return records;
}

/** What a form tool is looking for when none of its own actions matched. */
export interface EmbeddedActionQuery {
  /** The action's name, as the tool's group shares it: `quote-form`. */
  actionName: string;
  /** The field that chooses between the group's actions: `business`, or the added `target`. */
  field: string;
  /** The value the call gave it: `Hatzel & Sons Plumbing`. */
  value: string;
  /** The origin the action's page must be on. Defaults to the page's own. */
  origin?: string;
}

/**
 * Find a form the index holds only inside another record.
 *
 * The site's actions are fetched once, as standalone Action records. An index
 * can lag behind its pages — a partial re-crawl leaves some forms only as the
 * `potentialAction` of the business or page they belong to — and a call naming
 * one of those would otherwise fail with "say which one". So a miss looks the
 * value up by name, and takes an action embedded in what it finds when that
 * action is the same form: the same name, on this origin, and meant for this
 * value.
 *
 * @param client - A connected client for the site's MCP server.
 * @param query - The form, the choosing field, and the value asked for.
 * @returns The action, or null when nothing on the site matches.
 */
export async function findEmbeddedAction(client: Client, query: EmbeddedActionQuery): Promise<NxisAction | null> {
  const origin = query.origin ?? location.origin;
  const wanted = query.value.trim().toLowerCase();
  if (!wanted) return null;
  const result = await withRetry(() =>
    client.callTool({
      name: 'nxis_query',
      arguments: {
        filter: { schema_type: '', field_filters: [{ path: 'name', operator: 'CONTAINS', value: query.value.trim() }] },
        limit: 20,
      },
    }),
  );
  const matches: NxisAction[] = [];
  for (const record of readResults(result).results) {
    if (!isObj(record)) continue;
    const owner = (str(schemaValue(record, 'name')) ?? '').trim().toLowerCase();
    const embedded = schemaValue(record, 'potentialAction');
    for (const raw of Array.isArray(embedded) ? embedded : [embedded]) {
      const action = parseAction(raw);
      if (!action || action.name !== query.actionName || !onOrigin(action, origin)) continue;
      // Meant for this value: the form says so itself, or it belongs to the record the value names.
      const own = action.input?.find((i) => i.valueName === query.field)?.defaultValue?.trim().toLowerCase();
      // A constant (the hidden event code) is what the form holds, not what anyone calls it: the record's
      // name answers as well.
      const fixed = action['nxis:fixedInput']?.find((i) => i.valueName === query.field)?.defaultValue?.trim().toLowerCase();
      if (own ? own === wanted : fixed ? fixed === wanted || owner === wanted : owner === wanted) matches.push(action);
    }
  }
  // Two different forms answering to one name is a question for the visitor, not a guess.
  const pages = new Set(matches.map((a) => a.target['nxis:pageUrl']));
  return pages.size === 1 ? matches[0] : null;
}

/** The tab's session storage, or null where it is unavailable or blocked. */
function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

interface CacheEntry {
  fetchedAt: number;
  actions: NxisAction[];
}

function readCache(storage: Storage | null, key: string, now: number, ttl: number): NxisAction[] | null {
  if (!storage) return null;
  try {
    const entry = JSON.parse(storage.getItem(key) || 'null') as CacheEntry | null;
    if (!entry || !Array.isArray(entry.actions) || typeof entry.fetchedAt !== 'number') return null;
    if (now - entry.fetchedAt > ttl || entry.fetchedAt > now) return null;
    return entry.actions;
  } catch {
    return null;
  }
}

function writeCache(storage: Storage | null, key: string, entry: CacheEntry): void {
  try {
    storage?.setItem(key, JSON.stringify(entry));
  } catch {
    // Full or blocked storage costs a refetch on the next page, nothing more.
  }
}

/** Options for {@link loadSiteActions}. */
export interface SiteActionsOptions {
  /**
   * The origin actions must belong to. Defaults to the page's own.
   *
   * An action whose page is on any other origin is dropped.
   */
  origin?: string;
  /** Where the list is cached between page loads. Defaults to `sessionStorage`; null disables. */
  storage?: Storage | null;
  /** How long a cached list is reused, in milliseconds. Defaults to ten minutes. */
  ttlMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

/**
 * Every Action on the site that can be carried out from this origin.
 *
 * Reuses a list fetched in the same tab within the last ten minutes, so moving
 * between pages costs one request per session rather than one per page.
 *
 * @param client - A connected client for the site's MCP server. The query is a
 * public read and needs no key.
 * @param info - The server's details; its endpoint keys the cache.
 * @param opts - Origin, cache and clock overrides.
 * @returns The actions, each once, in the order the server returned them.
 * @throws When the query itself fails. The caller decides whether that matters.
 */
export async function loadSiteActions(
  client: Client,
  info: Pick<McpServerInfo, 'endpoint'>,
  opts: SiteActionsOptions = {},
): Promise<NxisAction[]> {
  const origin = opts.origin ?? location.origin;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = (opts.now ?? Date.now)();
  const key = CACHE_PREFIX + info.endpoint;

  const cached = readCache(storage, key, now, opts.ttlMs ?? CACHE_TTL_MS);
  if (cached) return cached;

  const seen = new Set<string>();
  const actions: NxisAction[] = [];
  // Skipped: the origins of pages elsewhere, and '' for an action with no page.
  const skipped: string[] = [];
  for (const record of await queryTypedRecords(client, 'Action')) {
    const action = parseAction(record);
    if (!action || seen.has(action['@id'])) continue;
    seen.add(action['@id']);
    if (!onOrigin(action, origin)) {
      skipped.push(pageOrigin(action));
      continue;
    }
    actions.push(action);
  }
  if (skipped.length) noteSkipped(storage, key, skipped);

  writeCache(storage, key, { fetchedAt: now, actions });
  return actions;
}
