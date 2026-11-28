/**
 * The steps catalog: the basic catalog's components plus the harness's step components, as Lit elements the A2UI
 * renderer draws inside a surface.
 *
 * | Component | Draws |
 * | --- | --- |
 * | `DayStrip` | a week's days, one button each; a full day is disabled and says so |
 * | `WindowGrid` | a day's arrival windows in two columns, with the receiver's open counts; a full window is disabled, and the visitor's own (`held`) says so |
 * | `HoldCountdown` | the time left on the receiver's hold, from its `expires_at`; nothing once its surface is superseded |
 * | `DateTile` | "NOV" over "25" |
 * | `EstimateCard` | a price range, what it includes, what is priced on site, and its source markers |
 * | `ConfirmCard` | what will be sent or booked, and the visitor's yes: the only place a commit comes from |
 * | `ReceiptCard` | the reference, next steps, Add to calendar, and the target's follow-ups |
 *
 * An EstimateCard, ConfirmCard or ReceiptCard with `inset` draws without its own border, for one inside a Card (under
 * the Card's StepHeader, as the intake's steps are).
 * | `ChoiceChips` | a field's choices as chips (one or several), a segmented control for two or three short ones, and More |
 * | `StepHeader` | "Step 2 of 3 · The job", the job's title, and a segmented progress bar |
 * | `FieldNote` | one line under a field, with an icon for its tone: "Inside the Chicago service area" |
 * | `TextField` | the basic TextField, plus "Optional" or "Required" after its label, its own error line under it, and what it holds (`inputType`: email, tel, url, numeric) and its `autocomplete` hint |
 *
 * Every choice is a real `<button>`, with `aria-pressed` for a choice, at least 44 px each way, focus drawn with a
 * ring. Colors are the element's tokens (`--bg`, `--ink`, `--blue`…), which reach inside a shadow root, so a theme
 * (a dark one included) restyles these as it does the rest. Icons are Heroicons. Every string is set as text.
 *
 * Built from a {@link StepsKit} rather than imported: the renderer, Lit and zod are already in the element's
 * page-load code, and importing them from this lazy chunk would split them into a shared chunk of their own.
 *
 * @module
 */
import { AUTOCOMPLETE, COMMIT_KEY, INPUT_TYPES, LIMITS, STEPS_CATALOG, type ConfirmRow } from './steps.js';

/** What the catalog is built from: the renderer's classes, Lit's template tags, zod, and the basic catalog. */
export interface StepsKit {
  A2uiLitElement: any;
  A2uiController: any;
  Catalog: any;
  basicCatalog: any;
  functions: any[];
  z: any;
  html: any;
  unsafeCSS: any;
  nothing: any;
}

/** Event a component sends up (composed) for the page to handle: a Source marker, or a link to open. */
export const CITE_EVENT = 'nxis-cite';
export const OPEN_EVENT = 'nxis-open';
/** A file to save (a ReceiptCard's `.ics`): downloaded where it is, never opened as a page. */
export const DOWNLOAD_EVENT = 'nxis-download';

// Heroicons v2.2.0, MIT, © Tailwind Labs (https://heroicons.com). See THIRD_PARTY_NOTICES. 24/outline unless noted.
const ICONS = {
  check: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  wrench:
    'M21.75 6.75a4.5 4.5 0 0 1-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 1 1-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 0 1 6.336-4.486l-3.276 3.276a3.004 3.004 0 0 0 2.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852ZM4.867 19.125h.008v.008h-.008v-.008Z',
  clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  calendar:
    'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5',
  left: 'M15.75 19.5 8.25 12l7.5-7.5',
  right: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  down: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  tick: 'm4.5 12.75 6 6 9-13.5',
  warn: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  info: 'm11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z',
  /** check-circle, 24/solid. */
  done: 'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z',
};

