/**
 * The step surfaces a handoff target draws in the chat: what a target may send, and how the page keeps it.
 *
 * A target (a Quote or Booking agent) sends A2UI v1.0 messages in a `surface` part of the handoff extension, beside
 * its text. The page renders them with the steps catalog: the basic catalog's layout and input components, plus the
 * harness's own (`DayStrip`, `WindowGrid`, `HoldCountdown`, `DateTile`, `EstimateCard`, `ConfirmCard`,
 * `ReceiptCard`, and from `ui.surfaces` 2 `ChoiceChips`, `StepHeader` and `FieldNote`; from 3, a field's `required`,
 * `optional` and `error`, and a TextField's `inputType` and `autocomplete`). See
 * docs/quote-booking-surfaces.md.
 *
 * Everything here is data from another server, so it is read strictly: only the four message kinds, only the
 * components listed below, only event actions (no `functionCall`, no `openUrl`), and within size limits. What
 * doesn't fit is dropped, not truncated.
 *
 * Pure: no DOM, no renderer. The element's surfaces chunk and anyone writing a target can use it alike.
 *
 * @module
 */
import type { A2uiMessage } from './emit.js';

/** The steps catalog's id: the basic catalog plus the harness's step components. */
export const STEPS_CATALOG = 'https://nxis.ai/a2ui/catalogs/steps/v1.json';
/** The basic catalog a target may name instead; it is drawn with the steps catalog, a superset. */
const BASIC_V1 = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** The harness's own components. */
export const STEP_COMPONENTS = [
  'DayStrip',
  'WindowGrid',
  'HoldCountdown',
  'DateTile',
  'EstimateCard',
  'ConfirmCard',
  'ReceiptCard',
  // ui.surfaces 2: the guided intake.
  'ChoiceChips',
  'StepHeader',
  'FieldNote',
] as const;

/** Basic-catalog components a remote surface may use. Image, Video, AudioPlayer, Tabs, Modal and Slider are not. */
export const BASIC_ALLOWED = ['Card', 'Column', 'Row', 'List', 'Text', 'Button', 'ChoicePicker', 'TextField', 'CheckBox', 'DateTimeInput', 'Divider', 'Icon'] as const;

const ALLOWED = new Set<string>([...BASIC_ALLOWED, ...STEP_COMPONENTS]);

/** Event names the page handles itself, never sent to the target. */
export const PAGE_EVENTS = { back: 'nxis.back', open: 'nxis.open' } as const;

/** The context key a ConfirmCard's confirm button sets, and only it: the rows the visitor saw. */
export const COMMIT_KEY = 'nxis:commit';

export const LIMITS = { messages: 20, components: 150, bytes: 48 * 1024, surfaces: 8, id: /^[A-Za-z0-9_-]{1,64}$/, choices: 50, steps: 10, words: 200 } as const;

/** What a TextField holds (`inputType`), for the keyboard and autofill: `numeric` is digits typed as text (a ZIP code). */
export const INPUT_TYPES = ['text', 'email', 'tel', 'url', 'numeric'] as const;
/** A TextField's `autocomplete` hint: autofill tokens ("postal-code", "shipping street-address"). */
export const AUTOCOMPLETE = /^[a-z0-9-]{1,40}( [a-z0-9-]{1,40}){0,3}$/;

/** A row a ConfirmCard shows, and echoes back in `consent`. */
export interface ConfirmRow { label: string; value: string }

/** What the page sends the target for a choice or a press: the `action` part's data. */
export interface SurfaceAction {
  handoff: 'action';
  surfaceId: string;
  /** The event's name, as the component's action names it. */
  name: string;
  /** The component it came from. */
  component: string;
  /** The event's context, every `{ path }` resolved against the surface's data model. */
  context: Record<string, unknown>;
  /** Set only for a ConfirmCard's confirm button: the visitor's yes. */
  commit?: true;
  consent?: { rows: ConfirmRow[]; at: string };
}

