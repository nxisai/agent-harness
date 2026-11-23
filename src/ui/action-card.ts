/**
 * The action card: how the agent asks for, confirms and sends a form or a
 * handoff, as one message in the conversation.
 *
 * A write goes through several prompts in the harness (ask for what is
 * missing, confirm, run, report), and each used to draw its own card. Here
 * one card carries the whole request: who it is for, what the agent already
 * has, what is still needed, a sentence saying what will happen, then the
 * steps as they run and the outcome. It is the assistant's message, so it
 * reads as the assistant speaking rather than a form dropped into the chat.
 *
 * The card is a {@link ActionItem}: plain data, saved with the conversation
 * and redrawn from it. What a live card can do (continue, send, decline) is
 * passed in as {@link ActionHandlers}; a card drawn without them, after a
 * reload, shows how things stood and offers nothing to press.
 *
 * @module
 */
import type { Slot } from '../harness/slots.js';
import type { JsonSchema } from '../types.js';

/** Where a request stands. */
export type ActionStage =
  /** Some details are still needed, or the visitor asked to change them. */
  | 'collect'
  /** Everything is known; waiting for the visitor to send. */
  | 'review'
  /** Sent; the steps are running. */
  | 'working'
  /** Sent, and the form or the target took it. */
  | 'done'
  /** Left for the page that submits it. That page finishes the request. */
  | 'left'
  /** It did not go through. */
  | 'failed'
  /** The visitor said not now, or the prompt was replaced. */
  | 'declined';

/** How a field is edited. */
export type ActionFieldKind = 'text' | 'long' | 'email' | 'tel' | 'date' | 'number' | 'choice' | 'select' | 'check';

/** One field of the request. */
export interface ActionField {
  name: string;
  label: string;
  /** The value as typed, always a string; see {@link actionValues} for the typed form. */
  value: string;
  kind: ActionFieldKind;
  options?: { value: string; label: string }[];
  required: boolean;
  /**
   * `known`: the agent had it (from the chat, a saved profile, the page).
   * `needed`: still to be given. `hidden`: sent but not shown, such as the
   * business the card is already about.
   */
  group: 'known' | 'needed' | 'hidden';
}

/** Who the request goes to. */
export interface ActionIdentity {
  name: string;
  /** One line under the name: "Plumber · Royal Oak · ★ 4.9 (287)", "Quote form". */
  sub?: string;
  /** Availability, when it is known: "Replies in ~5 min", "Away until 8am". */
  status?: string;
  tone?: 'ok' | 'away';
}

/** One step of a running request, as the card lists it. */
export interface ActionStep {
  label: string;
  status: 'active' | 'done' | 'failed';
}

/** A request as the conversation keeps it. */
export interface ActionItem {
  kind: 'action';
  /** The journey this request is, so its steps find their card. */
  id: string;
  /** The tool it calls. */
  tool: string;
  /** A form, or a handoff to an agent or a person. */
  variant: 'form' | 'handoff-agent' | 'handoff-person';
  /** What it is, in words: "quote form". */
  noun: string;
  identity: ActionIdentity;
  fields: ActionField[];
  stage: ActionStage;
  /** What will happen, in one sentence, shown when reviewing. */
  sentence: string;
  /** A line under the sentence: where it is sent from, when that is another page. */
  note?: string;
  /** What the primary button says when sending. */
  sendLabel: string;
  /** The steps once sent. */
  steps?: ActionStep[];
  /** The outcome in words: a confirmation, or why it failed. */
  message?: string;
  /** The disclosure is open. */
  open?: boolean;
}

/** What a live card can do. Absent on a card redrawn from history. */
export interface ActionHandlers {
  /** Collecting is done: the values, typed. */
  continue(values: Record<string, unknown>): void;
  /** Review asked to change something. */
  change(): void;
  /** Send, with the values as they now stand. */
  send(values: Record<string, unknown>): void;
  /** Not now. */
  decline(): void;
}

