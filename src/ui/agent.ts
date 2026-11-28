/**
 * The `<nxis-agent>` custom element: a chat interface over an
 * {@link AgentHarness}, opened as a window in the corner (the default), across
 * the full screen, or inline in a box the host lays out — see `mode`. With
 * `contained`, the window and its launcher are drawn inside the host's box
 * instead, as a preview of what a visitor sees.
 *
 * `<nxis-agent-fullscreen>` is the same element under its old name, kept as a
 * deprecated alias: see {@link NxisAgentFullscreen}.
 *
 * The layout is a conversation drawer beside a thread. Messages, generated tool
 * forms and submitted detail cards all render inline in that thread, so a form
 * appears where it was asked for rather than in a separate dialog.
 *
 * The model proposes a tool; a form generated from the tool's JSON Schema and
 * prefilled from stored preferences appears inline; submitting it is the
 * confirmation step for a write, after which the form becomes a read-only card.
 *
 * Configurable through properties and attributes: see the property accessors
 * below, and `README.md` for worked examples.
 *
 * @example
 * ```html
 * <nxis-agent preload="idle"></nxis-agent>
 * ```
 *
 * @module
 */
import { mountSurface, stepsKit, type MountedSurface } from '../a2ui/host.js';
import { emitCardsSurface, emitFigureSurface, emitMediaSurface, emitSeriesSurface, pressMessages, showAllMessages, type CanPlay, type ResultCardData } from '../a2ui/cards.js';
import { actionCta, cardCtas, playButtonFor, playCtas, playLatestCtas, seriesParts, targetUrl, type CardAction, type CardCtas, type PlayAction } from '../harness/cta.js';
import { mediaRow, seriesCard, type MediaRow, type SeriesCard } from '../harness/media.js';
import { openTarget, openWay } from '../harness/tools/open-target.js';
import { rememberReportToken, reportPageOpen } from '../harness/tools/report.js';
// Types only: event cards load by a dynamic import() with the first result that is an event (see _loadEvents).
import type { EventHost } from './event-cards.js';
import { figureOf, fromOffset, imageOf, mayPlay, playableOf, type FigureModel, type MediaModel } from '../harness/playable.js';
import { emitToolForm } from '../a2ui/form.js';
import { A2UI_THEME_CSS } from '../a2ui/theme.js';
// Compiled from agent.tw.css at build time (scripts/css-to-ts.mjs). It is a
// string rather than a stylesheet import because the UI renders into a shadow
// root (a <link> in the host page's head never crosses that boundary) and
// because a published package cannot assume the consumer runs Tailwind.
import { TAILWIND_CSS } from './tailwind.generated.js';
import { emitAsk, emitStep, emitConfirm } from '../a2ui/stepper.js';
import { AgentHarness, isAbort, isTypeListing, loadGuard } from '../harness/harness.js';
import { isTechnicalRecord, typeTag } from '../harness/type-labels.js';
import { emergencyFirst, isEmergency } from '../harness/emergency.js';
import type { Guardrails, GuardrailsConfig } from '../guardrails/index.js';
import { executeRegistered, WebMcpTools } from '../harness/tools/webmcp.js';
import {
  extractResult,
  proseAnswer,
  missingRequired,
  toolSchema,
} from '../harness/tools/schema.js';
import type { ModelProvider } from '../providers/types.js';
import { connectTools } from '../harness/tools/source.js';
import {
  chooserIsFixed,
  chooserOf,
  formNoun,
  formOptions,
  formsFor,
  handoffFor,
  isSiteTool,
  siteFormFor,
  withoutSiteSuffix,
  HANDOFF_RESULT,
} from '../harness/tools/action-tools.js';
import { resolveSlots, type Slot } from '../harness/slots.js';
import { isHandoffTool, TALK_TO_A_PERSON_TOOL, TRANSFER_TO_AGENT_TOOL } from '../handoff/tools.js';
import {
  actionCard,
  fieldLabel,
  fieldsFromSlots,
  ACTION_CARD_CSS,
  type ActionHandlers,
  type ActionItem,
  type ActionStep,
} from './action-card.js';
import { citeCards, resultsAnswer, RESULTS_ANSWER_CSS, syncPlayButtons, type AnswerCard, type AnswerHandlers } from './result-pick.js';
import { allowedLink, anchor, citeViews, linkNodes, REMOTE_ANSWER_CSS, withoutNote, type LinkPolicy } from './remote-answer.js';
import type { LocalSource } from './sources.js';
import { extensionPart, readCard, type HandoffAnswer } from '../handoff/envelope.js';
import type { SurfaceAction, SurfaceEntry } from '../a2ui/steps.js';
// Types only: a target's step surfaces are a lazy chunk, loaded with the first reply that has one (see _steps).
import type { Surfaces } from './surfaces.js';
// Types only: the player itself is loaded by a dynamic import() on the first Play tap (see _loadMedia), never statically.
import type { MediaController } from '../media/index.js';
import { extractRecords, hoursText, openStatus, recordFacts } from '../harness/records.js';
import { hoursStatus, isEmergencyRecord, readOpeningHours, type OpeningHours } from '../harness/opening-hours.js';
import { access, accessAction, archetype, compact, entityLabel, groupOf, mediaKind, nameOf, onceEach, reviewFacts, reviewStars, subtitle as byline, telHref, type Archetype, type MediaKind } from '../harness/entity.js';
import type { ResultPick } from '../harness/recommend.js';
import { resumePendingAction } from '../harness/tools/resume.js';
import { findHandoffForm, handoffUrl, startFormMessage, startMessage, takeInboundHandoff, type InboundHandoff } from '../harness/tools/inbound.js';
import { savePendingVisit, setConversationSource, takePendingVisit } from '../harness/tools/pending-action.js';
import { pageForEntity, type SitePage } from '../harness/tools/site-pages.js';
import { samePage } from '../harness/tools/site-actions.js';
import { OPEN_PAGE_TOOL } from '../harness/tools/open-page.js';
import { currentJourney, onJourneyChange, recordStep, restoreJourney, type AgentStep } from '../harness/steps.js';
import { viewJourney } from './journey.js';
import { AgentCoordinator } from '../harness/router/coordinator.js';
import {
  HandoffController,
  handoffActivity,
  isHandoffOver,
  type HandoffConfig,
  type HandoffEvent,
  type HandoffSession,
  type HandoffTarget,
} from '../handoff/controller.js';
import { registerHandoffTools, HANDOFF_SESSION_RESULT } from '../handoff/tools.js';
import { formTakenBy } from '../handoff/takes.js';
import { CLEAR_DETAILS_EVENT, contactFromProfile, detailOf, detailsFromContact, detailsFromFields, mergeDetails } from './details.js';
import type { RouteRule } from '../harness/router/rules.js';
import type { AskRequest, ConfirmRequest, HarnessRenderer, StreamingBubble as HStreamingBubble } from '../harness/renderer.js';
import {
  LocalGemmaProvider,
  parseToolCall,
  stripMarkers,
  humanize,
  escapeHtml,
  NXIS_LOGO_SVG,
  NXIS_SITE_URL,
  ICON_CHECK,
  ICON_WARN,
  ICON_ARROW,
  ICON_PLUS,
  ICON_MENU,
  ICON_TRASH,
  ICON_STOP,
  ICON_COPY,
  ICON_PENCIL,
  ICON_REDO,
  ICON_CHECK_MARK,
  type ChatMessage,
  type ProgressDetail,
  type PreloadMode,
} from '../engine.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUGGESTIONS,
  DEFAULT_EMPTY_STATE,
  DEFAULT_AGENT_NAME,
  DEFAULT_LOGO,
  THEME_TOKENS,
  PROFILE_ALIASES,
  type AgentTheme,
} from './config.js';
import type { JsonSchema, ModelContextToolInfo, ModelContextToolResponse } from '../types.js';

// Prefixed keys so state never collides with other Nxis examples on the same origin.
const PROFILE_KEY = 'nxis-listings-agent-profile';
const CONV_KEY = 'nxis-listings-agent-conversations';

/** The panel's open state, kept for this tab so a reload opens it again. */
const OPEN_KEY = 'nxis-agent-open';
const keepOpen = (open: boolean): void => {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, '1');
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* storage off: it opens closed */
  }
};
const wasOpen = (): boolean => {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
/** The viewer's last choice of window or full screen, used when the host sets no `mode`. */
const MODE_KEY = 'nxis-agent:mode';

// ── Metrics (Typed Agent vs Traditional RAG) ─────────────────────────────────
// RAG retrieval assumptions, ported from the original demo's MetricsPanel.
const AVG_HTML_CHUNK_TOKENS = 650; // avg tokens per chunked HTML segment (nav/footer/CSS included)
const CHUNKS_PER_RESULT = 3; // header + services + reviews chunks to match one JSON-LD record
const TOOL_DEF_OVERHEAD = 600; // ~tokens for the MCP tool schemas in the prompt

interface MetricsRound {
  round: number;
  promptTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolResultTokens: number;
  results: number;
}

function estimateRagTokens(rounds: MetricsRound[]): {
  ragInput: number;
  ragOutput: number;
  numResults: number;
  ragChunks: number;
} {
  const toolCalls = rounds.reduce((s, m) => s + m.toolCalls, 0);
  // Floor: each retrieval call fetches at least 3 results in a typical RAG setup.
  const numResults = Math.max(
    rounds.reduce((s, m) => s + m.results, 0),
    toolCalls * 3,
  );
  // Round 1 input = system prompt + tool definitions + user message. RAG keeps
  // the same prompt + user but swaps tool definitions for retrieved chunks.
  const round1Input = rounds.length ? rounds[0].promptTokens : 3000;
  const ragBaseContext = Math.max(round1Input - TOOL_DEF_OVERHEAD, 0);
  const ragChunks = numResults * CHUNKS_PER_RESULT;
  return {
    ragInput: ragBaseContext + ragChunks * AVG_HTML_CHUNK_TOKENS,
    ragOutput: rounds.reduce((s, m) => s + m.outputTokens, 0),
    numResults,
    ragChunks,
  };
}

const fmt = (n: number) => n.toLocaleString();

/**
 * The contents of a pending bubble: three dots, a phase label and a byte count.
 *
 * The dots are separate spans rather than an animated glyph, so the motion can
 * be disabled under `prefers-reduced-motion` while the bubble still reads as
 * pending. The label and byte spans are filled per phase and hidden while empty.
 */
/**
 * How long the running-step line stays once the conversation moves on past
 * its card. A glance's worth: long enough to notice and open it.
 */
const JSTATUS_TIMEOUT_MS = 10_000;

const THINKING_MARKUP =
  '<span class="think-row">' +
  '<span class="think-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
  '<span class="think-label"></span>' +
  '<span class="think-bytes"></span>' +
  '</span>';

/** Format a byte count for display, as `"412 MB"` or `"1.6 GB"`. */
function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** A type listing as an older version kept it ("8 kinds"): never drawn. */
const isListingItem = (it: { note?: string }): boolean => /^\d+ kinds?$/.test(it.note ?? '');

const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * Names for the retrieval tools the package itself bridges in.
 *
 * `nxis_query` is a fine name for a model and a poor one for a visitor, and a
 * native registry may strip any title we attach, so the few tools this package
 * registers are named here.
 */
const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  nxis_query: 'Search records',
  nxis_get: 'Get a record',
  nxis_list_types: 'List record types',
};

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
/** A plug: the tools the agent can reach. */
const ICON_TOOLS = svg('<path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0V7ZM10 15v3"/>');
const ICON_LOCK = svg('<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>');
const ICON_FORM = svg('<rect x="4" y="3.5" width="12" height="13" rx="2"/><path d="M7 8h6M7 11h6M7 14h3"/>');
const ICON_SEARCH = svg('<circle cx="9" cy="9" r="4.8"/><path d="m13 13 3.5 3.5"/>');
/** Expand to full screen, and shrink back to a window: the header's mode toggle. */
const ICON_EXPAND = svg('<path d="M12 4h4v4M8 16H4v-4M16 4l-5 5M4 16l5-5"/>');
const ICON_SHRINK = svg('<path d="M15 9h-4V5M5 11h4v4M11 9l5-5M9 11l-5 5"/>');
// Heroicons v2.2.0, MIT, © Tailwind Labs (https://heroicons.com). See THIRD_PARTY_NOTICES.
/** document-text, 24/outline: a handoff bar's mark. */
const ICON_HANDED =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>';
const ICON_GLOBE = svg('<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2 2 11 0 13M10 3.5c-2 2-2 11 0 13"/>');

/**
 * Split a message into prose and code.
 *
 * Two things read as code: a fenced block, and a message that is nothing but
 * JSON — which is what a tool result looks like when something hands one back
 * raw. Wrapped as prose it becomes a wall of text that breaks at the wrong
 * places, taking any URL inside it with it.
 *
 * @param text - The message.
 * @returns The parts in order, each marked as code or not.
 */