/** One surface as the conversation keeps it: its creation, with every later update folded in. */
export interface SurfaceEntry {
  id: string;
  create: A2uiMessage;
  /** A ConfirmCard on it was confirmed: it stays done until the target re-creates it or changes its components. */
  done?: boolean;
  /**
   * The conversation's count of replies with surfaces, when one created it (`made`) and last created or updated it
   * (`at`). A surface no reply has touched since the newest one was made is superseded: inert, for good.
   */
  made?: number;
  at?: number;
  /** The visitor's edits not sent yet: the surface's whole data model as they left it, drawn again after a reload. */
  draft?: Obj;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const BAD = Symbol('bad');

/** A JSON value with no prototype keys, or undefined when it holds something an action must never do. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const y = clean(x);
      if (y === BAD) return BAD;
      out.push(y);
    }
    return out;
  }
  if (!isObj(v)) return v;
  if ('functionCall' in v || v.call === 'openUrl') return BAD;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (UNSAFE.has(k)) continue;
    const y = clean(x);
    if (y === BAD) return BAD;
    out[k] = y;
  }
  return out;
}

/** A `{ path }` binding, or a whole-string `"${/path}"`. */
const isBinding = (v: unknown): boolean => (isObj(v) && typeof v.path === 'string') || (typeof v === 'string' && /^\$\{[^}]*\}$/.test(v));
const words = (v: unknown, optional = false): boolean =>
  (optional && v === undefined) || isBinding(v) || (typeof v === 'string' && v.length <= LIMITS.words);
const count = (v: unknown, max: number, optional = false): boolean =>
  (optional && v === undefined) || isBinding(v) || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max);

/** A field's `required` and `optional` (booleans, not both) and its `error` (words, or a binding), from `ui.surfaces` 3. */
const marks = (c: Obj): boolean =>
  [c.required, c.optional].every((b) => b === undefined || typeof b === 'boolean') && !(c.required && c.optional) && words(c.error, true);

/**
 * What a ChoiceChips, StepHeader, FieldNote or TextField may hold, beyond its schema: a literal list of choices is at
 * most {@link LIMITS}.choices `{ value, label, hint? }`, a StepHeader at most {@link LIMITS}.steps steps, a FieldNote's
 * tone one of three, and a field's `error` words like any other. A literal that breaks it drops the component; a bound one is checked when it's drawn.
 */
function fits(c: Obj): boolean {
  switch (c.component) {
    case 'ChoiceChips': {
      const o = c.options;
      const listed =
        isBinding(o) ||
        (Array.isArray(o) &&
          o.length <= LIMITS.choices &&
          o.every((x) => isObj(x) && typeof x.value === 'string' && x.value.length <= LIMITS.words && words(x.label) && words(x.hint, true)));
      return listed && isBinding(c.value) && words(c.label, true) && count(c.max, LIMITS.choices, true) && marks(c);
    }
    case 'StepHeader':
      return words(c.title, true) && words(c.caption, true) && count(c.step, LIMITS.steps) && count(c.of, LIMITS.steps) && !(typeof c.step === 'number' && typeof c.of === 'number' && c.step > c.of);
    case 'TextField':
      return marks(c) && (c.inputType === undefined || (INPUT_TYPES as readonly unknown[]).includes(c.inputType)) && (c.autocomplete === undefined || (typeof c.autocomplete === 'string' && AUTOCOMPLETE.test(c.autocomplete)));
    case 'FieldNote':
      return words(c.text) && (c.tone === undefined || isBinding(c.tone) || ['ok', 'warn', 'info'].includes(c.tone as string));
    default:
      return true;
  }
}

/** A component the steps catalog may draw, or null. One that opens a URL itself, isn't listed, or doesn't fit, is dropped. */
function component(v: unknown): Obj | null {
  if (!isObj(v) || typeof v.id !== 'string' || !LIMITS.id.test(v.id) || typeof v.component !== 'string' || !ALLOWED.has(v.component)) return null;
  const c = clean(v);
  return c === BAD || !fits(c as Obj) ? null : (c as Obj);
}

const components = (v: unknown): Obj[] | null =>
  Array.isArray(v) && v.length <= LIMITS.components ? v.map(component).filter((c): c is Obj => !!c) : null;