// ── Fields ──────────────────────────────────────────────────────────────────

/** `full_name` → `Full name`. */
export function fieldLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LONG = /description|details|message|summary|notes?|comments?|problem|issue|project|question/i;

function kindOf(name: string, schema: JsonSchema, value: string): Pick<ActionField, 'kind' | 'options'> {
  // "Select…" and "Choose a service…" are how a form asks, not answers.
  const values = (schema.enum ?? schema.items?.enum)?.filter((v) => !/^\s*(select|choose|pick)\b/i.test(String(v)) && !/(…|\.\.\.)\s*$/.test(String(v)));
  if (values?.length) {
    const options = values.map((v) => ({ value: String(v), label: fieldLabel(String(v)) }));
    return { kind: options.length <= 4 ? 'choice' : 'select', options };
  }
  if (schema.type === 'boolean') return { kind: 'check' };
  if (schema.type === 'integer' || schema.type === 'number') return { kind: 'number' };
  if (schema.format === 'email' || /e-?mail/i.test(name)) return { kind: 'email' };
  if (/phone|tel\b|mobile/i.test(name)) return { kind: 'tel' };
  if (schema.format === 'date' || /(^|_)date($|_)/i.test(name)) return { kind: 'date' };
  if (LONG.test(name) || value.length > 60) return { kind: 'long' };
  return { kind: 'text' };
}

/**
 * The card's fields, from the harness's resolved slots.
 *
 * @param slots - Every slot of the tool.
 * @param values - The values known so far.
 * @param opts.needed - Slots still to be given.
 * @param opts.hidden - Slots sent but not shown.
 * @param opts.labels - Labels to use instead of the field's name.
 */
export function fieldsFromSlots(
  slots: Slot[],
  values: Record<string, unknown>,
  opts: { needed?: Set<string>; hidden?: Set<string>; labels?: Record<string, string> } = {},
): ActionField[] {
  return slots.map((slot) => {
    const raw = values[slot.name];
    const value = raw === undefined || raw === null ? '' : typeof raw === 'boolean' ? (raw ? 'true' : '') : String(raw);
    const group: ActionField['group'] = opts.hidden?.has(slot.name)
      ? 'hidden'
      : opts.needed?.has(slot.name) || value === ''
        ? 'needed'
        : 'known';
    return {
      name: slot.name,
      label: opts.labels?.[slot.name] ?? fieldLabel(slot.name),
      value,
      required: slot.required,
      group,
      ...kindOf(slot.name, slot.schema ?? {}, value),
    };
  });
}