function splitCode(text: string): { text: string; code: boolean }[] {
  const fenced = text.split(/```[a-zA-Z]*\n?/);
  // An opening and a closing fence produce at least three parts; the odd ones
  // are what sat between them.
  if (fenced.length > 2) {
    return fenced.map((part, i) => ({ text: i % 2 ? part.replace(/\n$/, '') : part, code: i % 2 === 1 }));
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [{ text: JSON.stringify(JSON.parse(trimmed), null, 2), code: true }];
    } catch {
      // Starts like JSON without being it — ordinary prose.
    }
  }
  return [{ text, code: false }];
}

/** Machine output rather than something someone wrote: JSON, most often raw. */
function looksMachine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Anything markdown would draw differently: emphasis, code, a link, a heading, a list, a line break. */
const MD_HINT = /[*_`[#\n]|https?:/;

/** Longer than this, a block is folded away rather than filling the thread. */
const FOLD_LINES = 10;

/**
 * Write a message into its bubble, keeping code as code.
 *
 * A long block is folded behind a summary: output worth keeping, but not
 * worth scrolling past every time. Everything is written as text rather than
 * markup — a message may carry a tool's output, which is not ours to trust
 * as HTML.
 */
function fillMessage(el: HTMLElement, text: string, link?: (text: string) => Node[], md?: (el: HTMLElement, text: string) => void): void {
  for (const part of splitCode(text)) {
    if (part.code) {
      const pre = document.createElement('pre');
      pre.className = 'codeblock';
      const code = document.createElement('code');
      code.textContent = part.text;
      pre.appendChild(code);

      const lines = part.text.split('\n').length;
      if (lines > FOLD_LINES) {
        const fold = document.createElement('details');
        fold.className = 'codefold';
        const summary = document.createElement('summary');
        summary.textContent = `${lines} lines`;
        fold.append(summary, pre);
        el.appendChild(fold);
      } else {
        el.appendChild(pre);
      }
    } else if (part.text) {
      if (md) md(el, part.text);
      else if (link) el.append(...link(part.text));
      else el.appendChild(document.createTextNode(part.text));
    }
  }
}

/**
 * Stored values the agent reuses across turns, exposed as `element.preferences`.
 *
 * The host page supplies what it already knows about the visitor, and the agent
 * uses it to fill forms and to answer in context.
 */
export interface AgentPreferences {
  /** All values, or one by key. */
  get(): Record<string, string>;
  get(key: string): string | undefined;
  /** Set one key, or merge an object. An empty value clears the key. */
  set(key: string, value: string): void;
  set(values: Record<string, string>): void;
  /** Forget one key, or everything. */
  clear(key?: string): void;
  /** Keys the agent can map onto form fields. */
  keys(): string[];
  /** Survive reloads. Off by default — see the `preferences` getter. */
  persist: boolean;
}

interface DetailRow {
  label: string;
  value: string;
  /** Optional link target (e.g. tel: for phone numbers). */
  href?: string;
}

interface ResultCard {
  title: string;
  /** schema.org @type — rendered as a blue tag. */
  type: string;
  /** Aggregate rating summary — rendered as a green (positive-outcome) tag. */
  rating?: string;
  /** Open 24/7 (00:00–23:59 opening hours) — rendered as a green tag. */
  emergency?: boolean;
  /** One supporting line under the headline (feature-card pattern). */
  sub?: string;
  rows: DetailRow[];
  id?: string;
  /** The page on this site the record came from, when it can be told. */
  page?: { url: string; label: string };
  /** The rating and how many reviews it rests on. */
  stars?: number;
  reviews?: number;
  /** Open or closed when the search ran: "Open now · 24/7", "Opens 7am". */
  status?: { open: boolean; label: string };
  phone?: string;
  /** What the record states, short, for comparing it. */
  facts?: string[];
  /** The action the record itself offers (its potentialAction), as a button. */
  action?: CardAction;
  /** How the card draws, from the renderer spec: a business, a review, an article. */
  archetype?: Archetype;
  /** The heading it is listed under: "Businesses", "Reviews". */
  group?: string;
  /** The line under the name: "Plumber · Royal Oak", "The Ledger · Dana Ruiz · 2026-10-02". */
  byline?: string;
  /** What access costs, when the record says: "Free preview", "$49". */
  badge?: string;
  /** A paywalled article opens on its free preview. */
  preview?: boolean;
  /** What a review reviews, by name. */
  about?: string;
  /** A review's author and words. */
  author?: string;
  quote?: string;
  /** A media item, as its row draws it. */
  media?: MediaRow;
  /** What kind of media the record is or holds, for its tile: a microphone, a play mark, a picture. */
  kind?: MediaKind;
  /** The record's own picture for its tile, https only. */
  image?: string;
  /** A picture record (an ImageObject) as its figure card. */
  figure?: FigureModel;
  /** A series with its parts, as its card draws it. */
  series?: SeriesCard;
  /** Listen and Subscribe (and "Their page"), which open places on the site rather than ask. */
  ctas?: CardCtas;
  /** An event's record, compacted: its card is drawn from it when it is shown, so "past" is said as of then. */
  event?: Record<string, unknown>;
}

type ThreadItem =
  /** `sources`: the records read in the turn an assistant's reply answered from, for its markers and Sources list. */
  | { kind: 'msg'; role: string; text: string; sources?: LocalSource[] }
  | { kind: 'tool'; name: string; text: string; isError: boolean }
  | { kind: 'trace'; name: string; args: Record<string, unknown>; text: string; isError: boolean; count?: number }
  | { kind: 'route'; agent: string; via: string }
  | { kind: 'detail'; title: string; note: string; rows: DetailRow[] }
  | { kind: 'results'; title: string; note: string; cards: ResultCard[]; pick?: ResultPick; calendar?: string }
  | { kind: 'metrics'; rounds: MetricsRound[] }
  | { kind: 'form' }
  /** A turn the person called off. Kept so the thread explains its own gap. */
  | { kind: 'stopped' }
  /**
   * What the agent did about a request: its steps, kept with the conversation
   * so a second request does not erase the first, and so a card survives the
   * page change a cross-page action makes.
   */
  | { kind: 'journey'; id: string; steps: AgentStep[] }
  /** Something a handoff target said: an agent, or a person at a desk. */
  | {
      kind: 'remote';
      from: string;
      fromKind: 'agent' | 'person';
      text: string;
      answer?: HandoffAnswer;
      /** The task an answer with an id came on: feedback goes to it, and only while it's open. */
      task?: string;
      /** The visitor's 👍 or 👎 on the answer, once given. */
      feedback?: 'up' | 'down';
      /** The target's step surfaces drawn under it, each as last updated. See ./surfaces.ts. */
      surface?: SurfaceEntry[];
      /** Its surfaces end in a receipt: the bar no longer says the target waits on the visitor. */
      receipt?: boolean;
    }
  /** Where a handoff stands, as a quiet line in the thread. */
  | { kind: 'handoff'; text: string; tone: 'info' | 'done' | 'error' }
  /** A form or a handoff, asked for, confirmed and sent in one card. See ./action-card.ts. */
  | ActionItem;

/**
 * A handoff's state as a line in the thread, or '' for a state the bar alone
 * shows.
 */
/** The token the site signed into a card's action, by the action's `@id`: the A2UI surface carries no token, so a
 * tap's report finds it on the cards it was drawn from. */
function tokenFor(cards: ResultCard[], actionId: string): string | undefined {
  if (!actionId) return undefined;
  for (const ctas of ctasOf(cards)) {
    for (const b of [ctas?.lead, ctas?.secondary]) {
      const o = b?.kind === 'play' ? b.fallback : b;
      if (o?.kind === 'open' && o.actionId === actionId && o.reportToken) return o.reportToken;
    }
  }
  return undefined;
}

/** Every set of buttons the cards draw: their own, a series', an episode row's, a series' parts'. */
const ctasOf = (cards: ResultCard[]): (CardCtas | undefined)[] =>
  cards.flatMap((c) => [c.ctas, c.series?.ctas, c.media?.ctas, ...(c.series?.parts.map((p) => p.ctas) ?? [])]);

function handoffLine(session: HandoffSession): string {
  const who = session.label;
  switch (session.state) {
    case 'connecting':
      return `Connecting you to ${who}…`;
    case 'queued':
      // The bar says where they are in line; a desk usually says it in words too.
      return '';
    case 'active':
      return session.operator && session.operator !== who ? `${session.operator} has joined` : `You're talking with ${who}`;
    case 'awaiting-visitor':
      return '';
    case 'handed-back':
      return 'Back with the assistant';
    case 'ended':
      return `${who} has finished. Back with the assistant.`;
    case 'failed':
      return `${session.error ?? `${who} couldn't continue.`} Back with the assistant.`;
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  items: ThreadItem[];
  /** Real Gemma tokenizer counts per generation round (drives the metrics panel). */
  metrics?: MetricsRound[];
  /**
   * The visitor's details for this conversation, by profile key (./details.ts): what they typed or confirmed here,
   * over the host's preferences. Kept with the conversation and gone with it.
   */
  details?: Record<string, string>;
}

interface AgentEls {
  launcher: HTMLElement;
  overlay: HTMLElement;
  close: HTMLElement;
  /** Switches between window and full screen. */
  modeBtn: HTMLButtonElement;
  menu: HTMLElement;
  /** Dismisses the conversation drawer where it overlaps the panel. */
  scrim: HTMLElement;
  newchat: HTMLElement;
  history: HTMLElement;
  thread: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  /** Names the running step while its card is scrolled out of view. */
  jstatus: HTMLButtonElement;
  /** Shown while the conversation is handed off: who to, and the way back. */
  handoffBar: HTMLElement;
  handoffLabel: HTMLElement;
  handoffBack: HTMLButtonElement;
  input: HTMLTextAreaElement;
  go: HTMLButtonElement;
  /** Opens the list of tools the agent can use. */
  toolsBtn: HTMLButtonElement;
  toolsPop: HTMLElement;
  toolsCount: HTMLElement;
  /** Which model is answering, beside the input. */
  model: HTMLElement;
}

/**
 * One specialist agent, as declared by the host page.
 *
 * The prompt and the tool filter are what specialise it. The description is
 * read only when the model is asked to route a turn.
 */
export interface AgentDefinition {
  systemPrompt?: string;
  tools?(tool: ModelContextToolInfo): boolean;
  description?: string;
  /**
   * What this agent says when its tools are not on the page.
   *
   * Worth writing: the useful sentence names what cannot be done and where it
   * can be, and it is the difference between an agent that admits a limit and
   * one that answers a booking request by searching the site.
   */
  unavailable?: string;
}

type StreamingBubble = HStreamingBubble;

/**
 * What a form that is for something does, in a sentence: a "pass form" for an event gets passes for it, and any
 * other form is sent for it.
 */
function forSentence(noun: string, what: string): string {
  const stem = /^(\w+) form$/.exec(noun)?.[1];
  if (!stem) return `I'll send this ${noun} for ${what}.`;
  const plural = /(?:s|x|z|ch|sh)$/.test(stem) ? `${stem}es` : /[^aeiou]y$/.test(stem) ? `${stem.slice(0, -1)}ies` : `${stem}s`;
  return `Get ${plural} for ${what}.`;
}

/** Progress is pushed at the bubble from outside the turn loop — see `_liveBubble`. */
type SetProgress = (pct: number, detail?: ProgressDetail) => void;

export class NxisAgent extends HTMLElement {
  private _turnActive: boolean;
  /** True while the turn in flight can still be called off. */
  private _stoppable = false;
  /**
   * Settles when the turn in flight is finished, however it finished.
   *
   * Edit and send-again stop the current turn before replacing the question it
   * was answering, and a stop resolves a tick later. Without something to wait
   * on, the re-run would race `_onSend`'s own guard and be dropped.
   */
  private _turnDone: Promise<void> | null = null;
  private _tool: ModelContextToolInfo | null;
  private _formEl: HTMLElement | null;
  /** Render thread components through A2UI. Off with a2ui="false". */
  private _useA2ui!: boolean;
  /** Live A2UI surfaces, disposed when the thread is re-rendered. */
  private _surfaces!: MountedSurface[];
  /** Stops listening to the journal. */
  private _offJourney: (() => void) | null = null;
  /** Whether the tools menu is showing. */
  private _toolsOpen = false;
  /** Closes the tools menu on a press outside it. An arrow, so it can be removed. */
  private _onOutsidePress = (e: PointerEvent): void => {
    if (!this._toolsOpen) return;
    const path = e.composedPath();
    if (path.includes(this._els.toolsPop) || path.includes(this._els.toolsBtn)) return;
    this._toggleTools(false);
  };
  /** Watches whether the running journey's card is on screen. */
  private _journeyObserver: IntersectionObserver | null = null;
  /** The journey the status line is about, while one is running. */
  private _jstatusJourney: string | null = null;
  /** Journeys whose status line was opened once or timed out: it does not come back. */
  private _jstatusDismissed = new Set<string>();
  /** Dismisses the status line a while after the thread moves on past the card. */
  private _jstatusTimer: ReturnType<typeof setTimeout> | null = null;
  /** The turn loop. This element is only its renderer. */
  private _harness!: AgentHarness;
  /** Built only when the host defines agents — otherwise there is one harness. */
  private _coordinator: AgentCoordinator | null = null;
  private _agentDefs: Record<string, AgentDefinition> | null = null;
  private _routes: RouteRule[] = [];
  private _fallbackAgent = '';
  /** The live ask/confirm surface, if one is open. */
  private _prompt: MountedSurface | null = null;
  /**
   * The action card still waiting on the visitor or a result, and what it can
   * do: the harness's ask or confirm request, or, after a page change, a call
   * of the widget's own.
   */
  private _live: {
    item: ActionItem;
    tool: ModelContextToolInfo;
    ask?: AskRequest;
    confirm?: ConfirmRequest;
    run?: (values: Record<string, unknown>) => Promise<void>;
    sent: boolean;
    declining: boolean;
  } | null = null;
  /** Handoff targets as the relay last reported them, for a card's availability line. */
  private _handoffTargets = new Map<string, HandoffTarget>();
  private _profile: Record<string, string>;
  private _persistPrefs = false;
  private _systemPrompt: string = DEFAULT_SYSTEM_PROMPT;
  private _suggestions: string[] = DEFAULT_SUGGESTIONS;
  private _emptyState: string = DEFAULT_EMPTY_STATE;
  private _name: string = DEFAULT_AGENT_NAME;
  private _logo: string = DEFAULT_LOGO;
  private _theme: AgentTheme = {};
  /** The pending bubble currently on screen, if any — the target for progress. */
  private _liveBubble: (StreamingBubble & { setProgress: SetProgress }) | null = null;
  /** The engine's current phase name, shown in the empty state while loading. */
  private _stage = '';
  /** The one discovery run, kicked off on first open and awaited before a turn. */
  private _connect: Promise<void> | null = null;
  /** The site's pages, for linking results to where they came from. */
  private _sitePages: SitePage[] = [];
  /** The site's MCP server's remote tools, and where it builds calendar files, once connected. */
  private _remoteTools = new Set<string>();
  private _calendar?: string;
  private _loadPct = 0;
  private _loadDetail: ProgressDetail | undefined;
  /**
   * Which mode the empty state is currently drawn in, or null when a
   * conversation has replaced it.
   *
   * The load almost never starts while the empty state is being built, since
   * opening the panel is what starts it, so the view has to notice that it moved
   * underneath it and redraw. Without this the chips stay up through a load
   * that was supposed to withhold them, and never come back when it ends.
   */
  private _emptyLoading: boolean | null = null;
  private _prefsApi!: AgentPreferences;
  private _conversations: Conversation[];
  private _activeId: string | null;
  private _els!: AgentEls;
  private provider!: ModelProvider;
  private toolSource!: WebMcpTools;
  /** A provider the host supplied, used instead of the local model. */
  private _provider: ModelProvider | null = null;
  /** Runs handoffs to agents and people, when the host configured any. */
  private _handoff: HandoffController | null = null;
  private _offHandoff: (() => void) | null = null;
  /** In-chat playback (`media="play"`): the docked player once loaded, the element the first tap started, the
   * loading module, what is playing, and "Listen to the latest" episodes fetched as their cards were drawn. */
  private _media: MediaController | null = null;
  private _mediaEl: HTMLVideoElement | null = null;
  private _mediaLoad: Promise<typeof import('../media/index.js')> | null = null;
  private _mediaNow: { id: string | null; playing: boolean } = { id: null, playing: false };
  private _latest = new Map<string, MediaModel>();
  /** The guardrails, once loaded (see {@link _guard}), and the host's configuration for them. */
  private _g: Guardrails | null = null;
  private _gc?: GuardrailsConfig;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    // A2UI Text asks its Lit context for a markdown renderer: this element is its provider. (The context is the
    // symbol the renderer made, matched by its description so a second copy of the harness answers its own.)
    root.addEventListener('context-request', (e: any) => {
      if (typeof e.context !== 'symbol' || e.context.description !== 'A2UIMarkdown') return;
      e.stopPropagation();
      e.callback((text: string) => this._mdHtml(text), () => {});
    });
    // A link drawn in A2UI Text opens only past the guardrails' navigation check.
    root.addEventListener('click', (e) => {
      const a = e.composedPath().find((n) => (n as HTMLElement).dataset?.md !== undefined) as HTMLAnchorElement | undefined;
      if (a && !e.defaultPrevented && !this._g?.nav(a.href)) e.preventDefault();
    });
    this._turnActive = false;
    this._tool = null; // tool of the live inline form (if any)
    this._formEl = null; // the live inline form element (transient, not persisted)
    this._profile = {}; // device-local profile
    this._conversations = []; // [{ id, title, messages, items }]
    this._activeId = null;
    this._surfaces = [];
    // Opt out with a2ui="false" to compare against the inline renderers, which
    // are kept rather than deleted, since the basic catalog cannot express the tag
    // colours, links and logo chip they use.
    this._useA2ui = this.getAttribute('a2ui') !== 'false';
  }

  connectedCallback(): void {
    this.shadowRoot!.innerHTML = this._template();
    this._applyIdentity();
    this._applyTheme();
    const root = this.shadowRoot!;
    this._els = {
      launcher: root.querySelector('.launcher')!,
      overlay: root.querySelector('.overlay')!,
      close: root.querySelector('.close')!,
      modeBtn: root.querySelector('.modebtn')!,
      menu: root.querySelector('.menu')!,
      scrim: root.querySelector('.scrim')! as HTMLElement,
      newchat: root.querySelector('.newchat')!,
      history: root.querySelector('.history')!,
      thread: root.querySelector('.thread')!,
      status: root.querySelector('.statusline')!,
      bar: root.querySelector('.prog > i')!,
      jstatus: root.querySelector('.jstatus')!,
      handoffBar: root.querySelector('.handoff-bar')!,
      handoffLabel: root.querySelector('.handoff-bar .hb-label')!,
      handoffBack: root.querySelector('.handoff-bar .hb-back')!,
      input: root.querySelector('.composer textarea')!,
      go: root.querySelector('.composer .go')!,
      toolsBtn: root.querySelector('.tools-btn')!,
      toolsPop: root.querySelector('.tools-pop')!,
      toolsCount: root.querySelector('.tools-count')!,
      model: root.querySelector('.composer .model')!,
    };

    // Below 520px a window covers the page, so the toggle would switch between two identical things.
    this._narrow = window.matchMedia?.('(max-width: 520px)') ?? null;
    this._narrow?.addEventListener?.('change', this._paintModeBtn);
    this._els.modeBtn.addEventListener('click', () => this._toggleMode());
    this._applyMode();

    // A host-supplied provider wins; otherwise the local model, configured from
    // the attributes that only mean anything to it.
    this.provider =
      this._provider ??
      new LocalGemmaProvider({
        modelHost: this.getAttribute('model-host') || undefined,
        modelPathTemplate: this.getAttribute('model-path-template') || undefined,
        // cache="false" skips Cache Storage: the escape hatch for a browser
        // whose cache backend fails on entries this size.
        useBrowserCache: this.getAttribute('cache') !== 'false',
        systemPrompt: this._systemPrompt,
        onStatus: (t, e) => this._setStatus(t, e),
        onProgress: (pct, detail) => {
          this._loadPct = pct;
          this._loadDetail = detail;
          this._setBar(pct);
          this._liveBubble?.setProgress(pct, detail);
          this._paintLoad();
        },
      });
    this.toolSource = new WebMcpTools();
    this._paintProvenance();

    this._buildAgents();

    // The element renders; the harness decides. Everything from choosing a
    // tool to running it happens behind harness.turn().
    this._harness = this._singleHarness();

    // Preferences are supplied by the host page through `element.preferences`.
    // Anything a previous build persisted is picked up so upgrading does not
    // silently drop a user's saved details; `persist` then stays true so they
    // are not silently dropped on the next write either.
    this._prefsApi = this._buildPreferencesApi();
    this._profile = this._loadProfile();
    this._persistPrefs = Object.keys(this._profile).length > 0;

    // Conversation history.
    this._loadConversations();
    this._renderHistory();
    this._renderThread();

    // Journey cards follow the journal rather than the renderer, because the
    // steps that finish a cross-page action are recorded by the resume below,
    // before any turn — and so before any renderer call — exists on this page.
    this._offJourney?.();
    this._offJourney = onJourneyChange((_step, all) => this._onJourney(all));
    this._els.toolsBtn.addEventListener('click', () => this._toggleTools());
    this._els.toolsPop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this._toggleTools(false);
      this._els.toolsBtn.focus();
    });
    // Outside the menu closes it. On the document, with the composed path,
    // so a press anywhere on the host page counts as outside too.
    document.removeEventListener('pointerdown', this._onOutsidePress);
    document.addEventListener('pointerdown', this._onOutsidePress);

    this._els.jstatus.addEventListener('click', () => {
      const cards = this._els.thread.querySelectorAll<HTMLElement>('.journey.is-running');
      cards[cards.length - 1]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // One look is what it is for; after that it would only be in the way.
      this._dismissJourneyStatus();
    });

    // Whoever builds the tools, a call that leaves this page reports back to
    // the thread it was made in.
    setConversationSource(() => this._activeId ?? undefined);

    // A form confirmed on another page submits here, now that the page it
    // belongs to is the one open. A contained preview isn't the page the
    // visitor left, so it takes none of what they left pending.
    if (!this.contained) {
      void this._resumePendingAction();
      const visited = this._resumePendingVisit();
      // Sent here from the NxisAI app to use one of this page's forms, or from this chat on another page (an event's
      // Get tickets): then in the conversation it came from.
      void this._arriveFromHandoff(visited);
    }

    this._els.launcher.addEventListener('click', () => this._open());
    this._els.handoffBack.addEventListener('click', () => void this._endHandoff());
    // A handoff left open on the last page carries on here.
    this._paintHandoffBar();
    if (this._activeId) void this._handoff?.resume(this._activeId);
    this._els.close.addEventListener('click', () => this.close());
    this._els.menu.addEventListener('click', () => this._setNav(!this._navOpen()));
    // Tapping the conversation is how a drawer is dismissed everywhere else.
    // The drawer is a fixed 280px, so on any phone a strip of the thread stays
    // visible beside it, and that strip is the target.
    this._els.scrim.addEventListener('click', () => this._setNav(false));
    this._els.newchat.addEventListener('click', () => this._newConversation());
    this._els.go.addEventListener('click', () => {
      // One control, two jobs. A separate stop button would be inactive for
      // most of a conversation, and appears where attention is not.
      if (this._stoppable) this._stopTurn();
      else this._onSend();
    });
    this._els.input.addEventListener('input', () => this._autosize());
    this._els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._onSend();
      }
    });

    // Escape stops the turn, and only that. Closing the panel on the same key
    // would mean the reflex for "wait, no" also throws away the thread it was
    // aimed at, and the two mistakes look identical until it is too late.
    this._els.overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // The drawer is on top of everything, so it is what Escape is aimed at
      // while it is open. Only once it is gone does the key reach the turn.
      if (this._navOpen()) {
        e.preventDefault();
        e.stopPropagation();
        this._setNav(false);
        return;
      }
      if (!this._stoppable) return;
      e.preventDefault();
      e.stopPropagation();
      this._stopTurn();
    });

    // The tools register as the element boots, not when the chat opens: a browser agent reads the page's registry
    // and never opens the chat. Registering calls no model, and opening later connects nothing again. A site whose
    // WebMCP mode is "none" registers no tools on the page until the visitor opens the chat.
    if (window.__NXIS_CONFIG__?.webmcp?.mode !== 'none') void this._connectTools();

    const preload = this.preload;
    if (preload !== 'none') this.provider.preload?.(preload);
    // Contained, opening on connect doesn't take focus: the preview sits in
    // someone else's page, which shouldn't scroll to it or lose its place.
    if (this.hasAttribute('auto-open')) this._open(!this.contained);
    // Open when the page reloaded (or the visitor went to another page of the site) with it open: in this tab only.
    else if (!this.contained && wasOpen()) this._open(false);
  }

  private _navOpen(): boolean {
    return this._els.overlay.classList.contains('nav');
  }

  /**
   * Show or hide the conversation drawer.
   *
   * On a narrow screen the drawer covers the panel, including the button that
   * opened it, so every way out has to be somewhere else: the strip of
   * conversation beside it, Escape, or picking a conversation.
   */
  private _setNav(open: boolean, focus = true): void {
    this._els.overlay.classList.toggle('nav', open);
    this._els.menu.setAttribute('aria-expanded', String(open));
    // Kept out of the accessibility tree and out of the tab order when closed:
    // a full-bleed element that swallows taps is not something to leave lying
    // over the conversation.
    this._els.scrim.hidden = !open;
    // Focus follows the drawer, returning to the control it came from.
    if (!open && focus) this._els.menu.focus();
  }

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this._onOutsidePress);
    this._narrow?.removeEventListener?.('change', this._paintModeBtn);
    // Moved or removed: nothing left on screen to keep in step with the journal.
    this._offJourney?.();
    this._offJourney = null;
    this._journeyObserver?.disconnect();
    this._journeyObserver = null;
    this._clearJourneyStatusTimer();
    // Streams stop with the element; the handoff itself stays saved, and resumes when it returns.
    this._handoff?.dispose();
    // Playback stops with it, and the file is let go.
    this._media?.dispose();
    this._mediaEl?.pause();
    this._mediaEl?.replaceChildren();
    this._media = null;
    this._mediaEl = null;
  }

  /** Programmatic open (used by pages that dock the agent full-page). */
  open(): void {
    this._open();
  }

  /**
   * Close the window to the launcher, as its close button does, in any mode
   * (inline too, which has no launcher: `open()` brings it back). Focus that
   * was inside the agent goes to the launcher; focus elsewhere on the page
   * stays put. Does nothing when already closed.
   */
  close(): void {
    if (!this.isOpen) return;
    const had = !!this.shadowRoot!.activeElement;
    this._setOpen(false);
    if (had) this._els.launcher.focus({ preventScroll: true });
    // Audio goes on beside the launcher; video pauses.
    this._media?.panel(false);
    // A remote turn can outlive the panel, and its answer would go unread.
    this._setStoppable(false);
    (this._coordinator ?? this._harness).stop();
  }

  /** Whether the window is showing. Changes are announced with `nxis-agent-toggle`. */
  get isOpen(): boolean {
    return !!this._els?.overlay.classList.contains('show');
  }

  /**
   * Show or hide the window, and say so with `nxis-agent-toggle` (`detail.open`)
   * when that changes, whatever changed it.
   */
  /** The thread's scroll offset when the panel closed; -1 for its end. */
  private _at = -1;

  private _setOpen(open: boolean): void {
    if (this.isOpen === open) return;
    const t = this._els.thread;
    // Where the visitor was in the thread, kept while it's closed: at the end, unless they had scrolled up.
    if (!open) this._at = t.scrollHeight - t.scrollTop - t.clientHeight > 40 ? t.scrollTop : -1;
    this._els.overlay.classList.toggle('show', open);
    if (!this.contained) keepOpen(open);
    if (open && this._at < 0) this._scroll();
    else if (open) t.scrollTop = this._at;
    this.dispatchEvent(new CustomEvent('nxis-agent-toggle', { detail: { open }, bubbles: true, composed: true }));
  }

  private _open(focus = true): void {
    this._setOpen(true);
    this._media?.panel(true);
    // With the input off there is nothing to type into, so focus goes to the header's first control.
    if (focus) (this._inputOff() ? this._els.menu : this._els.input).focus({ preventScroll: this.contained });
    void this._connectTools();
    void this._guard();
    // A contained preview loads only a provider the host gave it: opening it
    // never starts the on-device model's download.
    const load = this.contained && !this._provider ? undefined : this.provider.load?.();
    (load ?? Promise.resolve())
      // A finished load has to redraw too: the chips were withheld while it ran.
      .then(() => this._paintLoad())
      .catch((err) => this._reportEngineError(err));
    // ensureEngine flips `loading` synchronously, so the empty state can switch
    // to the stage view now rather than waiting for the first status callback.
    this._paintLoad();
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  private _loadConversations(): void {
    // A contained preview starts empty and keeps nothing: what the page's
    // visitors said isn't its to show, and what is typed into it isn't kept.
    if (this.contained) {
      // Without focus: the preview is on someone else's page, which shouldn't jump to it.
      this._newConversation(false);
      return;
    }
    try {
      const arr = JSON.parse(localStorage.getItem(CONV_KEY) || 'null');
      if (Array.isArray(arr) && arr.length) {
        this._conversations = arr;
        this._activeId = arr[0].id;
        return;
      }
    } catch {
      /* fall through to a fresh one */
    }
    this._newConversation();
  }

  private _saveConversations(): void {
    if (this.contained) return;
    try {
      // Live forms are transient: persist only finalized thread items.
      const slim = this._conversations.map((c) => ({
        id: c.id,
        title: c.title,
        messages: c.messages,
        items: c.items.filter((it) => it.kind !== 'form'),
        ...(c.details && Object.keys(c.details).length ? { details: c.details } : {}),
      }));
      localStorage.setItem(CONV_KEY, JSON.stringify(slim));
    } catch {
      /* storage blocked/full */
    }
  }

  private _active(): Conversation | null {
    return this._conversations.find((c) => c.id === this._activeId) || null;
  }

  private _newConversation(focus = true): void {
    const conv: Conversation = {
      id: uid(),
      title: 'New conversation',
      messages: [{ role: 'system', content: this._systemPrompt }],
      items: [],
    };
    this._conversations.unshift(conv);
    this._activeId = conv.id;
    this._tool = null;
    this._formEl = null;
    this._syncProfileContext();
    this._setNav(false, focus);
    if (this._els.history) {
      this._renderHistory();
      this._renderThread();
      this._saveConversations();
      this._paintHandoffBar();
    }
    if (focus && this._els.input) this._els.input.focus();
  }

  private _switchConversation(id: string): void {
    if (id === this._activeId) return;
    this._activeId = id;
    this._tool = null;
    this._formEl = null;
    this._syncProfileContext();
    this._setNav(false);
    this._renderHistory();
    this._renderThread();
    this._paintHandoffBar();
    void this._handoff?.resume(id);
  }

  private _renderHistory(): void {
    this._els.history.innerHTML = this._conversations
      .map(
        (c) =>
          `<div class="hist-row${c.id === this._activeId ? ' active' : ''}">
        <button class="hist-item" data-id="${c.id}">${escapeHtml(c.title || 'New conversation')}</button>
        <button class="hist-del" data-id="${c.id}" title="Delete conversation" aria-label="Delete conversation">${ICON_TRASH}</button>
      </div>`,
      )
      .join('');
    this._els.history.querySelectorAll('.hist-item').forEach((b) =>
      b.addEventListener('click', () => this._switchConversation((b as HTMLElement).dataset.id!)),
    );
    this._els.history.querySelectorAll('.hist-del').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteConversation((b as HTMLElement).dataset.id!);
      }),
    );
  }

  private _deleteConversation(id: string): void {
    const idx = this._conversations.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const wasActive = id === this._activeId;
    this._conversations.splice(idx, 1);

    if (!this._conversations.length) {
      this._newConversation(); // creates a fresh one + re-renders + saves
      return;
    }
    if (wasActive) {
      this._activeId = this._conversations[Math.min(idx, this._conversations.length - 1)].id;
      this._tool = null;
      this._formEl = null;
      this._syncProfileContext();
      this._renderThread();
    }
    this._renderHistory();
    this._saveConversations();
  }

  // ── Thread rendering ───────────────────────────────────────────────────────
  private _renderThread(): void {
    const t = this._els.thread;
    // innerHTML = '' detaches the surface elements but leaves their processors
    // subscribed; dispose explicitly before dropping the references.
    for (const s of this._surfaces) {
      try { s.dispose(); } catch { /* already disposed */ }
    }
    this._surfaces = [];
    t.innerHTML = '';
    this._emptyLoading = null;
    const conv = this._active();
    if (!conv || !conv.items.length) {
      // The mark doubles as the loading indicator, with a ring filling around
      // it while the weights download, rather than adding a second widget.
      //
      // The suggestions are withheld until the model exists, since tapping one
      // before then would do nothing.
      const loading = (this.provider?.load ? this.provider.loading : false) ?? false;
      this._emptyLoading = loading;
      const body = loading
        ? `<p class="stage">${escapeHtml(this._stage || 'Loading model…')}</p>` +
          `<p class="stage-bytes"></p>`
        : `<p>${escapeHtml(this._emptyState)}</p>` +
          `<div class="chips appear">` +
          // A preview's chips look as a visitor's do, and send nothing.
          this._suggestions.map((c) => `<button class="chip"${this._inputOff() ? ' aria-disabled="true" tabindex="-1"' : ''}>${escapeHtml(c)}</button>`).join('') +
          `</div>`;
      t.innerHTML =
        `<div class="empty">` +
        `<span class="empty-mark"><span class="ring" hidden></span>${this._logoMarkup()}</span>` +
        body +
        `</div>`;
      this._paintLoad();
      t.querySelectorAll('.chip').forEach((b) =>
        b.addEventListener('click', () => {
          if (this._inputOff()) return;
          this._els.input.value = (b as HTMLElement).textContent || '';
          this._onSend();
        }),
      );
      return;
    }
    for (let i = 0; i < conv.items.length; i++) {
      const it = conv.items[i];
      if (it.kind === 'msg') this._paintMsg(it.role, it.text, i, it.sources);
      else if (it.kind === 'tool') this._paintToolResult(it.name, it.text, it.isError);
      else if (it.kind === 'trace') {
        if (this.debug) this._els.thread.appendChild(this._traceEl(it));
      } else if (it.kind === 'stopped') {
        this._paintStopped();
      } else if (it.kind === 'route') {
        if (this.debug) this._els.thread.appendChild(this._routeEl(it));
      }
      else if (it.kind === 'detail') this._els.thread.appendChild(this._detailEl(it));
      else if (it.kind === 'results') {
        // A type listing kept by an older version is not drawn: visitors never read one.
        if (!isListingItem(it)) this._els.thread.appendChild(this._resultsEl(it));
      } else if (it.kind === 'metrics') this._els.thread.appendChild(this._metricsEl(it));
      else if (it.kind === 'journey') {
        // A request drawn as an action card shows its own steps.
        if (!conv.items.some((a) => a.kind === 'action' && a.id === it.id)) this._els.thread.appendChild(this._journeyEl(it));
      } else if (it.kind === 'action') this._paintAction(it);
      else if (it.kind === 'remote' || it.kind === 'handoff') this._paintHandoffItem(it, i);
    }
    this._scroll();
    this._watchRunningJourney();
  }

  private _clearEmpty(): void {
    const e = this._els.thread.querySelector('.empty');
    if (e) e.remove();
  }

  /**
   * A chat bubble.
   *
   * `.msg` styles the bubble and also wraps non-bubble content, so the form,
   * detail and results wrappers each had to undo it (`background: none;
   * border: none; padding: 0`. Splitting the two roles removes that undo:
   * bubbles get bubble utilities, wrappers get layout utilities, and neither
   * has to know about the other.
   *
   * The squared corner nearest the sender is the one carrying information: it
   * is how a glance tells user from assistant before any colour is read.
   */
  private _msgEl(role: string, text: string): HTMLElement {
    const el = document.createElement('div');
    const base =
      'max-w-[76%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm leading-relaxed';
    const byRole =
      role === 'user'
        ? 'self-end bg-blue text-white rounded-2xl rounded-br-md'
        : 'self-start bg-surface text-ink border border-border-hair rounded-2xl rounded-bl-md shadow-resting';
    el.className = `msg ${role} ${base} ${byRole}`;
    if (role === 'assistant') void this._fillReply(el, text);
    else fillMessage(el, text);
    return el;
  }

  /** The markdown chunk, once here. See ./markdown.ts. */
  private _mdMod?: typeof import('./markdown.js');
  private _mdLoad?: Promise<unknown>;
  /** What each reply's bubble last had written into it, and when it is drawn as it will stay. */
  private _replyText = new WeakMap<HTMLElement, string>();
  private _replyDrawn = new WeakMap<HTMLElement, Promise<void>>();

  /**
   * Write a reply (the assistant's, or a remote agent's) into its bubble: as markdown once that chunk is here,
   * loading it the first time a reply has anything markdown would change, and as text with its links till then.
   * Links open only where the page allows ({@link _linkPolicy}). Resolves once the bubble is drawn as it will stay.
   */
  private _fillReply(el: HTMLElement, text: string): Promise<void> {
    this._replyText.set(el, text);
    const policy = this._linkPolicy();
    const visit = (url: string, label: string) => savePendingVisit({ pageUrl: url, label, conversationId: this._activeId ?? undefined });
    const draw = () => {
      el.textContent = '';
      const m = this._mdMod;
      const link = (label: string, href: string) => {
        const url = allowedLink(href, policy);
        return url ? anchor(url, label, policy, visit) : null;
      };
      fillMessage(el, this._replyText.get(el) ?? '', (t) => linkNodes(t, policy, visit), m && ((into, t) => m.mdFill(into, t, { link })));
    };
    draw();
    const done =
      this._mdMod || !MD_HINT.test(text)
        ? Promise.resolve()
        : (this._mdLoad ??= import('./markdown.js').then(
            (m) => void (this._mdMod = m),
            () => void (this._mdLoad = undefined),
          )).then(() => void (this._mdMod && draw()));
    this._replyDrawn.set(el, done);
    return done;
  }

  /** A2UI Text's markdown, as HTML built from our own elements; plain text is escaped without loading anything. */
  private _mdHtml(text: string): Promise<string> {
    if (!MD_HINT.test(text)) return Promise.resolve(escapeHtml(text));
    const policy = this._linkPolicy();
    return (this._mdLoad ??= import('./markdown.js').then((m) => void (this._mdMod = m)))
      .then(() =>
        this._mdMod!.mdHtml(text, {
          link: (label, href) => {
            const url = allowedLink(href, policy);
            if (!url) return null;
            const a = document.createElement('a');
            a.href = url;
            a.dataset.md = '';
            a.textContent = label;
            if (openWay(url) === 'new-tab') {
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
            }
            return a;
          },
        }),
      )
      .catch(() => {
        this._mdLoad = undefined;
        return escapeHtml(text);
      });
  }

  /**
   * A tool outcome.
   *
   * Not a bubble, since nobody said it. Styled as a system line: full width, mono
   * eyebrow for the tool name, and the result beneath in body text. Colour
   * carries the outcome (design.md §2: green is a positive result, and error
   * red is reserved for actual failure).
   */
  private _toolEl(name: string, text: string, isError: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className =
      'msg tool self-stretch w-full rounded-card border px-3.5 py-2.5 ' +
      (isError
        ? 'bg-surface border-red/25 text-red'
        : 'bg-surface border-border-hair text-green-strong');
    const head = document.createElement('b');
    head.className =
      'flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em]';
    head.innerHTML = `${isError ? ICON_WARN : ICON_CHECK}${escapeHtml(withoutSiteSuffix(name))}`;

    const body = document.createElement('div');
    body.className = 'mt-1 font-sans text-[13px] leading-normal text-ink-2';
    // A tool's own sentence is worth showing; its raw payload is for whoever
    // is building the agent, and lives in the trace, which `debug` governs.
    const shown =
      this.debug || !looksMachine(text)
        ? text
        : `${humanize(withoutSiteSuffix(name))} could not be completed.`;
    fillMessage(body, shown);

    el.append(head, body);
    return el;
  }

  private _detailEl(item: { title: string; note: string; rows?: DetailRow[] }): HTMLElement {
    const rows = (item.rows || [])
      .map(
        (r) =>
          // Focusable, so a keyboard can open a truncated row the way a pointer does.
          `<div class="dc-row" tabindex="0"><dt title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</dt>` +
          `<dd title="${escapeHtml(r.value)}">${escapeHtml(r.value)}</dd></div>`,
      )
      .join('');
    const el = document.createElement('div');
    el.className = 'msg detail';
    el.innerHTML = `
      <div class="detailcard">
        <div class="dc-badge">${ICON_CHECK}</div>
        <div class="dc-eyebrow">Submitted</div>
        <div class="dc-title">${escapeHtml(item.title)}</div>
        <div class="dc-sub">${escapeHtml(item.note)}</div>
        <dl class="dc-list">${rows || '<div class="dc-row"><dd>No details captured.</dd></div>'}</dl>
      </div>`;
    return el;
  }

  /**
   * Draw one message.
   *
   * A message the user sent carries a row of actions, so `index` identifies
   * which item it is: copy needs the text, and edit and send-again need to know
   * how much of the conversation they will replace.
   *
   * @param role - Who sent the message.
   * @param text - The message text.
   * @param index - Its position in the conversation's items. Required for the
   * action bar; omit it for messages that should not carry one.
   * @returns The bubble element.
   */
  private _paintMsg(role: string, text: string, index?: number, sources?: LocalSource[]): HTMLElement {
    this._clearEmpty();
    const el = this._msgEl(role, text);
    if (sources?.length) this._paintLocalSources(el, sources, index);
    if (role !== 'user' || index === undefined) {
      this._els.thread.appendChild(el);
      return el;
    }
    const turn = document.createElement('div');
    turn.className = 'turn';
    // Focusable so the row can be reached without a pointer: `:focus-within`
    // is what reveals it, and a bubble that cannot take focus never fires it.
    turn.tabIndex = -1;
    turn.dataset.item = String(index);
    turn.appendChild(el);
    turn.appendChild(this._actionBar(index, text));
    this._els.thread.appendChild(turn);
    return el;
  }

  /** Copy, edit, send again, under the person's own message. */
  private _actionBar(index: number, text: string): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'actions';
    bar.innerHTML =
      `<button class="act" data-act="copy" type="button" aria-label="Copy message" title="Copy">${ICON_COPY}</button>` +
      `<button class="act" data-act="edit" type="button" aria-label="Edit message" title="Edit">${ICON_PENCIL}</button>` +
      `<button class="act" data-act="resend" type="button" aria-label="Send again" title="Send again">${ICON_REDO}</button>`;

    const copy = bar.querySelector<HTMLButtonElement>('[data-act="copy"]')!;
    copy.addEventListener('click', () => {
      // The tick is the confirmation; a toast would be redundant.
      navigator.clipboard?.writeText(text).catch(() => {});
      copy.innerHTML = ICON_CHECK_MARK;
      copy.classList.add('done');
      copy.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        copy.innerHTML = ICON_COPY;
        copy.classList.remove('done');
        copy.setAttribute('aria-label', 'Copy message');
      }, 1400);
    });

    bar
      .querySelector('[data-act="resend"]')!
      .addEventListener('click', () => void this._rerunFrom(index, text));
    bar
      .querySelector('[data-act="edit"]')!
      .addEventListener('click', () => this._editMessage(index, text));
    return bar;
  }

  /**
   * Turn the bubble into a field where it already sits.
   *
   * Not the composer. Editing in the composer means looking at one copy of the
   * sentence while typing into another, and the one being changed is the one
   * further from the eye.
   */
  private _editMessage(index: number, text: string): void {
    const turn = this._els.thread.querySelector<HTMLElement>(`.turn[data-item="${index}"]`);
    if (!turn) return;
    const box = document.createElement('div');
    box.className = 'editing';
    box.innerHTML =
      `<textarea rows="2"></textarea>` +
      `<div class="edit-actions">` +
      `<button class="ebtn" data-e="cancel" type="button">Cancel</button>` +
      `<button class="ebtn primary" data-e="save" type="button">Send</button>` +
      `</div>`;
    const hint = document.createElement('div');
    hint.className = 'edit-hint';
    // Said before the commit, not after. Editing the first of five turns throws
    // away the four below it, because they answered a question that no longer
    // exists, and that is not something to discover by watching it happen.
    hint.textContent = 'everything below is replaced when this is sent';

    const ta = box.querySelector('textarea')!;
    ta.value = text;
    turn.replaceWith(box);
    box.after(hint);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const close = () => {
      hint.remove();
      box.remove();
      this._renderThread();
    };
    const send = () => {
      const next = ta.value.trim();
      if (!next) return;
      void this._rerunFrom(index, next);
    };
    box.querySelector('[data-e="cancel"]')!.addEventListener('click', close);
    box.querySelector('[data-e="save"]')!.addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  /**
   * Send a message again from this point, replacing everything below it.
   *
   * Discards the following items and messages from both the thread and the
   * transcript, since they answered a question that no longer exists.
   *
   * @param index - The item index of the message to resend.
   * @param text - The message to send, edited or unchanged.
   */
  private async _rerunFrom(index: number, text: string): Promise<void> {
    if (!this._active()) return;
    // The turn in flight is answering the question being replaced.
    if (this._turnActive) {
      this._stopTurn();
      await this._turnDone;
    }
    this._truncateFrom(index);
    this._renderThread();
    this._els.input.value = text;
    this._autosize();
    await this._onSend();
  }

  /**
   * Drop every item and every message from `index` down, the message itself
   * included: it is about to be sent again.
   */
  private _truncateFrom(index: number): void {
    const conv = this._active();
    if (!conv) return;
    let turns = 0;
    for (let i = 0; i < index; i++) {
      const it = conv.items[i];
      if (it.kind === 'msg' && it.role === 'user') turns++;
    }
    // Tool results are written into the transcript as user turns too, so the
    // person's own messages are the unbracketed ones.
    let seen = 0;
    let cut = conv.messages.length;
    for (let i = 0; i < conv.messages.length; i++) {
      const m = conv.messages[i];
      if (m.role !== 'user' || m.content.startsWith('[')) continue;
      if (seen++ === turns) {
        cut = i;
        break;
      }
    }
    conv.messages.length = cut;
    conv.items.length = index;
    this._saveConversations();
  }
  /**
   * The receipt for a tool call: one muted line, collapsed.
   *
   * `<details>` rather than a button and a class, because the summary is a
   * real disclosure control, so keyboard, screen reader and find-in-page all
   * work without anything being wired up. Closed by default: this is the row
   * a person scrolls past, and opens only when the answer above it looks
   * wrong.
   */
  private _traceEl(item: Extract<ThreadItem, { kind: 'trace' }>): HTMLElement {
    const el = document.createElement('details');
    el.className = `trace${item.isError ? ' err' : ''}`;

    const summary = document.createElement('summary');
    const verb = item.isError ? 'failed' : 'ran';
    const outcome = item.isError
      ? 'error'
      : typeof item.count === 'number'
        ? `${item.count} result${item.count === 1 ? '' : 's'}`
        : 'ok';
    summary.innerHTML =
      `<span class="caret" aria-hidden="true"></span>` +
      `<span>${escapeHtml(humanize(item.name))} ${verb} · ${escapeHtml(outcome)}</span>`;
    el.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'trace-body';
    const args = JSON.stringify(item.args ?? {}, null, 2);
    body.innerHTML =
      `<span class="trace-label">Call</span>` +
      `<pre>${escapeHtml(`${item.name}(${args === '{}' ? '' : args})`)}</pre>` +
      `<span class="trace-label">Response</span>` +
      `<pre class="raw">${escapeHtml(item.text || '(empty)')}</pre>`;
    el.appendChild(body);
    return el;
  }

  /**
   * A journey as a card in the thread.
   *
   * Open while it runs, so the step being taken is on screen; folded to one
   * line once it finishes, so the thread reads as a record rather than a wall
   * of finished checklists. A `<details>` either way, so a folded journey can
   * still be opened.
   */
  private _journeyEl(item: Extract<ThreadItem, { kind: 'journey' }>): HTMLDetailsElement {
    const view = viewJourney(item.steps);
    const el = document.createElement('details');
    el.className = `msg journey is-${view?.outcome ?? 'running'}`;
    el.dataset.journey = item.id;
    el.open = view?.outcome === 'running';
    if (view?.active) el.dataset.active = view.active.label;

    const summary = document.createElement('summary');
    const mark = document.createElement('span');
    mark.className = 'j-sum-mark';
    mark.setAttribute('aria-hidden', 'true');
    if (view?.outcome === 'done') mark.textContent = '✓';
    if (view?.outcome === 'failed') mark.textContent = '!';
    const title = document.createElement('span');
    title.className = 'j-title';
    title.textContent = view?.title ?? 'Working on it';
    const state = document.createElement('span');
    state.className = 'j-state';
    // Running, the header says what is happening now; finished, it says how
    // it ended, which is the one thing a folded card has to carry.
    state.textContent =
      view?.outcome === 'running' ? (view.active?.label ?? '') : (view?.summary.split(' · ')[1] ?? '');
    summary.append(mark, title, state);
    el.appendChild(summary);

    const list = document.createElement('ol');
    list.className = 'j-steps';
    (view?.steps ?? []).forEach((step, i) => {
      const li = document.createElement('li');
      li.className = `j-step is-${step.status}`;
      const m = document.createElement('span');
      m.className = 'j-mark';
      m.textContent = step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : String(i + 1);
      const label = document.createElement('span');
      label.className = 'j-label';
      // Text throughout: a label can carry a business name from the site's data.
      label.textContent = step.label;
      label.title = step.detail ? `${step.label} — ${step.detail}` : step.label;
      if (step.detail) {
        const small = document.createElement('small');
        small.textContent = step.detail;
        label.appendChild(small);
      }
      li.append(m, label);
      list.appendChild(li);
    });
    el.appendChild(list);
    return el;
  }

  /**
   * Keep a journey's card, and its record in the conversation, up to date.
   *
   * Looks for the journey in every conversation before assuming it is new:
   * on arrival after a page change the resume records steps before the
   * conversation they came from has been reopened, and those steps belong
   * with the card saved on the page before, not in whichever thread is open.
   */
  private _onJourney(all: AgentStep[]): void {
    const view = viewJourney(all);
    if (!view?.id) return;

    type JourneyItem = Extract<ThreadItem, { kind: 'journey' }>;
    const isThis = (it: ThreadItem): it is JourneyItem => it.kind === 'journey' && it.id === view.id;
    let conv = this._conversations.find((c) => c.items.some(isThis));
    let item = conv?.items.find(isThis);
    if (conv && item) {
      item.steps = all;
    } else {
      conv = this._active() ?? undefined;
      if (!conv) return;
      item = { kind: 'journey', id: view.id, steps: all };
      conv.items.push(item);
    }

    // A request with an action card: the steps belong in the card.
    const action = conv.items.find((it): it is ActionItem => it.kind === 'action' && it.id === view.id);
    if (action) {
      this._actionFollows(action, all);
      this._watchRunningJourney();
      this._saveConversations();
      return;
    }

    if (conv.id === this._activeId && this._els?.thread) {
      const fresh = this._journeyEl(item);
      const old = this._els.thread.querySelector(`[data-journey="${CSS.escape(view.id)}"]`);
      if (old) {
        // Keep a folded card open if someone opened it to read.
        if ((old as HTMLDetailsElement).open && view.outcome !== 'running') fresh.open = true;
        old.replaceWith(fresh);
      } else {
        this._clearEmpty();
        this._els.thread.appendChild(fresh);
        this._scroll();
      }
      this._watchRunningJourney();
    }
    this._saveConversations();
  }

  /**
   * Show the status line only while the running journey is out of view.
   *
   * The card is where the steps are; the line exists for the moment a long
   * reply pushes it off the top of the thread mid-action, and hides again as
   * soon as the card is back.
   */
  private _watchRunningJourney(): void {
    this._journeyObserver?.disconnect();
    this._journeyObserver = null;
    const bar = this._els?.jstatus;
    if (!bar) return;
    const cards = this._els.thread.querySelectorAll<HTMLElement>('.journey.is-running');
    const card = cards[cards.length - 1];
    const id = card?.dataset.journey ?? null;
    if (id !== this._jstatusJourney) {
      this._clearJourneyStatusTimer();
      this._jstatusJourney = id;
    }
    if (!card || !id || this._jstatusDismissed.has(id) || typeof IntersectionObserver === 'undefined') {
      bar.hidden = true;
      return;
    }
    (bar.querySelector('.js-label') as HTMLElement).textContent = card.dataset.active ?? '';
    this._journeyObserver = new IntersectionObserver(
      (entries) => {
        bar.hidden = entries[entries.length - 1].isIntersecting;
      },
      { root: this._els.thread, threshold: 0.2 },
    );
    this._journeyObserver.observe(card);
  }

  /**
   * The thread grew: start the clock on the status line.
   *
   * A journey can stay running while the conversation goes on without it, and a
   * line that spins through all of that says nothing. So once new messages
   * arrive, the line gets a while longer, then goes.
   */
  private _noteThreadGrew(): void {
    const id = this._jstatusJourney;
    if (!id || this._jstatusTimer || this._jstatusDismissed.has(id)) return;
    this._jstatusTimer = setTimeout(() => {
      this._jstatusTimer = null;
      this._dismissJourneyStatus();
    }, JSTATUS_TIMEOUT_MS);
  }

  /** Hide the status line for the running journey, for good. */
  private _dismissJourneyStatus(): void {
    this._clearJourneyStatusTimer();
    if (this._jstatusJourney) this._jstatusDismissed.add(this._jstatusJourney);
    this._journeyObserver?.disconnect();
    this._journeyObserver = null;
    if (this._els?.jstatus) this._els.jstatus.hidden = true;
  }

  private _clearJourneyStatusTimer(): void {
    if (this._jstatusTimer) clearTimeout(this._jstatusTimer);
    this._jstatusTimer = null;
  }

  private _paintToolResult(name: string, text: string, isError: boolean): HTMLElement {
    this._clearEmpty();
    const el = this._toolEl(name, text, isError);
    this._els.thread.appendChild(el);
    return el;
  }

  /** Append a bubble both to the persisted thread and the DOM. */
  /**
   * Call off the turn in flight.
   *
   * The note left in the thread is presented neutrally: a stop is neither an
   * error nor a refusal, so it is not styled as a warning.
   */
  private _stopTurn(): void {
    if (!this._stoppable) return;
    this._setStoppable(false);
    (this._coordinator ?? this._harness).stop();
    const conv = this._active();
    if (conv) {
      conv.items.push({ kind: 'stopped' });
      this._saveConversations();
    }
    this._paintStopped();
    this._setStatus('');
    this._scroll();
    this._els.input.focus();
  }

  private _paintStopped(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'stopped-note';
    el.textContent = 'Stopped';
    this._els.thread.appendChild(el);
    return el;
  }

  /** Swap the composer button between sending and stopping. */
  private _setStoppable(canStop: boolean): void {
    if (this._stoppable === canStop) return;
    this._stoppable = canStop;
    const go = this._els.go;
    go.classList.toggle('stop', canStop);
    go.innerHTML = canStop ? ICON_STOP : ICON_ARROW;
    go.setAttribute('aria-label', canStop ? 'Stop' : 'Send');
    // The model's dot pulses while it is working, so the two controls agree.
    this._els.model.classList.toggle('busy', canStop);
    // Enabled either way: disabling it during a turn would disable the very
    // control needed to stop that turn.
    go.disabled = false;
  }

  private _appendMsg(role: string, text: string): HTMLElement {
    const conv = this._active()!;
    conv.items.push({ kind: 'msg', role, text });
    const el = this._paintMsg(role, text, conv.items.length - 1);
    this._saveConversations();
    this._scroll();
    this._noteThreadGrew();
    return el;
  }

  /**
   * The assistant's bubble for one phase of a turn.
   *
   * Starts as an animated thinking indicator rather than a static ellipsis: a
   * turn can be silent for tens of seconds while weights download, and a
   * motionless dot is indistinguishable from a hung page. The first token
   * replaces the indicator with text, and only a non-empty `finalize` persists
   * the bubble into the stored conversation.
   */
  private _appendStreaming(): StreamingBubble {
    const el = this._paintMsg('assistant', '');
    el.classList.add('thinking');
    el.innerHTML = THINKING_MARKUP;
    // The bubble is a live region so a screen reader hears the phase change
    // without the focus moving to it.
    el.setAttribute('aria-live', 'polite');
    this._scroll();
    this._noteThreadGrew();

    const setLabel = (label?: string) => {
      const node = el.querySelector('.think-label');
      if (node) node.textContent = label ?? '';
    };

    /**
     * Show byte counts for the current phase, or nothing.
     *
     * Only the weight download reports totals. The runtime fetch and the warm-up
     * do not, and those phases show the dots alone rather than an empty readout.
     */
    const setProgress = (_pct: number, detail?: ProgressDetail) => {
      const bytes = el.querySelector('.think-bytes');
      if (!bytes) return;
      // Figures rather than a bar: the ring on the header mark already carries
      // the proportion, and what it cannot show is how much is left in bytes.
      bytes.textContent = detail?.total
        ? `${formatBytes(detail.loaded)} / ${formatBytes(detail.total)}`
        : '';
    };

    const bubble: StreamingBubble & { setProgress: typeof setProgress } = {
      // Naming a new phase reuses the same bubble, so a turn that loads, then
      // discovers, then generates remains one element in the thread rather than
      // three that appear and vanish.
      thinking: (label) => {
        if (!el.classList.contains('thinking')) {
          el.classList.add('thinking');
          el.innerHTML = THINKING_MARKUP;
        }
        setLabel(label);
        this._scroll();
      },
      // `t` is the whole answer so far, not the newest fragment; assigning it
      // is correct; appending would repeat the answer on every token.
      update: (t) => {
        if (!t) return;
        // First token: drop the indicator and become an ordinary bubble. The
        // live region goes with it, since announcing a streaming answer word by
        // word would talk over the reader.
        if (el.classList.contains('thinking')) {
          el.classList.remove('thinking');
          el.removeAttribute('aria-live');
          el.innerHTML = '';
          if (this._liveBubble === bubble) this._liveBubble = null;
        }
        void this._fillReply(el, t);
        this._scroll();
      },
      // Empty text means the phase had nothing to leave behind (a finished
      // tool call, a failed load), so the bubble goes rather than lingering as
      // a blank one. Anything else is persisted; a pending indicator never is.
      finalize: (t) => {
        el.classList.remove('thinking');
        el.removeAttribute('aria-live');
        if (this._liveBubble === bubble) this._liveBubble = null;
        if (!t) {
          el.remove();
          return;
        }
        void this._fillReply(el, t);
        // An answer from records read in this turn (else read earlier in this conversation, as the model answers from
        // them too): their markers and Sources list, as a remote answer has. Only a record the reply names is cited.
        const read = this._citable();
        const sources = read.length ? [...read] : undefined;
        const items = this._active()!.items;
        items.push({ kind: 'msg', role: 'assistant', text: t, ...(sources ? { sources } : {}) });
        if (sources) this._paintLocalSources(el, sources, items.length - 1);
        this._saveConversations();
        this._scroll();
      },
      setProgress,
    };

    // The engine reports progress to the element, not through the turn loop,
    // so the element has to know which bubble is currently on screen.
    this._liveBubble = bubble;
    return bubble;
  }

  // ── Turn loop ──────────────────────────────────────────────────────────────
  /**
   * Send what is in the composer.
   *
   * @param call - A tool call already decided, run without asking the model
   *   (a handoff names its form). Falls back to an ordinary turn when no agent
   *   here holds the tool.
   */
  private async _onSend(call?: { name: string; args: Record<string, unknown> }): Promise<void> {
    const goal = this._els.input.value.trim();
    if (!goal || this._turnActive || this._inputOff()) return;
    this._els.input.value = '';
    this._autosize();
    this._appendMsg('user', goal);
    // Nothing is sent, to the model or to a remote agent, without the guardrails.
    const down = await this._guard();
    if (down) return this._reportEngineError(down);

    const conv = this._active();
    if (conv && (!conv.title || conv.title === 'New conversation')) {
      conv.title = goal.length > 40 ? goal.slice(0, 40) + '…' : goal;
      this._renderHistory();
      this._saveConversations();
    }

    // Handed off: this message is for the target, not the assistant.
    const handed = this._handoff?.active(this._activeId ?? undefined);
    if (handed && this._activeId) {
      // The input stage, as for a turn: the length cap and the send rate apply to a remote agent too.
      if (await this._g!.input(goal, conv!.messages, this._renderer())) return;
      try {
        await this._handoff!.send(this._activeId, goal);
      } catch (err) {
        const why = this._handoff!.session(this._activeId)?.error ?? String((err as Error)?.message || err);
        this._appendHandoffItem(this._activeId, { kind: 'handoff', text: why, tone: 'error' });
      }
      return;
    }

    // A card still waiting for its button (a Hand over or Send offer) is stale once the visitor moves on: it goes
    // inert, and the model reads that nothing was sent, so a typed "yes" is never taken as the press.
    const live = this._live;
    if (live && !live.sent && live.item.stage === 'review' && conv) {
      live.item.stage = 'declined';
      this._live = null;
      this._paintAction(live.item);
      conv.messages.push({
        role: 'user',
        content: `[${live.tool.name} was not sent]`,
        data: `The visitor wrote a new message instead of pressing the card's ${live.item.sendLabel ?? 'Send'} button, so nothing was sent or handed over, and that card no longer works. If they still want it, call the tool again: the page shows a new card for them to press.`,
      });
      this._saveConversations();
    }

    await this._runTurn(goal, conv!, call);
  }

  /**
   * One turn of the page's assistant: `call` made without asking the model when given, else the model's turn.
   *
   * @param only - Only `call`: when no agent here holds its tool, nothing happens (no model call).
   */
  private async _runTurn(goal: string, conv: Conversation, call?: { name: string; args: Record<string, unknown> }, only = false): Promise<void> {
    this._turnActive = true;
    this._turnSources = [];
    this._turnGoal = goal;
    this._setStoppable(true);
    let settle!: () => void;
    this._turnDone = new Promise<void>((r) => (settle = r));
    try {
      // The toolset has to be complete before the model is asked to choose from
      // it. Discovery normally finished while the weights were downloading; this
      // only waits when a message is sent the instant the panel opens.
      await this._connectTools();
      // A kind of target the relay didn't list before (a specialist added since) gets its tool, for the next turn.
      if (this._handoff) void this._registerHandoff().catch(() => {});
      this._syncProfileContext();
      // One agent, or several with a router in front: the signatures match.
      const engine = this._coordinator ?? this._harness;
      const begun = call ? await engine.begin(goal, call.name, call.args, conv.messages) : null;
      if (!only && (!begun || begun.decision === 'unavailable')) await engine.turn(goal, conv.messages);
      // A remote endpoint reports which model answered; the name beside the
      // input follows it rather than keeping whatever was configured.
      this._paintProvenance();
    } catch (err) {
      // A cancelled turn has already reported itself in the thread, and is not
      // a failure to report a second time.
      if (!isAbort(err)) this._reportEngineError(err);
    } finally {
      this._turnActive = false;
      this._setStoppable(false);
      this._turnDone = null;
      settle();
    }
  }

  // ── HarnessRenderer ────────────────────────────────────────────────────────
  /**
   * The element's implementation of {@link HarnessRenderer}.
   *
   * Drawing and reporting back only: whether to ask, what to ask for, and when
   * to run a tool are all decided by the harness.
   */
  private _renderer(): HarnessRenderer {
    return {
      message: (role, text) => this._appendMsg(role, text),
      streaming: (): HStreamingBubble => this._appendStreaming(),
      status: (text, isError) => this._setStatus(text, isError),
      inlinePrompts: !this._classicPrompts,
      ask: (req) => (this._usesCard(req.tool) ? this._cardAsk(req) : this._renderAsk(req)),
      confirm: (req) => (this._usesCard(req.tool) ? this._cardConfirm(req) : this._renderConfirm(req)),
      left: (tool, destination) => this._cardLeft(tool, destination),
      results: (tool, res, extra) => {
        const conv = this._active();
        // A type listing is a step for the model (which kinds of records to search next), never something a visitor
        // reads: nothing is drawn or kept. The tool trace (behind `debug`) still shows the call.
        if (isTypeListing(tool.name)) return;
        const item = this._buildResultsItem(tool, res, extra?.pick);
        // A dated search that found nothing then says so, before the next ones or in their place.
        let lead = '';
        try {
          const n = JSON.parse(extractResult(res)).notice;
          if (typeof n == 'string') lead = n;
        } catch {}
        // A read that answers in words — "you are on the home page", "already open" — has no records
        // to draw, and an empty result card reading "No results found." contradicts the answer it
        // just gave. Say what it said.
        const prose = item.cards.length ? '' : proseAnswer(res) || lead;
        if (lead && !prose) this._appendMsg('assistant', lead);
        if (prose) {
          this._appendMsg('assistant', prose);
          this._upsertMetrics();
          this._saveConversations();
          this._scroll();
          return;
        }
        conv?.items.push(item);
        this._els.thread.appendChild(this._resultsEl(item));
        this._noteSources(res);
        this._upsertMetrics();
        this._saveConversations();
        this._scroll();
      },
      detail: (tool, values, text) => {
        if (this._cardDone(tool, values, text)) return;
        const conv = this._active();
        const item = this._buildDetailItem(tool, values, text);
        conv?.items.push(item);
        this._els.thread.appendChild(this._detailEl(item));
        this._saveConversations();
        this._scroll();
      },
      trace: ({ tool, args, text, isError, count }) => {
        // Not recorded at all when debugging is off. See the `debug` getter.
        if (!this.debug) return;
        const item: Extract<ThreadItem, { kind: 'trace' }> = {
          kind: 'trace',
          name: tool.name,
          args,
          text,
          isError,
          count,
        };
        this._active()?.items.push(item);
        this._els.thread.appendChild(this._traceEl(item));
        this._saveConversations();
        this._scroll();
      },
      toolError: (tool, message) => {
        if (this._cardFailed(tool, message)) return;
        this._paintToolResult(tool.name, message, true);
      },
      dismissPrompt: () => {
        // A sent card stays, and shows the steps; one never sent says so.
        const live = this._live;
        if (live) {
          if (live.sent && (live.item.stage === 'review' || live.item.stage === 'collect')) {
            live.item.stage = 'working';
            this._paintAction(live.item);
            this._saveConversations();
          }
          return;
        }
        this._dismissPrompt();
      },
      // The harness says when stopping stops being possible, because it is the
      // part that knows a tool has been invoked. Once a call is out, offering
      // to stop would be offering to un-send a booking.
      stoppable: (canStop) => this._setStoppable(canStop),
    };
  }

  private _dismissPrompt(): void {
    if (this._prompt) {
      try { this._prompt.dispose(); } catch { /* already gone */ }
      this._prompt = null;
    }
    if (this._formEl && this._formEl.isConnected) this._formEl.remove();
    this._formEl = null;
  }

  /** Mount an A2UI prompt surface into the thread. */
  private _mountPrompt(
    messages: ReturnType<typeof emitAsk>,
    onAction: (name: string, ctx: Record<string, unknown>) => void,
  ): MountedSurface | null {
    this._clearEmpty();
    this._dismissPrompt();

    const wrap = document.createElement('div');
    wrap.className = 'form a2ui a2ui-scope self-start w-full max-w-[420px]';
    const mounted = mountSurface(wrap, messages, (event: any) => {
      const name = event?.event?.name ?? event?.name ?? '';
      const ctx = (event?.event?.context ?? event?.context ?? {}) as Record<string, unknown>;
      onAction(String(name), ctx);
    });
    if (!mounted) return null;

    this._els.thread.appendChild(wrap);
    this._formEl = wrap;
    this._prompt = mounted;
    this._surfaces.push(mounted);
    this._scroll();
    return mounted;
  }

  /** Gaps to fill — one question, or a wizard when the plan has several. */
  private _renderAsk(req: AskRequest): void {
    const { tool, plan } = req;
    if (!plan.steps.length) {
      req.onComplete({});
      return;
    }

    let step = 0;
    const mounted = this._mountPrompt(
      emitAsk(tool.name, plan, req.resolution.values, 'ask'),
      (name, ctx) => {
        if (name === 'nxis.cancel') { req.onCancel(); return; }

        if (name === 'nxis.back') {
          step = Math.max(0, step - 1);
          this._prompt?.send(emitStep('ask', tool.name, plan, step));
          return;
        }

        if (name === 'nxis.next') {
          // Do not advance past an unanswered question: the step exists
          // precisely because this value is unknown.
          const form = (this._prompt?.read('form') ?? {}) as Record<string, unknown>;
          const unanswered = plan.steps[step].slots.filter(
            (sl) => { const v = form[sl.name]; return v === undefined || v === null || String(v).trim() === ''; },
          );
          if (unanswered.length) {
            this._setStatus(`Please answer: ${unanswered.map((sl) => humanize(sl.name)).join(', ')}`, true);
            return;
          }
          this._setStatus('');
          step = Math.min(plan.steps.length - 1, step + 1);
          this._prompt?.send(emitStep('ask', tool.name, plan, step));
          return;
        }

        if (name === 'nxis.submit') {
          const form = (this._prompt?.read('form') ?? {}) as Record<string, unknown>;
          req.onComplete(form);
        }
        void ctx;
      },
    );

    // A renderer failure must not strand the turn; fall back to the DOM form.
    if (!mounted) this._renderFormLegacy(tool, req.resolution.values);
  }

  /**
   * Show what a write will send, and wait for the user to submit it.
   *
   * Drawn as DOM rather than an A2UI surface so the confirmation matches the
   * detail card it becomes once submitted. A2UI's basic catalog cannot express
   * that styling: each component nests its own shadow root, and the `--a2ui-*`
   * properties that reach inside are per component type rather than per
   * instance. `emitConfirm` remains available for renderers that prefer the
   * surface.
   */
  private _renderConfirm(req: ConfirmRequest): void {
    this._clearEmpty();
    this._dismissPrompt();

    const rows = req.slots
      .map((sl) => {
        const label = escapeHtml(sl.schema.description || humanize(sl.name));
        const value = escapeHtml(String(sl.value ?? ''));
        return `<div class="dc-row" tabindex="0"><dt title="${label}">${label}</dt><dd title="${value}">${value}</dd></div>`;
      })
      .join('');
    // Where pressing submit leads, when that is another page. Said here in a
    // sentence so the button itself can stay short enough for a narrow card.
    const sub = req.destination
      ? `Submitting opens the page for ${escapeHtml(req.destination)} and sends it from there.`
      : 'Review these details, then submit.';

    const wrap = document.createElement('div');
    wrap.className = 'msg detail';
    wrap.innerHTML = `
      <div class="detailcard">
        <div class="dc-badge review">${ICON_ARROW}</div>
        <div class="dc-eyebrow review">Ready to send</div>
        <div class="dc-title">${escapeHtml(humanize(req.tool.name))}</div>
        <div class="dc-sub">${sub}</div>
        <dl class="dc-list">${rows || '<div class="dc-row"><dd>No details captured.</dd></div>'}</dl>
        <div class="dc-actions">
          <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
          <button type="button" class="btn ghost" data-act="edit">Edit</button>
          <button type="button" class="btn primary" data-act="submit">${escapeHtml(
            req.submitLabel ?? 'Submit',
          )} ${ICON_ARROW}</button>
        </div>
      </div>`;

    wrap.querySelector('[data-act="cancel"]')!.addEventListener('click', () => req.onCancel());
    wrap.querySelector('[data-act="edit"]')!.addEventListener('click', () => req.onEdit());
    wrap.querySelector('[data-act="submit"]')!.addEventListener('click', () => {
      const btn = wrap.querySelector('[data-act="submit"]') as HTMLButtonElement;
      btn.disabled = true;
      this._rememberDetails(this._active(), detailsFromFields(req.values));
      req.onSubmit(req.values);
    });

    this._els.thread.appendChild(wrap);
    this._formEl = wrap;
    this._scroll();
  }

  // ── Action cards ─────────────────────────────────────────────────────────────

  /** `prompt-style="classic"`: the separate ask, review and submitted cards of earlier versions. */
  private get _classicPrompts(): boolean {
    return this.getAttribute('prompt-style') === 'classic';
  }

  /** Whether a prompt for this tool is drawn as an action card: every write and handoff. */
  private _usesCard(tool: ModelContextToolInfo): boolean {
    return !this._classicPrompts && (isHandoffTool(tool.name) || !tool.annotations?.readOnlyHint);
  }

  /** Details are missing: the card asks for them, beside what it already has. */
  private _cardAsk(req: AskRequest): void {
    const needed = new Set(req.plan.steps.flatMap((st) => st.slots.map((sl) => sl.name)));
    const item = this._liveCard(req.tool, req.resolution.all, req.resolution.values, needed);
    this._live!.ask = req;
    this._live!.confirm = undefined;
    item.stage = 'collect';
    this._paintAction(item);
    this._saveConversations();
  }

  /** Everything is known: the card says what will happen, and waits for Send. */
  private _cardConfirm(req: ConfirmRequest): void {
    const all = resolveSlots(toolSchema(req.tool), { modelArgs: req.values }).all;
    const item = this._liveCard(req.tool, all, req.values, new Set(), req.destination);
    this._live!.confirm = req;
    item.stage = 'review';
    this._paintAction(item);
    this._saveConversations();
  }

  /**
   * The live card for a tool's prompt: the one already open for this request,
   * or a new one, which takes over from the journey card of the same request.
   */
  private _liveCard(
    tool: ModelContextToolInfo,
    slots: Slot[],
    values: Record<string, unknown>,
    needed: Set<string>,
    destination?: string,
  ): ActionItem {
    const conv = this._active()!;
    const id = currentJourney() ?? `a${Date.now().toString(36)}`;
    const live = this._live;
    const described = this._describeAction(tool, values, destination);
    const fields = fieldsFromSlots(this._narrowed(tool, slots, values), values, { needed, hidden: described.hidden, labels: described.labels });

    if (live && live.item.id === id && live.tool.name === tool.name) {
      // The same request, a step on: keep what was typed, and anything the harness has since learned.
      live.item.fields = fields.map((f) => {
        const had = live.item.fields.find((o) => o.name === f.name);
        return had && f.value === '' ? { ...f, value: had.value } : f;
      });
      Object.assign(live.item, described.view);
      live.tool = tool;
      return live.item;
    }

    // A request left waiting is replaced by the new one.
    if (live && (live.item.stage === 'collect' || live.item.stage === 'review')) {
      live.item.stage = 'declined';
      this._paintAction(live.item);
    }

    const item: ActionItem = { kind: 'action', id, tool: tool.name, fields, stage: 'collect', ...described.view };
    conv.items.push(item);
    this._live = { item, tool, sent: false, declining: false };
    this._els?.thread?.querySelector(`[data-journey="${CSS.escape(id)}"]`)?.remove();
    this._watchRunningJourney();
    if (isHandoffTool(tool.name)) void this._refreshHandoffTargets(item);
    return item;
  }

  /**
   * The slots with each field's options cut to the form the call means: one
   * business's services rather than every business's.
   */
  private _narrowed(tool: ModelContextToolInfo, slots: Slot[], values: Record<string, unknown>): Slot[] {
    const options = formOptions(tool, values);
    return slots.map((slot) => {
      const only = options[slot.name];
      if (!only) return slot;
      // Keep a value the call already gave, even one the form does not list: the form decides.
      const current = values[slot.name];
      const list = current !== undefined && current !== '' && !only.includes(String(current)) ? [String(current), ...only] : only;
      return { ...slot, schema: { ...slot.schema, enum: list } };
    });
  }

  /** Who a request goes to, and how the card words it. */
  private _describeAction(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
    destination?: string,
  ): {
    view: Pick<ActionItem, 'variant' | 'noun' | 'identity' | 'sentence' | 'note' | 'sendLabel'>;
    hidden: Set<string>;
    labels: Record<string, string>;
  } {
    const email = String(values.email ?? Object.entries(values).find(([k]) => /e-?mail/i.test(k))?.[1] ?? '').trim();

    if (isHandoffTool(tool.name)) {
      const name = String(values.target ?? '');
      const config = this._handoff?.config?.targets?.[name];
      const known = this._handoffTargets.get(name);
      const label = known?.label ?? config?.label ?? fieldLabel(name || 'the team');
      const person = (known?.kind ?? config?.kind) !== 'agent';
      const away = known ? !known.available : false;
      // "The directory team" leads a line, but mid-sentence it is "the directory team".
      const inline = label.replace(/^The\s/, 'the ');
      const about = known?.description ?? config?.description;
      const status = !known
        ? undefined
        : away
          ? `Away now${known.hours ? ` · open ${known.hours}` : ''}`
          : person
            ? known.waitMinutes
              ? `Available · replies in ~${known.waitMinutes} min`
              : 'Available'
            : 'Available';
      const sentence = !person
        ? `I'll hand this conversation to ${inline}. They'll take it from here.`
        : away
          ? email
            ? `${label} is away right now. They'll reply to ${email}.`
            : `${label} is away right now. Leave an email and they'll reply there.`
          : `I'll pass this to ${inline} so you don't have to repeat yourself.`;
      return {
        view: {
          variant: person ? 'handoff-person' : 'handoff-agent',
          noun: person ? 'handoff' : 'handover',
          identity: { name: label, sub: about ? about.charAt(0).toUpperCase() + about.slice(1) : undefined, status, tone: away ? 'away' : 'ok' },
          sentence,
          note: undefined,
          sendLabel: !person ? 'Hand over' : away ? `Send to ${inline}` : 'Connect me',
        },
        hidden: new Set(['target']),
        labels: { reason: 'Why', summary: 'What they need to know', email: 'Where should they reply?' },
      };
    }

    // "quote form", or just "form": a name like `filters` is the form's HTML id, not what anyone calls it.
    const noun = formNoun(tool.name);
    // Which business or place it is for: the site tool's own chooser, else a field the form names it in.
    const chooser = chooserOf(tool) ?? Object.keys(values).find((k) => /^(business|company|organi[sz]ation|provider|vendor|store|restaurant|practice|venue)(_name)?$/i.test(k)) ?? null;
    const chosen = chooser ? String(values[chooser] ?? '').trim() : '';
    const fixed = !!chosen && chooserIsFixed(tool);
    const away = destination !== undefined || !!handoffFor(tool, values);
    // The destination's title, never its path; empty when its page record gives none.
    const leaving = destination || handoffFor(tool, values)?.label;
    const name = chosen || leaving || (away ? this._siteName() : this._pageName());
    // What the conversation already showed about them: their card from a search.
    const card = this._conversations
      .find((c) => c.id === this._activeId)
      ?.items.flatMap((it) => (it.kind === 'results' ? it.cards : []))
      .find((c) => c.title.toLowerCase() === name.toLowerCase());
    const sub = [fieldLabel(noun), card?.type && card.type !== 'Thing' ? fieldLabel(card.type) : '', card?.rating ? `★ ${card.rating}` : '']
      .filter(Boolean)
      .join(' · ');
    return {
      view: {
        variant: 'form',
        noun,
        identity: { name, sub },
        // Sent *to* someone only when the form names who: a page's title is where it is, not who reads it. A
        // form's own constant (the event a pass form is for) names what it is for: "Get passes for Low Light".
        sentence: fixed
          ? `${forSentence(noun, chosen)}${email ? ` The confirmation goes to ${email}.` : ''}`
          : `I'll send this ${noun} ${chosen ? `to ${chosen}` : 'for you'}.${email ? ` They'll reply to ${email}.` : ''}`,
        note: away
          ? fixed
            ? 'This form is on its own page. I’ll open it and send it from there.'
            : 'Their form is on its own page. I’ll open it and send it from there.'
          : undefined,
        sendLabel: 'Send',
      },
      hidden: new Set(chooser && chooser !== 'target' && chosen ? [chooser] : chooser === 'target' ? ['target'] : []),
      labels: {},
    };
  }

  /** The site's own name: what its titles end with ("Events | Wrenfield"), else its host. */
  private _siteName(): string {
    const parts = (typeof document === 'undefined' ? '' : document.title).split(/\s+[|—–·-]\s+/);
    const host = typeof location === 'undefined' ? '' : location.hostname.replace(/^www\./, '');
    return (parts.length > 1 ? parts[parts.length - 1].trim() : '') || host || 'this site';
  }

  /** The site's name for this page: its title, without the site's own name after it. */
  private _pageName(): string {
    const title = (typeof document === 'undefined' ? '' : document.title).split(/\s+[|—–·-]\s+/)[0].trim();
    return title || 'this page';
  }

  /** Read availability for a handoff card, and redraw it once known. */
  private async _refreshHandoffTargets(item: ActionItem): Promise<void> {
    const targets = await this._handoff?.targets().catch(() => []);
    for (const t of targets ?? []) this._handoffTargets.set(t.name, t);
    if (item.stage !== 'collect' && item.stage !== 'review') return;
    const values = Object.fromEntries(item.fields.map((f) => [f.name, f.value]));
    Object.assign(item, this._describeAction({ name: item.tool } as ModelContextToolInfo, values).view);
    this._paintAction(item);
  }

  /** What the live card's buttons do. */
  private _actionHandlers(): ActionHandlers {
    return {
      continue: (values) => {
        const live = this._live;
        if (!live) return;
        if (live.ask && !live.confirm) {
          live.ask.onComplete(values);
          return;
        }
        // Back from a change, or a card of the widget's own: review again, here.
        Object.assign(live.item, this._describeAction(live.tool, values, live.confirm?.destination).view);
        live.item.stage = 'review';
        this._paintAction(live.item);
        this._saveConversations();
      },
      change: () => {
        const live = this._live;
        if (!live) return;
        live.item.fields.forEach((f) => {
          if (f.group === 'needed' && f.value.trim() !== '') f.group = 'known';
        });
        live.sent = false;
        live.item.stage = 'collect';
        live.item.open = true;
        this._paintAction(live.item);
        this._saveConversations();
      },
      send: (values) => {
        const live = this._live;
        if (!live) return;
        live.sent = true;
        // What the visitor sends on a page's form is theirs: kept for this conversation's next form and agent.
        this._rememberDetails(this._active(), detailsFromFields(values));
        if (live.confirm) live.confirm.onSubmit(values);
        else if (live.run) void live.run(values);
      },
      decline: () => {
        const live = this._live;
        if (!live) return;
        live.declining = true;
        if (live.confirm) live.confirm.onCancel();
        else if (live.ask) live.ask.onCancel();
        // A card the harness is not waiting on declines itself.
        if (this._live === live) {
          live.item.stage = 'declined';
          this._paintAction(live.item);
          this._live = null;
          this._saveConversations();
        }
      },
    };
  }

  /** Draw a card where it was, or at the end of the thread. */
  private _paintAction(item: ActionItem): void {
    if (!this._els?.thread) return;
    const conv = this._active();
    if (!conv?.items.includes(item)) return;
    const live = this._live?.item === item;
    const fresh = actionCard(item, live ? this._actionHandlers() : null, () => this._saveConversations());
    const old = this._els.thread.querySelector(`[data-action="${CSS.escape(item.id)}"]`);
    if (old) old.replaceWith(fresh);
    else {
      this._clearEmpty();
      this._els.thread.appendChild(fresh);
      this._scroll();
    }
  }

  /** A request's steps, as its card shows them once sent. */
  private _actionFollows(item: ActionItem, all: AgentStep[]): void {
    const live = this._live?.item === item ? this._live : null;
    const failed = [...all].reverse().find((st) => st.status === 'failed');
    const done = all.some((st) => st.id === 'submit' && st.status === 'done');
    const running = ['navigate', 'arrive', 'collect', 'fill', 'submit'];
    item.steps = all
      .filter((st) => running.includes(st.id))
      .map((st): ActionStep => ({
        label:
          st.id === 'fill' && st.status === 'active' && item.variant === 'form'
            ? `Filling in the ${item.noun}`
            : st.id === 'submit' && st.status === 'done' && item.variant === 'form'
              ? 'Sent'
              : st.label,
        status: st.status === 'failed' ? 'failed' : st.status === 'done' ? 'done' : 'active',
      }));

    if (failed) {
      if (live?.declining || failed.label === 'Cancelled') {
        item.stage = 'declined';
        if (live) this._live = null;
      } else {
        item.stage = 'failed';
        item.message = failed.detail || failed.label;
      }
    } else if (done) {
      item.stage = 'done';
      if (live) this._live = null;
    } else if (item.stage === 'left' || (item.stage === 'working' && item.steps.length)) {
      item.stage = 'working';
    }
    this._paintAction(item);
  }

  /** The confirmed call is leaving for its page. The card says so, and the new page finishes it. */
  private _cardLeft(tool: ModelContextToolInfo, destination: string | null): void {
    const live = this._live;
    if (!live || live.tool.name !== tool.name) {
      const reads = !!tool.annotations?.readOnlyHint;
      this._appendMsg('assistant', destination ? `Opening ${destination}…` : reads ? 'Opening the results…' : 'Opening the page that can submit this…');
      return;
    }
    live.item.stage = 'left';
    // No name: the card already says who it is for, and a destination's name may be no more than its path.
    live.item.message = 'Opening the form’s own page to send it from there.';
    this._live = null;
    this._paintAction(live.item);
    this._saveConversations();
  }

  /** The form took it: the card becomes the receipt. False when no card is waiting on this tool. */
  private _cardDone(tool: ModelContextToolInfo, values: Record<string, unknown>, text: string): boolean {
    const conv = this._active();
    const id = currentJourney();
    const item = conv?.items.find((it): it is ActionItem => it.kind === 'action' && it.id === id && it.tool === tool.name);
    if (!item || this._classicPrompts) return false;
    const note = this._buildDetailItem(tool, values, text).note;
    // The default note says nothing the card's "Sent" does not.
    item.message = /submitted successfully/.test(note) ? undefined : note;
    item.stage = 'done';
    item.fields.forEach((f) => {
      if (values[f.name] !== undefined) f.value = String(values[f.name]);
    });
    if (this._live?.item === item) this._live = null;
    this._paintAction(item);
    this._saveConversations();
    return true;
  }

  /** It did not go through: the card says why and offers to change it. False when no card is waiting. */
  private _cardFailed(tool: ModelContextToolInfo, message: string): boolean {
    const live = this._live;
    if (!live || live.tool.name !== tool.name) return false;
    live.sent = false;
    live.item.stage = 'failed';
    live.item.message = message;
    this._paintAction(live.item);
    this._saveConversations();
    return true;
  }

  /**
   * After a page change: the card of the request that travelled, found by its
   * journey, now finished or asked about here.
   */
  private _resumedCard(journeyId: string | undefined): ActionItem | null {
    if (!journeyId || this._classicPrompts) return null;
    return this._active()?.items.find((it): it is ActionItem => it.kind === 'action' && it.id === journeyId) ?? null;
  }

  /** Let a resumed card be changed and sent again from this page, with the page's own tool. */
  private _reviveCard(item: ActionItem, tool: ModelContextToolInfo, values: Record<string, unknown>, needed: string[]): void {
    const slots = resolveSlots(toolSchema(tool), { modelArgs: values }).all;
    const hidden = new Set(item.fields.filter((f) => f.group === 'hidden').map((f) => f.name));
    item.fields = fieldsFromSlots(slots, values, { needed: new Set(needed), hidden });
    this._live = {
      item,
      tool,
      sent: false,
      declining: false,
      run: async (vals) => {
        item.stage = 'working';
        item.steps = [{ label: `Sending the ${item.noun}`, status: 'active' }];
        this._paintAction(item);
        try {
          const res = await this.toolSource.execTool(tool, tool.name, vals);
          const text = extractResult(res);
          if (res?.isError) {
            this._cardFailed(tool, text || 'That form did not accept the details.');
            return;
          }
          this._active()?.messages.push({
            role: 'user',
            content: `[${tool.name} submitted with: ${JSON.stringify(vals)}]. Keep these unless I ask to change them.`,
          });
          this._live = null;
          const note = this._buildDetailItem(tool, vals, text).note;
          item.message = /submitted successfully/.test(note) ? undefined : note;
          item.stage = 'done';
          item.steps = [];
          this._paintAction(item);
          this._saveConversations();
        } catch (err) {
          this._cardFailed(tool, String((err as Error)?.message || err));
        }
      },
    };
  }

  // ── Inline generated form (from JSON-Schema) ───────────────────────────────
  private _renderForm(tool: ModelContextToolInfo, args: Record<string, unknown>): void {
    if (this._useA2ui) {
      try {
        this._renderFormA2ui(tool, args);
        return;
      } catch (err) {
        // Never strand the user without a form; fall through to the DOM one.
        console.warn('[a2ui] form surface failed, using inline form', err);
      }
    }
    this._renderFormLegacy(tool, args);
  }

  /** The tool form as an A2UI surface rather than hand-built DOM. */
  private _renderFormA2ui(tool: ModelContextToolInfo, args: Record<string, unknown>): void {
    this._clearEmpty();
    this._tool = tool;

    const wrap = document.createElement('div');
    wrap.className = 'form a2ui a2ui-scope self-start w-full max-w-[420px]';
    const surfaceHost = document.createElement('div');
    // The status line stays outside the surface: reporting progress and errors
    // is the host's job, and the basic catalog has no component for it.
    const result = document.createElement('div');
    result.className = 'genform-result';
    wrap.append(surfaceHost, result);

    const messages = emitToolForm(
      tool.name,
      (tool.description || '').trim(),
      toolSchema(tool),
      args,
    );

    const mounted = mountSurface(surfaceHost, messages, (event: any) => {
      const name = event?.event?.name ?? event?.name;
      if (name === 'nxis.cancel') {
        this._cancelForm();
        return;
      }
      if (name !== 'nxis.submit') return;

      const values = (mounted?.read('form') ?? {}) as Record<string, unknown>;
      const missing = missingRequired(tool, values);
      if (missing.length) {
        this._showFormError(result, `Please fill in: ${missing.map((m) => humanize(m)).join(', ')}.`);
        this._setStatus('');
        return;
      }
      void this._submitValues(tool, values, result, () => { /* button state lives in the surface */ });
    });

    if (!mounted) throw new Error('no form surface produced');
    this._surfaces.push(mounted);

    if (this._formEl && this._formEl.isConnected) this._formEl.remove();
    this._els.thread.appendChild(wrap);
    this._formEl = wrap;
    this._scroll();
  }

  private _renderFormLegacy(tool: ModelContextToolInfo, args: Record<string, unknown>): void {
    this._clearEmpty();
    this._tool = tool;
    const schema = toolSchema(tool);
    const props = schema.properties || {};
    const required = new Set(schema.required || []);

    const fields = Object.entries(props)
      .map(([key, spec]) => {
        const id = `f_${key}`;
        const label = `${humanize(key)}${required.has(key) ? ' <span class="req">*</span>' : ''}`;
        return `<div class="field"><label for="${id}">${label}</label>${this._control(id, key, spec || {}, args[key])}</div>`;
      })
      .join('');

    const wrap = document.createElement('div');
    wrap.className = 'msg form';
    wrap.innerHTML = `
      <form class="genform" novalidate>
        <div class="genform-head">
          <div class="gf-tool">${escapeHtml(humanize(withoutSiteSuffix(tool.name)))}</div>
          <div class="gf-desc">${escapeHtml((tool.description || '').trim())}</div>
        </div>
        ${fields || '<p class="gf-empty">This tool takes no inputs.</p>'}
        <div class="genform-actions">
          <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">Submit ${ICON_ARROW}</button>
        </div>
        <div class="genform-result"></div>
      </form>`;

    if (this._formEl && this._formEl.isConnected) this._formEl.remove();
    this._els.thread.appendChild(wrap);
    this._formEl = wrap;

    const form = wrap.querySelector('.genform') as HTMLFormElement;
    form.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this._cancelForm());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submitForm(tool, form);
    });
    const clearInvalid = (e: Event) =>
      (e.target as HTMLElement).classList && (e.target as HTMLElement).classList.remove('invalid');
    form.addEventListener('input', clearInvalid);
    form.addEventListener('change', clearInvalid);
    this._scroll();
  }

  private _cancelForm(): void {
    if (this._formEl) this._formEl.remove();
    this._formEl = null;
    this._tool = null;
    this._appendMsg('assistant', 'Okay — cancelled. Tell me what you’d like to do.');
  }

  /** Build one input control from a property schema. */
  private _control(id: string, name: string, spec: JsonSchema, value: unknown): string {
    const enumVals = spec.enum || (spec.items && spec.items.enum);
    if (enumVals) {
      const opts = enumVals
        .map(
          (v) =>
            `<option value="${escapeHtml(String(v))}"${String(v) === String(value) ? ' selected' : ''}>${escapeHtml(humanize(String(v)))}</option>`,
        )
        .join('');
      return `<select id="${id}" data-name="${escapeHtml(name)}"><option value="">Select…</option>${opts}</select>`;
    }
    if (spec.type === 'boolean') {
      return `<label class="check"><input id="${id}" data-name="${escapeHtml(name)}" type="checkbox"${value ? ' checked' : ''}> Yes</label>`;
    }
    let type = 'text';
    if (spec.type === 'integer' || spec.type === 'number') type = 'number';
    else if (spec.format === 'date' || /\bdate\b/.test(name)) type = 'date';
    else if (/email/.test(name)) type = 'email';

    let val = value == null ? '' : String(value);
    if (type === 'date' && val) {
      const parts = val.split(/[\/\-]/);
      if (parts.length === 3 && parts[0].length <= 2) {
        let y = parts[2];
        if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
        val = `${y}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
      }
    }
    val = escapeHtml(val);

    return `<input id="${id}" data-name="${escapeHtml(name)}" type="${type}" value="${val}">`;
  }

  private _collect(form: HTMLElement): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    form.querySelectorAll('[data-name]').forEach((node) => {
      const el = node as HTMLInputElement | HTMLSelectElement;
      const name = (el as HTMLElement).dataset.name!;
      if ((el as HTMLInputElement).type === 'checkbox') {
        out[name] = (el as HTMLInputElement).checked;
        return;
      }
      const v = el.value;
      if (v !== '' && v != null) out[name] = (el as HTMLInputElement).type === 'number' ? Number(v) : v;
    });
    return out;
  }

  private async _submitForm(tool: ModelContextToolInfo, form: HTMLFormElement): Promise<void> {
    const result = form.querySelector('.genform-result') as HTMLElement;
    const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    const values = this._collect(form);

    // Highlighting the offending controls is specific to the DOM form; the
    // A2UI surface has no equivalent, so it stays here rather than in the
    // shared path below.
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    const missing = missingRequired(tool, values);
    if (missing.length) {
      missing.forEach((m) => {
        let ctrl: Element | null = null;
        try {
          ctrl = form.querySelector(`[data-name="${CSS.escape(m)}"]`);
        } catch {
          /* ignore */
        }
        if (ctrl) ctrl.classList.add('invalid');
      });
      this._showFormError(result, `Please fill in: ${missing.map((m) => humanize(m)).join(', ')}.`);
      this._setStatus('');
      return;
    }

    await this._submitValues(tool, values, result, (b) => (submitBtn.disabled = b));
  }

  private _showFormError(result: HTMLElement, msg: string): void {
    result.className = 'genform-result error';
    result.innerHTML = `${ICON_WARN}<span>${escapeHtml(msg)}</span>`;
  }

  /**
   * Everything after "we have valid values": run the tool, then swap the form
   * for a detail card or result cards.
   *
   * Shared by the DOM form and the A2UI surface, which differ only in how
   * values are collected and how invalid fields are flagged, so only that part
   * stays renderer-specific.
   */
  private async _submitValues(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
    result: HTMLElement,
    setBusy: (busy: boolean) => void,
  ): Promise<void> {
    const submitBtn = { set disabled(b: boolean) { setBusy(b); } } as { disabled: boolean };
    submitBtn.disabled = true;
    result.className = 'genform-result';
    result.textContent = 'Submitting…';
    // Read before the call: a registry may return only the response's text,
    // and the annotations already say whether this call leaves the page.
    const leaving = handoffFor(tool, values);
    try {
      this._setStatus(`Running ${tool.name}…`);
      const res = await this.toolSource.execTool(tool, tool.name, values);
      const isError = !!(res && res.isError);
      const text = extractResult(res);
      this._setStatus('');
      if (isError) {
        result.className = 'genform-result error';
        result.innerHTML = `${ICON_WARN}<span>${escapeHtml(text || 'Failed')}</span>`;
        submitBtn.disabled = false;
        return;
      }
      // A handoff started: what happens next arrives from the target, and the
      // controller's events draw it. There is nothing to show as "Submitted".
      const started = res?.structuredContent?.[HANDOFF_SESSION_RESULT] as { label?: string } | undefined;
      if (started) {
        this._dismissPrompt();
        this._active()?.messages.push({
          role: 'user',
          content: `[${tool.name}: the conversation was handed to ${started.label ?? 'another agent'}. Their replies go to the visitor directly.]`,
        });
        this._saveConversations();
        this._paintHandoffBar();
        return;
      }

      // A call that left for another page has filled in nothing yet, so it
      // must not become a "Submitted" card. The page it is opening finishes
      // the job and draws the card there.
      if (leaving || res?.structuredContent?.[HANDOFF_RESULT]) {
        this._dismissPrompt();
        // From what we know, not from the response: a registry may hand back
        // the whole response object as JSON.
        this._appendMsg(
          'assistant',
          leaving
            ? `Opening ${leaving.label} to submit this…`
            : 'Opening the page that can submit this…',
        );
        return;
      }

      // Success → the form transitions inline. A write tool (form/action)
      // becomes a "Submitted" detail card; a read-only tool (typed retrieval)
      // becomes result cards for the records it returned.
      const conv = this._active()!;
      const readOnly = !!(tool.annotations && tool.annotations.readOnlyHint);
      let item: ThreadItem;
      let card: HTMLElement;
      if (readOnly) {
        const results = this._buildResultsItem(tool, res);
        const summary = results.cards
          .map((c) => c.title)
          .filter(Boolean)
          .slice(0, 8)
          .join(', ');
        conv.messages.push({ role: 'user', content: `[${tool.name} returned]`, data: results.note + (summary ? ': ' + summary : '') });
        // Attribute the typed-retrieval cost to the round that proposed the call.
        const round = conv.metrics && conv.metrics[conv.metrics.length - 1];
        if (round) {
          round.toolCalls += 1;
          round.results += results.cards.length;
          round.toolResultTokens += await this.countTokens(text);
        }
        item = results;
        card = this._resultsEl(results);
      } else {
        conv.messages.push({
          role: 'user',
          content: `[${tool.name} submitted with: ${JSON.stringify(values)}]. Keep these unless I ask to change them.`,
        });
        const detail = this._buildDetailItem(tool, values, text);
        item = detail;
        card = this._detailEl(detail);
      }
      conv.items.push(item);
      if (this._formEl && this._formEl.isConnected) this._formEl.replaceWith(card);
      else this._els.thread.appendChild(card);
      this._formEl = null;
      this._tool = null;
      if (readOnly) this._upsertMetrics();
      this._saveConversations();
      this._scroll();
    } catch (e) {
      result.className = 'genform-result error';
      result.innerHTML = `${ICON_WARN}<span>${escapeHtml(String((e as Error).message || e))}</span>`;
      submitBtn.disabled = false;
    }
  }

  private _buildDetailItem(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
    resultText: string,
  ): Extract<ThreadItem, { kind: 'detail' }> {
    const schema = toolSchema(tool);
    const props = schema.properties || {};
    const order = [...Object.keys(props), ...Object.keys(values).filter((k) => !(k in props))];
    const rows: DetailRow[] = order
      .filter((k) => values[k] !== undefined && values[k] !== null && values[k] !== '')
      .map((k) => {
        const spec = props[k] || {};
        let v: unknown = values[k];
        if (spec.type === 'boolean' || typeof v === 'boolean') v = v ? 'Yes' : 'No';
        else if (spec.enum || (spec.items && spec.items.enum)) v = humanize(String(v));
        return { label: humanize(k), value: String(v) };
      });
    const note =
      resultText && !/^\s*[[{]/.test(resultText) ? resultText : 'Your details were submitted successfully.';
    return { kind: 'detail', title: humanize(withoutSiteSuffix(tool.name)), note, rows };
  }

  // ── Read-tool results → cards ──────────────────────────────────────────────
  /** Pull the array of records out of a tool response. The WebMCP polyfill's
   * result normalizer can drop `structuredContent`, so every source is tried:
   * structuredContent (object or JSON string) and each content text part, and
   * return the first that yields records. Shapes covered: query → results[],
   * list_types → types[], get → result{}, or a bare entity/array. */
  private _extractItems(res: ModelContextToolResponse | string | null): Record<string, unknown>[] {
    const items = extractRecords(res);
    if (!items.length) console.warn('[nxis] no items extracted from tool result', { res });
    return items;
  }

  /** The proxy copy's opening hours, read strictly once per copy; null without them. */
  private _ownerHours(): OpeningHours | null {
    const raw = this._g?.remote?.openingHours;
    if (raw !== this._ohRaw) this._oh = readOpeningHours((this._ohRaw = raw));
    return this._oh;
  }
  private _ohRaw?: unknown;
  private _oh: OpeningHours | null = null;

  /** Build a display card from a single record (a JSON-LD entity or a type row). */
  private _entityCard(record: Record<string, unknown>): ResultCard {
    // One shape whatever the server sent: expanded JSON-LD (`http://schema.org/name: [{"@value": …}]`) reads as
    // compact.
    const entity = compact(record);
    const str = (v: unknown) => (v == null ? '' : String(Array.isArray(v) ? v[0] : v));
    const title = entityLabel(entity);
    const arch = archetype(entity);
    // In words, never a schema.org name; none for site plumbing.
    const type = typeTag(entity) ?? '';

    // Positive outcome (rating) → green tag, per the color rules.
    let rating: string | undefined;
    const ar = entity.aggregateRating as Record<string, unknown> | undefined;
    if (ar && typeof ar === 'object' && ar.ratingValue != null) {
      const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(Number(ar.ratingValue) || 0))));
      rating = ar.reviewCount != null ? `${stars} ${str(ar.ratingValue)} · ${str(ar.reviewCount)}` : `${stars} ${str(ar.ratingValue)}`;
    }

    // The owner's opening hours, when the site's proxy sends them, for the business's own records (a place, not its
    // emergency service): its status reads them, in its zone, and its own round-the-clock hours aren't its hours.
    const owner = archetype(entity) === 'place' && !isEmergencyRecord(entity) ? this._ownerHours() : null;
    // 24/7 emergency service is only implied by round-the-clock opening hours.
    const hours = entity.openingHoursSpecification;
    const emergency =
      !owner &&
      Array.isArray(hours) &&
      hours.some(
        (h) =>
          h &&
          typeof h === 'object' &&
          String((h as Record<string, unknown>).opens) === '00:00' &&
          String((h as Record<string, unknown>).closes) === '23:59',
      );

    // One supporting line under the headline (feature-card pattern).
    const desc = str(entity.description).trim();
    const sub = desc ? (desc.length > 150 ? desc.slice(0, 147) + '…' : desc) : undefined;

    const rows: DetailRow[] = [];
    const push = (label: string, value: unknown, href?: string) => {
      const v = str(value).trim();
      if (v && rows.length < 4 && !rows.some((r) => r.label === label)) {
        rows.push({ label, value: v.length > 90 ? v.slice(0, 87) + '…' : v, ...(href ? { href } : {}) });
      }
    };

    const addr = entity.address as Record<string, unknown> | undefined;
    if (addr && typeof addr === 'object') {
      const parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).map(str);
      if (parts.length) push('Address', parts.join(', '));
    }

    // Preferred scalar fields, then any remaining scalars as a fallback.
    const preferred = ['telephone', 'email', 'url', 'count'];
    const seen = new Set(['name', 'title', 'headline', 'image', 'description', ...preferred]);
    for (const key of preferred) {
      const v = entity[key];
      if (typeof v === 'string' || typeof v === 'number') {
        const href = key === 'telephone' ? telHref(v) : undefined;
        push(humanize(key === 'url' ? 'website' : key), v, href);
      }
    }
    if (rows.length < 3) {
      for (const [k, v] of Object.entries(entity)) {
        if (k.startsWith('@') || seen.has(k)) continue;
        if (typeof v === 'string' || typeof v === 'number') push(humanize(k), v);
      }
    }

    const id = entity['@id'] != null ? str(entity['@id']) : undefined;
    const found = pageForEntity(entity, this._sitePages, location.origin);
    const page = found ? { url: found.url, label: found.name } : undefined;

    // What the answer view compares by, beyond the rating and hours its heading already shows.
    const facts = recordFacts(entity);
    const status = (owner ? hoursStatus(owner) : openStatus(entity)) ?? undefined;
    // A review's facts are its own: who wrote it and what they said, not the business's.
    const lines =
      arch === 'opinion'
        ? reviewFacts(entity)
        : [
            facts.services.length ? facts.services.slice(0, 3).map((x) => x.name).join(', ') : facts.knows.slice(0, 3).join(', '),
            facts.since ? `In business since ${facts.since}` : '',
            facts.reviews[0] ? `\u201c${facts.reviews[0].text}\u201d${facts.reviews[0].author ? ` \u2014 ${facts.reviews[0].author}` : ''}` : '',
          ].filter((l): l is string => !!l);
    const action = actionCta(entity, title);
    // Access is the consume action's when there is one (a paid episode's Listen carries its subscription), else the
    // first action's, as in the NxisAI app.
    const acc = access(entity, accessAction(entity));
    // Media opens places on the site (Listen, Subscribe) instead of asking: its row, a series' card, their buttons.
    let media = arch === 'media' ? mediaRow(entity) : undefined;
    let series = arch === 'series' ? seriesCard(entity) : undefined;
    let ctas = arch === 'media' || arch === 'series' ? cardCtas(entity) : undefined;
    // In-chat playback: a Listen that may play plays in the dock, its page kept as the fallback. A series' parts
    // carry no media, so "Listen to the latest" plays once its episode is fetched (_prefetchLatest).
    if (this._playOn() && (media || series)) {
      const play = playableOf(entity, { recordAccess: acc?.state });
      if (mayPlay(play, { unmarked: this._unmarked() })) {
        ctas = playCtas(ctas, play);
        if (media) media = { ...media, ctas: playCtas(media.ctas, play) };
      }
      const lead = series?.ctas?.lead;
      const latest = lead?.kind === 'open' && seriesParts(entity).find((p) => [p.potentialAction].flat().some((a) => targetUrl(a) === lead.url))?.['@id'];
      if (series?.ctas && typeof latest === 'string') series = { ...series, ctas: playLatestCtas(series.ctas, latest) };
    }
    const stars = arch === 'opinion' ? reviewStars(entity) : facts.rating;
    const about = arch === 'opinion' ? nameOf(entity.itemReviewed) : undefined;
    const author = arch === 'opinion' ? nameOf(entity.author) : undefined;
    const quote = arch === 'opinion' && typeof entity.reviewBody === 'string' ? entity.reviewBody.trim() || undefined : undefined;
    const line = byline(entity, arch);
    const kind = mediaKind(entity);
    const image = imageOf(entity);
    const figure = figureOf(entity);
    return {
      title,
      type,
      rating,
      emergency,
      sub,
      rows,
      id,
      ...(page ? { page } : {}),
      ...(stars !== undefined ? { stars } : {}),
      ...(arch !== 'opinion' && facts.reviewCount !== undefined ? { reviews: facts.reviewCount } : {}),
      ...(status ? { status: { open: status.open, label: status.label } } : {}),
      ...(facts.phone ? { phone: facts.phone } : {}),
      ...(action ? { action } : {}),
      archetype: arch,
      group: groupOf(arch),
      ...(line ? { byline: line } : {}),
      ...(acc ? { badge: acc.label } : {}),
      ...(acc?.state === 'preview' ? { preview: true } : {}),
      ...(about ? { about } : {}),
      ...(author ? { author } : {}),
      ...(quote ? { quote } : {}),
      ...(media ? { media } : {}),
      ...(series ? { series } : {}),
      ...(ctas ? { ctas } : {}),
      ...(kind ? { kind } : {}),
      ...(image ? { image } : {}),
      ...(figure ? { figure } : {}),
      ...(arch === 'happening' ? { event: entity } : {}),
      facts: lines,
    };
  }

  private _buildResultsItem(
    tool: ModelContextToolInfo,
    res: ModelContextToolResponse,
    pick?: ResultPick,
  ): Extract<ThreadItem, { kind: 'results' }> {
    const items = this._extractItems(res);
    const title = humanize(withoutSiteSuffix(tool.name));
    // Site plumbing (breadcrumbs, the website, a picture) isn't drawn beside the things it came with.
    const things = pick ? items : items.filter((e) => !isTechnicalRecord(compact(e)));
    // One business once: records of one name, type and address are one row (a pick moves to the row it is in).
    const all = things.length ? things : items;
    const once = onceEach(all.map((e) => compact(e)));
    const shown = once.keep.map((i) => all[i]).slice(0, 12);
    if (pick) pick = { ...pick, index: once.at[pick.index] ?? pick.index };
    let cards = shown.map((e) => this._entityCard(e));
    // An emergency: the first call a card offers is the emergency line, never the main one.
    if (!pick && isEmergency(this._turnGoal)) cards = emergencyFirst(cards, shown.map((e) => compact(e)));
    for (const c of cards) {
      const lead = c.series?.ctas?.lead;
      if (lead?.kind === 'play' && !lead.media) void this._prefetchLatest(lead);
    }
    const note = !cards.length
      ? 'No results found.'
      : `${cards.length} result${cards.length === 1 ? '' : 's'}`;
    // An event's Add to calendar opens the file the server its records came from builds.
    const calendar = this._calendar && this._remoteTools.has(tool.name) && cards.some((c) => c.event) ? this._calendar : undefined;
    return { kind: 'results', title, note, cards, ...(pick && pick.index < cards.length ? { pick } : {}), ...(calendar ? { calendar } : {}) };
  }

  /**
   * Results as an answer: the recommended pick with its reasons and the others
   * to compare, or a short list that opens per result. Records of things
   * only: a listing of types or counts keeps the plain cards.
   */
  private _answerEl(item: Extract<ThreadItem, { kind: 'results' }>): HTMLElement | null {
    // Records of things: a pick, or at least one result with a rating, hours, a phone or a page, or a type the
    // renderer draws. A sparse record beside them (an index entry with only a name) still shows, by name.
    const things = item.cards.filter((c) => c.stars !== undefined || c.status || c.phone || c.page || (c.archetype && c.archetype !== 'thing'));
    if (!item.pick && !things.length) return null;
    const cards: AnswerCard[] = item.cards.map((c) => {
      // The record's own action first: the same map and prompt as the Typed Retrieval skill and the NxisAI
      // app. A record that states none falls back to a form found on this page for it.
      // A review is no business: no page form is its own.
      const form = c.action || c.ctas || c.archetype === 'opinion' ? undefined : formsFor(c.title)[0];
      const quote = form && /quote/.test(form.noun);
      return {
        title: c.title,
        stars: c.stars,
        reviews: c.reviews,
        status: c.status,
        phone: c.phone,
        page: c.page,
        facts: c.facts ?? [],
        archetype: c.archetype,
        group: c.group,
        byline: c.byline,
        badge: c.badge,
        preview: c.preview,
        about: c.about,
        author: c.author,
        quote: c.quote,
        ...(c.media ? { media: c.media } : {}),
        ...(c.series ? { series: c.series } : {}),
        ...(c.ctas ? { ctas: c.ctas } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
        ...(c.image ? { image: c.image } : {}),
        ...(c.figure ? { figure: c.figure } : {}),
        ...(c.action
          ? { form: { label: c.action.label, message: c.action.message } }
          : form
          ? {
              form: quote
                ? { label: 'Get a quote', message: `Get a quote from ${c.title}` }
                : { label: `Use their ${form.noun}`, message: `Start the ${form.noun} for ${c.title}` },
            }
          : {}),
      };
    });
    // Events draw once their module is here; until then (the first time only), as any other card.
    const hasEvents = item.cards.some((c) => c.event);
    const m = hasEvents ? this._events : undefined;
    const ev = m?.answerEvents(this.shadowRoot!, cards, item.cards.map((c) => c.event), item.pick, item.calendar, this._eventHost());
    const el = resultsAnswer(ev?.cards ?? cards, ev ? ev.pick : item.pick, {
      ...ev?.handlers,
      ask: (text) => {
        if (this._turnActive) return;
        this._els.input.value = text;
        void this._onSend();
      },
      // Listen or Subscribe on another page of this site: the conversation continues there, as "Open page" does.
      visit: (url, name) => {
        savePendingVisit({ pageUrl: url, label: name, conversationId: this._activeId ?? undefined });
      },
      // Counted as the NxisAI app counts it: page_open, with the action's type, @id and the site's token.
      opened: (b, way) => reportPageOpen(b, { leaving: way === 'same-site' }),
      canPlay: (b) => this._canPlay(b),
      play: (b, name) => this._mediaTap(b, name),
      warm: () => void this._loadMedia().catch(() => {}),
    });
    if (hasEvents && !m) this._loadEvents().then(() => el.isConnected && el.replaceWith(this._resultsEl(item)), () => {});
    return el;
  }

  /** The event cards' module, loaded with the first result that is an event. See ./event-cards.ts. */
  private _events?: typeof import('./event-cards.js');
  private _eventsLoad?: Promise<unknown>;
  private _loadEvents(): Promise<unknown> {
    return (this._eventsLoad ??= import('./event-cards.js').then(
      (m) => (this._events = m),
      (err) => {
        this._eventsLoad = undefined;
        throw err;
      },
    ));
  }

  /** What an event's buttons ask of the element: start a form here, go to a page, open a file beside this one. */
  private _eventHost(): EventHost {
    return {
      openForm: (actionId) => {
        this._open();
        void this._openForm({ actionId });
      },
      go: (url, name) => this._go(url, name),
      beside: (url) => void (this._g?.nav(url) && window.open(url, '_blank', 'noopener,noreferrer')),
      openWay: (url) => openWay(url),
      samePage,
      handoffUrl,
      report: reportPageOpen,
      remember: rememberReportToken,
      here: () => location.href,
    };
  }

  /** Feature-card pattern: tinted icon chip, tags, tight Manrope headline, one
   * supporting line, then mono-labelled detail rows. */
  /**
   * ResultCard → A2UI card data.
   *
   * Three things do not survive the trip, all catalog limits rather than
   * mapping choices: the tag colours (basic Text has no tone), the tel: links
   * on rows (no link component), and the @id line. They are dropped here
   * rather than faked so the difference is visible when comparing renderers.
   */
  private _toA2uiCards(cards: ResultCard[]): ResultCardData[] {
    return cards.map((c) => ({
      title: c.title,
      sub: c.sub ?? '',
      tags: [
        ...(c.type ? [{ label: c.type }] : []),
        ...(c.rating ? [{ label: c.rating }] : []),
        ...(c.emergency ? [{ label: '24/7' }] : []),
      ],
      rows: c.rows.map((r) => ({ label: r.label, value: r.value })),
      images: c.image ? [{ url: c.image, alt: c.title }] : [],
      actions: c.action ? [c.action] : [],
    }));
  }

  /** Results rendered through A2UI instead of the bespoke card markup. */
  private _resultsElA2ui(item: Extract<ThreadItem, { kind: 'results' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'results a2ui a2ui-scope self-stretch w-full';
    if (!item.cards.length) {
      wrap.innerHTML = `<div class="rc-empty">${escapeHtml(item.note)}</div>`;
      return wrap;
    }
    try {
      // A lone series that lists its parts draws as its card; episodes as rows; anything else, or a mix, as cards.
      const lone = item.cards.length === 1 ? item.cards[0].series : undefined;
      const figure = item.cards.length === 1 ? item.cards[0].figure : undefined;
      const episodes = item.cards.every((c) => c.media && !c.figure) ? item.cards.map((c) => c.media!) : undefined;
      const canPlay: CanPlay | undefined = this._playOn() ? (b) => this._canPlay(b) : undefined;
      // Events, once their module is here: a lone one as its card, several as rows. Until then, as cards.
      const all = item.cards.every((c) => c.event);
      if (all && !this._events) this._loadEvents().then(() => wrap.isConnected && wrap.replaceWith(this._resultsElA2ui(item)), () => {});
      const events = all ? this._events?.eventSurface(item.note, item.cards.map((c) => c.event!), item.calendar, this._eventHost()) : undefined;
      const messages = events
        ? events.messages
        : lone
        ? emitSeriesSurface(lone, 'results', canPlay)
        : figure
        ? emitFigureSurface(item.cards[0].title, figure, item.cards[0].ctas)
        : episodes
        ? emitMediaSurface(item.note, episodes, 'results', canPlay)
        : emitCardsSurface(item.note, this._toA2uiCards(item.cards));
      let mounted: MountedSurface | null = null;
      mounted = mountSurface(wrap, messages, (event: any) => {
        const name = event?.event?.name ?? event?.name ?? '';
        const ctx = (event?.event?.context ?? event?.context ?? {}) as Record<string, unknown>;
        // A card's action button: send its message as the visitor, as the inline card does.
        if (name === 'nxis.ask' && typeof ctx.message === 'string' && !this._turnActive) {
          this._els.input.value = ctx.message;
          void this._onSend();
        }
        // Listen, Subscribe or "Their page": go there, keeping the conversation (see harness/tools/open-target.ts).
        // A play button (media="play"): play it in the dock, inside the tap; one that can't opens its page.
        const play = name === 'nxis.play' && typeof ctx.mediaId === 'string' && ctx.mediaId ? playButtonFor(ctasOf(item.cards), ctx.mediaId) : undefined;
        if (play) return this._mediaTap(play, typeof ctx.name === 'string' ? ctx.name : '');
        if ((name === 'nxis.open' || name === 'nxis.play') && typeof ctx.url === 'string' && /^https?:\/\//i.test(ctx.url)) {
          const actionId = typeof ctx.actionId === 'string' ? ctx.actionId : '';
          reportPageOpen(
            { actionType: typeof ctx.actionType === 'string' ? ctx.actionType : undefined, actionId, reportToken: tokenFor(item.cards, actionId) },
            { leaving: openWay(ctx.url) === 'same-site' },
          );
          this._go(ctx.url, typeof ctx.name === 'string' ? ctx.name : '');
        }
        // An event's button: its ticket form started or handed to, else opened as any other.
        if (name === 'nxis.event') events?.tap(ctx);
        // "Show all episodes": the rows the surface holds, in place of the few shown.
        if (name === 'nxis.more' && mounted) mounted.send(showAllMessages('results', mounted.read));
      });
      if (!mounted) throw new Error('no surface produced');
      this._surfaces.push(mounted);
    } catch (err) {
      // A renderer failure must not take the conversation with it.
      console.warn('[a2ui] results surface failed, using inline cards', err);
      return this._resultsElLegacy(item);
    }
    return wrap;
  }

  // ── In-chat playback (media="play") ─────────────────────────────────────────────────────────────────────────

  /** `media="play"`: Listen and Watch play in the docked player. The default, and `media="open"`, open the page. */
  private _playOn(): boolean {
    return this.getAttribute('media') === 'play';
  }

  /** `media-play="unmarked"`: records that say nothing about access play too. */
  private _unmarked(): boolean {
    return this.getAttribute('media-play') === 'unmarked';
  }

  /** Whether a play button plays now: the gate again (a saved card may be older than its access, or its host
   * blocked since). "Listen to the latest" plays while its episode is still being fetched, and opens it if the tap
   * comes first. */
  private _canPlay(b: PlayAction): boolean {
    const m = b.media ?? this._latest.get(b.mediaId);
    return this._playOn() && (m ? mayPlay(m, { unmarked: this._unmarked() }) : !b.media);
  }

  /** The player, loaded once, on demand: nothing of it is downloaded before a Play button is pointed at or tapped. */
  private _loadMedia(): Promise<typeof import('../media/index.js')> {
    return (this._mediaLoad ??= import('../media/index.js').catch((err) => {
      this._mediaLoad = null;
      throw err;
    }));
  }

  /**
   * A tap on a play button. `play()` runs here, synchronously, inside the tap: on the first one on our own element
   * (the player module adopts it when it arrives), after that through the player. Anything that can't play (the gate
   * says no, no file this browser can play, the module won't load) opens the page instead.
   */
  private _mediaTap(b: PlayAction, name: string): void {
    const m = b.media ?? this._latest.get(b.mediaId);
    const open = (): void => {
      if (!b.fallback) return;
      reportPageOpen(b.fallback, { leaving: openWay(b.fallback.url) === 'same-site' });
      this._go(b.fallback.url, name);
    };
    if (!mayPlay(m, { unmarked: this._unmarked() })) return open();
    if (this._media) {
      if (!this._media.toggle(m)) open();
      return;
    }
    // The first file this browser can play (HLS only where it is native); the player adds the rest of it.
    const el = (this._mediaEl ??= document.createElement('video'));
    const src = m.sources.find((s) => !s.type || el.canPlayType(s.type) !== '');
    if (!src) return open();
    el.preload = 'none';
    el.setAttribute('playsinline', '');
    el.src = src.src;
    // Before the metadata, this is where playback starts. The player sets it again once that is in.
    if (m.start) el.currentTime = m.start;
    if (m.kind === 'video' && m.poster) el.poster = m.poster;
    const started = el.play();
    started?.catch(() => {});
    this._mediaNow = { id: m.id, playing: true };
    this._syncPlay();
    this._loadMedia().then(
      (mod) => {
        this._media ??= new mod.MediaController(
          {
            root: this.shadowRoot!,
            before: this._els.status,
            launcher: this._els.launcher,
            events: this,
            onState: (s) => {
              this._mediaNow = s;
              this._syncPlay();
            },
            // Its host is blocked for the session now: redrawn, its buttons are links to the page again.
            onBlocked: () => this._renderThread(),
            onFirstPlay: (item) => reportPageOpen(item),
          },
          el,
        );
        this._media.adopt(m, started);
      },
      () => {
        el.pause();
        this._mediaNow = { id: null, playing: false };
        this._syncPlay();
        open();
      },
    );
  }

  /** Every play button in the thread, and every A2UI surface's, says whether its item is the one playing. */
  private _syncPlay(): void {
    const { id, playing } = this._mediaNow;
    syncPlayButtons(this._els.thread, id, playing);
    for (const s of this._surfaces) {
      const msgs = pressMessages('results', s.read, id, playing);
      if (msgs.length) s.send(msgs);
    }
  }

  /** "Listen to the latest": its episode, fetched once as the series' card is drawn (`nxis_get`), since a series'
   * parts carry no media. Kept on the button, so the card plays it from then on, saved conversation included. */
  private async _prefetchLatest(b: PlayAction): Promise<void> {
    if (this._latest.has(b.mediaId)) return void (b.media = this._latest.get(b.mediaId));
    try {
      // As the harness calls any tool: the registered tool object first, since a spec registry refuses a name.
      const mc = this.toolSource?.modelContext();
      if (!mc) return;
      const tool = (await mc.getTools()).find((t) => t.name === 'nxis_get') ?? null;
      const res = await executeRegistered(mc, tool, 'nxis_get', { id: b.mediaId });
      const rec = extractRecords(res)[0];
      if (!rec) return;
      const e = compact(rec);
      const m = playableOf(e, { recordAccess: access(e, accessAction(e))?.state });
      if (!mayPlay(m, { unmarked: this._unmarked() })) return;
      const f = b.fallback;
      b.media = { ...m, id: b.mediaId, ...(f?.actionType ? { actionType: f.actionType } : {}), ...(f?.actionId ? { actionId: f.actionId } : {}), ...(f?.reportToken ? { reportToken: f.reportToken } : {}) };
      this._latest.set(b.mediaId, b.media);
      this._saveConversations();
    } catch {
      // Unfetched, it opens the episode's page, as it did before.
    }
  }

  /**
   * Typed-retrieval results.
   *
   * Drawn as DOM, for the same reason the review card is: the house result card
   * has a tinted logo chip, blue and green pill tags, a Manrope headline and
   * tel: links on its rows, and none of that is expressible in A2UI's basic
   * catalog. Each component nests its own shadow root, so only the global
   * --a2ui-* properties reach inside, and they are per component type, so there
   * is no way to say "this tag is a rating" from out here.
   *
   * emitCardsSurface remains in a2ui/cards.ts for renderers that want the
   * surface; a2ui="a2ui-results" opts this element back into it for comparison.
   */
  private _resultsEl(item: Extract<ThreadItem, { kind: 'results' }>): HTMLElement {
    // New play buttons say whether theirs is the item playing, once they are in the thread.
    if (this._mediaNow.id) queueMicrotask(() => this._syncPlay());
    if (this.getAttribute('a2ui') === 'a2ui-results') return this._resultsElA2ui(item);
    if (!this._classicPrompts && item.cards.length) {
      const answer = this._answerEl(item);
      if (answer) return answer;
    }
    return this._resultsElLegacy(item);
  }

  private _resultsElLegacy(item: Extract<ThreadItem, { kind: 'results' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'msg results';
    if (!item.cards.length) {
      wrap.innerHTML = `<div class="rc-empty">${escapeHtml(item.note)}</div>`;
      return wrap;
    }
    const cardsHtml = item.cards
      .map((c) => {
        const rows = c.rows
          .map(
            (r) =>
              `<div class="rc-row"><dt title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</dt>` +
              `<dd title="${escapeHtml(r.value)}">${
                r.href ? `<a href="${escapeHtml(r.href)}">${escapeHtml(r.value)}</a>` : escapeHtml(r.value)
              }</dd></div>`,
          )
          .join('');
        const tags =
          (c.type ? `<span class="tag blue"><i class="dot"></i>${escapeHtml(c.type)}</span>` : '') +
          (c.rating ? `<span class="tag green"><i class="dot"></i>${escapeHtml(c.rating)}</span>` : '') +
          (c.emergency ? `<span class="tag green"><i class="dot"></i>24/7</span>` : '');
        return `<div class="resultcard">
          <div class="rc-top">
            <div class="rc-chip">${this._logoMarkup()}</div>
            <div class="rc-tags">${tags}</div>
          </div>
          <div class="rc-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
          ${c.sub ? `<div class="rc-sub" title="${escapeHtml(c.sub)}">${escapeHtml(c.sub)}</div>` : ''}
          ${rows ? `<dl class="rc-list">${rows}</dl>` : ''}
          ${c.id ? `<div class="rc-id"><code>${escapeHtml(c.id)}</code></div>` : ''}
          ${
            c.page
              ? `<a class="rc-open" href="${escapeHtml(c.page.url)}" data-label="${escapeHtml(c.page.label)}" ` +
                `title="${escapeHtml(c.page.url)}">Open page<span aria-hidden="true">→</span></a>`
              : ''
          }
        </div>`;
      })
      .join('');
    wrap.innerHTML = `<div class="rc-head">${escapeHtml(item.note)}</div><div class="rc-cards">${cardsHtml}</div>`;
    // An ordinary link, so it opens in a new tab when asked to. Followed in
    // this one, the conversation goes with it.
    wrap.addEventListener('click', (e) => {
      const link = (e.target as Element).closest<HTMLAnchorElement>('a.rc-open');
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      savePendingVisit({ pageUrl: link.href, label: link.dataset.label ?? '', conversationId: this._activeId ?? undefined });
    });
    return wrap;
  }

  // ── Metrics panel (real Gemma tokenizer counts vs a RAG estimate) ──────────
  /** Keep one 'metrics' thread item, always at the end of the thread. */
  private _upsertMetrics(): void {
    // The comparison needs a tokenizer. A provider that cannot count would
    // render every figure as zero, which would read as a measurement.
    if (!this.provider?.countTokens) return;
    const conv = this._active();
    if (!conv || !conv.metrics || !conv.metrics.length) return;
    const idx = conv.items.findIndex((it) => it.kind === 'metrics');
    if (idx !== -1) conv.items.splice(idx, 1);
    const item: Extract<ThreadItem, { kind: 'metrics' }> = { kind: 'metrics', rounds: conv.metrics };
    conv.items.push(item);
    const existing = this._els.thread.querySelector('.msg.metrics');
    if (existing) existing.remove();
    this._els.thread.appendChild(this._metricsEl(item));
  }

  private _metricsEl(item: Extract<ThreadItem, { kind: 'metrics' }>): HTMLElement {
    const rounds = item.rounds;
    const totalInput = rounds.reduce((s, m) => s + m.promptTokens, 0);
    const totalOutput = rounds.reduce((s, m) => s + m.outputTokens, 0);
    const totalToolCalls = rounds.reduce((s, m) => s + m.toolCalls, 0);
    const totalToolTokens = rounds.reduce((s, m) => s + m.toolResultTokens, 0);
    const mcpTotal = totalInput + totalOutput;

    const { ragInput, ragOutput, numResults } = estimateRagTokens(rounds);
    const ragTotal = ragInput + ragOutput;
    const maxTotal = Math.max(mcpTotal, ragTotal, 1);
    const savings = ragTotal > 0 ? ((ragTotal - mcpTotal) / ragTotal) * 100 : 0;

    const rows = rounds
      .map(
        (m) =>
          `<tr><td>Round ${m.round}</td><td class="num">${fmt(m.promptTokens)}</td><td class="num">${fmt(m.outputTokens)}</td><td class="num">${m.toolCalls}</td><td class="num">${fmt(m.toolResultTokens)}</td></tr>`,
      )
      .join('');

    const bar = (label: string, value: number, cls: string) =>
      `<div class="mx-bar-row"><span class="mx-bar-label">${label}</span><div class="mx-bar-track"><i class="${cls}" style="width:${((value / maxTotal) * 100).toFixed(1)}%"></i></div><span class="mx-bar-value">${fmt(value)}</span></div>`;

    const badge =
      Math.abs(savings) > 1
        ? `<div class="mx-savings ${savings > 0 ? 'pos' : 'neg'}">${
            savings > 0
              ? `↓ ${savings.toFixed(0)}% fewer tokens with typed retrieval`
              : `↑ ${Math.abs(savings).toFixed(0)}% more — multi-round context accumulation adds overhead`
          }</div>`
        : '';

    const el = document.createElement('div');
    el.className = 'msg metrics';
    el.innerHTML = `
      <details class="metricscard">
        <summary>⚡ ${fmt(mcpTotal)} tokens · ${rounds.length} round${rounds.length === 1 ? '' : 's'} · ${totalToolCalls} tool call${totalToolCalls === 1 ? '' : 's'}</summary>
        <table class="mx-table">
          <thead><tr><th>Round</th><th class="num">Input</th><th class="num">Output</th><th class="num">Tools</th><th class="num">Tool tokens</th></tr></thead>
          <tbody>${rows}<tr class="total"><td>Total</td><td class="num">${fmt(totalInput)}</td><td class="num">${fmt(totalOutput)}</td><td class="num">${totalToolCalls}</td><td class="num">${fmt(totalToolTokens)}</td></tr></tbody>
        </table>
        <div class="mx-compare">
          <div class="mx-compare-title">Typed Agent vs Traditional RAG</div>
          ${bar('Typed', mcpTotal, 'mcp')}
          ${bar('RAG est.', ragTotal, 'rag')}
          ${badge}
          <div class="mx-note">RAG estimate: ${numResults} result${numResults === 1 ? '' : 's'} × ${CHUNKS_PER_RESULT} HTML chunks × ${AVG_HTML_CHUNK_TOKENS} tokens, on the same base prompt. Token counts are real, measured by the on-device Gemma tokenizer.</div>
        </div>
      </details>`;
    return el;
  }

  // ── Preferences (programmatic) ─────────────────────────────────────────────
  /**
   * Stored values the agent may use to fill forms.
   *
   * Supplied by the host page, which usually knows them already, so a signed-in
   * visitor is not asked to re-enter their own details.
   *
   * Session-scoped by default. Persistence is opt-in, since these values are
   * personal data and the element offers no UI for a visitor to review or clear
   * what a page has stored. Set `persist = true` to keep them across reloads.
   *
   * @example
   * ```ts
   * const agent = document.querySelector('nxis-agent');
   * agent.preferences.set({ name: 'Jane Doe', email: 'jane@example.com' });
   * agent.preferences.set('phone', '555-0100');
   * agent.preferences.persist = true;   // survive reloads
   * agent.preferences.clear();          // forget everything
   * ```
   */
  get preferences(): AgentPreferences {
    return this._prefsApi;
  }

  /**
   * The system prompt.
   *
   * Set it before the element connects, or call `reset()` afterwards. Two
   * instructions in {@link DEFAULT_SYSTEM_PROMPT} change how the harness
   * behaves rather than only how the model reads; see its documentation before
   * replacing them.
   */
  get systemPrompt(): string {
    return this._systemPrompt;
  }
  set systemPrompt(prompt: string) {
    this._systemPrompt = prompt;
    // The engine holds the prompt, so a change after connect needs it rebuilt.
    if (this.provider) this._systemPrompt = prompt;
  }

  /**
   * The line shown above the suggestion chips before a conversation starts.
   *
   * Only the host knows what this agent can actually do, so the default
   * describes the mechanism rather than the subject. Set it to say what is
   * available here.
   */
  get emptyState(): string {
    return this._emptyState;
  }
  set emptyState(text: string) {
    this._emptyState = text;
    if (this._els?.thread) this._renderThread();
  }

  /**
   * The agent's name, used in the header, the launcher's tooltip and the accessible
   * name of both the launcher and the dialog.
   *
   * "Nxis Agent" is a placeholder standing in for a name the host has not
   * chosen yet. On a customer's own site the agent is theirs, and it should
   * introduce itself as theirs.
   */
  get name(): string {
    return this._name;
  }
  set name(value: string) {
    this._name = value || DEFAULT_AGENT_NAME;
    this._applyIdentity();
  }

  /**
   * The mark on the launcher, in the headers, above the empty state and on
   * result cards. Inline SVG markup, or the URL of an image.
   *
   * Markup is injected as written, so pass only your own, never anything a
   * visitor can influence. The footer's "Powered by NxisAI" badge is not
   * affected by this.
   */
  get logo(): string {
    return this._logo;
  }
  set logo(value: string) {
    this._logo = value || DEFAULT_LOGO;
    this._applyIdentity();
    if (this._els?.thread) this._renderThread();
  }

  /**
   * Brand overrides, as custom properties on the host element.
   *
   * Merged over the defaults, not replacing them, so a theme can set one
   * colour and leave the rest of the system alone. Assigning writes inline
   * styles, which outrank a stylesheet rule targeting this element, so theme
   * here or in CSS, but not both.
   */
  get theme(): AgentTheme {
    return { ...this._theme };
  }
  set theme(next: AgentTheme) {
    this._theme = { ...next };
    this._applyTheme();
  }

  /** Empty-state chips. Set to [] to show none. */
  get suggestions(): string[] {
    return [...this._suggestions];
  }
  set suggestions(next: string[]) {
    this._suggestions = [...next];
    if (this._els?.thread) this._renderThread();
  }

  private _loadProfile(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null') || {};
    } catch {
      return {};
    }
  }

  /** Persist only when asked; otherwise leave storage untouched. */
  private _persistProfile(): void {
    if (!this._persistPrefs) return;
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(this._profile));
    } catch {
      /* storage blocked/full */
    }
  }

  /**
   * Take new values and let the rest of the agent notice.
   *
   * Two things depend on this: the system message carries the values so the
   * model can use them in prose, and the harness reads them as a slot source
   * so a field the host already supplied is never asked for.
   */
  private _applyPreferences(next: Record<string, string>): void {
    this._profile = next;
    this._persistProfile();
    this._syncProfileContext();
    this._saveConversations();
    this.dispatchEvent(
      new CustomEvent('nxis-preferences-change', {
        detail: { preferences: { ...next } },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _buildPreferencesApi(): AgentPreferences {
    const self = this;
    return {
      get persist() {
        return self._persistPrefs;
      },
      set persist(on: boolean) {
        self._persistPrefs = on;
        if (on) self._persistProfile();
        else {
          try {
            localStorage.removeItem(PROFILE_KEY);
          } catch {
            /* storage blocked */
          }
        }
      },
      // Overloaded in the interface; implemented as one function, so the
      // implementation signature is widened and the cast narrows it back.
      get: ((key?: string) =>
        key === undefined ? { ...self._profile } : self._profile[key]) as AgentPreferences['get'],
      set: ((keyOrValues: string | Record<string, string>, value?: string) => {
        const patch =
          typeof keyOrValues === 'string' ? { [keyOrValues]: value ?? '' } : keyOrValues;
        const next = { ...self._profile };
        for (const [k, v] of Object.entries(patch)) {
          const trimmed = String(v ?? '').trim();
          // An empty value clears rather than storing "", so set(k, '') and
          // clear(k) mean the same thing instead of quietly differing.
          if (trimmed) next[k] = trimmed;
          else delete next[k];
        }
        self._applyPreferences(next);
      }) as AgentPreferences['set'],
      clear(key?: string) {
        if (key === undefined) {
          self._applyPreferences({});
          try {
            localStorage.removeItem(PROFILE_KEY);
          } catch {
            /* storage blocked */
          }
          return;
        }
        const next = { ...self._profile };
        delete next[key];
        self._applyPreferences(next);
      },
      /** The keys the agent knows how to map onto form fields. */
      keys(): string[] {
        return Object.keys(PROFILE_ALIASES);
      },
    };
  }

  /**
   * The profile the agent reads: the host's preferences, with the active conversation's details (what the visitor
   * typed or confirmed in it) over them.
   */
  private _profileNow(conv: Conversation | null = this._active()): Record<string, string> {
    return { ...this._profile, ...(conv?.details ?? {}) };
  }

  /**
   * Keep details the visitor typed or confirmed, with the conversation they belong to: the next form, and the next
   * agent handed the conversation, start with them. Nothing changes for a blank value.
   */
  private _rememberDetails(conv: Conversation | null | undefined, patch: Record<string, string>): void {
    if (!conv) return;
    const next = mergeDetails(conv.details, patch);
    if (!next) return;
    conv.details = next;
    if (conv.id === this._activeId) this._syncProfileContext();
    this._saveConversations();
  }

  /** "Not you? Clear details": the conversation's details are gone; the host's preferences stay the host's. */
  private _forgetDetails(conv: Conversation | null | undefined): void {
    if (!conv?.details) return;
    delete conv.details;
    if (conv.id === this._activeId) this._syncProfileContext();
    this._saveConversations();
  }

  /** Map the saved profile onto a tool's schema property names. */
  private _profileForSchema(schema: JsonSchema): Record<string, string> {
    const props = schema && schema.properties ? Object.keys(schema.properties) : [];
    if (!props.length) return {};
    const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const out: Record<string, string> = {};
    for (const [pf, val] of Object.entries(this._profileNow())) {
      if (!val || !String(val).trim()) continue;
      const cands = (PROFILE_ALIASES[pf] || [pf]).map(norm);
      // A near match never takes a field that is exactly another detail's (`email_address` is the email's).
      const match =
        props.find((p) => cands.includes(norm(p))) ||
        props.find((p) => { const d = detailOf(p); return (!d || d === pf) && cands.some((c) => norm(p).includes(c) || c.includes(norm(p))); });
      if (match && out[match] === undefined) out[match] = val;
    }
    return out;
  }

  /**
   * Fold the current profile into the active conversation's system message: as its `data`, which the model reads
   * in a data block, never as instructions (the values are the visitor's, and could say anything).
   */
  private _syncProfileContext(): void {
    const conv = this._active();
    if (!conv || !conv.messages[0]) return;
    const data = Object.entries(this._profileNow(conv))
      .filter(([, v]) => v && String(v).trim())
      .map(([k, v]) => `${humanize(k)}: ${v}`)
      .join('\n');
    const formatReq =
      '\n\nFor fields that require a specific format (such as dates), explicitly inform the user of the required format (e.g., mm/dd/yyyy).';
    conv.messages[0] = { role: 'system', content: this._systemPrompt + formatReq, data };
  }

  /**
   * Load the guardrails, at the first open or send. Every agent here shares one runtime, built for this element: it
   * reads `guardrails` (the property, then the attribute) live, and dispatches `nxis-guardrail` here.
   *
   * @returns Nothing once loaded; the error when they can't load (and a send then fails closed).
   */
  private _guard(): Promise<unknown> {
    return loadGuard(this).then(
      (g) => void (this._g = g),
      (err) => err,
    );
  }

  /** Open a card's target, when the guardrails let it go there (another origin is confirmed first). */
  private _go(url: string, name: string): void {
    if (this._g?.nav(url)) openTarget(url, name, { conversationId: this._activeId ?? undefined });
  }

  // ── Misc UI ────────────────────────────────────────────────────────────────
  private _setStatus(text: string, isError = false): void {
    // Errors only.
    //
    // The empty state names the phase while loading and the pending bubble
    // names it during a turn, so echoing the same words above the composer was
    // the same sentence twice on one screen. An error has nowhere else to go.
    this._els.status.textContent = isError ? text || '' : '';
    this._els.status.classList.toggle('err', !!isError);
    // The engine names its phases through onStatus, and the empty state shows
    // that name in place of the invitation, so a phase change has to reach it.
    if (!isError && text && text !== this._stage) {
      this._stage = text;
      const stage = this._els?.thread?.querySelector('.stage');
      if (stage) stage.textContent = text;
      // A phase with no numbers still changes what the ring should be doing,
      // and the phase that ends the load is what brings the chips back, so
      // this repaints either way rather than only while loading.
      if (!this.provider?.ready) this._loadDetail = undefined;
      this._paintLoad();
    }
  }
  private _setBar(pct: number): void {
    this._els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  private _scroll(): void {
    const t = this._els.thread;
    t.scrollTop = t.scrollHeight;
    this._endAt = t.scrollTop;
  }

  /** Where the thread was last put at its end: a visitor still there hasn't scrolled away since. */
  private _endAt = 0;

  /**
   * Cards drawn a moment after their reply (their chunk loads, then they render) keep a thread that was at its end
   * there, as after a reload: it opens at the bottom, not above the card.
   */
  private _keepEnd(drawn: Promise<unknown>): void {
    const again = () => {
      if (this._els.thread.scrollTop >= this._endAt - 4) this._scroll();
    };
    void drawn.then(() => {
      again();
      setTimeout(again, 120);
    });
  }

  private _autosize(): void {
    const ta = this._els.input;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  /**
   * Rebuild the specialist agents and their coordinator.
   *
   * Called on connect and whenever the host changes `agents`, `routes` or
   * `fallback`. Inexpensive: each agent is a role over the one shared provider,
   * so no additional model is loaded.
   */
  /** The one agent a page without `agents` runs, on the current provider. */
  private _singleHarness(): AgentHarness {
    return new AgentHarness({
      provider: this.provider,
      toolSource: this.toolSource,
      renderer: this._renderer(),
      profile: (schema) => this._profileForSchema(schema as JsonSchema),
      onMessages: () => this._saveConversations(),
      guardrails: this,
      // Read per turn: the host can set `handoff` after the agent is built.
      handoff: () => this._handoff,
    });
  }

  private _buildAgents(): void {
    if (!this.provider || !this._agentDefs) {
      this._coordinator = null;
      return;
    }
    const names = Object.keys(this._agentDefs);
    const agents: Record<string, AgentHarness> = {};
    for (const name of names) {
      const def = this._agentDefs[name];
      agents[name] = new AgentHarness({
        provider: this.provider,
        toolSource: this.toolSource,
        renderer: this._renderer(),
        profile: (schema) => this._profileForSchema(schema as JsonSchema),
        onMessages: () => this._saveConversations(),
        systemPrompt: def.systemPrompt,
        tools: def.tools,
        name,
        unavailable: def.unavailable,
        handoff: () => this._handoff,
        guardrails: this,
      });
    }

    const descriptions: Record<string, string> = {};
    for (const name of names) {
      const d = this._agentDefs[name].description;
      if (d) descriptions[name] = d;
    }

    const fallback = this._fallbackAgent && agents[this._fallbackAgent] ? this._fallbackAgent : names[0];
    this._coordinator = new AgentCoordinator({
      agents,
      rules: this._routes,
      fallback,
      // The model pass is the last resort, and it uses the same weights the
      // specialists do, so there is no second model to load.
      provider: this.provider,
      descriptions,
      onRoute: (routed) => this._paintRoute(routed.agent, routed.via),
    });
  }

  // ── Handoff ────────────────────────────────────────────────────────────────

  /**
   * Handing conversations to other agents and to people.
   *
   * Set to `{ relay, targets }` to offer `transfer_to_agent` and
   * `talk_to_a_person` for those targets, or to `{ relay }` alone for NxisAI's
   * relay, whose agent cards list them (see docs/handoff.md). While a
   * conversation is handed off, what the visitor types goes to the target,
   * and a bar above the input shows who is listening and the way back.
   */
  get handoff(): HandoffConfig | null {
    return this._handoff?.config ?? null;
  }
  set handoff(next: HandoffConfig | null) {
    this._offHandoff?.();
    this._offHandoff = null;
    this._handoff?.dispose();
    this._handoff = null;
    if (!next?.relay) {
      if (this._els?.thread) this._paintHandoffBar();
      return;
    }
    const controller = new HandoffController(next);
    const listener = (e: Event) => this._onHandoffEvent((e as CustomEvent<HandoffEvent>).detail);
    controller.addEventListener('handoff', listener);
    this._offHandoff = () => controller.removeEventListener('handoff', listener);
    this._handoff = controller;
    // Tools already connecting or connected: add the handoff tools, and make the next turn wait for them.
    if (this._connect) this._connect = this._connect.then(() => this._registerHandoffBounded());
    if (this._els?.thread) {
      this._paintHandoffBar();
      if (this._activeId) void controller.resume(this._activeId);
    }
  }

  /** {@link _registerHandoff}, given at most four seconds: a slow relay must not hold up the conversation. */
  private _registerHandoffBounded(): Promise<void> {
    return Promise.race([this._registerHandoff(), new Promise<void>((r) => setTimeout(r, 4000))]).catch((err) =>
      console.warn('[nxis] handoff tools unavailable:', err),
    );
  }

  /** Offer the handoff tools on the page's registry. */
  private async _registerHandoff(): Promise<void> {
    const controller = this._handoff;
    const mc = this.toolSource?.modelContext();
    if (!controller || !mc) return;
    const added = await registerHandoffTools(mc, controller, {
      conversationId: () => this._activeId ?? undefined,
      transcript: () => this._transcript(),
      contact: () => contactFromProfile(this._profileNow()),
    });
    if (added.length) void this._refreshToolCount();
  }

  /** The conversation's last turns, text only, for a target allowed to see them. */
  private _transcript(): { role: 'visitor' | 'assistant'; text: string }[] {
    const conv = this._active();
    if (!conv) return [];
    return conv.items
      .filter((it): it is Extract<ThreadItem, { kind: 'msg' }> => it.kind === 'msg' && (it.role === 'user' || it.role === 'assistant'))
      .slice(-10)
      .map((it) => ({ role: it.role === 'user' ? ('visitor' as const) : ('assistant' as const), text: it.text }));
  }

  /** What a handoff reported, into the conversation it belongs to. */
  private _onHandoffEvent(e: HandoffEvent): void {
    // For the site's own analytics, and for tests: what happened, without the session's key.
    this.dispatchEvent(new CustomEvent('nxis-handoff', { detail: handoffActivity(e), bubbles: true, composed: true }));
    const conv = this._conversations.find((c) => c.id === e.conversationId);
    if (!conv) return;
    if (e.type === 'message') {
      // The task it came on: feedback on its answer goes there, and only while it's open.
      const item: Extract<ThreadItem, { kind: 'remote' }> = { kind: 'remote', from: e.from, fromKind: e.fromKind, text: e.text, answer: e.answer, task: e.session.taskId ?? e.session.contextId };
      // Words are drawn at once; a reply that only updates a surface draws nothing of its own.
      const shown = !!(e.text || e.answer);
      // Its step cards come once their chunk is here: its Sources wait for them, to go under the card.
      let painted = () => {};
      if (e.surface && shown) this._stepsPending.set(item, new Promise<void>((r) => (painted = r)));
      const el = shown ? this._appendHandoffItem(conv.id, item) : null;
      // Kept and drawn under the reply, or, for a reply with no words, under one of its own when it draws a new one.
      if (e.surface)
        void this._steps()
          .then((st) => st.receive(conv.items, item, e.surface) && (shown ? el && st.paint(el, item) : this._appendHandoffItem(conv.id, item)))
          .finally(() => (painted(), conv.id === this._activeId && this._paintHandoffBar()));
      else void this._surfacesLoad?.then((s) => s.sync(true), () => {});
    } else if (e.type === 'handback') {
      const { outcome, note, references } = e.handBack;
      const refs = references.map((r) => `${r.label}: ${r.value}`).join(' · ');
      // The assistant carries on from here, so it learns what happened: the note, and nothing else the
      // target said. A remote reply is shown to the visitor and never read as an instruction; what the
      // target wrote (its outcome, note and references) reaches the model only as data.
      conv.messages.push({
        role: 'user',
        content: `[${e.session.label} handed the conversation back]`,
        data: `${outcome}\n${note ?? ''}\n${refs}`,
      });
      // A person's own words for the visitor (the team's close note), drawn as text: then the references.
      if (note && e.session.kind === 'person')
        this._appendHandoffItem(conv.id, { kind: 'handoff', text: `${e.session.label} ${outcome === 'transferred' ? 'passed you back' : 'closed this conversation'}: ${note}`, tone: 'done' });
      if (refs) this._appendHandoffItem(conv.id, { kind: 'handoff', text: refs, tone: 'done' });
      // The details the visitor confirmed with the target, for the next agent: kept with the conversation, and read
      // by the model only as the profile's data.
      if (e.handBack.contact) this._rememberDetails(conv, detailsFromContact(e.handBack.contact));
      // The visitor asked the target for another agent: offered once the hand-back has settled.
      if (e.handBack.next) this._next = { id: conv.id, from: e.session.target, ...e.handBack.next };
    } else {
      const text = handoffLine(e.session);
      const last = [...conv.items].reverse().find((it) => it.kind === 'handoff') as
        | Extract<ThreadItem, { kind: 'handoff' }>
        | undefined;
      if (text && last?.text !== text) {
        const tone = e.state === 'failed' ? 'error' : isHandoffOver(e.state) ? 'done' : 'info';
        this._appendHandoffItem(conv.id, { kind: 'handoff', text, tone });
      }
      if (e.state === 'ended' || e.state === 'failed') {
        conv.messages.push({
          role: 'user',
          content: `[The conversation with ${e.session.label} ${e.state === 'failed' ? 'failed' : 'ended'}. You are handling it again.]`,
          // Why it failed may have come from the relay or the target: data.
          data: e.session.error,
        });
      }
    }
    this._saveConversations();
    if (conv.id === this._activeId) this._paintHandoffBar();
    if (e.type === 'state') void this._surfacesLoad?.then((s) => s.sync(), () => {});
    const next = this._next;
    if (next?.id === conv.id && !this._handoff?.active(conv.id)) {
      this._next = null;
      setTimeout(() => void this._offerNext(next));
    }
  }

  /** A hand-back's `next`, waiting for the hand-back to settle. Never kept: a reload offers nothing again. */
  private _next: { id: string; from: string; target: string; reason: string; summary: string } | null = null;

  /**
   * Offer the agent a target's hand-back asked for: the Hand over card the model's own `transfer_to_agent` call
   * draws (or, for a person target, `talk_to_a_person`'s), without asking the model. Only in the conversation on screen,
   * after any turn running ends, and for a listed target that is available and isn't the one that handed back;
   * otherwise the model reads the note as before.
   */
  private async _offerNext({ id, from, target, reason, summary }: NonNullable<typeof this._next>): Promise<void> {
    await this._turnDone;
    const h = this._handoff;
    const t = h && (await h.targets()).find((x) => x.name === target);
    if (!t || (await this._guard())) return;
    const conv = this._active();
    if (!t.available || target === from || id !== conv?.id || this._turnActive) return;
    // A person target (the team, which an agent hands back for) gets the person tool's card.
    await this._runTurn(reason, conv, { name: t.kind === 'person' ? TALK_TO_A_PERSON_TOOL : TRANSFER_TO_AGENT_TOOL, args: { target, reason, summary } }, true);
  }

  /** Add a handoff item to a conversation, and draw it when that conversation is on screen. */
  private _appendHandoffItem(conversationId: string, item: Extract<ThreadItem, { kind: 'remote' | 'handoff' }>): HTMLElement | null {
    const conv = this._conversations.find((c) => c.id === conversationId);
    if (!conv) return null;
    conv.items.push(item);
    this._saveConversations();
    if (conversationId === this._activeId && this._els?.thread) {
      const el = this._paintHandoffItem(item, conv.items.length - 1);
      this._scroll();
      this._noteThreadGrew();
      return el;
    }
    return null;
  }

  // ── A target's step surfaces (./surfaces.ts) ─────────────────────────

  /** The surfaces' module, loaded with the first reply that has one. */
  private _surfacesLoad?: Promise<Surfaces>;

  /** A live reply's step cards, drawn once their chunk is here: what its Sources wait for. */
  private _stepsPending = new WeakMap<object, Promise<void>>();

  private _steps(): Promise<Surfaces> {
    return (this._surfacesLoad ??= import('./surfaces.js').then(
      (m) =>
        new m.Surfaces({
          kit: stepsKit,
          mount: mountSurface,
          act: (text, action) => this._surfaceAct(text, action),
          go: (url, name) => this._go(url, name),
          // Where a surface's links may go besides this page: `link-origins`, and the relay's (a calendar file).
          origins: () => [...(this._linkPolicy().origins ?? []), ...(this._handoff ? [new URL(this._handoff.config.relay, location.href).origin] : [])],
          back: () => void this._endHandoff(),
          live: () => !!this._handoff?.active(this._activeId ?? undefined),
          save: () => this._saveConversations(),
        }),
      (err) => {
        this._surfacesLoad = undefined;
        throw err;
      },
    ));
  }

  /** A choice made on a surface, to the target: through the same input checks as words typed to it. */
  private async _surfaceAct(text: string, action: SurfaceAction): Promise<boolean> {
    const id = this._activeId;
    const conv = this._active();
    const down = await this._guard();
    if (down) this._reportEngineError(down);
    if (down || !id || !conv || !this._handoff || (await this._g!.input(text, conv.messages, this._renderer()))) return false;
    // A form the visitor sent: its details are theirs, for the next agent. "Not you?": they go first.
    if (action.name === CLEAR_DETAILS_EVENT) this._forgetDetails(conv);
    else this._rememberDetails(conv, detailsFromFields(action.context?.form));
    try {
      await this._handoff.send(id, text, [extensionPart(action as unknown as Record<string, unknown>)]);
      return true;
    } catch (err) {
      this._appendHandoffItem(id, { kind: 'handoff', text: this._handoff.session(id)?.error ?? String((err as Error)?.message || err), tone: 'error' });
      return false;
    }
  }

  /**
   * A handoff item: a line, or what the target said. A target's reply is drawn as text whose links open when the
   * page allows their origin, under its language note, with the cards for its sources beneath it.
   *
   * @param index - The item's place in the conversation: records drawn before it make its repeats compact rows.
   */
  private _paintHandoffItem(item: Extract<ThreadItem, { kind: 'remote' | 'handoff' }>, index?: number): HTMLElement {
    this._clearEmpty();
    let el: HTMLElement;
    if (item.kind === 'remote') {
      el = document.createElement('div');
      el.className = 'remote';
      const who = document.createElement('div');
      who.className = 'remote-from';
      who.textContent = item.fromKind === 'agent' ? `${item.from} · agent` : item.from;
      el.append(who);
      const answer = item.answer;
      if (answer?.note) {
        const note = document.createElement('div');
        note.className = 'remote-note';
        note.textContent = answer.note;
        el.append(note);
      }
      const text = withoutNote(item.text, answer?.note);
      const bubble = text.trim() || answer?.cards.length ? this._msgEl('assistant', text) : null;
      if (bubble) el.append(bubble);
      const steps = item.surface?.length ? this._steps().then((st) => st.paint(el, item), () => {}) : (this._stepsPending.get(item) ?? null);
      if (steps) this._keepEnd(steps);
      if (bubble && answer?.cards.length) {
        el.classList.add('has-cards');
        // The markers go in the text as drawn: after the markdown, when it has any. With a step card (an estimate),
        // the Sources list goes under the card, as its markers point there too.
        void Promise.all([this._replyDrawn.get(bubble), steps]).then(() => this._paintSources(el, bubble, answer, index, !!steps));
      }
      // An answer with an id gets 👍 and 👎, cards or not.
      if (answer?.answerId) {
        el.dataset.answerId = answer.answerId;
        this._paintFeedback(el, item);
      }
    } else {
      el = document.createElement('div');
      el.className = `handoff-note ${item.tone}`;
      el.textContent = item.text;
    }
    this._els.thread.appendChild(el);
    return el;
  }

  /** The Sources' module, loaded with the first answer that has cards. */
  private _sourcesLoad?: Promise<typeof import('./sources.js')>;

  /** An answer's markers, its Sources list and its content cards, drawn once their module arrives. See ./sources.ts. */
  private _paintSources(el: HTMLElement, bubble: HTMLElement, answer: HandoffAnswer, index: number | undefined, under = false): void {
    (this._sourcesLoad ??= import('./sources.js')).then(
      (m) => {
        const below = under ? ([...el.children].filter((c) => c.classList.contains('surface')).slice(-1)[0] as HTMLElement | undefined) : undefined;
        m.paintSources(bubble, answer, { views: this._citeViews(answer, index), handlers: this._citeHandlers(), allow: (url) => !!this._g?.nav(url), openWay, citeCards, ...(below ? { below } : {}) });
        if (!el.nextElementSibling) this._scroll();
      },
      () => (this._sourcesLoad = undefined),
    );
  }

  /** The records read in the turn now running, for the markers and Sources list of the answer it gives. */
  private _turnSources: LocalSource[] = [];
  /** What the visitor asked in the turn now running (or last ran): an emergency changes which number the cards call. */
  private _turnGoal = '';

  /** Records read in earlier turns, by conversation, newest first: what a turn that reads none answers from. */
  private _readSources = new Map<string, LocalSource[]>();

  /**
   * What this turn's answer may cite: the records it read, else those the conversation read earlier, each for what it
   * says (a place it serves, its phone, its address), never for its name alone: a reference from a hand-back, said
   * with the business's name, isn't from the business's record.
   */
  private _citable(): LocalSource[] {
    if (this._turnSources.length) return this._turnSources;
    return this._earlierSources().map((x) => ({ ...x, keys: x.keys.filter((k) => k.toLowerCase() !== (x.card.name ?? '').toLowerCase()) }));
  }

  /** The records this conversation read before this turn: kept this session, and those its answers cited. */
  private _earlierSources(): LocalSource[] {
    const conv = this._active();
    if (!conv) return [];
    const out: LocalSource[] = [];
    const cited = conv.items.flatMap((it) => (it.kind === 'msg' && it.sources ? it.sources : [])).reverse();
    for (const src of [...(this._readSources.get(conv.id) ?? []), ...cited]) {
      if (out.length >= 24) break;
      if (!out.some((x) => x.card['@id'] === src.card['@id'])) out.push(src);
    }
    return out;
  }

  /** Keep a read's records (those with an `@id`) for this turn's answer: each as a card, and the words that name it. */
  private _noteSources(res: ModelContextToolResponse): void {
    for (const raw of extractRecords(res).slice(0, 12)) {
      const e = compact(raw);
      const card = readCard({ ...e, name: entityLabel(e) });
      if (!card || this._turnSources.some((s) => s.card['@id'] === card['@id']) || this._turnSources.length >= 24) continue;
      const addr = e.address as Record<string, unknown> | undefined;
      const keys = [entityLabel(e), e.telephone, addr && typeof addr === 'object' ? addr.streetAddress : undefined].filter(
        (k): k is string => typeof k === 'string' && k.trim().length >= 4,
      );
      // The places it serves and its seller's phone name it too, less surely: a reply about the service area cites it.
      const places = [e.areaServed, e.serviceArea].flat().flatMap((p) => (typeof p === 'string' ? [p] : p && typeof p === 'object' ? [(p as Record<string, unknown>).name] : []));
      const phones = [e.seller, e.provider, e.contactPoint].flat().map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>).telephone : undefined));
      const more = [...places, ...phones].filter((k): k is string => typeof k === 'string' && k.trim().length >= 4).slice(0, 24);
      // Its hours as a reply says them: each span of times, or round-the-clock.
      const said = hoursText(raw) ?? '';
      const hours = /^24 hours/.test(said) ? ['24 hours', '24/7'] : [...new Set(said.match(/(?:\d{1,2}(?::\d\d)? [ap]\.m\.|noon|midnight) to (?:\d{1,2}(?::\d\d)? [ap]\.m\.|noon|midnight)/g) ?? [])];
      const src: LocalSource = { card, keys, ...(more.length ? { more } : {}), ...(hours.length ? { hours } : {}) };
      this._turnSources.push(src);
      const id = this._activeId;
      if (id) this._readSources.set(id, [src, ...(this._readSources.get(id) ?? []).filter((x) => x.card['@id'] !== card['@id'])].slice(0, 24));
    }
  }

  /** The page assistant's reply's markers and Sources list, from the records it read, once the reply is drawn. */
  private _paintLocalSources(bubble: HTMLElement, sources: LocalSource[], index: number | undefined): void {
    void this._replyDrawn.get(bubble)?.then(() =>
      (this._sourcesLoad ??= import('./sources.js')).then(
        (m) => {
          const answer = bubble.isConnected ? m.localAnswer(bubble.textContent ?? '', sources) : null;
          if (!answer) return;
          m.paintSources(bubble, answer, { views: this._citeViews(answer, index), handlers: this._citeHandlers(), allow: (url) => !!this._g?.nav(url), openWay, citeCards });
          if (!bubble.nextElementSibling) this._scroll();
        },
        () => (this._sourcesLoad = undefined),
      ),
    );
  }

  /** The feedback controls' module, loaded with the first answer that has an id. */
  private _feedbackLoad?: Promise<typeof import('./feedback.js')>;

  /** 👍 and 👎 on an answer, drawn once their module arrives. See ./feedback.ts. */
  private _paintFeedback(el: HTMLElement, item: Extract<ThreadItem, { kind: 'remote' }>): void {
    (this._feedbackLoad ??= import('./feedback.js')).then(
      (m) =>
        m.paintFeedback(el, item, {
          session: () => this._handoff?.active(this._activeId ?? undefined),
          send: (id, v) => {
            this._saveConversations();
            // With no conversation, the controller finds no handoff and sends nothing.
            void this._handoff?.feedback(this._activeId!, id, v);
          },
        }),
      () => (this._feedbackLoad = undefined),
    );
  }

  /** Where a remote reply's links may go: this page's origin, and those listed in `link-origins`. */
  private _linkPolicy(): LinkPolicy {
    const origins = (this.getAttribute('link-origins') ?? '')
      .split(/[\s,]+/)
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return '';
        }
      })
      .filter((o) => o && o !== 'null');
    return { origins, allow: (url) => !!this._g?.nav(url) };
  }

  /** Every record's `@id` drawn in the active conversation before `index`: search results and remote answers. */
  private _drawnBefore(index: number | undefined): Set<string> {
    const drawn = new Set<string>();
    const items = this._active()?.items ?? [];
    for (const it of items.slice(0, index ?? items.length)) {
      if (it.kind === 'results') for (const c of it.cards) if (c.id) drawn.add(c.id);
      if (it.kind === 'remote') for (const c of it.answer?.cards ?? []) drawn.add(c['@id']);
    }
    return drawn;
  }

  /** An answer's cards; with `media="play"`, a video's Watch plays in the chat when the player may play it. */
  private _citeViews(answer: HandoffAnswer, index: number | undefined) {
    const views = citeViews(answer, this._drawnBefore(index), this._linkPolicy());
    if (!this._playOn()) return views;
    return views.map((v, i) => {
      if (v.archetype !== 'media' || v.compact || v.citation === 'page') return v;
      // A clip's Watch plays its video from the clip's start.
      const play = fromOffset(playableOf(answer.cards[i]), answer.cards[i].focus?.startOffset);
      return mayPlay(play, { unmarked: this._unmarked() }) ? { ...v, ctas: playCtas(v.ctas, play) } : v;
    });
  }

  /** What a cited card's buttons do: open their page, keeping the conversation when this tab goes there, or play. */
  private _citeHandlers(): AnswerHandlers {
    return {
      // Cited cards carry no action CTA, so nothing on them asks the agent.
      ask: () => {},
      visit: (url, name) => savePendingVisit({ pageUrl: url, label: name, conversationId: this._activeId ?? undefined }),
      canPlay: (b) => this._canPlay(b),
      play: (b, name) => this._mediaTap(b, name),
      warm: () => void this._loadMedia().catch(() => {}),
    };
  }

  /** The bar above the input: shown while the conversation is handed off. */
  private _paintHandoffBar(): void {
    void this._feedbackLoad?.then((m) => m.syncFeedback(), () => {});
    if (!this._els?.handoffBar) return;
    const session = this._handoff?.active(this._activeId ?? undefined) ?? null;
    this._els.handoffBar.hidden = !session;
    const input = this._els.input;
    if (!session) {
      input.placeholder = this._inputOff() ? 'Preview only: messages are off' : 'Message the agent…';
      input.setAttribute('aria-label', 'Message the agent');
      return;
    }
    const who = session.operator ?? session.label;
    const q = session.queue;
    let last: { receipt?: boolean } | undefined;
    for (const it of this._active()?.items ?? []) if (it.kind === 'remote' && it.surface?.length) last = it;
    const inLine = q?.position ? ` · ${ordinal(q.position)} in line${q.waitMinutes ? `, about ${q.waitMinutes} min` : ''}` : ' · waiting in line';
    const doing =
      session.state === 'connecting'
        ? ' · connecting…'
        : session.state === 'queued'
          ? inLine
          : session.state === 'awaiting-visitor'
            ? // Once the target's latest step is a receipt (./surfaces.ts), it has done its part: nothing waits on the visitor.
              last?.receipt
              ? ' · done'
              : ' · waiting for your reply'
            : '';
    // An agent took over from the assistant; a person is talked with. Set as text: the names are another server's.
    const label = this._els.handoffLabel;
    label.textContent = '';
    const name = document.createElement('b');
    name.textContent = session.kind === 'agent' ? session.label : who;
    label.append(...(session.kind === 'agent' ? [name, ` · handed off from the assistant${doing}`] : ['Talking with ', name, doing]));
    input.placeholder = `Message ${who}…`;
    input.setAttribute('aria-label', `Message ${who}`);
  }

  /** "Back to the assistant": end the handoff for this conversation. */
  private async _endHandoff(): Promise<void> {
    if (!this._activeId || !this._handoff) return;
    await this._handoff.end(this._activeId);
    this._els.input.focus();
  }

  /** Zero when the provider cannot count, which hides the token metrics. */
  private async countTokens(text: string): Promise<number> {
    return (await this.provider.countTokens?.(text)) ?? 0;
  }

  /**
   * Add a line to the thread naming the agent that took the turn.
   *
   * Behind `debug`, like the tool traces: a misroute is otherwise invisible,
   * showing only as an unhelpful answer.
   */
  private _paintRoute(agent: string, via: string): void {
    if (!this.debug) return;
    const item: Extract<ThreadItem, { kind: 'route' }> = { kind: 'route', agent, via };
    this._active()?.items.push(item);
    this._els.thread.appendChild(this._routeEl(item));
    this._saveConversations();
    this._scroll();
  }

  private _routeEl(item: Extract<ThreadItem, { kind: 'route' }>): HTMLElement {
    const el = document.createElement('div');
    el.className = 'routeline';
    el.textContent = `routed to ${item.agent} · ${item.via}`;
    return el;
  }

  /**
   * Submit a form that was confirmed on another page.
   *
   * An action runs by filling the form on its own page, so a call made
   * elsewhere was confirmed there and carried here. The values were already
   * reviewed and pressed, which is why this submits rather than asking again —
   * the button that started it said it would open this page and submit.
   *
   * Nothing waiting is the ordinary case, and costs a single storage read.
   */
  /**
   * Continue the conversation that opened this page, and say it is open.
   *
   * Reached when the agent opened it or a result card's link was followed.
   * The thread is the one the visitor was in: by id, or failing that the one
   * holding the journey that left, so a visit saved without an id still
   * lands where it started rather than in whichever thread loaded first.
   *
   * @returns Whether a conversation was carried here.
   */
  private _resumePendingVisit(): boolean {
    const visit = takePendingVisit();
    if (!visit) return false;
    const journey = visit.steps?.find((s) => s.journey)?.journey;
    const conv =
      this._conversations.find((c) => c.id === visit.conversationId) ??
      (journey
        ? this._conversations.find((c) => c.items.some((it) => it.kind === 'journey' && it.id === journey))
        : undefined) ??
      this._active();
    if (!conv) return false;
    this._activeId = conv.id;
    this._renderHistory();
    this._renderThread();
    // Finished before the line below, so the card reads done above it.
    if (visit.steps?.length) {
      restoreJourney(visit.steps);
      recordStep({ id: 'navigate', label: `Opened ${visit.label}`, status: 'done' });
      recordStep({ id: 'submit', label: 'Arrived', status: 'done' });
    }
    const label = visit.label || 'the page';
    this._appendMsg('assistant', `You're on ${label} now.`);
    // What the model needs to know to answer "what is on this page".
    conv.messages.push({ role: 'user', content: `[${OPEN_PAGE_TOOL} returned]`, data: `Opened ${label}: ${visit.pageUrl}` });
    this._saveConversations();
    this._scroll();
    // Covering the page just opened would hide what was asked for.
    if (this.mode !== 'fullscreen') this._open();
    return true;
  }

  /**
   * Open on the form a link from the NxisAI app names.
   *
   * In a new conversation: the person arrives from another app, and nothing
   * on this site led here. The agent starts the form in its own words, so the
   * link only chooses which form; what the person wanted waits in the
   * composer for them to send, change or delete.
   *
   * When a handoff target `takes` that form and is available, the same start
   * begins the handoff instead — the harness turns the form's call into it —
   * and the visitor confirms it with Send like any handoff. The link's action
   * is what that handoff stands in for, so a resolved quote is reported with
   * the link's report token, as the form would have been.
   */
  private async _arriveFromHandoff(keep = false): Promise<void> {
    const handoff = takeInboundHandoff();
    if (!handoff) return;
    if (!keep) this._newConversation();
    this._open();
    await this._openForm(handoff);
  }

  /** Start one of the site's forms in the chat, as a handoff link does: the form is known, so the model needn't choose. */
  private async _openForm(handoff: InboundHandoff): Promise<void> {
    this._setStatus('Opening the form…');
    // The site's own tools first: they reach a form from any page, from the
    // site's records, so they work where the page registers nothing itself.
    await this._connectTools();
    const site = siteFormFor(handoff.actionId);
    let start: string | null = null;
    let call: { name: string; args: Record<string, unknown> } | undefined;
    if (site) {
      start = startFormMessage(site.noun, site.choice);
      call = { name: site.tool, args: site.args };
    } else {
      const found = await findHandoffForm(handoff);
      if (found.status === 'ready') {
        start = startMessage(found.tool);
        // The page's own form goes to the model as before, unless a target takes it now: then the
        // call is made here, so the handoff starts without the model choosing either way.
        if (await formTakenBy(this._handoff, found.tool.name)) call = { name: found.tool.name, args: {} };
      }
    }
    this._setStatus('');
    if (!start) {
      this._appendMsg('assistant', "I couldn't find that form on this page. Tell me what you need and I'll help from here.");
    } else if (!this._turnActive) {
      this._els.input.value = start;
      // The form is known, so it opens without the model choosing it: left to
      // choose, a model sometimes asks for the details in prose instead.
      await this._onSend(call);
    }
    if (handoff.intent && !this._els.input.value) {
      this._els.input.value = handoff.intent;
      this._autosize();
    }
  }

  private async _resumePendingAction(): Promise<void> {
    const outcome = await resumePendingAction({
      onStart: (pending) => {
        // Back to the conversation it was started in, so the result lands
        // under the question that prompted it rather than in a fresh thread.
        const conv = this._conversations.find((c) => c.id === pending.conversationId);
        if (conv) {
          this._activeId = conv.id;
          this._renderHistory();
          this._renderThread();
        }
        this._open();
        this._setStatus('Submitting the details you confirmed…');
      },
      exec: (tool, values) => this.toolSource.execTool(tool, tool.name, values),
    });
    if (outcome.status !== 'none') this._setStatus('');

    // The card that travelled with the request finishes here, when there is one.
    const card = outcome.status === 'none' ? null : this._resumedCard(outcome.pending.steps?.find((st) => st.journey)?.journey);
    if (card && outcome.status !== 'none') {
      switch (outcome.status) {
        case 'no-registry':
        case 'no-tool':
          card.stage = 'failed';
          card.message = `I couldn't find the ${card.noun} on this page, so nothing was sent. Ask me again and I'll fill it in from here.`;
          break;
        case 'incomplete':
          this._reviveCard(card, outcome.tool, outcome.pending.values, outcome.missing);
          card.stage = 'collect';
          card.message = undefined;
          break;
        case 'rejected':
        case 'failed':
          this._reviveCard(card, outcome.tool, outcome.pending.values, []);
          card.stage = 'failed';
          card.message = outcome.status === 'failed' ? outcome.error : outcome.text || 'That form did not accept the details.';
          break;
        case 'submitted': {
          const note = this._buildDetailItem(outcome.tool, outcome.pending.values, outcome.text).note;
          card.message = /submitted successfully/.test(note) ? undefined : note;
          card.stage = 'done';
          this._active()?.messages.push({
            role: 'user',
            content:
              `[${outcome.tool.name} submitted with: ${JSON.stringify(outcome.pending.values)}]. ` +
              'Keep these unless I ask to change them.',
          });
          break;
        }
      }
      this._paintAction(card);
      this._saveConversations();
      return;
    }

    switch (outcome.status) {
      case 'none':
        return;

      // Either way the form is out of reach, and saying which of the two
      // failed would describe our plumbing rather than their situation.
      case 'no-registry':
      case 'no-tool':
        this._appendMsg(
          'assistant',
          `I could not find the ${humanize(outcome.pending.pageToolName)} on this page, so ` +
            'nothing was submitted. Ask me again and I will fill it in from here.',
        );
        return;

      case 'incomplete':
        this._appendMsg(
          'assistant',
          `I brought your details over. This form also needs ${outcome.missing
            .map((m) => humanize(m).toLowerCase())
            .join(', ')}.`,
        );
        this._renderForm(outcome.tool, outcome.pending.values);
        return;

      case 'rejected':
        this._appendMsg('assistant', outcome.text || 'That form did not accept the details.');
        return;

      case 'failed':
        this._appendMsg('assistant', `That form could not be submitted: ${outcome.error}`);
        return;

      case 'submitted': {
        const active = this._active();
        const item = this._buildDetailItem(outcome.tool, outcome.pending.values, outcome.text);
        active?.items.push(item);
        active?.messages.push({
          role: 'user',
          content:
            `[${outcome.tool.name} submitted with: ${JSON.stringify(outcome.pending.values)}]. ` +
            'Keep these unless I ask to change them.',
        });
        this._els.thread.appendChild(this._detailEl(item));
        this._saveConversations();
        this._scroll();
      }
    }
  }

  /**
   * Bring in the site's own MCP server, once.
   *
   * The page's own action tools register themselves. Remote tools do not: they
   * live on an MCP server that must be discovered through
   * `/.well-known/ai-catalog.json` and bridged into the page's registry. The
   * same connection lists the actions on the site's other pages, unless
   * `site-actions="false"`.
   *
   * Runs as the element connects (and on open, a send or a form start, which
   * all share the first run), so a browser agent finds the tools without the
   * chat being opened. What it reads is kept in the tab (the server, its tool
   * list, the site's actions and pages), so after a session's first page it
   * costs no request until a tool runs. Failure is neither fatal nor loud: a
   * site with no MCP server is an ordinary case, and the page's own tools work
   * regardless.
   */
  private _connectTools(): Promise<void> {
    if (this._connect) return this._connect;
    // Contained implies discover="false" and site-actions="false": a preview fetches nothing.
    if (this.contained) {
      this._connect = Promise.resolve();
      return this._connect;
    }
    if (this.getAttribute('discover') === 'false') {
      // No site tools to find, but the handoff tools are still the page's.
      this._connect = this._registerHandoffBounded();
      return this._connect;
    }
    // The handoff targets are read beside discovery, so their tool registers with the rest rather than after it.
    void this._handoff?.targets();
    // No credential is passed, and the element takes none: a key in markup or
    // in a page global is served to every visitor and readable by every script
    // on the origin. Private tools belong behind an endpoint you host — see
    // `createProxyProvider` for the same decision on the model key.
    this._connect = connectTools(undefined, {
      // Short, because this blocks the first turn: a provider that has not
      // appeared within a few seconds is not going to.
      timeout: 4000,
      siteActions: this.getAttribute('site-actions') !== 'false',
    })
      .then(({ remoteTools, siteActions, siteTools, sitePages, calendar, warning }) => {
        this._sitePages = sitePages;
        this._remoteTools = new Set(remoteTools);
        this._calendar = calendar;
        if (warning) console.warn('[nxis]', warning);
        if (remoteTools.length) {
          console.info(`[nxis] discovered remote tools: ${remoteTools.join(', ')}`);
        }
        if (siteActions.length) {
          console.info(
            `[nxis] ${siteActions.length} site action(s) → ` +
              `${siteTools.length} tool(s): ${siteTools.join(', ')}`,
          );
        }
        void this._refreshToolCount();
        // The page's own script can register after we connect, and a native
        // registry announces it. Keep the count honest as it does.
        this.toolSource.modelContext()?.addEventListener('toolchange', () => {
          void this._refreshToolCount();
          if (this._toolsOpen) void this._renderTools();
        });
      })
      .catch((err) => console.warn('[nxis] tool discovery failed:', err))
      // Part of connecting, so the first turn waits for the handoff tools: a turn that ran without
      // them could only claim, in words, to be handing the visitor over.
      .then(() => this._registerHandoffBounded());
    return this._connect;
  }

  // ── Tools menu ─────────────────────────────────────────────────────────────

  /** Open or close the list of tools the agent can use. */
  private _toggleTools(open = !this._toolsOpen): void {
    this._toolsOpen = open;
    this._els.toolsBtn.setAttribute('aria-expanded', String(open));
    this._els.toolsPop.hidden = !open;
    if (open) void this._renderTools();
  }

  /** The number on the tools button, from what the agent would be offered now. */
  private async _refreshToolCount(): Promise<void> {
    const tools = await this._harness.offeredTools();
    this._els.toolsCount.textContent = String(tools.length);
    this._els.toolsCount.hidden = tools.length === 0;
    this._els.toolsBtn.setAttribute(
      'aria-label',
      tools.length ? `Tools on this page, ${tools.length}` : 'Tools on this page',
    );
  }

  /**
   * Draw the tools menu.
   *
   * Lists what the agent would be offered, not every tool registered: that
   * is the honest answer to "what can it do here". Grouped by where a tool
   * reaches — this page's own forms, then what works across the site — which
   * is what explains why a form from another listing is on the list. Every
   * row is disabled: the site provides these, and they are not the visitor's
   * to switch off.
   */
  private async _renderTools(): Promise<void> {
    const pop = this._els.toolsPop;
    const head =
      '<div class="tp-head"><div class="tp-title">What the agent can use here</div>' +
      '<div class="tp-sub">This site provides these tools. They load with the page and cannot be turned off.</div></div>';
    pop.innerHTML = `${head}<div class="tp-empty">Looking for tools…</div>`;

    const tools = await this._harness.offeredTools();
    if (!this._toolsOpen) return;
    this._els.toolsCount.textContent = String(tools.length);
    this._els.toolsCount.hidden = tools.length === 0;

    pop.innerHTML = head;
    if (!tools.length) {
      pop.insertAdjacentHTML('beforeend', '<div class="tp-empty">No tools on this page yet.</div>');
      return;
    }

    const readOnly = (t: ModelContextToolInfo) => !!t.annotations?.readOnlyHint;
    const onPage = tools.filter((t) => !isSiteTool(t) && !readOnly(t));
    const acrossSite = tools.filter((t) => isSiteTool(t) || readOnly(t));
    const group = (label: string, list: ModelContextToolInfo[]) => {
      if (!list.length) return;
      const title = document.createElement('div');
      title.className = 'tp-grp';
      title.textContent = label;
      pop.appendChild(title);
      for (const tool of list) pop.appendChild(this._toolRow(tool));
    };
    group('On this page', onPage);
    group('Across the site', acrossSite);

    if (tools.some((t) => !readOnly(t))) {
      pop.insertAdjacentHTML(
        'beforeend',
        '<div class="tp-foot">Anything that submits a form asks you first.</div>',
      );
    }
  }

  /** One tool in the menu: what it is, whether it writes, and a lock. */
  private _toolRow(tool: ModelContextToolInfo): HTMLElement {
    const site = isSiteTool(tool);
    const reads = !!tool.annotations?.readOnlyHint;
    const base = FRIENDLY_TOOL_NAMES[tool.name] ?? humanize(withoutSiteSuffix(tool.name));
    const name = (base.charAt(0).toUpperCase() + base.slice(1)) + (site ? ' · any page' : '');
    const desc = (tool.description ?? '').split(/(?<=[.!?])\s/)[0] ?? '';

    const row = document.createElement('div');
    row.className = 'tp-tool';
    row.setAttribute('aria-disabled', 'true');
    row.title = desc ? `${name} — ${desc}` : name;

    const icon = document.createElement('span');
    icon.className = 'tp-ti';
    icon.innerHTML = site ? ICON_GLOBE : reads ? ICON_SEARCH : ICON_FORM;

    const text = document.createElement('span');
    text.className = 'tp-tn';
    const n = document.createElement('span');
    n.className = 'tp-name';
    // Text, not markup: names and descriptions come from the site's data.
    n.textContent = name;
    text.appendChild(n);
    if (desc) {
      const d = document.createElement('span');
      d.className = 'tp-desc';
      d.textContent = desc;
      text.appendChild(d);
    }

    const kind = document.createElement('span');
    kind.className = 'tp-kind';
    kind.textContent = reads ? 'reads' : 'asks first';

    const lock = document.createElement('span');
    lock.className = 'tp-lock';
    lock.innerHTML = ICON_LOCK;

    row.append(icon, text, kind, lock);
    return row;
  }

  /**
   * Report a failure in the thread, where it will be seen.
   *
   * Translates the underlying error into a sentence that says what to do next,
   * rather than surfacing the exception.
   */
  private _reportEngineError(err: unknown): void {
    const raw = String((err as Error)?.message || err || 'Unknown error');
    let human: string;
    if (/webgpu/i.test(raw)) {
      human =
        'This browser cannot run the on-device model — it needs WebGPU. ' +
        'Chrome or Edge 113+, or Safari 18+, will work.';
    } else if (/cache|quota|storage/i.test(raw)) {
      human =
        "The model could not be stored in this browser's cache, so it did not finish " +
        'loading. Clearing this site\'s data usually fixes it, and the next attempt ' +
        'will skip the cache.';
    } else if (/fetch|network|import|load/i.test(raw)) {
      // The model's files, or the guardrails' chunk: without either, nothing is sent.
      human = 'The agent could not be downloaded. Check the connection and try again — nothing was lost.';
    } else {
      human = `The on-device model could not be started: ${raw}`;
    }
    this._setStatus(raw, true);
    this._appendMsg('assistant', human);
  }

  /**
   * Draw load progress on whichever mark is currently visible.
   *
   * Exactly one ring is ever on screen: the empty state's mark until a
   * conversation replaces it, then the header's. Phases that report no totals,
   * such as the runtime fetch and the warm-up, spin rather than fill.
   */
  private _paintLoad(): void {
    // A provider with nothing to load is ready as soon as it exists, so none
    // of the progress treatment applies. `load` is optional on the interface so
    // that this can be detected.
    const loading = (this.provider?.load ? this.provider.loading : false) ?? false;

    // The empty state was drawn before this load existed, or before it
    // finished. Redrawing it calls back here against the right DOM.
    if (this._emptyLoading !== null && this._emptyLoading !== loading) {
      this._renderThread();
      return;
    }

    const detail = this._loadDetail;
    const determinate = loading && !!detail?.total && this._loadPct > 0;
    const clamped = Math.max(0, Math.min(100, this._loadPct));

    const ring = this._els?.thread?.querySelector('.ring') as HTMLElement | null;
    const head = this.shadowRoot?.querySelector('.head-ring') as HTMLElement | null;

    for (const [node, show] of [
      [ring, loading],
      // The header only takes over once the empty state is gone.
      [head, loading && !ring],
    ] as const) {
      if (!node) continue;
      node.hidden = !show;
      node.classList.toggle('indet', show && !determinate);
      if (show && determinate) node.style.setProperty('--pct', String(clamped));
    }

    const byteLine = this._els?.thread?.querySelector('.stage-bytes');
    if (byteLine) {
      byteLine.textContent = determinate
        ? `${formatBytes(detail!.loaded)} / ${formatBytes(detail!.total)}`
        : '';
    }
  }

  /**
   * Split this element into several specialist agents.
   *
   * Each definition becomes an {@link AgentHarness} sharing this element's
   * provider, so one model in memory serves every role. With none set, the
   * element runs as a single agent with every tool and one prompt.
   *
   * @example
   * ```ts
   * agent.agents = {
   *   retrieval: { systemPrompt: '…', tools: (t) => t.name.startsWith('nxis_') },
   *   booking:   { systemPrompt: '…', tools: (t) => /book/.test(t.name) },
   * };
   * agent.routes = [{ route: 'booking', match: /\bbook\b/ }];
   * agent.fallback = 'retrieval';
   * ```
   */
  get agents(): Record<string, AgentDefinition> | null {
    return this._agentDefs;
  }
  set agents(defs: Record<string, AgentDefinition> | null) {
    this._agentDefs = defs && Object.keys(defs).length ? defs : null;
    this._buildAgents();
  }

  /** The routing table. Ignored unless `agents` is set. */
  get routes(): RouteRule[] {
    return this._routes;
  }
  set routes(rules: RouteRule[]) {
    this._routes = rules ?? [];
    this._buildAgents();
  }

  /**
   * Where a turn goes when the rules abstain, nothing is sticky and the model
   * declined. Defaults to the first agent declared.
   */
  get fallback(): string {
    return this._fallbackAgent;
  }
  set fallback(name: string) {
    this._fallbackAgent = name;
    this._buildAgents();
  }

  /**
   * Where completions come from. Defaults to Gemma on WebGPU.
   *
   * Set a provider to run the agent on a remote model. Anything a host writes
   * here should talk to their own origin rather than a vendor directly: a key
   * in a browser is a key anyone can read from the page.
   */
  get modelProvider(): ModelProvider | null {
    return this._provider;
  }
  set modelProvider(next: ModelProvider | null) {
    this._provider = next;
    // Late enough to matter: rebuild so the next turn uses it.
    if (this._els?.thread) {
      this.provider = next ?? this.provider;
      this._paintProvenance();
      // Both the single agent and any configured ones: a page without `agents` kept the old
      // provider's harness, and answered with the model it had just replaced.
      this._harness = this._singleHarness();
      this._buildAgents();
    }
  }

  /**
   * The guardrails every turn passes through (`@nxisai/agent-harness/guardrails`). On by default, with the
   * `standard` preset; the `guardrails="strict"` attribute picks the strict one. Read live: a change applies from
   * the next check, and a conversation's counters and approvals are kept.
   *
   * `agent.guardrails.lockdown(reason, scope?)` turns off tools (`'tools'`, the default) or the whole agent
   * (`'agent'`) at once, for remote config or incident response; `agent.guardrails.locked = null` lifts it.
   */
  get guardrails(): GuardrailsConfig {
    return (this._gc ??= {
      lockdown(reason, scope = 'tools') {
        this.locked = { reason, scope };
      },
    });
  }
  set guardrails(next: GuardrailsConfig | null) {
    // A copy, with `lockdown` beside what the host set.
    this._gc = next ? { ...this.guardrails, ...next } : undefined;
  }

  /**
   * Show the tool calls behind each answer.
   *
   * Off by default, and intended for whoever is building the agent. Traces
   * carry the arguments a tool was called with, which for a form tool includes
   * personal data, so while this is off they are neither rendered nor stored
   * rather than merely hidden.
   *
   * Enabling it affects subsequent turns, not those already recorded.
   */
  /**
   * How much of the page the agent takes when open.
   *
   * `'window'`, the default, docks it in the corner at
   * `--window-w` × `--window-h` (400 × 620 by default), for a site whose own
   * content should stay visible and usable beside it. `'fullscreen'` covers
   * the page, which suits a site where the agent is the experience. Below
   * 520px a window covers the page anyway, since at that width the two are
   * the same thing.
   *
   * A button in the header switches between the two while the agent is open
   * (hidden in `'inline'`, below 520px, and with `no-mode-toggle`). The
   * viewer's choice is kept in `localStorage` and used on the next load only
   * when the host sets no `mode` attribute: the host's explicit mode wins.
   * Precedence: the viewer's toggle this session, then the `mode` attribute,
   * then the stored choice, then `'window'` (`'fullscreen'` for the deprecated
   * `<nxis-agent-fullscreen>` alias).
   *
   * `'inline'` fills the box the host puts the element in and is always
   * open — for a copilot rail or a sidebar the host lays out itself. The
   * element does not position itself or move the page; the host does both.
   */
  get mode(): 'fullscreen' | 'window' | 'inline' {
    // Contained always starts as the window, whatever the attribute or a stored choice says.
    if (this.contained) return this._viewerMode ?? 'window';
    const raw = this._viewerMode ?? this.getAttribute('mode');
    if (raw === 'fullscreen' || raw === 'window' || raw === 'inline') return raw;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MODE_KEY);
    } catch {
      /* no storage: the default */
    }
    return saved === 'fullscreen' || saved === 'window' ? saved : this._defaultMode;
  }

  /** The mode with no attribute and no stored choice. The deprecated alias overrides it. */
  protected _defaultMode: 'fullscreen' | 'window' = 'window';
  set mode(next: 'fullscreen' | 'window' | 'inline') {
    this._viewerMode = null;
    this.setAttribute('mode', next === 'fullscreen' || next === 'inline' ? next : 'window');
    this._applyMode();
  }

  /** What the viewer switched to with the header's toggle, this session. */
  private _viewerMode: 'fullscreen' | 'window' | null = null;
  private _narrow: MediaQueryList | null = null;

  /**
   * Draw the window and its launcher inside the host's box rather than fixed
   * to the viewport: a preview of what a visitor sees.
   *
   * The same launcher, window, header, composer and footer as `'window'`
   * mode, at the same insets (20px from the bottom right) and the same
   * `--window-w` × `--window-h`, capped to the host's size less 16px a side.
   * The host gives the element its size, as for `'inline'`. The launcher
   * opens the window, the close button closes it back to the launcher, and
   * `auto-open` starts it open (without taking focus).
   *
   * The header's expand button is kept, and fills the host's box rather than
   * the screen; it shrinks back the same way. The `mode` attribute and the
   * stored choice don't apply, and the toggle isn't remembered.
   *
   * It fetches nothing: discovery and site actions are off, `preload` is
   * `'none'`, and opening loads only a `modelProvider` the host supplied.
   * Conversations aren't read from or saved to storage, and nothing left
   * pending on another page is resumed. Nothing is drawn outside the box:
   * the host is `position: relative`, `z-index: 0` (its own stacking context,
   * so the launcher's and window's z-indexes stay inside it) and
   * `overflow: hidden`, clipping at its edge as the viewport would. The
   * 520px narrow-viewport rule skips it, since the box is its screen.
   */
  get contained(): boolean {
    return this.hasAttribute('contained');
  }
  set contained(on: boolean) {
    this.toggleAttribute('contained', !!on);
    this._viewerMode = null;
    this._applyMode();
    if (this._els?.thread) this._renderThread();
  }

  /**
   * Let a `contained` preview take messages. Off by default: a preview is for
   * seeing the look, so its input and send button are disabled, its
   * placeholder says so, and its suggestion chips send nothing. With this on,
   * it takes messages as any other mode does. No effect without `contained`.
   */
  get allowInput(): boolean {
    return this.hasAttribute('allow-input');
  }
  set allowInput(on: boolean) {
    this.toggleAttribute('allow-input', !!on);
    this._paintInput();
    if (this._els?.thread) this._renderThread();
  }

  /** A contained preview without `allow-input`: the composer and chips are off. */
  private _inputOff(): boolean {
    return this.contained && !this.allowInput;
  }

  /** Disable or restore the composer for {@link _inputOff}. */
  private _paintInput(): void {
    const els = this._els;
    if (!els?.input) return;
    const off = this._inputOff();
    els.input.disabled = off;
    els.go.disabled = off;
    // The placeholder is the handoff bar's to set, since it names who a message goes to.
    this._paintHandoffBar();
  }

  /**
   * Switch between window and full screen, from the header's button.
   *
   * Only the overlay's shape changes: the conversation, an open handoff and
   * focus (on the button) stay as they are, and a thread read to its end
   * stays at its end.
   */
  private _toggleMode(): void {
    const mode = this.mode === 'fullscreen' ? 'window' : 'fullscreen';
    const t = this._els.thread;
    const atEnd = t.scrollHeight - t.scrollTop - t.clientHeight < 4;
    this._viewerMode = mode;
    try {
      // A preview's toggle isn't the viewer's choice for the page.
      if (!this.contained) localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* not remembered, still switched */
    }
    this._applyMode();
    if (atEnd) t.scrollTop = t.scrollHeight;
    this._els.modeBtn.focus();
    this.dispatchEvent(new CustomEvent('nxis-mode-change', { detail: { mode }, bubbles: true, composed: true }));
  }

  /** The toggle names what it will do, and is hidden where there is nothing to switch. */
  private _paintModeBtn = (): void => {
    const b = this._els?.modeBtn;
    if (!b) return;
    const mode = this.mode;
    const label = mode === 'fullscreen' ? 'Shrink to a window' : 'Expand to full screen';
    // Contained, the host's box is the screen, so the viewport's width doesn't hide it.
    b.hidden = mode === 'inline' || this.hasAttribute('no-mode-toggle') || (!this.contained && !!this._narrow?.matches);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = mode === 'fullscreen' ? ICON_SHRINK : ICON_EXPAND;
  };

  /** Put the overlay in the shape {@link mode} asks for. */
  private _applyMode(): void {
    const overlay = this._els?.overlay;
    if (!overlay) return;
    const mode = this.mode;
    overlay.classList.toggle('window', mode === 'window');
    overlay.classList.toggle('inline', mode === 'inline');
    overlay.classList.toggle('contained', this.contained);
    this._paintModeBtn();
    this._paintInput();
    if (mode === 'inline') {
      // Always on screen, so it has to be ready without an open. Tools are
      // cheap to connect; the model still waits for `preload` or a first
      // message, so a rail on every page does not cost every visitor 3.4 GB.
      this._setOpen(true);
      void this._connectTools();
    }
  }

  get debug(): boolean {
    const raw = (this.getAttribute('debug') || '').toLowerCase();
    if (!this.hasAttribute('debug')) return false;
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }
  set debug(on: boolean) {
    if (on) this.setAttribute('debug', 'true');
    else this.removeAttribute('debug');
    if (this._els?.thread) this._renderThread();
  }

  /**
   * How eagerly to fetch the model weights.
   *
   * `eager` starts on connect, `idle` waits for the browser to be free (the
   * default), and `none` waits until the panel is opened or a message is sent.
   * `preload="false"` is accepted as a synonym for `none`.
   */
  get preload(): PreloadMode {
    // A contained preview never fetches the weights ahead of a message.
    if (this.contained) return 'none';
    const raw = (this.getAttribute('preload') || '').toLowerCase();
    if (raw === 'eager') return 'eager';
    if (raw === 'false' || raw === 'none') return 'none';
    return 'idle';
  }
  set preload(mode: PreloadMode) {
    this.setAttribute('preload', mode);
    // Honoured when set after connect, so a host can start the load mid-session
    // without a reload.
    if (this.preload === 'eager' && this.provider && !this.provider.ready && !this.provider.loading) {
      this.provider.preload?.('eager');
    }
  }

  /**
   * The logo as markup.
   *
   * A value starting with `<` is used as written; anything else is treated as
   * an image URL.
   */
  private _logoMarkup(): string {
    const logo = this._logo.trim();
    return logo.startsWith('<') ? logo : `<img src="${escapeHtml(logo)}" alt="" />`;
  }

  /**
   * Push the current name and logo into the rendered shadow tree.
   *
   * Called on connect and on every set, so hosts can configure the element
   * before or after it upgrades without having to know which happened first.
   */
  private _applyIdentity(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const logo = this._logoMarkup();
    root.querySelectorAll('.launcher, .brand').forEach((node) => {
      node.innerHTML = logo;
    });
    const heading = root.querySelector('.main-head h2');
    if (heading) {
      heading.textContent = this._name;
      // Cut short in a narrow window: the whole name on hover.
      heading.setAttribute('title', this._name);
    }

    this._paintProvenance();
    const launcher = root.querySelector('.launcher');
    launcher?.setAttribute('title', `Open ${this._name}`);
    launcher?.setAttribute('aria-label', `Open ${this._name}`);
    root.querySelector('.overlay')?.setAttribute('aria-label', this._name);
  }

  /**
   * Say where the answers come from.
   *
   * The package's claim is that nothing leaves the tab, so the one case where
   * that stops being true has to be on screen. Painted separately from the rest
   * of the identity because the provider is built after the shadow tree, and
   * can be replaced later.
   */
  private _paintProvenance(): void {
    const local = this.provider?.local ?? true;
    // Beside the input: which model is answering, and where it runs.
    const model = this.shadowRoot?.querySelector('.composer .model');
    if (model) {
      const label = this.provider?.label || this.provider?.name || 'Model';
      (model.querySelector('.model-name') as HTMLElement).textContent = label;
      (model.querySelector('.model-where') as HTMLElement).textContent = local ? 'on-device' : 'remote';
      model.setAttribute('title', `${label}, ${local ? 'running in this browser' : 'running on a server'}`);
    }
    const badge = this.shadowRoot?.querySelector('.provenance');
    if (!badge?.lastChild) return;
    badge.lastChild.textContent = local ? 'On-device' : 'Remote';
    badge.setAttribute(
      'title',
      local
        ? 'The model runs in this browser. Nothing you type leaves the device.'
        : 'Answers come from a model on a server, so this conversation leaves the device.',
    );
  }

  /** Write the theme's custom properties onto the host element. */
  private _applyTheme(): void {
    for (const props of Object.values(THEME_TOKENS)) {
      for (const prop of props) this.style.removeProperty(prop);
    }
    // An accent alone (a site's brand color) brings its pressed shade and its wash with it, so a chosen chip, a tag
    // and the handoff bar read in the brand rather than in the default blue.
    const a = this._theme.accent;
    const theme: AgentTheme = a
      ? { accentStrong: `color-mix(in srgb, ${a} 70%, var(--ink))`, accentTint: `color-mix(in srgb, ${a} 9%, var(--bg))`, ...this._theme }
      : this._theme;
    for (const [key, value] of Object.entries(theme)) {
      const props = THEME_TOKENS[key as keyof AgentTheme];
      if (!props || !value) continue;
      for (const prop of props) this.style.setProperty(prop, value);
    }
  }

  private _template(): string {
    return `
    <style>
      /* NxisAI Visual Direction — tokens from design.md (drop-in CSS). */
      :host {
        all: initial;
        --bg:#FFFFFF; --surface:#F5F7FB; --surface-2:#EDF1F9;
        --border:#E4E9F2; --border-strong:#CFD8E8;
        --ink:#0F172A; --ink-2:#475569; --ink-3:#8A97AC;
        --blue:#2563EB; --blue-strong:#1D4ED8; --blue-tint:#EEF3FF;
        --green:#22C55E; --green-strong:#16A34A; --green-tint:#E8FAEF;
        --inline-bg:#EEF2F8; --red:#B91C1C; --stop:#DC2626; --stop-strong:#B91C1C;
        --radius:14px; --radius-sm:10px; --radius-pill:999px;
        --shadow-sm:0 1px 2px rgba(15,23,42,.05);
        --shadow:0 1px 2px rgba(15,23,42,.04), 0 10px 30px rgba(15,23,42,.06);
        --display:'Manrope', system-ui, sans-serif;
        --sans:'Inter', system-ui, sans-serif;
        --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-family: var(--sans);

        /*
         * Tailwind v4 composes box-shadow, ring and border-style from --tw-*
         * custom properties, and "all: initial" above wipes them, so every
         * child inherits empty values, and shadow/border utilities resolve to
         * nothing while looking perfectly correct in the stylesheet. Restoring
         * the defaults here is what makes those utilities work inside a shadow
         * root that isolates itself from the page.
         */
        --tw-shadow: 0 0 #0000;
        --tw-inset-shadow: 0 0 #0000;
        --tw-ring-shadow: 0 0 #0000;
        --tw-inset-ring-shadow: 0 0 #0000;
        --tw-ring-offset-shadow: 0 0 #0000;
        --tw-border-style: solid;
      }

      /* Tailwind, scoped to this shadow root. Utilities resolve to the NxisAI
         palette because agent.tw.css themes them from design.md. */
      ${TAILWIND_CSS}

      /* A2UI surfaces inherit the tokens above through --a2ui-* bridges. */
      ${A2UI_THEME_CSS}

      /* The action card: forms and handoffs as one message. */
      ${ACTION_CARD_CSS}

      /* Search results as an answer: a pick and why, or a short list. */
      ${RESULTS_ANSWER_CSS}

      /* App-icon tile: chevron centered in a 56px tile, Soft Gray, hairline. */
      .launcher {
        position: fixed; right: 20px; bottom: 20px; z-index: 9998;
        width: 56px; height: 56px; border-radius: var(--radius); cursor: pointer; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid var(--border); background: var(--surface);
        box-shadow: var(--shadow-sm);
        transition: transform .15s ease, box-shadow .15s ease;
      }
      .launcher:hover { transform: translateY(-2px); box-shadow: var(--shadow); }
      .launcher svg, .launcher img { width: 34px; height: auto; display: block; }

      .overlay { position: fixed; inset: 0; z-index: 9999; display: none; background: var(--bg); color: var(--ink); }
      .overlay.show { display: flex; animation: fade .2s ease; }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

      /* ── Window mode ────────────────────────────────────────────
         The same panel, docked in a corner rather than covering the
         page — for a site that wants an assistant beside its content
         instead of in front of it. The host sets the size through
         --window-w and --window-h. */
      .overlay.window {
        inset: auto; right: 20px; bottom: 20px;
        width: min(var(--window-w, 400px), calc(100vw - 32px));
        height: min(var(--window-h, 620px), calc(100vh - 32px));
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        box-shadow: 0 24px 60px rgba(15,23,42,.22);
        overflow: hidden;
      }
      /* ── Inline mode ────────────────────────────────────────────
         Fills whatever box the host puts it in — a copilot rail, a sidebar,
         a column — and leaves where that box goes, and what the page does
         to make room, to the host. Always open: there is no launcher to
         press and nothing to close back to. */
      :host([mode="inline"]) { display: block; position: relative; height: 100%; }
      :host([mode="inline"]) .launcher { display: none; }
      /* overflow: hidden is what keeps the conversation drawer inside the
         host's box. Closed, the drawer waits just off the left edge; without
         the clip it sits on top of the host's page, and pressing the menu
         only slides it between two visible places. */
      .overlay.inline { position: absolute; inset: 0; z-index: auto; animation: none; overflow: hidden; }
      .overlay.inline .close { display: none; }

      /* The conversation list cannot sit beside a narrow thread, so in a
         window or a rail it behaves as the drawer the narrow layout already
         defines, whatever the viewport is doing. */
      .overlay.window .side, .overlay.inline .side, .overlay.contained .side {
        position: absolute; inset: 0 auto 0 0; z-index: 6;
        transform: translateX(-100%); transition: transform .2s ease;
        box-shadow: 0 18px 48px rgba(15,23,42,.18);
      }
      .overlay.window.nav .side, .overlay.inline.nav .side, .overlay.contained.nav .side { transform: none; }
      .overlay.window.nav .scrim, .overlay.inline.nav .scrim, .overlay.contained.nav .scrim {
        display: block; position: absolute; inset: 0; z-index: 5;
        background: rgba(15,23,42,.32);
      }
      .overlay.window .menu, .overlay.inline .menu, .overlay.contained .menu { display: flex; }
      .overlay.window .msg, .overlay.inline .msg, .overlay.contained .msg { max-width: 88%; }
      .overlay.window .hist-del, .overlay.inline .hist-del, .overlay.contained .hist-del { opacity: 1; }
      .overlay.window .main-head, .overlay.inline .main-head, .overlay.contained .main-head { padding: 12px 14px; }
      .overlay.window .thread, .overlay.inline .thread, .overlay.contained .thread { padding: 14px; }
      @media (prefers-reduced-motion: reduce) {
        .overlay.window .side, .overlay.inline .side, .overlay.contained .side { transition: none; }
      }

      /* ── Journeys ───────────────────────────────────────────────
         What the agent did about a request, as a card under it. */
      .msg.journey { align-self: stretch; max-width: 100%; padding: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg); overflow: hidden; }
      .msg.journey > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 12.5px; color: var(--ink-2); }
      .msg.journey > summary::-webkit-details-marker { display: none; }
      .msg.journey > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
      .msg.journey[open] > summary { background: var(--surface); border-bottom: 1px solid var(--border); }
      .j-title { font-family: var(--display); font-weight: 700; color: var(--ink); white-space: nowrap; }
      .j-state { margin-left: auto; min-width: 0; font-size: 11.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .j-sum-mark { width: 16px; height: 16px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; }
      .is-running .j-sum-mark { border: 2px solid var(--blue); border-right-color: transparent; animation: jspin 1s linear infinite; }
      .is-done .j-sum-mark { background: var(--green-tint); color: var(--green-strong); }
      .is-failed .j-sum-mark { background: rgba(185,28,28,.1); color: var(--red); }
      .is-failed .j-state { color: var(--red); }
      @keyframes jspin { to { transform: rotate(360deg); } }
      .j-steps { list-style: none; margin: 0; padding: 12px; display: grid; }
      .j-step { display: grid; grid-template-columns: 20px 1fr; gap: 10px; position: relative; padding-bottom: 10px; font-size: 12.5px; }
      .j-step:last-child { padding-bottom: 0; }
      .j-step:not(:last-child)::before { content: ''; position: absolute; left: 9px; top: 21px; bottom: 1px; width: 1px; background: var(--border-strong); }
      .j-mark { width: 19px; height: 19px; border-radius: 50%; border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink-3); font-size: 10px; display: grid; place-items: center; z-index: 1; }
      .j-step.is-done .j-mark { background: var(--green-tint); border-color: var(--green-strong); color: var(--green-strong); }
      .j-step.is-active .j-mark { background: var(--blue); border-color: var(--blue); color: #fff; }
      .j-step.is-failed .j-mark { background: rgba(185,28,28,.1); border-color: var(--red); color: var(--red); }
      .j-label { color: var(--ink-2); line-height: 1.35; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .j-label small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .j-step:hover .j-label, .j-step:hover .j-label small { white-space: normal; overflow: visible; }
      .j-step.is-done .j-label, .j-step.is-active .j-label { color: var(--ink); }
      .j-step.is-active .j-label { font-weight: 600; }
      .j-label small { display: block; font-size: 11px; font-weight: 400; color: var(--ink-3); margin-top: 1px; }

      /* The running step, while its card is scrolled out of view. */
      .jstatus { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-bottom: 1px solid var(--border); background: var(--blue-tint); color: var(--ink); font-family: var(--sans); font-size: 12.5px; font-weight: 600; padding: 8px 20px; cursor: pointer; text-align: left; }
      .jstatus[hidden] { display: none; }
      .jstatus:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
      .js-spin { width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid var(--blue); border-right-color: transparent; animation: jspin 1s linear infinite; }
      .js-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .js-go { margin-left: auto; font-weight: 500; color: var(--blue-strong); }
      .overlay.window .jstatus, .overlay.inline .jstatus { padding: 8px 14px; }
      @media (prefers-reduced-motion: reduce) { .is-running .j-sum-mark, .js-spin { animation: none; } }
      /* Narrower than the card, a card is the viewport: drop the chrome
         rather than leaving a 16px frame around a full-height panel. */
      @media (max-width: 520px) {
        .overlay.window:not(.contained) { inset: 0; width: auto; height: auto; border: 0; border-radius: 0; box-shadow: none; }
      }

      /* ── Contained: the window and launcher in the host's box ── */
      :host([contained]) { display: block; position: relative; z-index: 0; height: 100%; overflow: hidden; }
      :host([contained]) .launcher, .overlay.contained { position: absolute; }
      .overlay.contained.window { width: min(var(--window-w, 400px), calc(100% - 32px)); height: min(var(--window-h, 620px), calc(100% - 32px)); }

      /* ── Side panel ─────────────────────────────────────────────── */
      .scrim { display: none; }
      .side { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; background: var(--surface); border-right: 1px solid var(--border); }
      .side-head { display: flex; align-items: center; gap: 10px; padding: 16px 14px 12px; }
      .side-head .brand { width: 22px; height: 22px; display: block; }
      .side-head .brand svg, .side-head .brand img { width: 22px; height: auto; display: block; }
      .side-title { font-family: var(--display); font-weight: 800; font-size: 14px; }
      .newchat, .modebtn { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--ink-2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .newchat:hover, .modebtn:hover { color: var(--blue-strong); border-color: var(--blue); }
      .modebtn[hidden] { display: none; }
      .modebtn:not([hidden]) + .close { margin-left: 0; }
      .newchat svg, .modebtn svg { width: 16px; height: 16px; }
      .history { flex: 1; overflow-y: auto; padding: 6px 10px; display: flex; flex-direction: column; gap: 3px; }
      .hist-row { display: flex; align-items: center; border-radius: 8px; }
      .hist-row:hover { background: var(--surface-2); }
      .hist-row.active { background: var(--blue-tint); }
      .hist-item { flex: 1; min-width: 0; text-align: left; background: none; border: none; padding: 9px 10px; font-family: var(--sans); font-size: 13px; color: var(--ink-2); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hist-row.active .hist-item { color: var(--blue-strong); font-weight: 600; }
      .hist-del { flex-shrink: 0; opacity: 0; width: 26px; height: 26px; margin-right: 4px; border: none; background: none; color: var(--ink-3); cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
      .hist-row:hover .hist-del, .hist-row.active .hist-del { opacity: 1; }
      .hist-del:hover { color: var(--red); background: var(--bg); }
      .hist-del svg { width: 15px; height: 15px; }

      
      
      
      
      
      
      
      
      
      
      

      /* ── Main view ──────────────────────────────────────────────── */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .main-head { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
      .menu { display: none; width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--ink-2); cursor: pointer; align-items: center; justify-content: center; }
      .menu svg { width: 18px; height: 18px; }
      .main-head .brand { width: 24px; height: 24px; display: block; }
      .main-head .brand svg, .main-head .brand img { width: 24px; height: auto; display: block; }
      .main-head h2 { margin: 0; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--display); font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
      .main-head .provenance { flex: none; }
      /* Tags & chips — Inter 500 13px pill, optional leading dot. */
      .tag { font-family: var(--sans); font-weight: 500; font-size: 13px; padding: 4px 12px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--bg); display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
      .tag .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); }
      .tag.blue { color: var(--blue-strong); background: var(--blue-tint); border-color: transparent; }
      .tag.blue .dot { background: var(--blue); }
      .tag.green { color: var(--green-strong); background: var(--green-tint); border-color: transparent; }
      .tag.green .dot { background: var(--green); }
      .main-head .close { margin-left: auto; background: none; border: none; font-size: 24px; line-height: 1; color: var(--ink-3); cursor: pointer; font-family: inherit; }
      .prog { height: 2px; background: var(--surface-2); }
      .prog > i { display: block; height: 100%; width: 0; background: var(--blue); transition: width .2s ease; }

      .thread { flex: 1; overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 10px; }
      /* The thread scrolls; what is in it never shrinks to fit. A child with overflow other than visible (an answer
         with Sources, a journey) has no content-sized minimum, so it would shrink to a sliver of itself. */
      .thread > * { flex-shrink: 0; }
      .empty { margin: auto; text-align: center; color: var(--ink-3); display: flex; flex-direction: column; align-items: center; gap: 14px; }
      .empty svg, .empty img { width: 44px; height: auto; opacity: .9; }
      .empty p { max-width: 320px; font-size: 14px; line-height: 1.5; }
      .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 460px; }
      .chip { font-family: var(--sans); font-weight: 500; font-size: 13px; padding: 6px 14px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink-2); cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease; }
      .chip:hover { border-color: var(--blue); color: var(--blue-strong); background: var(--blue-tint); }

      /* Thinking indicator — three dots and an optional phase label. */
      .msg.thinking { display: inline-flex; align-items: center; gap: 10px; }
      .think-dots { display: inline-flex; align-items: center; gap: 4px; }
      .think-dots i {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--ink-3); display: block;
        animation: nxis-think 1.2s ease-in-out infinite;
      }
      .think-dots i:nth-child(2) { animation-delay: .15s; }
      .think-dots i:nth-child(3) { animation-delay: .3s; }
      @keyframes nxis-think {
        0%, 80%, 100% { opacity: .28; transform: translateY(0); }
        40%           { opacity: 1;   transform: translateY(-3px); }
      }
      .think-label {
        font-family: var(--mono); font-size: 11px; font-weight: 500;
        letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3);
      }
      .think-label:empty { display: none; }

      /* ── The wait, with numbers on it ──────────────────────────────────
         A first run downloads gigabytes. Dots alone say "working"; they never
         say "for how long", which is the only question a multi-minute wait
         raises. The line appears for the phases that have bytes behind them
         and stays hidden for the ones that do not. */
      .msg.thinking { flex-direction: column; align-items: stretch; gap: 8px; min-width: 190px; }
      .think-row { display: inline-flex; align-items: center; gap: 10px; }
      .think-bytes {
        margin-left: auto; font-family: var(--mono); font-size: 10px;
        color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .think-bytes:empty { display: none; }

      /* ── The mark, charging ────────────────────────────────────────────
         Same progress, drawn on the object already sitting in the empty
         state. The ring wraps whatever the host set as their logo, so the
         thing that fills is theirs. */
      .empty-mark { position: relative; display: grid; place-items: center; }
      .empty-mark .ring {
        --pct: 0;
        position: absolute; inset: -13px;
        border-radius: 50%;
        background: conic-gradient(var(--blue) calc(var(--pct) * 1%), var(--surface-2) 0);
        transition: background .35s linear;
      }
      .empty-mark .ring::after {
        content: ""; position: absolute; inset: 3px;
        border-radius: 50%; background: var(--bg);
      }
      .empty-mark svg, .empty-mark img { position: relative; z-index: 1; }

      /* The stage, standing in for the invitation while weights arrive. */
      .empty .stage {
        font-family: var(--mono); font-weight: 500; font-size: 11px;
        letter-spacing: .05em; color: var(--ink-2); margin: 0;
      }
      .empty .stage-bytes {
        font-family: var(--mono); font-size: 10px; color: var(--ink-3);
        font-variant-numeric: tabular-nums; margin: -8px 0 0;
      }
      .empty .stage-bytes:empty { display: none; }
      /* The suggestions have waited for the model; let them arrive, rather than
         appearing as though they had been there all along. */
      .chips.appear { animation: nxis-chips-in .32s ease both; }
      @keyframes nxis-chips-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: none; }
      }

      /* The header mark carries what is left of the load once the thread is
         open: the same ring, smaller, out of the conversation's way. */
      .main-head .head-mark { position: relative; display: grid; place-items: center; }
      /* The ring is absolutely positioned, so it paints above a static sibling,
         and its ::after fills the middle with the panel colour. Without this the
         disc covers the logo and the header shows an empty circle. */
      .main-head .brand { position: relative; z-index: 1; }
      .main-head .head-ring {
        --pct: 0; position: absolute; inset: -4px; border-radius: 50%;
        background: conic-gradient(var(--blue) calc(var(--pct) * 1%), var(--surface-2) 0);
        transition: background .35s linear;
      }
      .main-head .head-ring::after {
        content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--bg);
      }
      /* No numbers yet: sweep instead of sitting at zero, which reads as hung. */
      .empty-mark .ring.indet, .main-head .head-ring.indet {
        background: conic-gradient(from 0deg, transparent 0deg, var(--blue) 300deg, transparent 360deg);
        animation: nxis-ring-spin 1.1s linear infinite;
      }
      @keyframes nxis-ring-spin { to { transform: rotate(360deg); } }
      /*
       * Motion carries the signal here, so removing it needs a replacement
       * rather than a still frame: the dots hold a steady mid-opacity so the
       * bubble still reads as pending.
       */
      @media (prefers-reduced-motion: reduce) {
        /* The rings carry information, so they stay; only their easing goes. */
        .empty-mark .ring, .main-head .head-ring, .caret { transition: none; }
        .chips.appear { animation: none; }
        /* A spin with the motion removed has to still say "busy": hold a
           partial arc rather than an empty track. */
        .empty-mark .ring.indet, .main-head .head-ring.indet {
          animation: none;
          background: conic-gradient(var(--blue) 25%, var(--surface-2) 0);
        }
        .think-dots i { animation: none; opacity: .5; }
      }

      /* Bubble styling now lives in _msgEl as Tailwind utilities. The .msg
         class is kept only as a hook for the wrappers below, which are layout
         rather than bubbles — so there is nothing here to undo. */
      
      
      
      .msg.tool.error { border-color: var(--red); color: var(--red); }
      .msg.tool b { display: inline-flex; align-items: center; gap: 6px; }
      .msg.tool svg { width: 14px; height: 14px; }
      .msg.form, .msg.detail { align-self: flex-start; width: 100%; max-width: 380px; }

      /* ── The receipt ───────────────────────────────────────────────────
         Muted enough to scroll past, addressable when something looks wrong. */
      /* The route, when debugging: quieter than a receipt, since it is one
         word of provenance rather than something to read. */
      .routeline {
        align-self: flex-start; font-family: var(--mono); font-size: 10px;
        letter-spacing: .06em; color: var(--ink-3); opacity: .8; padding: 1px 0;
      }

      details.trace { align-self: flex-start; max-width: 92%; }
      details.trace > summary {
        cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 7px;
        font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em;
        color: var(--ink-3); padding: 2px 0;
      }
      details.trace > summary::-webkit-details-marker { display: none; }
      details.trace > summary:hover { color: var(--ink-2); }
      details.trace > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 4px; }
      details.trace.err > summary { color: var(--red); }
      .caret {
        width: 0; height: 0; border-left: 4px solid currentColor;
        border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;
        transition: transform .16s ease; flex-shrink: 0;
      }
      details.trace[open] .caret { transform: rotate(90deg); }
      .trace-body {
        margin-top: 7px; background: var(--surface); border: 1px solid var(--border);
        border-radius: 9px; padding: 9px 11px; display: flex; flex-direction: column; gap: 6px;
      }
      .trace-label {
        font-family: var(--mono); font-size: 9.5px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--ink-3);
      }
      .trace-body pre {
        margin: 0; font-family: var(--mono); font-size: 10.5px; line-height: 1.5;
        color: var(--ink-2); white-space: pre-wrap; word-break: break-word;
        max-height: 160px; overflow-y: auto;
      }
      .trace-body pre.raw { color: var(--ink); }

      .statusline { font-family: var(--mono); font-weight: 500; font-size: 11px; letter-spacing: 0.04em; color: var(--ink-3); padding: 4px 20px 0; min-height: 15px; }
      .statusline.err { color: var(--red); }
      /* ── Composer: the input, with a bar beneath it ─────────────
         Tools on the left, the model beside them, send or stop on the
         right. One box around both, so the bar reads as part of the input
         rather than a second control strip. */
      .composer { padding: 12px 20px 14px; border-top: 1px solid var(--border); }
      .overlay.window .composer, .overlay.inline .composer { padding: 10px 12px 12px; }
      .cbox { border: 1px solid var(--border-strong); border-radius: 14px; background: var(--bg); padding: 8px 8px 8px 12px; transition: border-color .15s ease, box-shadow .15s ease; }
      .cbox:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-tint); }
      .composer textarea {
        display: block; width: 100%; font-family: var(--sans); font-size: 14px; line-height: 1.45; color: var(--ink); resize: none;
        background: transparent; border: 0; padding: 2px 2px 8px; outline: none; max-height: 140px; overflow-y: auto;
      }
      .composer textarea::placeholder { color: var(--ink-3); }
      .composer textarea:disabled, .chip[aria-disabled] { cursor: not-allowed; }
      .chip[aria-disabled]:hover { border-color: var(--border-strong); color: var(--ink-2); background: var(--bg); }
      .cbar { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .composer .go { margin-left: auto; flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px; border: none; background: var(--blue); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 2px rgba(37,99,235,.3); }
      .composer .go:hover { background: var(--blue-strong); }
      .composer .go:disabled { opacity: .45; cursor: not-allowed; }
      /* Stop is red, with a filled white square: while a prompt runs this is
         the one control that matters, and it has to be found at a glance. */
      .composer .go.stop { background: var(--stop); color: #fff; border: 0; box-shadow: 0 0 0 3px rgba(220,38,38,.18); }
      .composer .go.stop:hover { background: var(--stop-strong); }
      .composer .go.stop svg { width: 15px; height: 15px; }
      .composer .go.stop svg path { fill: currentColor; }
      .composer .go:focus-visible, .tools-btn:focus-visible, .modebtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

      .model { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin-left: 2px; font-size: 12px; font-weight: 500; color: var(--ink-2); white-space: nowrap; overflow: hidden; }
      .model-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--green); }
      .model.busy .model-dot { background: var(--blue); animation: mpulse 1.2s ease-in-out infinite; }
      @keyframes mpulse { 50% { opacity: .35; } }
      .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .model-where { flex: none; font-family: var(--mono); font-size: 10px; letter-spacing: .04em; color: var(--ink-3); }

      /* ── Tools menu ── */
      .tools { position: relative; flex: none; }
      .tools-btn { position: relative; width: 32px; height: 32px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--bg); color: var(--ink-2); display: grid; place-items: center; cursor: pointer; padding: 0; }
      .tools-btn:hover { color: var(--ink); border-color: var(--ink-3); }
      .tools-btn[aria-expanded="true"] { border-color: var(--blue); color: var(--blue); background: var(--blue-tint); }
      .tools-btn svg { width: 17px; height: 17px; }
      .tools-count { position: absolute; top: -7px; right: -7px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px; background: var(--ink); color: var(--bg); font-size: 10px; font-weight: 600; display: grid; place-items: center; border: 2px solid var(--bg); }
      .tools-count[hidden] { display: none; }
      .tools-pop { position: absolute; left: -4px; bottom: calc(100% + 12px); z-index: 20; width: 320px; max-width: calc(100vw - 48px); max-height: 380px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 13px; box-shadow: 0 14px 36px rgba(15,23,42,.16), 0 2px 6px rgba(15,23,42,.06); padding: 6px; }
      .tools-pop[hidden] { display: none; }
      .overlay.window .tools-pop, .overlay.inline .tools-pop { width: 296px; }
      .tp-head { padding: 8px 10px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
      .tp-title { font-family: var(--display); font-weight: 700; font-size: 13px; color: var(--ink); }
      .tp-sub { font-size: 11.5px; line-height: 1.4; color: var(--ink-3); margin-top: 2px; }
      .tp-grp { font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: 8px 10px 3px; }
      /* Greyed and locked: visible, not the visitor's to change. */
      .tp-tool { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 8px; cursor: default; }
      .tp-ti { width: 24px; height: 24px; flex: none; border-radius: 6px; background: var(--surface-2); color: var(--ink-3); display: grid; place-items: center; opacity: .75; }
      .tp-ti svg { width: 13px; height: 13px; }
      .tp-tn { min-width: 0; flex: 1; }
      .tp-name { display: block; font-size: 12.5px; font-weight: 500; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tp-desc { display: block; font-size: 11px; color: var(--ink-3); opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tp-kind { flex: none; font-family: var(--mono); font-size: 9px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
      .tp-lock { flex: none; width: 13px; height: 13px; color: var(--ink-3); opacity: .7; display: grid; }
      .tp-lock svg { width: 13px; height: 13px; }
      .tp-empty { padding: 12px 10px; font-size: 12px; color: var(--ink-3); }
      .tp-foot { padding: 8px 10px 4px; margin-top: 4px; border-top: 1px solid var(--border); font-size: 11px; color: var(--ink-3); }
      @media (prefers-reduced-motion: reduce) { .model.busy .model-dot { animation: none; } }
      /* A message the person sent, plus the row of things they can do to it.
         The wrapper carries the alignment the bubble used to carry on its own. */
      .turn { display: flex; flex-direction: column; align-items: flex-end; }
      .turn:focus { outline: none; }
      .turn .msg.user { align-self: flex-end; }
      .actions { display: flex; gap: 2px; padding: 2px 2px 0; }
      .act {
        display: grid; place-items: center; width: 26px; height: 26px; padding: 0;
        background: none; border: none; border-radius: 7px; cursor: pointer;
        color: var(--ink-3); transition: color .12s ease, background .12s ease;
      }
      .act:hover { color: var(--ink-2); background: var(--surface); }
      .act:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
      .act svg { width: 15px; height: 15px; display: block; }
      .act.done { color: var(--green-strong); }

      /* Split on hover capability, not on width: a touch laptop needs the row
         visible and a narrow desktop window does not. Where there is no hover,
         the actions are simply there, because no gesture will reveal them. */
      .actions { opacity: .55; transition: opacity .13s ease; }
      @media (hover: hover) {
        .actions { opacity: 0; }
        .turn:hover .actions,
        .turn:focus-within .actions { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .actions { transition: none; }
      }

      .editing {
        align-self: flex-end; max-width: 84%; width: 84%;
        display: flex; flex-direction: column; gap: 7px;
        background: var(--bg); border: 1px solid var(--blue); border-radius: 12px; padding: 9px 10px;
      }
      .editing textarea {
        width: 100%; border: none; outline: none; resize: none; background: transparent;
        font-family: var(--sans); font-size: 13px; line-height: 1.5; color: var(--ink);
      }
      .edit-actions { display: flex; gap: 7px; justify-content: flex-end; }
      .ebtn {
        font-family: var(--sans); font-size: 12px; font-weight: 500; border-radius: 8px;
        padding: 5px 11px; cursor: pointer; border: 1px solid var(--border-strong);
        background: var(--bg); color: var(--ink-2);
      }
      .ebtn:hover { border-color: var(--blue); color: var(--blue-strong); }
      .ebtn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
      .ebtn.primary:hover { background: var(--blue-strong); color: #fff; }
      .edit-hint {
        font-family: var(--mono); font-size: 10px; letter-spacing: .05em;
        color: var(--ink-3); align-self: flex-end; padding-top: 2px;
      }

      .stopped-note {
        align-self: flex-start;
        font-size: 12px;
        color: var(--ink-3);
        padding: 2px 0 6px;
        letter-spacing: .01em;
      }

      /* Handoffs. A target's message is a bubble with its name above; where the
         handoff stands is a quiet centred line; the bar says who is listening. */
      .remote { align-self: flex-start; display: flex; flex-direction: column; gap: 4px; max-width: 76%; }
      .remote .msg { max-width: 100%; }
      .remote.has-cards { max-width: min(100%, 460px); }
${REMOTE_ANSWER_CSS}
      .remote-from { font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; color: var(--ink-3); padding-left: 4px; }
      .handoff-note { align-self: center; font-size: 12px; color: var(--ink-3); padding: 2px 12px 6px; text-align: center; letter-spacing: .01em; }
      .handoff-note.done { color: var(--green-strong); }
      .handoff-note.error { color: var(--red); }
      /* Handed off: a strip under the header, in the accent's tint, naming who has the conversation. */
      .handoff-bar { display: flex; align-items: center; gap: 8px; padding: 6px 14px 6px 20px; background: var(--blue-tint); border-bottom: 1px solid color-mix(in srgb, var(--blue) 22%, var(--bg)); color: var(--blue-strong); font-family: var(--sans); font-size: 12.5px; line-height: 1.4; }
      .handoff-bar[hidden] { display: none; }
      .handoff-bar svg { width: 16px; height: 16px; flex: none; }
      .handoff-bar .hb-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .handoff-bar .hb-label b { font-weight: 600; }
      .handoff-bar .hb-back { flex: none; min-height: 32px; border: 0; background: none; color: inherit; padding: 4px; font: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; border-radius: 6px; }
      .handoff-bar .hb-back:hover { text-decoration-thickness: 2px; }
      .handoff-bar .hb-back:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .overlay.window .handoff-bar, .overlay.inline .handoff-bar, .overlay.contained .handoff-bar { padding-left: 14px; }
      .composer .go svg { width: 17px; height: 17px; }

      /* Attribution. Quiet enough to sit under a customer's own chat surface
         without competing with it, legible enough to be worth having. */
      .foot { display: flex; justify-content: center; padding: 0 20px 12px; }
      .powered {
        display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
        font-family: var(--mono); font-weight: 500; font-size: 10px; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--ink-3);
        border-radius: var(--radius-pill); padding: 4px 10px;
        transition: color .15s ease, background .15s ease;
      }
      .powered:hover { color: var(--ink-2); background: var(--surface); }
      .powered:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .powered svg { width: 13px; height: auto; display: block; flex-shrink: 0; }

      /* ── Inline generated form ──────────────────────────────────── */
      .genform { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 18px 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 13px; }
      .genform-head { display: flex; flex-direction: column; gap: 3px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
      .gf-tool { font-family: var(--display); font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
      .gf-desc { font-size: 13px; color: var(--ink-2); }
      .field { display: flex; flex-direction: column; gap: 5px; }
      .field label { font-family: var(--mono); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); }
      .field .req { color: var(--blue); }
      .field input, .field select {
        font-family: var(--sans); font-size: 14px; color: var(--ink);
        background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 9px 11px; outline: none;
        transition: border-color .15s ease, box-shadow .15s ease;
      }
      .field input:focus, .field select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-tint); }
      .field input.invalid, .field select.invalid { border-color: var(--red); box-shadow: 0 0 0 3px rgba(185,28,28,.12); }
      .field .check { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink); }
      .field .check input { width: auto; }
      .genform-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 2px; }
      /* Buttons — radius 10, weight 600; Action confirms a positive outcome,
         Secondary (ghost class) is the alternative path. */
      .btn { font-family: var(--sans); font-size: 14px; font-weight: 600; border-radius: var(--radius-sm); padding: 11px 20px; cursor: pointer; border: 1px solid transparent; display: inline-flex; align-items: center; gap: 8px; transition: .15s; }
      .btn svg { width: 16px; height: 16px; }
      .btn.ghost { background: var(--bg); border-color: var(--border-strong); color: var(--ink); }
      .btn.ghost:hover { border-color: var(--ink-3); }
      /*
       * Signal Blue, not Action Green. design.md §4 gives green to "confirm a
       * positive outcome", which is the submitted card's badge and eyebrow,
       * after the fact. The button is the main path before anything has
       * happened, and that is blue. Using green on both blurred "about to
       * happen" into "has happened".
       *
       * It also has to be blue to stay consistent with the A2UI cards:
       * --a2ui-color-primary drives their primary buttons AND their
       * ChoicePicker selection, so repointing it at green would have coloured
       * "Water Heaters" as a positive outcome rather than a choice.
       */
      .btn.primary { background: var(--blue); color: #fff; }
      .btn.primary:hover { background: var(--blue-strong); }
      .btn:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
      .genform-result { display: none; font-size: 13px; align-items: center; gap: 8px; padding: 2px; }
      .genform-result.error { display: flex; color: var(--red); }
      .genform-result svg { width: 16px; height: 16px; flex-shrink: 0; }
      .gf-empty { color: var(--ink-3); font-size: 14px; }

      /* ── Inline detail (confirmation) card ──────────────────────── */
      .detailcard { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 4px; }
      .dc-badge { width: 44px; height: 44px; border-radius: 50%; background: var(--green-tint); color: var(--green-strong); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
      .dc-badge svg { width: 22px; height: 22px; }
      .dc-eyebrow { font-family: var(--mono); font-weight: 500; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--green-strong); }
      .dc-title { font-family: var(--display); font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
      .dc-sub { font-size: 13px; color: var(--ink-2); margin-bottom: 6px; }
      .dc-list { margin: 6px 0 0; border-top: 1px solid var(--border); }
      /* Review is the before-picture of the same card. Green marks a positive
         outcome (design.md §2), and nothing has happened yet — so the pending
         state carries Signal Blue, the colour of the action about to be taken. */
      .dc-badge.review { background: var(--blue-tint); color: var(--blue); }
      .dc-eyebrow.review { color: var(--blue-strong); }
      .dc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .dc-row { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
      /* One line per row, truncated. A card in a window or a rail is too
         narrow for a long value to wrap without becoming a column of
         fragments. The whole row comes back on hover or keyboard focus, and
         every cell carries its full text as a title too. */
      .dc-row dt { font-family: var(--mono); font-weight: 500; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); padding-top: 2px; flex: 0 1 auto; min-width: 0; max-width: 45%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dc-row dd { margin: 0; flex: 1 1 auto; min-width: 0; font-size: 14px; color: var(--ink); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dc-row:hover dt, .dc-row:hover dd, .dc-row:focus-within dt, .dc-row:focus-within dd { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
      .dc-row:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 4px; }
      /* Buttons keep their words on one line and wrap as whole buttons. */
      .dc-actions { flex-wrap: wrap; }
      .dc-actions .btn { white-space: nowrap; }
      .overlay.window .dc-actions .btn, .overlay.inline .dc-actions .btn { padding: 9px 14px; font-size: 13px; }

      /* Code inside a message: monospace, and scrolled rather than wrapped,
         so a long line does not break at arbitrary places. */
      .msg .codeblock { margin: 6px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); overflow-x: auto; max-width: 100%; }
      .msg .codeblock:first-child { margin-top: 0; }
      .msg .codeblock code { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; white-space: pre; color: var(--ink); }
      .msg.user .codeblock { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.28); }
      .msg.user .codeblock code { color: #fff; }

      /* A long block folds away: kept, but not filling the thread. */
      .codefold { margin-top: 6px; }
      .codefold > summary { cursor: pointer; list-style: none; font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); padding: 2px 0; }
      .codefold > summary::-webkit-details-marker { display: none; }
      .codefold > summary::before { content: '▸ '; }
      .codefold[open] > summary::before { content: '▾ '; }
      .codefold > summary:hover { color: var(--ink-2); }
      .codefold > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 4px; }
      .codefold .codeblock { margin-top: 4px; }

      /* ── Inline result cards — feature-card pattern: tinted icon chip,
            tags, tight Manrope headline, one supporting line. ─────── */
      .msg.results { align-self: stretch; width: 100%; }
      .rc-head { font-family: var(--mono); font-weight: 500; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--blue); margin: 2px 0 10px; }
      .rc-empty { font-size: 13px; color: var(--ink-2); padding: 8px 0; }
      .rc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
      .resultcard { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; display: flex; flex-direction: column; gap: 4px; box-shadow: var(--shadow-sm); transition: box-shadow .15s ease, transform .15s ease; }
      .resultcard:hover { box-shadow: var(--shadow); transform: translateY(-1px); }
      .rc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .rc-chip { width: 44px; height: 44px; border-radius: 50%; background: var(--blue-tint); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .rc-chip svg, .rc-chip img { width: 21px; height: auto; display: block; }
      .rc-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      .rc-tags .tag { font-size: 12px; padding: 3px 10px; }
      .rc-title { font-family: var(--display); font-size: 16px; font-weight: 800; color: var(--ink); line-height: 1.25; letter-spacing: -0.01em; }
      .rc-sub { font-size: 13px; line-height: 1.5; color: var(--ink-2); margin-top: 2px; }
      .rc-list { margin: 10px 0 0; border-top: 1px solid var(--border); display: flex; flex-direction: column; }
      .rc-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 1.4; }
      .rc-row dt { font-family: var(--mono); font-weight: 500; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); flex: 0 1 auto; min-width: 0; max-width: 45%; padding-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rc-row dd { margin: 0; flex: 1 1 auto; min-width: 0; color: var(--ink); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rc-row:hover dt, .rc-row:hover dd, .rc-row:focus-within dt, .rc-row:focus-within dd { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
      /* The headline and its supporting line truncate too, and come back
         when the card is hovered or focused. */
      .rc-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rc-sub { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .resultcard:hover .rc-title, .resultcard:focus-within .rc-title { white-space: normal; overflow: visible; }
      .resultcard:hover .rc-sub, .resultcard:focus-within .rc-sub { -webkit-line-clamp: unset; overflow: visible; }
      .rc-id { margin-top: 10px; min-width: 0; }
      .rc-open { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 13px; font-weight: 600; color: var(--blue-strong); text-decoration: none; }
      .rc-open span { transition: transform 120ms ease; }
      .rc-open:hover { text-decoration: underline; }
      .rc-open:hover span { transform: translateX(2px); }
      .rc-open:focus-visible { outline: 2px solid var(--blue-strong); outline-offset: 2px; border-radius: 4px; }
      .rc-id code { display: block; font-family: var(--mono); font-size: 10px; color: var(--blue-strong); background: var(--inline-bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rc-row dd a { color: var(--blue-strong); text-decoration: none; }
      .rc-row dd a:hover { text-decoration: underline; }

      /* ── Metrics panel (technical details on demand) ─────────────── */
      .msg.metrics { align-self: stretch; width: 100%; max-width: 100%; background: none; border: none; padding: 0; white-space: normal; }
      .metricscard { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
      .metricscard summary { cursor: pointer; list-style: none; font-family: var(--mono); font-weight: 500; font-size: 11px; letter-spacing: 0.06em; color: var(--ink-2); padding: 11px 16px; user-select: none; }
      .metricscard summary::-webkit-details-marker { display: none; }
      .metricscard summary:hover { color: var(--blue-strong); }
      .metricscard[open] summary { border-bottom: 1px solid var(--border); }
      .mx-table { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 12px; }
      .mx-table th { font-family: var(--mono); font-weight: 500; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); text-align: left; padding: 4px 8px 6px 0; border-bottom: 1px solid var(--border); }
      .mx-table td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--border); color: var(--ink-2); }
      .mx-table th.num, .mx-table td.num { text-align: right; font-family: var(--mono); font-size: 11px; }
      .mx-table tr.total td { color: var(--ink); font-weight: 600; border-bottom: none; }
      .mx-compare { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
      .mx-compare-title { font-family: var(--mono); font-weight: 500; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 2px; }
      .mx-bar-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
      .mx-bar-label { font-family: var(--mono); font-size: 10px; color: var(--ink-3); width: 56px; flex-shrink: 0; }
      .mx-bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
      .mx-bar-track i { display: block; height: 100%; border-radius: 4px; }
      .mx-bar-track i.mcp { background: var(--blue); }
      .mx-bar-track i.rag { background: var(--ink-3); }
      .mx-bar-value { font-family: var(--mono); font-size: 11px; color: var(--ink-2); width: 64px; text-align: right; flex-shrink: 0; }
      .mx-savings { align-self: flex-start; font-size: 12px; font-weight: 600; border-radius: var(--radius-pill); padding: 4px 12px; margin-top: 2px; }
      .mx-savings.pos { color: var(--green-strong); background: var(--green-tint); }
      .mx-savings.neg { color: var(--red); background: #FEF2F2; }
      .mx-note { font-size: 11px; line-height: 1.5; color: var(--ink-3); }

      @media (max-width: 840px) {
        .side { position: absolute; inset: 0 auto 0 0; z-index: 6; transform: translateX(-100%); transition: transform .2s ease; box-shadow: 0 18px 48px rgba(15,23,42,.18); }
        .overlay.nav .side { transform: none; }
        /* Under the drawer, over the conversation: the strip of thread still
           showing beside the drawer is what a tap to dismiss lands on. */
        .overlay.nav .scrim {
          display: block; position: absolute; inset: 0; z-index: 5;
          background: rgba(15,23,42,.32);
          animation: nx-scrim-in .2s ease;
        }
        @keyframes nx-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .side { transition: none; }
          .overlay.nav .scrim { animation: none; }
        }
        .menu { display: flex; }
        .msg { max-width: 86%; }
        .hist-del { opacity: 1; }
      }
    </style>
    <button class="launcher" title="Open ${escapeHtml(this._name)}" aria-label="Open ${escapeHtml(this._name)}">${this._logoMarkup()}</button>
    <div class="overlay" role="dialog" aria-label="${escapeHtml(this._name)}">
      <div class="scrim" hidden></div>
      <aside class="side">
        <div class="side-head">
          <span class="brand">${this._logoMarkup()}</span>
          <span class="side-title">Conversations</span>
          <button class="newchat" title="New conversation" aria-label="New conversation">${ICON_PLUS}</button>
        </div>
        <div class="history"></div>
      </aside>
      <main class="main">
        <div class="main-head">
          <button class="menu" aria-label="Toggle conversations">${ICON_MENU}</button>
          <span class="head-mark"><span class="head-ring" hidden></span><span class="brand">${this._logoMarkup()}</span></span>
          <h2>${escapeHtml(this._name)}</h2>
          <span class="tag blue provenance"><i class="dot"></i>On-device</span>
          <button class="modebtn" type="button" hidden></button>
          <button class="close" aria-label="Close">×</button>
        </div>
        <div class="prog"><i></i></div>
        <div class="handoff-bar" role="status" hidden>
          ${ICON_HANDED}<span class="hb-label"></span>
          <button class="hb-back" type="button">Back to assistant</button>
        </div>
        <button class="jstatus" type="button" hidden>
          <span class="js-spin" aria-hidden="true"></span><span class="js-label"></span><span class="js-go">Show</span>
        </button>
        <div class="thread"></div>
        <div class="statusline"></div>
        <div class="composer">
          <div class="cbox">
            <textarea rows="1" placeholder="Message the agent…" aria-label="Message the agent"></textarea>
            <div class="cbar">
              <div class="tools">
                <button class="tools-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Tools on this page">${ICON_TOOLS}<span class="tools-count" hidden></span></button>
                <div class="tools-pop" role="dialog" aria-label="What the agent can use here" hidden></div>
              </div>
              <span class="model"><i class="model-dot" aria-hidden="true"></i><span class="model-name"></span><span class="model-where"></span></span>
              <button class="go" aria-label="Send">${ICON_ARROW}</button>
            </div>
          </div>
        </div>
        <footer class="foot">
          <a class="powered" href="${NXIS_SITE_URL}" target="_blank" rel="noopener noreferrer">
            ${NXIS_LOGO_SVG}<span>Powered by NxisAI</span>
          </a>
        </footer>
      </main>
    </div>`;
  }
}