const STYLES = `
:host{display:block;font-family:var(--sans,system-ui,sans-serif);color:var(--ink,#0F172A);font-size:14px;line-height:1.5}
*{box-sizing:border-box}
p{margin:0}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--blue,#2563EB);outline-offset:2px}
svg{width:18px;height:18px;flex:none}
.cap{font:500 11px/1.4 var(--mono,ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3,#8A97AC)}
.card{display:flex;flex-direction:column;gap:12px;padding:18px;background:var(--bg,#fff);border:1px solid var(--border,#E4E9F2);border-radius:var(--radius,14px);box-shadow:var(--shadow-sm,none)}
.t{font:600 16px/1.35 var(--display,var(--sans,inherit))}
.sub{color:var(--ink-2,#475569);font-size:13px}
.row{display:flex;gap:12px;align-items:center}
.grow{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.opt,.btn{min-height:44px;min-width:44px;border:1px solid var(--border-strong,#CFD8E8);background:var(--bg,#fff);border-radius:var(--radius-sm,10px);cursor:pointer;padding:8px 12px}
.opt{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.opt[aria-pressed=true]{border-color:var(--blue,#2563EB);background:var(--blue-tint,#EEF3FF);color:var(--blue-strong,#1D4ED8);box-shadow:inset 0 0 0 1px var(--blue,#2563EB)}
.opt:disabled{cursor:not-allowed;color:var(--ink-3,#8A97AC);background:var(--surface,#F5F7FB);border-style:dashed}
.small{font-size:12px;color:var(--ink-2,#475569)}
.opt[aria-pressed=true] .small{color:inherit}
.opt:disabled .small{color:inherit}
.big{font-weight:600;font-size:16px}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nav{display:flex;gap:4px}
.nav .btn{padding:0;display:inline-flex;align-items:center;justify-content:center}
.days{display:grid;grid-template-columns:repeat(auto-fit,minmax(52px,1fr));gap:6px;margin-top:8px}
.wins{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.wins .opt{align-items:flex-start;text-align:left}
.btn{font-weight:600;padding:10px 18px;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn.p{background:var(--blue,#2563EB);border-color:var(--blue,#2563EB);color:var(--on-blue,#fff)}
.btn.p:hover:not(:disabled){background:var(--blue-strong,#1D4ED8)}
.btn:not(.p):hover:not(:disabled){background:var(--surface-2,#EDF1F9)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn{border-style:var(--off-line,solid)}.btn:not(.p){background:var(--off-bg,var(--bg,#fff));color:var(--off-ink,inherit)}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.acts .btn.p{flex:1 1 0;min-width:0}
.hd{font-weight:600;font-size:13px;line-height:1.4}
.card.inset{padding:0;border:0;border-radius:0;box-shadow:none;background:none}
.link{min-height:44px;border:0;background:none;padding:0 4px;color:var(--ink-2,#475569);text-decoration:underline;cursor:pointer;align-self:flex-start}a.link{display:inline-flex;align-items:center;font:inherit}
.hold{display:inline-flex;align-items:center;gap:6px;color:var(--ink-2,#475569);font-size:13px}
.hold.end{color:var(--red,#B91C1C)}
.tile{flex:none;width:56px;height:60px;border:1px solid var(--border,#E4E9F2);border-radius:12px;background:var(--surface,#F5F7FB);display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.1}
.mon{font:600 11px var(--sans,inherit);letter-spacing:.08em;color:var(--blue-strong,#1D4ED8)}
.dn{font:700 22px var(--display,var(--sans,inherit))}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.price{font:700 26px/1.2 var(--display,var(--sans,inherit))}
.price span{font:400 14px var(--sans,inherit);color:var(--ink-2,#475569);margin-left:6px}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
li{display:flex;gap:8px;align-items:flex-start}
li svg{margin-top:1px}
.ok{color:var(--green-strong,#16A34A)}
.ink2{color:var(--ink-2,#475569)}
.mark{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:4px;border:0;border-radius:9px;background:color-mix(in srgb,var(--blue,#2563EB) 16%,var(--bg,#fff));color:var(--blue-strong,#1D4ED8);font:600 11px/1 var(--sans,inherit);vertical-align:1px;cursor:pointer}
.mark::before{content:"";position:absolute;inset:-13px -8px}
dl{margin:0;display:flex;flex-direction:column;gap:8px}
dl div{display:grid;grid-template-columns:minmax(72px,30%) 1fr;gap:10px}
dt{font-size:13px;color:var(--ink-2,#475569)}
dd{margin:0;overflow-wrap:anywhere}
.badge{color:var(--green-strong,#16A34A)}
.badge svg{width:28px;height:28px}
.ref{font:600 14px var(--mono,ui-monospace,monospace);letter-spacing:.04em}
.fld{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;min-width:0}
.lbl{font-weight:600;font-size:13px;color:var(--ink,#0F172A)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{min-height:44px;padding:6px 14px;border:1px solid var(--border-strong,#CFD8E8);border-radius:var(--radius-pill,999px);background:var(--bg,#fff);font-size:13px;line-height:1.3;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-align:left}
.chip:hover{background:var(--surface,#F5F7FB)}
.chip[aria-pressed=true]{border-color:var(--blue,#2563EB);background:var(--blue-tint,#EEF3FF);color:var(--blue-strong,#1D4ED8);font-weight:600;box-shadow:inset 0 0 0 1px var(--blue,#2563EB)}
.chip .small{font-weight:400}
.chip.more{color:var(--ink-2,#475569);border-style:dashed}
.chip.more svg{width:16px;height:16px}
.chip.more[aria-expanded=true] svg{transform:rotate(180deg)}
.seg{display:grid;grid-template-columns:repeat(var(--n,2),minmax(0,1fr));gap:6px;max-width:420px}
.seg .chip{border-radius:var(--radius-sm,10px);justify-content:center;text-align:center}
.sh{display:flex;flex-direction:column;gap:8px}
.sh .top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;font-size:12px;line-height:1.4;color:var(--ink-2,#475569)}
.sh .top span{min-width:0;overflow-wrap:anywhere}
.sh .where{flex:none;white-space:nowrap}
.sh .job{flex:1 1 40%;text-align:right}
.bars{display:grid;grid-template-columns:repeat(var(--n,3),minmax(0,1fr));gap:6px}
.bars i{height:4px;border-radius:2px;background:var(--border,#E4E9F2)}
.bars i.on{background:var(--blue,#2563EB)}
.fn{display:flex;gap:6px;align-items:flex-start;font-size:12px;color:var(--ink-2,#475569)}
.fn svg{width:16px;height:16px;margin-top:1px}
.fn.ok{color:var(--green-strong,#16A34A)}
.fn.warn{color:var(--red,#B91C1C)}
.mk{font-weight:400;color:var(--ink-2,#475569)}
.in{width:100%;min-height:40px;padding:10px 12px;border:1px solid var(--border,#E4E9F2);border-radius:var(--radius-sm,10px);background:var(--bg,#fff);color:var(--ink,#0F172A);font:inherit}
textarea.in{min-height:72px;resize:vertical}
.in:focus{outline:none;border-color:var(--blue,#2563EB)}
.in[aria-invalid=true]{border-color:var(--red,#B91C1C)}
`;