/** The values to send, typed as the schema wants them. Empty optional fields are left out. */
export function actionValues(item: Pick<ActionItem, 'fields'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of item.fields) {
    if (f.kind === 'check') {
      out[f.name] = f.value === 'true';
      continue;
    }
    if (f.value.trim() === '') continue;
    out[f.name] = f.kind === 'number' && !Number.isNaN(Number(f.value)) ? Number(f.value) : f.value;
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fields that stop the request from going: required and empty, or not an email address. */
export function missingFields(item: Pick<ActionItem, 'fields'>): ActionField[] {
  return item.fields.filter(
    (f) => f.group !== 'hidden' && ((f.required && f.kind !== 'check' && f.value.trim() === '') || (f.kind === 'email' && f.value.trim() !== '' && !EMAIL.test(f.value.trim()))),
  );
}

/** Up to two letters for a name: "Hatzel & Sons Plumbing" → "HS". */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

// ── Drawing ─────────────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
const LEAVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';

function icon(svg: string, cls: string): HTMLElement {
  const span = h('span', { class: cls });
  span.innerHTML = svg;
  return span;
}

let uid = 0;

/**
 * Draw a card.
 *
 * @param item - The request. Edits to its fields are written back to it.
 * @param handlers - What a live card can do; null for a card from history.
 * @param onChange - Called after an edit, so the conversation can be saved.
 */
export function actionCard(item: ActionItem, handlers: ActionHandlers | null, onChange: () => void): HTMLElement {
  const id = `ac${++uid}`;
  const live = !!handlers;
  // A card from history that never got past asking was left behind: say so, and offer nothing.
  const stage: ActionStage = !live && (item.stage === 'collect' || item.stage === 'review') ? 'declined' : item.stage;
  const card = h('div', { class: `msg assistant action-card is-${stage}`, 'data-action': item.id });

  card.append(identityRow(item, stage));

  const visible = item.fields.filter((f) => f.group !== 'hidden');
  const known = visible.filter((f) => f.group === 'known');
  const needed = visible.filter((f) => f.group === 'needed');
  const person = item.variant === 'handoff-person';
  const handoff = item.variant !== 'form';
  const disclosureLabel = handoff ? 'What they’ll see' : stage === 'done' ? 'What was sent' : 'What they’ll get';

  const disclosure = (editable: boolean): HTMLElement | null => {
    const shown = editable ? known : visible.filter((f) => f.value.trim() !== '');
    if (!shown.length) return null;
    const panel = h('div', { class: 'ac-panel', id: `${id}-panel` });
    if (editable) shown.forEach((f) => panel.append(control(f, id, onChange, () => refresh())));
    else {
      const dl = h('dl', { class: 'ac-list' });
      shown.forEach((f) => dl.append(h('dt', {}, f.label), h('dd', {}, f.kind === 'check' ? (f.value === 'true' ? 'Yes' : 'No') : f.value)));
      panel.append(dl);
    }
    panel.hidden = !item.open;
    const toggle = h('button', { type: 'button', class: 'ac-toggle', 'aria-expanded': String(!!item.open), 'aria-controls': `${id}-panel` }, `${disclosureLabel} ›`);
    toggle.addEventListener('click', () => {
      item.open = !item.open;
      panel.hidden = !item.open;
      toggle.setAttribute('aria-expanded', String(!!item.open));
      onChange();
    });
    return h('div', { class: 'ac-disclosure' }, toggle, panel);
  };

  // Enables the primary button as fields are filled, without redrawing what is being typed in.
  let refresh = (): void => {};

  if (stage === 'collect') {
    if (item.sentence && handoff) card.append(h('p', { class: 'ac-sentence' }, item.sentence));
    if (handoff) card.append(disclosure(true) as Node);
    else if (known.length) {
      const group = h('div', { class: 'ac-group' }, h('div', { class: 'ac-eyebrow' }, 'What I have · tap to change'));
      known.forEach((f) => group.append(control(f, id, onChange, () => refresh())));
      card.append(group);
    }
    if (needed.length) {
      const group = h('div', { class: 'ac-group' }, h('div', { class: 'ac-eyebrow' }, person ? 'So they can reply' : 'Still needed'));
      needed.forEach((f) => group.append(control(f, id, onChange, () => refresh())));
      card.append(group);
    }
    const primary = h('button', { type: 'button', class: 'ac-btn primary' });
    refresh = () => {
      const gaps = missingFields(item);
      primary.disabled = gaps.length > 0;
      primary.textContent = gaps.length ? `Add ${list(gaps.map(askFor))}` : handoff ? item.sendLabel : 'Review';
    };
    refresh();
    primary.addEventListener('click', () => {
      if (missingFields(item).length) return;
      handlers?.continue(actionValues(item));
    });
    card.append(actions(primary, notNow(handlers)));
  } else if (stage === 'review') {
    card.append(h('p', { class: 'ac-sentence' }, item.sentence));
    const d = disclosure(false);
    if (d) {
      const change = h('button', { type: 'button', class: 'ac-link' }, 'Change');
      change.addEventListener('click', () => handlers?.change());
      d.querySelector('.ac-toggle')!.after(change);
      card.append(d);
    }
    if (item.note) card.append(h('p', { class: 'ac-note' }, icon(LEAVE, 'ac-note-icon'), item.note));
    const primary = h('button', { type: 'button', class: 'ac-btn primary' }, item.sendLabel);
    primary.addEventListener('click', () => {
      primary.disabled = true;
      handlers?.send(actionValues(item));
    });
    card.append(actions(primary, notNow(handlers)));
  } else if (stage === 'working') {
    const steps = item.steps?.length ? item.steps : [{ label: 'Sending', status: 'active' as const }];
    const ol = h('ol', { class: 'ac-steps', 'aria-live': 'polite' });
    steps.forEach((s) => ol.append(h('li', { class: `is-${s.status}` }, marker(s.status), h('span', {}, s.label))));
    card.append(ol);
  } else if (stage === 'done') {
    card.append(h('div', { class: 'ac-outcome ok' }, icon(CHECK, 'ac-tick'), h('strong', {}, handoff ? `Handed to ${item.identity.name.replace(/^The\s/, 'the ')}` : 'Sent')));
    // The form's own words when it had any; otherwise who replies, and where.
    const email = item.fields.find((f) => f.kind === 'email' && f.value.trim())?.value.trim();
    const reply = item.message ?? (!handoff && email ? `${item.identity.name} will reply to ${email}.` : undefined);
    if (reply) card.append(h('p', { class: 'ac-sentence' }, reply));
    if (!handoff) card.append(disclosure(false) as Node);
  } else if (stage === 'left') {
    card.append(h('p', { class: 'ac-note' }, icon(LEAVE, 'ac-note-icon'), item.message ?? `Opened ${item.identity.name}’s page to send it from there.`));
  } else if (stage === 'failed') {
    card.append(h('div', { class: 'ac-outcome bad' }, h('span', { class: 'ac-bang', 'aria-hidden': 'true' }, '!'), h('strong', {}, 'It didn’t go through')));
    if (item.message) card.append(h('p', { class: 'ac-sentence' }, item.message));
    if (live) {
      const again = h('button', { type: 'button', class: 'ac-btn primary' }, 'Change and try again');
      again.addEventListener('click', () => handlers!.change());
      card.append(actions(again, notNow(handlers)));
    }
  } else {
    card.append(h('p', { class: 'ac-muted' }, 'Not sent.'));
  }
  return card;
}

function identityRow(item: ActionItem, stage: ActionStage): HTMLElement {
  const who = item.identity;
  const text = h('div', { class: 'ac-who' }, h('strong', {}, who.name));
  if (who.sub) text.append(h('span', {}, who.sub));
  // Availability matters while deciding; afterwards the outcome says what happened.
  if (who.status && (stage === 'collect' || stage === 'review')) {
    text.append(h('span', { class: `ac-status ${who.tone ?? ''}` }, h('i', { 'aria-hidden': 'true' }), who.status));
  }
  return h('div', { class: 'ac-id' }, h('div', { class: `ac-avatar ${item.variant === 'form' ? 'square' : ''}`, 'aria-hidden': 'true' }, initials(who.name)), text);
}

function marker(status: ActionStep['status']): HTMLElement {
  if (status === 'done') return icon(CHECK, 'ac-mark done');
  if (status === 'failed') return h('span', { class: 'ac-mark failed', 'aria-hidden': 'true' }, '!');
  return h('span', { class: 'ac-mark active', 'aria-hidden': 'true' });
}

function actions(primary: HTMLElement, secondary: HTMLElement | null): HTMLElement {
  return h('div', { class: 'ac-actions' }, primary, secondary);
}

function notNow(handlers: ActionHandlers | null): HTMLElement | null {
  if (!handlers) return null;
  const b = h('button', { type: 'button', class: 'ac-btn' }, 'Not now');
  b.addEventListener('click', () => handlers.decline());
  return b;
}

/** A missing field as the button asks for it: "your email", not "where should they reply?". */
function askFor(f: ActionField): string {
  if (f.kind === 'email') return 'your email';
  if (f.kind === 'tel') return 'your phone number';
  if (/^(full_?)?name$/i.test(f.name)) return 'your name';
  return f.label.replace(/\?$/, '').toLowerCase();
}

function list(words: string[]): string {
  // "your name and email", not "your name and your email".
  words = words.map((w, i) => (i > 0 && words[0].startsWith('your ') ? w.replace(/^your /, '') : w));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function control(f: ActionField, id: string, onChange: () => void, onInput: () => void): HTMLElement {
  const fid = `${id}-${f.name}`;
  const set = (v: string) => {
    f.value = v;
    onInput();
    onChange();
  };
  const label = h('span', { class: 'ac-label' }, f.label, !f.required && f.group === 'needed' ? h('em', {}, ' (optional)') : null);

  if (f.kind === 'choice' && f.options) {
    const group = h('div', { class: 'ac-choices', role: 'group', 'aria-labelledby': `${fid}-l` });
    const buttons = f.options.map((o) => {
      const b = h('button', { type: 'button', class: 'ac-choice', 'aria-pressed': String(o.value === f.value) }, o.label);
      b.addEventListener('click', () => {
        set(o.value);
        buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(f.options![i].value === f.value)));
      });
      return b;
    });
    buttons.forEach((b) => group.append(b));
    label.id = `${fid}-l`;
    return h('div', { class: 'ac-field' }, label, group);
  }
  if (f.kind === 'check') {
    const box = h('input', { type: 'checkbox', id: fid }) as HTMLInputElement;
    box.checked = f.value === 'true';
    box.addEventListener('change', () => set(box.checked ? 'true' : ''));
    return h('label', { class: 'ac-field check', for: fid }, box, label);
  }
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (f.kind === 'select' && f.options) {
    const select = h('select', { id: fid }) as HTMLSelectElement;
    select.append(h('option', { value: '' }, 'Choose…'));
    f.options.forEach((o) => select.append(h('option', { value: o.value }, o.label)));
    select.value = f.value;
    input = select;
  } else if (f.kind === 'long') {
    input = h('textarea', { id: fid, rows: '2' }) as HTMLTextAreaElement;
    input.value = f.value;
  } else {
    const type = f.kind === 'email' ? 'email' : f.kind === 'tel' ? 'tel' : f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text';
    const auto = f.kind === 'email' ? 'email' : f.kind === 'tel' ? 'tel' : /(^|_)name$/i.test(f.name) ? 'name' : undefined;
    input = h('input', { id: fid, type, autocomplete: auto }) as HTMLInputElement;
    input.value = f.value;
  }
  if (f.required) input.setAttribute('aria-required', 'true');
  input.addEventListener('input', () => set(input.value));
  input.addEventListener('change', () => set(input.value));
  return h('label', { class: 'ac-field', for: fid }, label, input);
}