const validPath = (p: unknown): p is string => typeof p === 'string' && p.length <= 256 && (p === '' || p === '/' || /^\/[^]*$/.test(p)) && !p.split('/').some((s) => UNSAFE.has(s));

/**
 * The messages of a `surface` part, read strictly: A2UI v1.0, the four message kinds, the steps catalog, the allowed
 * components, event actions only, and the limits in {@link LIMITS}. A message that breaks a rule is dropped; a
 * part over the size limit is dropped whole.
 */
export function readSurfaceMessages(raw: unknown): A2uiMessage[] {
  if (!Array.isArray(raw) || raw.length > LIMITS.messages) return [];
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    return [];
  }
  if (json.length > LIMITS.bytes) return [];
  const out: A2uiMessage[] = [];
  for (const m of JSON.parse(json) as unknown[]) {
    if (!isObj(m)) continue;
    const kinds = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].filter((k) => isObj(m[k]));
    if (kinds.length !== 1) continue;
    const kind = kinds[0];
    const body = m[kind] as Obj;
    const surfaceId = body.surfaceId;
    if (typeof surfaceId !== 'string' || !LIMITS.id.test(surfaceId)) continue;
    if (kind === 'createSurface') {
      if (body.catalogId !== undefined && body.catalogId !== STEPS_CATALOG && body.catalogId !== BASIC_V1) continue;
      const comps = components(body.components ?? []);
      const data = clean(body.dataModel ?? {});
      if (!comps || data === BAD || !isObj(data)) continue;
      out.push({ version: 'v1.0', createSurface: { surfaceId, catalogId: STEPS_CATALOG, components: comps, dataModel: data } });
    } else if (kind === 'updateComponents') {
      const comps = components(body.components);
      if (comps?.length) out.push({ version: 'v1.0', updateComponents: { surfaceId, components: comps } });
    } else if (kind === 'updateDataModel') {
      const value = clean(body.value);
      if (validPath(body.path) && value !== BAD) out.push({ version: 'v1.0', updateDataModel: { surfaceId, path: body.path, value } });
    } else {
      out.push({ version: 'v1.0', deleteSurface: { surfaceId } });
    }
  }
  return out;
}

/** The surface a message is about. */
export const surfaceIdOf = (m: A2uiMessage): string =>
  ((m.createSurface ?? m.updateComponents ?? m.updateDataModel ?? m.deleteSurface) as { surfaceId: string }).surfaceId;

/** Set `value` at a JSON Pointer in `root` (creating objects on the way), or delete it when `value` is undefined. */
export function setPointer(root: Obj, path: string, value: unknown): Obj {
  const keys = path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!keys.length || (keys.length === 1 && keys[0] === '')) return isObj(value) ? value : {};
  let at: any = root;
  for (const k of keys.slice(0, -1)) {
    if (!at[k] || typeof at[k] !== 'object') at[k] = {};
    at = at[k];
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete at[last];
  else at[last] = value;
  return root;
}

/**
 * Fold an update into a surface's kept creation, so the conversation stores one message per surface however many
 * updates it had: components replace those with the same id, and a data update is written at its path.
 */
export function fold(entry: SurfaceEntry, m: A2uiMessage): void {
  const create = entry.create.createSurface as { components: Obj[]; dataModel: Obj };
  if (m.updateComponents) {
    const byId = new Map(create.components.map((c) => [c.id, c]));
    // As the renderer does: a component sent again replaces the one with its id, properties and all.
    for (const c of (m.updateComponents as { components: Obj[] }).components) byId.set(c.id, c);
    create.components = [...byId.values()].slice(0, LIMITS.components);
    entry.done = false;
  } else if (m.updateDataModel) {
    const { path, value } = m.updateDataModel as { path: string; value: unknown };
    create.dataModel = setPointer(create.dataModel, path, value);
    // The target's update goes over the visitor's unsent edits too.
    if (entry.draft) entry.draft = setPointer(entry.draft, path, structuredClone(value));
  }
}