/** Whether the surface a component is drawn in is superseded: the page marks its wrapper `data-stale`. */
const stale = (el: any): boolean => {
  for (let n = el; n; n = n.parentNode ?? n.host) if (n.hasAttribute?.('data-stale')) return true;
  return false;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Seconds left until `iso`, or null when it isn't a time. */
export function secondsLeft(iso: unknown, now = Date.now()): number | null {
  const t = Date.parse(str(iso));
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : null;
}

/** "9:41", "1:02:03". */
export const clock = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** A `YYYY-MM-DD` day, as a UTC date (a day has no time zone), or null. */
function dayOf(v: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "NOV", "25", "Wednesday, November 25" in the visitor's locale. */
export function tileParts(v: unknown): { mon: string; day: string; full: string } | null {
  const d = dayOf(v);
  if (!d) return null;
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, { timeZone: 'UTC', ...o });
  return { mon: f({ month: 'short' }).replace('.', '').toUpperCase(), day: String(d.getUTCDate()), full: f({ weekday: 'long', month: 'long', day: 'numeric' }) };
}

/** "$1,800 – $2,600", whole units when whole. */
export function priceRange(low: unknown, high: unknown, currency: unknown): string {
  const nums = [low, high].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (!nums.length) return '';
  let fmt: (n: number) => string;
  try {
    const whole = nums.every((n) => Number.isInteger(n));
    const nf = new Intl.NumberFormat(undefined, { style: 'currency', currency: str(currency) || 'USD', maximumFractionDigits: whole ? 0 : 2 });
    fmt = (n) => nf.format(n);
  } catch {
    fmt = (n) => n.toLocaleString();
  }
  return nums.length === 2 && nums[0] !== nums[1] ? `${fmt(nums[0])} – ${fmt(nums[1])}` : fmt(nums[0]);
}

let built: any = null;

/**
 * The steps catalog, built once from `kit`: the basic catalog's components, the step components, and the basic
 * functions except `openUrl` (a remote surface never opens a URL by itself).
 */
export function stepsCatalog(kit: StepsKit): any {
  if (built) return built;
  const { A2uiLitElement, A2uiController, Catalog, basicCatalog, z, html, unsafeCSS, nothing } = kit;
  const styles = unsafeCSS(STYLES);
  const icon = (d: string, cls = '') =>
    d === ICONS.done
      ? html`<svg class=${cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d=${d}></path></svg>`
      : html`<svg class=${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d=${d}></path></svg>`;

  // Schemas: a dynamic value is a literal or a { path } (a union with a path object is how the binder knows to
  // resolve and subscribe it); an action is described as one, which is how the binder knows not to resolve it.
  const bind = z.object({ path: z.string() });
  const dyn = (t: any) => z.union([t, bind]).optional();
  const action = z.object({ event: z.object({ name: z.string(), context: z.record(z.any()).optional() }) }).describe('REF:common_types.json#/$defs/Action').optional();
  const button = z.object({ label: dyn(z.string()), action, primary: z.boolean().optional() });
  const common = { weight: z.number().optional(), accessibility: z.any().optional() };

  /** Send a component's action: its context resolved, a label for the visitor's words, and the page's own keys. */
  function fire(el: any, raw: any, label: string, extra: Record<string, unknown> = {}): void {
    if (!raw?.event?.name) return;
    const data = el.context.dataContext;
    const deep = (v: any): any =>
      v && typeof v === 'object'
        ? 'path' in v
          ? data.resolveDynamicValue(v)
          : Array.isArray(v)
            ? v.map(deep)
            : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
        : v;
    const context: Record<string, unknown> = deep(raw.event.context ?? {});
    // The page's keys are the page's: a target can't set them.
    for (const k of Object.keys(context)) if (k.startsWith('nxis:')) delete context[k];
    if (label && typeof context.label !== 'string') context.label = label;
    el.context.dispatchAction({ event: { name: raw.event.name, context: { ...context, ...extra } } });
  }

  /** The raw (unresolved) value of a prop, for an action inside an object or a list. */
  const raw = (el: any, ...keys: (string | number)[]) => keys.reduce((o: any, k) => o?.[k], el.context.componentModel.properties);

  const up = (el: HTMLElement, type: string, detail: unknown) => el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

  /** A `nxis.open` action's phone number (`tel:`, as the page dials one), for a real link: null for anything else. */
  const telOf = (el: any, a: any): string | null => {
    if (a?.event?.name !== 'nxis.open') return null;
    const u = a.event.context?.url;
    const url = u && typeof u === 'object' && 'path' in u ? el.context.dataContext.resolveDynamicValue(u) : u;
    return typeof url === 'string' && /^tel:\+?[\d\s().-]{3,32}$/.test(url) ? url : null;
  };

  const buttons = (el: any, items: any[], key: string, max: number) =>
    items.slice(0, max).map(
      (b, i) => html`<button type="button" class=${b.primary ? 'btn p' : 'btn'} @click=${() => fire(el, raw(el, key, i, 'action'), str(b.label))}>${str(b.label)}</button>`,
    );

  const holdLine = (el: any, expiresAt: unknown, label: unknown, ended: unknown) => {
    const left = secondsLeft(expiresAt);
    if (left === null || stale(el)) return nothing;
    return left > 0
      ? html`<p class="hold" role="timer" aria-live="off">${icon(ICONS.clock)}<span>${str(label) || 'Held for you'} · ${clock(left)} left</span></p>`
      : html`<p class="hold end" role="status">${icon(ICONS.clock)}<span>${str(ended) || 'The hold has ended. Pick the time again.'}</span></p>`;
  };

  const tile = (date: unknown) => {
    const t = tileParts(date);
    return t ? html`<div class="tile"><span class="mon" aria-hidden="true">${t.mon}</span><span class="dn" aria-hidden="true">${t.day}</span><span class="sr">${t.full}</span></div>` : nothing;
  };

  /**
   * Defines one component's element and returns its API. `tick` redraws it every second (a countdown), until its
   * surface is superseded: then it stops, and `tick` isn't called.
   */
  function define(name: string, shape: Record<string, any>, render: (el: any, p: any) => unknown, tick?: (el: any, p: any) => void): any {
    const api = { name, tagName: `nxis-step-${name.toLowerCase()}`, schema: z.object({ ...common, ...shape }) };
    class Step extends A2uiLitElement {
      static styles = styles;
      _timer?: ReturnType<typeof setInterval>;
      createController() {
        return new A2uiController(this, api);
      }
      connectedCallback() {
        super.connectedCallback();
        if (tick) this._timer = setInterval(() => this.requestUpdate(), 1000);
      }
      disconnectedCallback() {
        super.disconnectedCallback();
        clearInterval(this._timer);
      }
      render() {
        const p = this.controller?.props;
        return p ? render(this, p) : nothing;
      }
      updated(changed: any) {
        super.updated?.(changed);
        const p = this.controller?.props;
        if (!tick || !p) return;
        if (stale(this)) this._timer = void clearInterval(this._timer);
        else {
          this._timer ??= setInterval(() => this.requestUpdate(), 1000);
          tick(this, p);
        }
      }
    }
    if (!customElements.get(api.tagName)) customElements.define(api.tagName, Step as unknown as CustomElementConstructor);
    return api;
  }

  /** Write a choice to the bound path, then send the action, so its context reads the new value. */
  const choose = (el: any, p: any, value: string, label: string) => {
    p.setValue?.(value);
    clearError(el);
    fire(el, raw(el, 'action'), label);
  };

  /** A field's name, with "Optional" or "Required" after it as the intake mock draws it. */
  const named = (label: string, p: any, tag: 'label' | 'span') => {
    const mark = p.optional === true ? 'Optional' : p.required === true ? 'Required' : '';
    const body = html`${label}${mark ? html` <span class="mk">${mark}</span>` : nothing}`;
    return tag === 'label' ? html`<label class="lbl" for="in">${body}</label>` : html`<span class="lbl" id="lbl">${body}</span>`;
  };

  /**
   * The visitor changed a field: its error, bound to a path of its own, is cleared on the page until the target
   * checks it again (a wrong ZIP code's error goes as the ZIP code is edited).
   */
  const clearError = (el: any) => {
    const b = raw(el, 'error');
    const path = b && typeof b === 'object' && typeof b.path === 'string' ? b.path : typeof b === 'string' ? /^\$\{(\/[^}]*)\}$/.exec(b)?.[1] : undefined;
    if (path && str(el.context.dataContext.resolveDynamicValue({ path }))) el.context.dataContext.set(path, '');
  };

  /** A field's error, as a target sends it (`error`, bound to its own path), else its failed check's; '' for none. */
  const errorOf = (p: any): string => {
    const e = str(p.error) || (p.isValid === false ? str(p.validationErrors?.[0]) : '');
    // Bound words over the limit draw nothing, rather than some of them.
    return e.length <= LIMITS.words ? e : '';
  };

  /** The error under a field: a warn FieldNote the field names in `aria-describedby`. */
  const errorLine = (e: string) => (e ? html`<p class="fn warn" id="err" role="status">${icon(ICONS.warn)}<span>${e}</span></p>` : nothing);

  const DayStrip = define(
    'DayStrip',
    { label: dyn(z.string()), days: dyn(z.array(z.any())), value: dyn(z.string()), action, previous: action, next: action },
    (el, p) => {
      const label = str(p.label);
      const nav = (key: 'previous' | 'next', d: string, name: string) =>
        raw(el, key) ? html`<button type="button" class="btn" aria-label=${name} @click=${() => fire(el, raw(el, key), name)}>${icon(d)}</button>` : nothing;
      return html`<div role="group" aria-label=${label || 'Days'}>
        <div class="head"><span class="cap">${label}</span><span class="nav">${nav('previous', ICONS.left, 'Earlier days')}${nav('next', ICONS.right, 'Later days')}</span></div>
        <div class="days">
          ${list<any>(p.days).map((d) => {
            const off = !!d?.disabled;
            const words = [str(d?.weekday), str(d?.day), off ? str(d?.note) : ''].filter(Boolean).join(' ');
            return html`<button type="button" class="opt" aria-pressed=${String(str(d?.value) === str(p.value))} aria-label=${words} ?disabled=${off}
              @click=${() => choose(el, p, str(d?.value), `${str(d?.weekday)} ${str(d?.day)}`.trim())}>
              <span class="small">${str(d?.weekday)}</span><span class="big">${off && str(d?.note) ? str(d.note) : str(d?.day)}</span></button>`;
          })}
        </div></div>`;
    },
  );

  const WindowGrid = define(
    'WindowGrid',
    { label: dyn(z.string()), windows: dyn(z.array(z.any())), value: dyn(z.string()), action },
    (el, p) => {
      const label = str(p.label);
      return html`<div role="group" aria-label=${label || 'Arrival windows'}>
        <span class="cap">${label}</span>
        <div class="wins">
          ${list<any>(p.windows).map((w) => {
            const open = typeof w?.open === 'number' ? w.open : null;
            // The visitor's own hold: never full to them, whatever the count says.
            const held = w?.held === true;
            const full = !held && (!!w?.disabled || open === 0);
            const count = held ? 'Held for you' : full ? 'Full' : open !== null ? `${open} open` : '';
            return html`<button type="button" class="opt" aria-pressed=${String(str(w?.value) === str(p.value))} ?disabled=${full}
              aria-label=${[str(w?.label), count].filter(Boolean).join(', ')} @click=${() => choose(el, p, str(w?.value), str(w?.label))}>
              <span class="big">${str(w?.label)}</span>${count ? html`<span class="small">${count}</span>` : nothing}</button>`;
          })}
        </div></div>`;
    },
  );

  /** Send `action` once a countdown reaches zero, once per expiry time. */
  const expire = (el: any, p: any, key: string) => {
    const at = str(p.expiresAt);
    if (secondsLeft(at) === 0 && el._expired !== at) {
      el._expired = at;
      if (raw(el, key)) fire(el, raw(el, key), 'The hold has ended');
    }
  };

  const HoldCountdown = define(
    'HoldCountdown',
    { expiresAt: dyn(z.string()), label: dyn(z.string()), expiredLabel: dyn(z.string()), action },
    (el, p) => holdLine(el, p.expiresAt, p.label, p.expiredLabel),
    (el, p) => expire(el, p, 'action'),
  );

  const DateTile = define('DateTile', { date: dyn(z.string()) }, (_el, p) => tile(p.date));

  const EstimateCard = define(
    'EstimateCard',
    {
      inset: z.boolean().optional(),
      eyebrow: dyn(z.string()),
      title: dyn(z.string()),
      low: dyn(z.number()),
      high: dyn(z.number()),
      currency: dyn(z.string()),
      qualifier: dyn(z.string()),
      note: dyn(z.string()),
      cites: dyn(z.array(z.number())),
      included: dyn(z.array(z.string())),
      onSite: dyn(z.array(z.string())),
      actions: z.array(button).max(2).optional(),
    },
    (el, p) => {
      const price = priceRange(p.low, p.high, p.currency);
      const items = (key: 'included' | 'onSite', d: string, cls: string) => {
        const xs = list<unknown>(p[key]).map(str).filter(Boolean);
        return xs.length ? html`<ul>${xs.map((x) => html`<li>${icon(d, cls)}<span>${x}</span></li>`)}</ul>` : nothing;
      };
      const marks = list<unknown>(p.cites).filter((n): n is number => typeof n === 'number' && n > 0);
      return html`<div class=${p.inset ? 'card inset' : 'card'}>
        ${str(p.eyebrow) ? html`<span class="cap">${str(p.eyebrow)}</span>` : nothing}
        <p class="t">${str(p.title)}</p>
        ${price ? html`<p class="price">${price}${str(p.qualifier) ? html`<span>${str(p.qualifier)}</span>` : nothing}</p>` : nothing}
        ${str(p.note) || marks.length
          ? html`<p class="sub">${str(p.note)}${marks.map((n) => html`<button type="button" class="mark" aria-label=${`Source ${n}`} @click=${() => up(el, CITE_EVENT, n)}>${n}</button>`)}</p>`
          : nothing}
        ${items('included', ICONS.check, 'ok')}${items('onSite', ICONS.wrench, 'ink2')}
        ${list(p.actions).length ? html`<div class="acts">${buttons(el, list(p.actions), 'actions', 2)}</div>` : nothing}
      </div>`;
    },
  );

  const ConfirmCard = define(
    'ConfirmCard',
    {
      inset: z.boolean().optional(),
      heading: dyn(z.string()),
      date: dyn(z.string()),
      title: dyn(z.string()),
      subtitle: dyn(z.string()),
      expiresAt: dyn(z.string()),
      rows: dyn(z.array(z.any())),
      note: dyn(z.string()),
      confirm: z.object({ label: dyn(z.string()), action }),
      cancel: z.object({ label: dyn(z.string()), action }).optional(),
    },
    (el, p) => {
      const rows: ConfirmRow[] = list<any>(p.rows)
        .map((r) => ({ label: str(r?.label), value: str(r?.value) }))
        .filter((r) => r.label || r.value);
      const ended = secondsLeft(p.expiresAt) === 0;
      const head = str(p.title) || str(p.subtitle) || tileParts(p.date);
      const yes = str(p.confirm?.label) || 'Confirm';
      // Pressed once for these props: a target that sends the card again (a new time, say) gets a fresh one.
      const sent = el._sent === raw(el, 'confirm');
      return html`<div class=${p.inset ? 'card inset' : 'card'}>
        ${str(p.heading) ? html`<p class="hd">${str(p.heading)}</p>` : nothing}
        ${head
          ? html`<div class="row">${tile(p.date)}<div class="grow">
              ${str(p.title) ? html`<p class="t">${str(p.title)}</p>` : nothing}
              ${str(p.subtitle) ? html`<p class="sub">${str(p.subtitle)}</p>` : nothing}
              ${holdLine(el, p.expiresAt, '', '')}</div></div>`
          : holdLine(el, p.expiresAt, '', '')}
        ${rows.length ? html`<dl>${rows.map((r) => html`<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl>` : nothing}
        ${str(p.note) ? html`<p class="sub">${str(p.note)}</p>` : nothing}
        <div class="acts">
          ${p.cancel ? html`<button type="button" class="btn" ?disabled=${sent} @click=${() => fire(el, raw(el, 'cancel', 'action'), str(p.cancel.label))}>${str(p.cancel.label)}</button>` : nothing}
          <button type="button" class="btn p" ?disabled=${sent || ended} aria-describedby="sent"
            @click=${() => {
              // Once: a second press before the redraw is the same yes.
              if (el._sent === raw(el, 'confirm')) return;
              el._sent = raw(el, 'confirm');
              el.requestUpdate();
              fire(el, raw(el, 'confirm', 'action'), yes, { [COMMIT_KEY]: rows });
            }}>${yes}</button>
        </div>
        <p class="sub" id="sent" role="status">${sent ? 'Sent. Waiting for the answer…' : ''}</p>
      </div>`;
    },
    () => {},
  );

  const ReceiptCard = define(
    'ReceiptCard',
    {
      inset: z.boolean().optional(),
      title: dyn(z.string()),
      summary: dyn(z.string()),
      reference: z.object({ label: dyn(z.string()), value: dyn(z.string()) }).optional(),
      nextSteps: dyn(z.string()),
      calendar: z.object({ label: dyn(z.string()), url: dyn(z.string()) }).optional(),
      actions: z.array(button).max(3).optional(),
      cancel: z.object({ label: dyn(z.string()), action }).optional(),
    },
    (el, p) => {
      const ref = p.reference && str(p.reference.value);
      const cal = p.calendar && /^https:\/\//.test(str(p.calendar.url)) ? p.calendar : null;
      return html`<div class=${p.inset ? 'card inset' : 'card'}>
        <div class="row"><span class="badge">${icon(ICONS.done)}</span><div class="grow"><p class="t">${str(p.title)}</p>
          ${str(p.summary) ? html`<p class="sub">${str(p.summary)}</p>` : nothing}</div></div>
        ${ref ? html`<p><span class="cap">${str(p.reference.label) || 'Reference'}</span> <span class="ref">${ref}</span></p>` : nothing}
        ${str(p.nextSteps) ? html`<p class="sub">${str(p.nextSteps)}</p>` : nothing}
        <div class="acts">
          ${cal ? html`<button type="button" class="btn" @click=${() => up(el, DOWNLOAD_EVENT, { url: str(cal.url) })}>${icon(ICONS.calendar)}${str(cal.label) || 'Add to calendar'}</button>` : nothing}
          ${buttons(el, list(p.actions), 'actions', 3)}
        </div>
        ${p.cancel
          ? telOf(el, raw(el, 'cancel', 'action'))
            ? html`<a class="link" href=${telOf(el, raw(el, 'cancel', 'action'))}>${str(p.cancel.label)}</a>`
            : html`<button type="button" class="link" @click=${() => fire(el, raw(el, 'cancel', 'action'), str(p.cancel.label))}>${str(p.cancel.label)}</button>`
          : nothing}
      </div>`;
    },
  );

  /** Up to {@link LIMITS}.choices `{ value, label, hint? }` with a value; null when a bound list holds more. */
  const choicesOf = (v: unknown): { value: string; label: string; hint: string }[] | null => {
    const xs = list<any>(v);
    if (xs.length > LIMITS.choices) return null;
    return xs.map((o) => ({ value: str(o?.value), label: str(o?.label) || str(o?.value), hint: str(o?.hint) })).filter((o) => o.value);
  };

  const ChoiceChips = define(
    'ChoiceChips',
    {
      label: dyn(z.string()),
      options: dyn(z.array(z.any())),
      value: dyn(z.union([z.string(), z.array(z.string())])),
      multiple: z.boolean().optional(),
      segmented: z.boolean().optional(),
      max: z.number().optional(),
      moreLabel: dyn(z.string()),
      action,
      required: z.boolean().optional(),
      optional: z.boolean().optional(),
      error: dyn(z.string()),
    },
    (el, p) => {
      const options = choicesOf(p.options);
      if (!options) return nothing;
      const label = str(p.label);
      const many = !!p.multiple;
      const chosen = new Set(Array.isArray(p.value) ? p.value.map(str) : str(p.value) ? [str(p.value)] : []);
      // Two or three short choices with no hints read as one control: Gas | Electric.
      const seg = !many && (p.segmented ?? (options.length >= 2 && options.length <= 3 && options.every((o) => o.label.length <= 14 && !o.hint)));
      const max = typeof p.max === 'number' && p.max >= 1 ? Math.floor(p.max) : seg ? options.length : 6;
      // The chosen ones always show, even past max; the rest wait behind More.
      const shown = el._open || options.length <= max ? options : options.filter((o, i) => i < max || chosen.has(o.value));
      const hidden = options.length - shown.length;
      // Each component has a shadow root of its own, so one id is unique.
      const id = 'lbl';
      const pick = (o: { value: string; label: string }) => {
        if (many) {
          const next = chosen.has(o.value) ? [...chosen].filter((v) => v !== o.value) : [...chosen, o.value];
          p.setValue?.(next);
          clearError(el);
          fire(el, raw(el, 'action'), next.map((v) => options.find((x) => x.value === v)?.label ?? v).join(', '));
        } else choose(el, p, o.value, o.label);
      };
      const more = () => {
        el._open = !el._open;
        el.requestUpdate();
      };
      const error = errorOf(p);
      return html`<div class="fld">
        ${label ? named(label, p, 'span') : nothing}
        <div class=${seg ? 'seg' : 'chips'} style=${seg ? `--n:${shown.length}` : ''} role="group" aria-labelledby=${label ? id : nothing} aria-label=${label ? nothing : 'Choices'}
          aria-describedby=${error ? 'err' : nothing} aria-required=${p.required === true ? 'true' : nothing}>
          ${shown.map(
            (o) => html`<button type="button" class="chip" aria-pressed=${String(chosen.has(o.value))} @click=${() => pick(o)}>
              <span>${o.label}</span>${o.hint ? html` <span class="small">${o.hint}</span>` : nothing}</button>`,
          )}
          ${options.length > max && !seg
            ? html`<button type="button" class="chip more" aria-expanded=${String(!!el._open)} @click=${more}>
                <span>${el._open ? 'Fewer' : `${str(p.moreLabel) || 'More'} (${hidden})`}</span>${icon(ICONS.down)}</button>`
            : nothing}
        </div>${errorLine(error)}</div>`;
    },
  );

  const StepHeader = define(
    'StepHeader',
    { title: dyn(z.string()), step: dyn(z.number()), of: dyn(z.number()), caption: dyn(z.string()) },
    (_el, p) => {
      const of = typeof p.of === 'number' ? Math.floor(p.of) : 0;
      if (of < 1 || of > LIMITS.steps) return nothing;
      const step = Math.min(of, Math.max(1, typeof p.step === 'number' ? Math.floor(p.step) : 1));
      const where = [`Step ${step} of ${of}`, str(p.caption)].filter(Boolean).join(' · ');
      const title = str(p.title);
      return html`<div class="sh">
        <div class="top"><span class="where">${where}</span>${title ? html`<span class="job">${title}</span>` : nothing}</div>
        <div class="bars" style=${`--n:${of}`} role="progressbar" aria-valuemin="1" aria-valuemax=${of} aria-valuenow=${step}
          aria-valuetext=${[where, title].filter(Boolean).join(': ')} aria-label="Progress">
          ${Array.from({ length: of }, (_, i) => html`<i class=${i < step ? 'on' : ''}></i>`)}
        </div></div>`;
    },
  );

  const FieldNote = define('FieldNote', { text: dyn(z.string()), tone: dyn(z.string()) }, (_el, p) => {
    const text = str(p.text);
    if (!text) return nothing;
    const tone = ['ok', 'warn'].includes(str(p.tone)) ? str(p.tone) : 'info';
    return html`<p class=${`fn ${tone}`} role="status">${icon(tone === 'ok' ? ICONS.tick : tone === 'warn' ? ICONS.warn : ICONS.info)}<span>${text}</span></p>`;
  });

  // The basic TextField's props (label, value, variant, validationRegexp, checks), plus whether it may be left empty
  // and the target's error for it, drawn under it.
  const TextField = define(
    'TextField',
    {
      ...basicCatalog.components.get('TextField').schema.shape,
      required: z.boolean().optional(),
      optional: z.boolean().optional(),
      error: dyn(z.string()),
      inputType: z.enum(INPUT_TYPES).optional(),
      autocomplete: z.string().regex(AUTOCOMPLETE).optional(),
    },
    (el, p) => {
      const label = str(p.label);
      const error = errorOf(p);
      const set = (e: Event) => {
        p.setValue?.((e.target as HTMLInputElement).value);
        clearError(el);
      };
      // What is on screen, into the card's data: a value that came without an input event (autofill that fires only
      // change, a value set by a script) is still what a press sends.
      el.flush = () => {
        const v = el.renderRoot?.querySelector('#in')?.value;
        if (typeof v === 'string' && v !== str(el.controller?.props?.value)) el.controller.props.setValue?.(v);
      };
      // What the field holds, for the keyboard and autofill: an email address, a phone number, digits (a ZIP code).
      const kind = INPUT_TYPES.includes(p.inputType) ? (p.inputType as (typeof INPUT_TYPES)[number]) : 'text';
      const type = p.variant === 'number' ? 'number' : p.variant === 'obscured' ? 'password' : kind === 'numeric' ? 'text' : kind;
      const mode = kind === 'numeric' ? 'numeric' : kind === 'email' ? 'email' : kind === 'tel' ? 'tel' : kind === 'url' ? 'url' : undefined;
      const auto = typeof p.autocomplete === 'string' && AUTOCOMPLETE.test(p.autocomplete) ? p.autocomplete : undefined;
      const field =
        p.variant === 'longText'
          ? html`<textarea id="in" class="in" rows="3" .value=${str(p.value)} @input=${set} @change=${set} aria-label=${label ? nothing : 'Text'}
              aria-required=${p.required === true ? 'true' : nothing} aria-invalid=${error ? 'true' : nothing} aria-describedby=${error ? 'err' : nothing}></textarea>`
          : html`<input id="in" class="in" type=${type} inputmode=${mode ?? nothing} autocomplete=${auto ?? nothing} .value=${str(p.value)} @input=${set} @change=${set} aria-label=${label ? nothing : 'Text'}
              aria-required=${p.required === true ? 'true' : nothing} aria-invalid=${error ? 'true' : nothing} aria-describedby=${error ? 'err' : nothing} />`;
      return html`<div class="fld">${label ? named(label, p, 'label') : nothing}${field}${errorLine(error)}</div>`;
    },
  );

  // A basic Button the target gives a weight (Continue beside Back) fills the room its weight gives it: the renderer
  // sets the weight as the host's flex, but its button stays as wide as its words. One its checks turn off ("Pick a
  // window to continue") looks off, as a step component's does: the basic one has no disabled style at all. Its
  // styles are read once, from the class, into the surface's own root, so the rules are added there.
  const Basic = customElements.get('a2ui-basic-button') as any;
  if (Basic && !Basic.nxisFill) {
    const own = [Basic.styles].flat().filter(Boolean);
    const off = '.a2ui-button:disabled,.a2ui-button:disabled:hover{cursor:not-allowed;background:var(--surface,#F5F7FB);border:1px dashed var(--border-strong,#CFD8E8);--_a2ui-text-color:var(--ink-3,#8A97AC)}';
    Object.defineProperty(Basic, 'styles', { configurable: true, value: [...own, unsafeCSS(`:host([style*="flex"]) .a2ui-button{width:100%}${off}`)] });
    Basic._processedStyle = undefined;
    Basic.nxisFill = true;
  }

  const allowed = new Set(['Card', 'Column', 'Row', 'List', 'Text', 'Button', 'ChoicePicker', 'CheckBox', 'DateTimeInput', 'Divider', 'Icon']);
  const basic = [...basicCatalog.components.values()].filter((c: any) => allowed.has(c.name));
  built = new Catalog(
    STEPS_CATALOG,
    [...basic, TextField, DayStrip, WindowGrid, HoldCountdown, DateTile, EstimateCard, ConfirmCard, ReceiptCard, ChoiceChips, StepHeader, FieldNote],
    kit.functions.filter((f: any) => f.name !== 'openUrl'),
  );
  return built;
}