/** The card's styles, on the widget's own tokens. */
export const ACTION_CARD_CSS = `
      .action-card { align-self: flex-start; width: min(100%, 420px); box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px 16px 16px 4px; font-size: 14px; line-height: 1.5; color: var(--ink); white-space: normal; }
      .action-card p { margin: 0; }
      .ac-id { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; }
      .ac-avatar { width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%; background: var(--blue-strong); color: #fff; font-size: 12px; font-weight: 700; display: grid; place-items: center; letter-spacing: .02em; }
      .ac-avatar.square { border-radius: 10px; background: var(--ink); }
      .ac-who { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .ac-who strong { font-size: 14px; font-weight: 600; }
      .ac-who span { font-size: 12.5px; color: var(--ink-2); }
      .ac-status { display: inline-flex; align-items: center; gap: 6px; }
      .ac-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--green-strong); flex-shrink: 0; }
      .ac-status.away i { background: #D97706; }
      .ac-sentence { color: var(--ink); }
      .ac-note { display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; color: var(--ink-2); }
      .ac-note-icon { flex-shrink: 0; margin-top: 2px; display: inline-flex; }
      .ac-muted { color: var(--ink-3); font-size: 13px; }
      .action-card.is-declined .ac-id { opacity: .7; }
      .ac-eyebrow { font-family: var(--mono); font-size: 10.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
      .ac-group { display: flex; flex-direction: column; gap: 10px; }
      .ac-field { display: flex; flex-direction: column; gap: 4px; }
      .ac-field.check { flex-direction: row; align-items: center; gap: 8px; }
      .ac-label { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
      .ac-label em { font-style: normal; font-weight: 400; color: var(--ink-3); }
      .ac-field input:not([type=checkbox]), .ac-field textarea, .ac-field select { box-sizing: border-box; width: 100%; min-height: 40px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 8px 12px; font: inherit; font-size: 14px; color: var(--ink); background: var(--bg); }
      .ac-field textarea { resize: vertical; line-height: 1.45; }
      .ac-field input:focus, .ac-field textarea:focus, .ac-field select:focus { outline: 2px solid var(--blue); outline-offset: -1px; border-color: transparent; }
      .ac-choices { display: flex; flex-wrap: wrap; gap: 6px; }
      .ac-choice { min-height: 36px; padding: 0 12px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink-2); font: 600 13px var(--sans); cursor: pointer; }
      .ac-choice[aria-pressed=true] { border: 1.5px solid var(--blue); background: var(--blue-tint); color: var(--blue-strong); }
      .ac-disclosure { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
      .ac-toggle, .ac-link { border: 0; background: none; padding: 0; font: 600 13px var(--sans); color: var(--blue-strong); cursor: pointer; }
      .ac-link { color: var(--ink-2); text-decoration: underline; text-underline-offset: 2px; }
      .ac-panel { flex-basis: 100%; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px; }
      .ac-list { display: grid; grid-template-columns: minmax(80px, max-content) minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13px; }
      .ac-list dt { color: var(--ink-3); }
      .ac-list dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      .ac-actions { display: flex; gap: 8px; }
      .ac-btn { min-height: 42px; padding: 0 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink); font: 600 14px var(--sans); cursor: pointer; }
      .ac-btn.primary { flex-grow: 1; border: 0; background: var(--blue); color: #fff; }
      .ac-btn.primary:hover:not(:disabled) { background: var(--blue-strong); }
      .ac-btn.primary:disabled { background: var(--surface-2); color: var(--ink-3); cursor: not-allowed; }
      .ac-btn:focus-visible, .ac-toggle:focus-visible, .ac-link:focus-visible, .ac-choice:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .ac-steps { list-style: none; margin: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; }
      .ac-steps li { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
      .ac-steps li.is-active { font-weight: 600; }
      .ac-mark { width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center; box-sizing: border-box; }
      .ac-mark.done { background: var(--green-strong); color: #fff; }
      .ac-mark.failed { background: var(--red); color: #fff; font-size: 11px; font-weight: 700; }
      .ac-mark.active { border: 2px solid var(--blue); border-right-color: transparent; animation: ac-spin .9s linear infinite; width: 14px; height: 14px; margin: 0 2px; }
      @keyframes ac-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .ac-mark.active { animation: none; } }
      .ac-outcome { display: flex; align-items: center; gap: 10px; font-size: 14.5px; }
      .ac-tick { width: 22px; height: 22px; border-radius: 50%; background: var(--green-strong); color: #fff; display: grid; place-items: center; flex-shrink: 0; }
      .ac-bang { width: 22px; height: 22px; border-radius: 50%; background: var(--red); color: #fff; display: grid; place-items: center; font-weight: 700; flex-shrink: 0; }
      .action-card.is-done { border-color: #BFE5CD; }
      .action-card.is-failed { border-color: #F3C4C4; }
`;