let warnedAlias = false;

/**
 * `<nxis-agent-fullscreen>`, the element's name before it had a `mode`: kept
 * so pages written for it keep working, and removed in a later minor.
 *
 * It is {@link NxisAgent} with one difference. The old tag opened full screen,
 * so with no `mode` attribute and no stored toggle choice it still does; a
 * `mode` attribute, or the viewer's choice, wins as it does on `<nxis-agent>`.
 * The first one on a page logs a deprecation warning.
 *
 * @deprecated Use `<nxis-agent>` (`mode="fullscreen"` for the old default) and {@link NxisAgent}.
 */
export class NxisAgentFullscreen extends NxisAgent {
  protected override _defaultMode: 'fullscreen' | 'window' = 'fullscreen';
  constructor() {
    super();
    if (!warnedAlias) {
      warnedAlias = true;
      console.warn('<nxis-agent-fullscreen> is deprecated: use <nxis-agent>, with mode="fullscreen" to keep opening full screen.');
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'nxis-agent': NxisAgent;
    /** @deprecated Use `nxis-agent`. */
    'nxis-agent-fullscreen': NxisAgentFullscreen;
  }
}

// Loaded twice (two bundles on one page, or a module and its copy) defines once rather than throwing.
if (!customElements.get('nxis-agent')) customElements.define('nxis-agent', NxisAgent);
if (!customElements.get('nxis-agent-fullscreen')) customElements.define('nxis-agent-fullscreen', NxisAgentFullscreen);
