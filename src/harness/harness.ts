/**
 * The turn loop: discover tools, generate, parse the tool call, resolve what is
 * still unknown, decide whether to ask or act, run the tool, report the result.
 *
 * The harness decides; a {@link HarnessRenderer} draws. What a turn does
 * depends on the tool's own annotations and on how much the model supplied:
 *
 * | Tool | Missing values | Outcome |
 * |---|---|---|
 * | read | none | runs immediately, no UI |
 * | read | some | asks for those, then runs |
 *
 * A read is a step, never the end of a turn: once its results are drawn the
 * model is asked again, to call the next read it needs (a type listing, then a
 * search) or to answer in words from what came back. See
 * {@link AgentHarness.carryOn}.
 * | write | none | read-only summary and one Submit |
 * | write | several | a stepper, then a confirmation |
 *
 * @module
 */

import {
  AgentEngine,
  MAX_STEPS,
  parseToolCall,
  stripMarkers,
  humanize,
  type ChatMessage,
} from '../engine.js';
import type { ModelContextToolInfo, ModelContextToolResponse } from '../types.js';
import { LocalGemmaProvider } from '../engine.js';
import type { CacheHint, Completion, ModelProvider } from '../providers/types.js';
import { WebMcpTools } from './tools/webmcp.js';
import {
  formNoun,
  handoffFor,
  selectSiteTools,
  siteCallFit,
  withoutShadowedTools,
  withoutSiteSuffix,
  HANDOFF_RESULT,
} from './tools/action-tools.js';
import { visitFor, OPEN_PAGE_TOOL } from './tools/open-page.js';
import { extractResult, missingRequired, reconcileArgs, toolSchema } from './tools/schema.js';
import { decide, policyFor, toolOrigins, type Decision } from './policy.js';
import { buildPlan } from './plan.js';
import { resolveSlots, summarySlots, type Resolution } from './slots.js';
import { beginJourney, journeySteps, recordStep, type AgentStep } from './steps.js';
import { extractRecords } from './records.js';
import { recommend, type ResultPick } from './recommend.js';
import { HANDOFF_SESSION_RESULT, TALK_TO_A_PERSON_TOOL, isHandoffTool, refreshHandoffTools } from '../handoff/tools.js';
import { handoffCallFor, listedTargets, takingNow, handoffToolFor, pageFormTakenBy, standInFor, takerOf } from '../handoff/takes.js';
import type { HandoffController, HandoffTarget } from '../handoff/controller.js';
import type { PageFormRun } from './tools/report.js';
import type { HarnessRenderer, StreamingBubble } from './renderer.js';
// Types only: the guardrails are a chunk of their own, loaded by loadGuard's dynamic import().
import type { Guardrails, GuardrailsSource } from '../guardrails/index.js';

/**
 * The guardrails for a configuration: `@nxisai/agent-harness/guardrails`, loaded by a dynamic `import()` (once:
 * the module map keeps it), and one runtime per configuration object, so agents given the same one share its
 * state. The element passes itself, and the runtime reads its `guardrails` property and attribute live.
 *
 * @param config - What the host configured, a runtime already built, or the element.
 * @returns The runtime. Rejects, as the `import()` did, when the chunk can't load: the caller fails closed.
 */
export const loadGuard = (config: GuardrailsSource): Promise<Guardrails> =>
  import('../guardrails/index.js').then((m) => m.createGuardrails(config, toolOrigins));

/** Configuration for an {@link AgentHarness}. */
export interface HarnessOptions {
  /**
   * Where completions come from. Defaults to a {@link LocalGemmaProvider}.
   *
   * Several agents may share one provider, so a coordinator and its specialists
   * need only one model between them.
   */
  provider?: ModelProvider;
  /** Where tools come from. Defaults to the page's WebMCP registry. */
  toolSource?: WebMcpTools;
  /** The UI to drive. The only required option. */
  renderer: HarnessRenderer;
  /**
   * This agent's instructions, asserted at the start of each of its turns.
   *
   * Agents sharing a provider can each hold a different prompt, since the
   * prompt travels with the agent rather than with the model.
   */
  systemPrompt?: string;
  /**
   * Filter deciding which of the page's tools this agent may use.
   *
   * Tool definitions dominate what the model reads each turn, so narrowing them
   * shortens the prompt and reduces the number of wrong tools available to be
   * chosen. Defaults to every tool on the page.
   *
   * @param tool - A tool reported by the tool source.
   * @returns True to expose it to this agent.
   */
  tools?(tool: ModelContextToolInfo): boolean;
  /**
   * How many of the site's own action tools a turn may carry.
   *
   * A site registers one tool per form, for every page, and every tool's
   * schema is written into every prompt. Past this many, the ones belonging
   * to the current page are kept and the rest compete on how well they answer
   * what was asked. Defaults to {@link DEFAULT_SITE_TOOL_LIMIT}; the page's
   * own tools and the retrieval tools are never dropped.
   */
  maxSiteTools?: number;
  /** This agent's name, used in warnings and the default unavailable message. */
  name?: string;
  /**
   * What to say when none of this agent's tools are on the page.
   *
   * Worth setting per agent, so the message can name what cannot be done here
   * and where it can be done instead.
   */
  unavailable?: string;
  /**
   * Standing values for a tool's schema, such as a saved name or email.
   *
   * @param schema - The tool's input schema.
   * @returns Values keyed by schema property name.
   */
  profile?(schema: unknown): Record<string, unknown>;
  /**
   * Values the host page knows, such as the record currently being viewed.
   *
   * @param tool - The tool about to be called.
   * @returns Values keyed by schema property name.
   */
  context?(tool: ModelContextToolInfo): Record<string, unknown>;
  /**
   * Whether related fields share a step when asking for missing values.
   * Defaults to true. Pass false to ask one question at a time.
   */
  groupRelated?: boolean;
  /**
   * Whether a search that finds several records ends with a recommendation:
   * the model picks one and gives reasons, and only reasons the record backs
   * are kept (see `recommend`). Defaults to true. Costs one more completion
   * per search.
   */
  recommend?: boolean;
  /** The clock "open now" is judged by. For tests. */
  now?: () => Date;
  /** Called whenever the conversation changes, for hosts that persist it. */
  onMessages?(messages: ChatMessage[]): void;
  /**
   * The page's handoff controller, read at the start of each turn.
   *
   * Only needed for targets that `take` site forms (see
   * {@link HandoffTargetConfig.takes}): while such a target is available,
   * the forms it takes are left out of the tools the model is offered, a call
   * to one anyway becomes the handoff to it, and the handoff is told which
   * form it stands in for, so a resolved hand-back is reported as that form.
   * Without it, or with no such target available, forms are offered as usual.
   */
  handoff?(): HandoffController | null;
  /**
   * The guardrails every turn passes through (see `@nxisai/agent-harness/guardrails`). The standard defaults apply
   * without it. Agents given the same object share one runtime, and so one set of counters and approvals.
   */
  guardrails?: GuardrailsSource;
}

/**
 * What a turn knows about targets taking forms: the tools it offers with the
 * taken forms left out, and the targets that took them.
 */
interface Takeover {
  /** The turn's tools, without the forms an available target takes. */
  tools: ModelContextToolInfo[];
  /** The available targets that take forms and that this turn can hand off to. */
  takers: HandoffTarget[];
}

/** A handoff call and the form it stands in for, waiting for the visitor's Send. */
interface StandIn {
  target: string;
  run: PageFormRun | null;
}

/**
 * Whether a reply reads as the model asking rather than answering.
 *
 * Intentionally crude: it gates one extra generation, so a false positive costs
 * a wasted round rather than a wrong action.
 */
function looksLikeQuestion(text: string): boolean {
  return /\?\s*$/.test(stripMarkers(text).trim());
}

/** How a turn ended. */
export interface TurnResult {
  /**
   * The outcome:
   *
   * - a {@link Decision}, when a tool call was resolved;
   * - `'none'`, when the model answered in prose;
   * - `'handback'`, when the model named a tool this agent does not hold, with
   *   the name in {@link TurnResult.wanted};
   * - `'unavailable'`, when none of this agent's tools are on the page;
   * - `'stopped'`, when the user cancelled the turn;
   * - `'handoff'`, when the conversation is handed off and the message went to
   *   the target instead (see {@link HandoffController}).
   */
  decision: Decision | 'none' | 'handback' | 'unavailable' | 'stopped' | 'handoff';
  /** The tool that was called, when one was. */
  tool?: ModelContextToolInfo;
  /** The arguments it was called with. */
  values?: Record<string, unknown>;
  /**
   * The tool the model asked for and this agent does not hold.
   *
   * Set only with `decision: 'handback'`, and used by
   * {@link AgentCoordinator} to move the turn to the agent that holds it.
   */
  wanted?: string;
}

/** Stands in when a reply was neither prose nor a recognisable tool call. */
const WORKING_ON_IT = 'Working on that.';

/** How much of a read's result the model reads back: enough for a page of records' hours, prices and places. */
export const RESULT_CHARS = 4000;

/**
 * Added, for one request, to the read the model answered with nothing: the result cards are not an answer
 * on their own. Never kept in the transcript.
 */
export const ANSWER_NOW =
  'Now answer the visitor in one or two short sentences, using only what this returned. ' +
  'They see the results as cards too, so give the answer itself rather than listing every field.';

/** Said when the model gave no answer even when asked: the cards are there, the words are not. */
export const ANSWER_FALLBACK = {
  found: "Here's what I found.",
  none: "I couldn't find that here.",
} as const;

/**
 * Whether a tool lists the kinds of records a site holds (`nxis_list_types`): a step before a search, which
 * answers nothing a visitor asks about the things themselves.
 */
export const isTypeListing = (name: string): boolean => /(^|_)list_types$/.test(name);

/** A call as one string: its name and its arguments with their keys in order. */
function callKey(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  return `${name} ${JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]))}`;
}

/** A read whose results were just drawn, waiting for the model's next step: another read, or the answer. */
interface DoneRead {
  tool: ModelContextToolInfo;
  /** The call, as name and arguments, so the same read isn't run twice in a turn. */
  key: string;
  /** How many records it drew, when that is known. */
  count?: number;
}

/**
 * Whether an error represents a cancelled operation rather than a failure.
 *
 * @param err - The caught value.
 * @returns True for a DOM `AbortError`, as thrown by an aborted `fetch`.
 */
export function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/**
 * A sentence to show for a turn whose model output was only a tool call.
 *
 * Claims no more than the harness knows at that point: which tool was chosen,
 * and whether it reads or writes.
 *
 * @param call - The parsed tool call, or null if there was none.
 * @param tools - The tools available this turn, used to read the annotations.
 * @returns A short line to display in place of the model's own words.
 */
export function narrateCall(
  call: ReturnType<typeof parseToolCall>,
  tools: ModelContextToolInfo[],
): string {
  if (!call) return WORKING_ON_IT;
  const tool = tools.find((t) => t.name === call.name);
  if (tool && policyFor(tool).readOnly) return 'Looking that up.';
  if (isHandoffTool(call.name)) {
    return call.name === TALK_TO_A_PERSON_TOOL ? "I can put you through to the team. Here's what I'd send them." : "I can hand you over. Here's what I'd send.";
  }
  // The form's own name only where it reads as one: "filters" is an HTML id, not a noun.
  return `Filling in the ${formNoun(call.name)}.`;
}

/**
 * A tool call the model wrote out as text, in the harness's own notation.
 *
 * The transcript records each call as `[called name with {...}]`, and a model
 * reading that history back sometimes answers in the same form instead of
 * making a call. Left as text it reaches the visitor as a line of JSON and
 * nothing happens, so it is read as the call it was meant to be. It then
 * meets the same policy as any other call: a write is still confirmed.
 *
 * @param text - The model's reply.
 * @returns The call and whatever was said before it, or null when the reply
 * contains no such line or its arguments are not a JSON object.
 */
export function readTranscribedCall(
  text: string,
): { said: string; call: { name: string; args: Record<string, unknown> } } | null {
  const m = /\[called ([\w.-]+) with ([\s\S]*)\]\s*$/.exec(text ?? '');
  if (!m) return null;
  const args = readArgs(m[2].trim());
  if (!args) return null;
  return { said: text.slice(0, m.index).trim(), call: { name: m[1], args } };
}

/**
 * The arguments of a written-out call, however the model wrote them.
 *
 * The transcript uses JSON, and a model copying the form often keeps the shape
 * but not the syntax: `page="Quick Fix Plumbing LLC"` rather than
 * `{"page":"Quick Fix Plumbing LLC"}`. Both are the same call, and refusing the
 * second leaves the visitor reading the notation instead of going anywhere.
 */
function readArgs(raw: string): Record<string, unknown> | null {
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  // key="value", key='value', key=value — separated by commas or spaces.
  const args: Record<string, unknown> = {};
  const pair = /([\w.-]+)\s*=\s*("([^"]*)"|'([^']*)'|[^,]+)/g;
  for (let m = pair.exec(raw); m; m = pair.exec(raw)) {
    args[m[1]] = (m[3] ?? m[4] ?? m[2]).trim();
  }
  return Object.keys(args).length ? args : null;
}

/** A completion with a written-out call read as a real one. */
function withTranscribedCall(completion: Completion): Completion {
  if (completion.call) return completion;
  const read = readTranscribedCall(completion.text);
  return read ? { ...completion, text: read.said, call: read.call } : completion;
}

/**
 * How many records a tool response contained.
 *
 * Best-effort: it feeds a summary line, so an unrecognised shape reports
 * nothing rather than guessing.
 *
 * @param res - The tool response, whose `structuredContent` is preferred.
 * @param text - The same response flattened to text, parsed as JSON if needed.
 * @returns The record count, or undefined when the shape is not recognised.
 */
export function countRecords(res: ModelContextToolResponse, text: string): number | undefined {
  const structured = res?.structuredContent as { results?: unknown[]; total?: number } | undefined;
  if (Array.isArray(structured?.results)) return structured.results.length;
  if (typeof structured?.total === 'number') return structured.total;
  try {
    const parsed = JSON.parse(text) as { results?: unknown[]; total?: number };
    if (Array.isArray(parsed?.results)) return parsed.results.length;
    if (typeof parsed?.total === 'number') return parsed.total;
  } catch {
    // A plain-text response carries no count.
  }
  return undefined;
}

/**
 * How a write's confirmation should describe pressing submit.
 *
 * Submitting a form that lives on another page of the site also takes the
 * visitor there, and a button marked "Submit" would not have said so. The
 * button gets a short label that fits a narrow card, and the destination
 * travels separately for the renderer to name in a sentence.
 *
 * @param tool - The tool about to be called.
 * @param values - The values resolved for it.
 * @returns Fields to spread into the confirmation; empty when the call runs
 * on this page.
 */
function handoffPrompt(
  tool: ModelContextToolInfo,
  values: Record<string, unknown>,
): { submitLabel?: string; destination?: string } {
  // Handing the conversation to someone: what is pressed is Send, and nothing is submitted.
  if (isHandoffTool(tool.name)) return { submitLabel: 'Send' };
  const handoff = handoffFor(tool, values);
  if (!handoff) return {};
  // A search form sends nothing: confirming one (a strict policy asks) only opens its results.
  return { submitLabel: policyFor(tool).readOnly ? 'Open' : 'Open & submit', destination: handoff.label };
}

/**
 * One agent: a provider, a set of tools, and the loop that runs a turn.
 *
 * Use it directly for a single-agent page, or several behind an
 * {@link AgentCoordinator} to route between specialists.
 *
 * @example
 * ```ts
 * const harness = new AgentHarness({ renderer });
 * const messages: ChatMessage[] = [];
 * await harness.turn('what are your opening hours?', messages);
 * ```
 */
export class AgentHarness {
  /** Where completions come from. May be shared between agents. */
  readonly provider: ModelProvider;
  /** Where tools come from. */
  readonly toolSource: WebMcpTools;

  private renderer: HarnessRenderer;
  private opts: HarnessOptions;
  /** Values typed into a prompt that is still open, kept across turns. */
  private entered: Record<string, unknown> = {};
  /**
   * The read that just failed, with the server's reason, for {@link recoverRead}; or a write refused before it
   * ran (a ticket tier the chosen event doesn't sell), which did nothing and so is as safe to try again.
   */
  private failedRead: string | null = null;
  private liveTool: ModelContextToolInfo | null = null;
  /** The in-flight turn's controller, so it can be cancelled. */
  private abort: AbortController | null = null;
  /** The previous request's system prompt and tool names, for the cache hint. */
  private lastPrompt = '';
  private lastTools = '';
  /** What the visitor asked this turn, for a recommendation to answer. */
  private goal = '';
  /** This turn's targets taking forms; see {@link takeover}. */
  private takeoverNow: Takeover | null = null;
  /** Every tool the page registered this turn, taken forms included. */
  private registeredNow: ModelContextToolInfo[] = [];
  /** The form the call being acted on stands in for; picked up by {@link act}. */
  private standingIn: StandIn | null = null;
  /** The read just drawn, for {@link carryOn}; set by {@link run}, cleared as each turn starts. */
  private lastRead: DoneRead | null = null;
  /** The tools this turn offered, for a read that runs after the turn returned (a field asked, a confirmation). */
  private turnTools: ModelContextToolInfo[] = [];
  /** The guardrails, once a turn has loaded them, and the provider through them. */
  private g!: Guardrails;
  private m!: ModelProvider;

  constructor(opts: HarnessOptions) {
    this.provider = opts.provider ?? new LocalGemmaProvider();
    this.toolSource = opts.toolSource ?? new WebMcpTools();
    this.renderer = opts.renderer;
    this.opts = opts;
  }

  /**
   * Before a turn does anything: load the guardrails (rejecting, so the turn fails closed, when they can't load)
   * and screen what the visitor sent.
   *
   * @param again - The same send, re-run on the agent that holds the tool: screened already.
   * @returns True when the input stage refused the send, and said so.
   */
  private async guard(goal: string, messages: ChatMessage[], again?: boolean): Promise<boolean> {
    const g = (this.g = await loadGuard((this.opts.guardrails ??= {})));
    this.m = g.model(this.provider);
    return !again && (await g.input(goal, messages, this.renderer));
  }

  /**
   * End a turn that the user stopped.
   *
   * Discards any partial answer and keeps the question, recording it if the
   * stop arrived before the turn had done so, so the transcript matches what is
   * on screen.
   */
  private stopTurn(bubble: StreamingBubble, messages: ChatMessage[], goal: string): TurnResult {
    bubble.finalize('');
    this.renderer.status('');
    const asked = [...messages].reverse().find((m) => m.role === 'user');
    if (asked?.content !== goal) {
      messages.push({ role: 'user', content: goal });
      this.opts.onMessages?.(messages);
    }
    return this.finished({ decision: 'stopped' as const });
  }

  /** Report a finished turn and clear the stoppable state. */
  private finished<T extends TurnResult>(result: T): T {
    this.renderer.stoppable?.(false);
    return result;
  }

  /** Whether the current turn has been stopped. */
  private get stopped(): boolean {
    return !!this.abort?.signal.aborted;
  }

  /**
   * Abandon the turn in flight.
   *
   * Aborts tool discovery or generation, whichever is running. The turn
   * resolves as `'stopped'` rather than rejecting, so a cancellation is not
   * reported as a failure. Safe to call when nothing is running.
   *
   * A tool call already in progress is not interrupted, since it may have
   * reached a server already.
   */
  stop(): void {
    // Aborted, not discarded. The controller is what `stopped` and every
    // `signal` read downstream go through, so clearing it here would make a
    // stop that lands early in a turn invisible to the rest of it: the checks
    // would read false and the provider would be handed no signal at all.
    // `turn()` replaces it on the next turn regardless.
    this.abort?.abort();
  }

  /**
   * Render a completion for the transcript.
   *
   * The transcript must record the tool call, or the model repeats it on the
   * next turn. Providers returning structured calls have no text form for one,
   * so this writes it. Never displayed: the UI shows `completion.text`.
   */
  private transcribe(completion: Completion): string {
    if (!completion.call) return completion.text;
    const args = JSON.stringify(completion.call.args ?? {});
    const said = completion.text ? `${completion.text}\n` : '';
    return `${said}[called ${completion.call.name} with ${args}]`;
  }

  /**
   * Compare this request with the previous one to build a {@link CacheHint}.
   *
   * Must be called after `applySystemPrompt`, since a handoff between agents
   * replaces both the system message and the tool slice.
   */
  private cacheHint(messages: ChatMessage[], tools: ModelContextToolInfo[]): CacheHint {
    const names = tools.map((t) => t.name).join(',');
    const prompt = messages[0]?.role === 'system' ? messages[0].content : '';
    const hint: CacheHint = {
      stableMessages: prompt && prompt === this.lastPrompt ? 1 : 0,
      toolsStable: names === this.lastTools,
    };
    this.lastPrompt = prompt;
    this.lastTools = names;
    return hint;
  }

  /**
   * Run one turn.
   *
   * The turn moves through phases the renderer is told about as they happen
   * (loading the model, finding tools, generating, running the tool), each on a
   * {@link HarnessRenderer.streaming} bubble with its own label. A renderer
   * should expect the first bubble before any token exists.
   *
   * Starting a turn supersedes any turn still running.
   *
   * @param goal - The user's message.
   * @param messages - The live conversation, appended to in place. The caller
   * keeps ownership of persistence; see {@link HarnessOptions.onMessages}.
   * @param again - True when this is the same send re-run on another agent (see {@link AgentCoordinator}), so the
   * guardrails' input stage doesn't screen and count it twice.
   * @returns How the turn ended. A page with no tools, a tool that errors, and
   * a cancellation all resolve normally; see {@link TurnResult.decision}.
   * @throws If the model cannot be loaded (no WebGPU, unreachable weights), the
   * guardrails cannot be loaded (no turn runs without them), or a generation fails for a
   * reason other than being aborted.
   */
  async turn(goal: string, messages: ChatMessage[], again?: boolean): Promise<TurnResult> {
    // Created before the first await, so `stopped` reads this turn's signal
    // rather than the previous turn's.
    this.abort?.abort();
    this.abort = new AbortController();
    if (await this.guard(goal, messages, again)) return { decision: 'none' };
    this.goal = goal;
    this.lastRead = null;
    this.renderer.stoppable?.(true);

    // Opened before the model is touched: loading weights is the longest
    // silence in a turn, and the thread should not be empty during it.
    const bubble = this.renderer.streaming();
    bubble.thinking(this.provider.ready ? 'Thinking…' : 'Loading model…');

    try {
      await this.provider.load?.();
    } catch (err) {
      // A stop during a load is not a failure to load. The download continues
      // and its bytes are cached, so the next attempt resumes rather than
      // starting over.
      if (this.stopped || isAbort(err)) return this.stopTurn(bubble, messages, goal);
      bubble.finalize('');
      throw err;
    }

    // Asserted per turn rather than seeded once, because agents share the
    // transcript and each has its own prompt.
    this.applySystemPrompt(messages);

    if (this.stopped) {
      return this.stopTurn(bubble, messages, goal);
    }

    // A new request, so the last one's steps are not shown beside this one's.
    beginJourney();

    bubble.thinking('Finding tools…');
    const registered = await this.toolSource.discoverTools(this.abort?.signal);
    if (this.stopped) {
      return this.stopTurn(bubble, messages, goal);
    }
    const visible = this.visibleTools(registered, goal);
    if (!visible.length) {
      bubble.finalize('');
      this.renderer.status('');

      // A page with no tools at all is a host misconfiguration; this agent
      // having none of them is answerable to the user. The slice is never
      // widened to compensate, since using the wrong tool succeeds at the wrong
      // thing rather than failing visibly.
      if (registered.length) {
        console.warn(
          `[nxis] ${this.opts.name ?? 'agent'} has no tools on this page ` +
            `(page has: ${registered.map((t) => t.name).join(', ')})`,
        );
        this.renderer.message(
          'assistant',
          this.opts.unavailable ??
            'I cannot do that from this page — the tools for it are not available here.',
        );
        return { decision: 'unavailable' };
      }

      // Actionable only by the host, so the detail goes to the console.
      console.warn('No tools are registered on this page yet — make sure nxis.js has loaded.');
      this.renderer.message('assistant', 'No tools are registered on this page yet.');
      return { decision: 'none' };
    }

    // A form a handoff target takes is not offered while the target can take it.
    const { tools } = await this.takeover(visible, registered);
    if (this.stopped) {
      return this.stopTurn(bubble, messages, goal);
    }
    this.turnTools = tools;

    messages.push({ role: 'user', content: goal });

    bubble.thinking('Thinking…');
    this.renderer.status('Thinking…');
    let completion: Completion;
    try {
      completion = await this.m.complete({
        messages,
        tools,
        onToken: (t) => bubble.update(t),
        signal: this.abort?.signal,
        cache: this.cacheHint(messages, tools),
      });
    } catch (err) {
      // A remote provider rejects on abort (as `fetch` does); the local one
      // returns what it had. Neither is a failure to report.
      if (this.stopped || isAbort(err)) return this.stopTurn(bubble, messages, goal);
      bubble.finalize('');
      throw err;
    }
    completion = this.steer(withTranscribedCall(completion));
    // Nothing the model produced survives a stop, on screen or in the
    // transcript: a model that reads its own unfinished reply back as history
    // will continue from it or contradict it.
    if (this.stopped) {
      return this.stopTurn(bubble, messages, goal);
    }

    // A reply is often nothing but the tool call. Left empty the bubble would
    // be dropped, and the thread would jump from the question to a rendered
    // card with no turn between them.
    bubble.finalize(completion.text || narrateCall(completion.call ?? null, tools));
    messages.push({ role: 'assistant', content: this.transcribe(completion) });
    this.opts.onMessages?.(messages);
    this.renderer.status('');

    let call = completion.call ?? null;

    // Small models sometimes ask in prose instead of calling the tool. One
    // nudge, then accept the question: a clarifying question is better than a
    // retry loop.
    if (!call && looksLikeQuestion(completion.text)) {
      const retry = await this.retryForToolCall(messages, tools, bubble);
      if (retry) call = retry;
      else if (this.stopped) return this.finished({ decision: 'stopped' as const });
    }

    // Still prose: a legitimate turn, already rendered and in the transcript.
    if (!call) return { decision: 'none' };

    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      // A tool the page has but this agent may not use is a routing problem,
      // which a coordinator can correct. A tool no page has was invented by the
      // model.
      const elsewhere = registered.some((t) => t.name === call.name);
      if (elsewhere) return { decision: 'handback', wanted: call.name };

      this.g.unknown(call.name, messages, this.renderer);
      return { decision: 'none' };
    }

    const result = await this.act(tool, call.args, messages);
    return this.carryOn(tools, messages, (await this.recoverRead(tools, messages)) ?? result);
  }

  /**
   * After a read, the rest of the turn: the model reads what came back and either calls the next read it
   * needs or answers in words. A turn never ends on result cards alone, and a type listing is never the end
   * of one.
   *
   * Bounded three ways: at most {@link MAX_STEPS} reads a turn (fewer when the guardrails allow fewer calls),
   * after which the model is offered no tools and can only answer; the same read is never run twice; and a
   * reply with neither words nor a call is asked again once, with no tools, and then stands in with a plain
   * line ({@link ANSWER_FALLBACK}). The guardrails' step and token budgets apply to every completion here too.
   *
   * @param tools - The turn's tools.
   * @param messages - The live conversation.
   * @param result - How the turn stands so far; returned when nothing follows.
   */
  private async carryOn(
    tools: ModelContextToolInfo[],
    messages: ChatMessage[],
    result: TurnResult,
  ): Promise<TurnResult> {
    if (!this.lastRead || this.stopped) return result;
    // This turn's controller: a turn the visitor starts meanwhile (after a confirmation, the input is open)
    // replaces it, and this one then ends without a word or a change to the new turn's state.
    const own = this.abort;
    const most = Math.min(MAX_STEPS, this.g?.settings?.().tools.maxPerTurn ?? MAX_STEPS);
    const ran = new Set<string>();
    for (let reads = 1; this.lastRead && !this.stopped && this.abort === own; reads++) {
      const read = this.lastRead;
      this.lastRead = null;
      ran.add(read.key);
      // A new generation, so stopping is possible again until the next call goes out.
      this.renderer.stoppable?.(true);
      const bubble = this.renderer.streaming();
      bubble.thinking('Thinking…');
      // The last read allowed: the model may only answer.
      const offered = reads < most ? tools : [];
      const completion = await this.generate(messages, offered, bubble, own);
      if (!completion) return this.stoppedAfterRead(bubble, own);

      const proposed = completion.call ?? null;
      const tool = proposed && offered.find((t) => t.name === proposed.name);
      // The same read again would draw the same cards and say nothing new: it is asked for the answer instead.
      const again = !!tool && policyFor(tool).readOnly && ran.has(callKey(tool.name, reconcileArgs(proposed!.args, toolSchema(tool))));
      if (tool && !again) {
        // Its own words, if any: a second "Looking that up." under the cards says nothing.
        bubble.finalize(completion.text);
        messages.push({ role: 'assistant', content: this.transcribe(completion) });
        this.opts.onMessages?.(messages);
        result = await this.act(tool, proposed!.args, messages);
        result = (await this.recoverRead(tools, messages)) ?? result;
        continue;
      }

      let said = stripMarkers(completion.text ?? '').trim();
      if (!said) {
        // Ended with nothing to say: once more, told to answer, with nothing to call.
        const retry = await this.generate(messages, [], bubble, own, ANSWER_NOW);
        if (!retry) return this.stoppedAfterRead(bubble, own);
        said = stripMarkers(retry.text ?? '').trim();
      }
      if (!said) said = read.count === 0 || isTypeListing(read.tool.name) ? ANSWER_FALLBACK.none : ANSWER_FALLBACK.found;
      bubble.finalize(said);
      messages.push({ role: 'assistant', content: said });
      this.opts.onMessages?.(messages);
      this.renderer.status('');
    }
    return this.abort === own ? this.finished(result) : result;
  }

  /** A stop while the model answered a read: the cards and the transcript stand, the unfinished answer doesn't. */
  private stoppedAfterRead(bubble: StreamingBubble, own: AbortController | null): TurnResult {
    bubble.finalize('');
    if (this.abort !== own) return { decision: 'stopped' };
    this.renderer.status('');
    return this.finished({ decision: 'stopped' as const });
  }

  /**
   * One completion for {@link carryOn}, its tokens streamed into `bubble`.
   *
   * @param own - The turn's controller; a stop, or a newer turn, ends it.
   * @param nudge - Added to the last message (the read's result) for this request only, so the request still
   * ends on a tool result, as the model proxy reads a step of a turn, and the transcript never keeps it.
   * @returns The completion, a written-out call read as one; null when the turn was stopped.
   * @throws When the generation fails for a reason other than a stop.
   */
  private async generate(
    messages: ChatMessage[],
    tools: ModelContextToolInfo[],
    bubble: StreamingBubble,
    own: AbortController | null,
    nudge?: string,
  ): Promise<Completion | null> {
    const gone = () => this.stopped || this.abort !== own;
    const last = nudge ? messages[messages.length - 1] : undefined;
    const was = last?.content ?? '';
    if (last) last.content = `${was} ${nudge}`;
    try {
      const completion = await this.m.complete({
        messages,
        tools,
        onToken: (t) => bubble.update(t),
        signal: own?.signal,
      });
      return gone() ? null : this.steer(withTranscribedCall(completion));
    } catch (err) {
      if (gone() || isAbort(err)) return null;
      bubble.finalize('');
      throw err;
    } finally {
      if (last) last.content = was;
    }
  }

  /**
   * Run a call that waited on the visitor (a field asked, a confirmation pressed), and when it was a read, carry
   * the turn on to its answer. Not awaited by anyone, so a failure is logged rather than thrown.
   */
  private runAndAnswer(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
    messages: ChatMessage[],
    standIn: StandIn | null,
  ): void {
    this.lastRead = null;
    void this.run(tool, values, messages, standIn)
      .then(() => this.carryOn(this.turnTools.length ? this.turnTools : [tool], messages, { decision: 'execute', tool, values }))
      .catch((err) => {
        if (!isAbort(err)) console.warn('[nxis] the answer after a read failed:', err);
      });
  }

  /**
   * One more try after a lookup the server refused: an @id the model made up, a type the site doesn't have. The
   * server's reason is already in the transcript, so the model can make the call it should have made, or say
   * plainly that there is nothing to find. Reads, and writes turned down before they ran (see {@link refuse}):
   * a write that failed may already have done something. Once per turn, so a model that keeps failing doesn't
   * loop.
   */
  private async recoverRead(tools: ModelContextToolInfo[], messages: ChatMessage[]): Promise<TurnResult | null> {
    if (!this.failedRead || this.stopped) return null;
    this.failedRead = null;
    const bubble = this.renderer.streaming();
    bubble.thinking('Trying another way…');
    let completion: Completion;
    try {
      completion = await this.m.complete({
        messages,
        tools,
        onToken: (t) => bubble.update(t),
        signal: this.abort?.signal,
      });
    } catch (err) {
      bubble.finalize('');
      if (this.stopped || isAbort(err)) return null;
      throw err;
    }
    completion = this.steer(withTranscribedCall(completion));
    if (this.stopped) {
      bubble.finalize('');
      return null;
    }
    const call = completion.call ?? null;
    bubble.finalize(completion.text || narrateCall(call, tools));
    messages.push({ role: 'assistant', content: this.transcribe(completion) });
    this.opts.onMessages?.(messages);
    const tool = call && tools.find((t) => t.name === call.name);
    if (!tool) return { decision: 'none' };
    const result = await this.act(tool, call.args, messages);
    // Failed again: what it said stands, and the visitor decides what next.
    this.failedRead = null;
    return result;
  }

  /**
   * Run a turn whose tool call is already decided, without asking the model.
   *
   * For a request that names its own action, such as a link from the NxisAI
   * app to one business's quote form: the tool and the business are known, so
   * the model has nothing to choose, and a model left to choose sometimes
   * asks for the details in prose instead of opening the form. What follows
   * the call is an ordinary turn's: the same slots, prompts and confirmation,
   * and the call goes into the transcript as if the model had made it.
   *
   * @param goal - The request as the person would have said it, for the thread and transcript.
   * @param name - The tool to call.
   * @param args - Its arguments, e.g. which business.
   * @param messages - The live conversation, appended to in place.
   * @returns The decision taken, or `'unavailable'` when this agent has no such tool.
   */
  async begin(goal: string, name: string, args: Record<string, unknown>, messages: ChatMessage[]): Promise<TurnResult> {
    this.abort?.abort();
    this.abort = new AbortController();
    if (await this.guard(goal, messages)) return { decision: 'none' };
    this.goal = goal;
    this.lastRead = null;
    this.renderer.stoppable?.(true);
    this.applySystemPrompt(messages);
    beginJourney();

    const bubble = this.renderer.streaming();
    bubble.thinking('Finding tools…');
    const registered = await this.toolSource.discoverTools(this.abort.signal);
    if (this.stopped) return this.stopTurn(bubble, messages, goal);
    const { tools } = await this.takeover(this.visibleTools(registered, goal), registered);
    if (this.stopped) return this.stopTurn(bubble, messages, goal);
    // A form a target takes, while it can: the handoff starts instead, confirmed as any handoff is.
    const call = this.steer({ text: '', call: { name, args } } as Completion).call!;
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      bubble.finalize('');
      return this.finished({ decision: 'unavailable' as const });
    }

    this.turnTools = tools;
    messages.push({ role: 'user', content: goal });
    bubble.finalize(narrateCall(call, tools));
    messages.push({ role: 'assistant', content: this.transcribe({ text: '', call } as Completion) });
    this.opts.onMessages?.(messages);
    return this.carryOn(tools, messages, await this.act(tool, call.args, messages));
  }

  /**
   * Leave out of a turn the forms an available handoff target takes, and
   * describe its handoff tools from the targets listed now.
   *
   * Only a target this turn can actually hand off to takes anything: its
   * handoff tool has to be among the turn's tools, listing it. Remembered for
   * {@link steer}, which turns a call to a hidden form into the handoff.
   *
   * @param tools - The turn's tools.
   * @param registered - Every tool on the page.
   */
  private async takeover(tools: ModelContextToolInfo[], registered: ModelContextToolInfo[]): Promise<Takeover> {
    this.registeredNow = registered;
    this.standingIn = null;
    // The targets as listed now: a handoff tool is described from them, and one with none left is not offered.
    const listed = await listedTargets(this.opts.handoff?.());
    if (listed) tools = refreshHandoffTools(tools, listed);
    const takers = takingNow(listed).filter((t) => {
      const via = tools.find((tool) => tool.name === handoffToolFor(t.kind));
      if (!via) return false;
      const listed = (toolSchema(via).properties?.target as { enum?: unknown[] } | undefined)?.enum;
      return !Array.isArray(listed) || listed.includes(t.name);
    });
    const takeover: Takeover = {
      tools: takers.length ? tools.filter((t) => !takerOf(t.name, takers)) : tools,
      takers,
    };
    this.takeoverNow = takeover;
    return takeover;
  }

  /**
   * A call to a form an available target takes, made into the handoff to that
   * target; any other call as it was.
   *
   * Hiding a form does not stop a model calling it by name, and the page
   * still has it. So the call is replaced, before it is shown, transcribed or
   * run: the visitor sees the handoff and its summary and presses Send, and
   * the transcript records the handoff. What it said beside the call is
   * dropped with it — it was about the form.
   *
   * Also notes which form the handoff stands in for, for {@link act}: the
   * form called, or, when the model handed off directly, the one form on this
   * page the target takes.
   */
  private steer(completion: Completion): Completion {
    const call = completion.call;
    const takeover = this.takeoverNow;
    if (!call || !takeover?.takers.length) return completion;
    const taker = takerOf(call.name, takeover.takers);
    if (taker) {
      const form = this.registeredNow.find((t) => t.name === call.name) ?? ({ name: call.name } as ModelContextToolInfo);
      this.standingIn = { target: taker.name, run: standInFor(form, call.args) };
      return { ...completion, text: '', call: handoffCallFor(taker, form, call.args) };
    }
    if (isHandoffTool(call.name)) {
      const target = takeover.takers.find((t) => t.name === String(call.args?.target ?? ''));
      this.standingIn = target ? { target: target.name, run: pageFormTakenBy(target, this.registeredNow) } : null;
    }
    return completion;
  }

  /**
   * Narrow the page's tools to this agent's slice.
   *
   * @param registered - Every tool the tool source reported.
   * @returns The tools matching {@link HarnessOptions.tools}, or all of them
   * when no filter is set.
   */
  private visibleTools(tools: ModelContextToolInfo[], goal = ''): ModelContextToolInfo[] {
    // One route per action first: where a site-wide tool covers this page's
    // own form tool, the page tool is its implementation, not an alternative.
    const routed = withoutShadowedTools(tools);
    // Then what fits: a site's forms are many, and all of them reach the
    // prompt unless this turn's request narrows them.
    const budgeted = selectSiteTools(routed, goal, { limit: this.opts.maxSiteTools });
    const filter = this.opts.tools;
    return filter ? budgeted.filter((t) => filter(t)) : budgeted;
  }

  /**
   * The tools this agent would be offered for a request, right now.
   *
   * What a surface should list when it shows what the agent can use — not
   * every tool registered on the page: a page tool that a site-wide tool
   * covers is hidden, the per-request budget applies, and so does this
   * agent's own filter. It can change as the page registers tools, and with
   * the request, which is what `goal` is for.
   *
   * Reads the registry as it stands instead of waiting for tools to appear,
   * so a menu opened before the page has finished registering shows what is
   * there rather than hanging.
   *
   * @param goal - The request to budget against. Empty for "before anyone
   * has asked", which keeps this page's tools first.
   * @returns The tools, in the order the registry reported them.
   */
  async offeredTools(goal = ''): Promise<ModelContextToolInfo[]> {
    let registered: ModelContextToolInfo[] = [];
    try {
      registered = (await this.toolSource.modelContext()?.getTools()) ?? [];
    } catch {
      // A registry that fails to list has nothing to show.
    }
    return this.visibleTools(registered, goal);
  }

  /**
   * Whether this agent's filter accepts a tool, by name.
   *
   * Called by {@link AgentCoordinator} when another agent hands a turn back.
   * The filter receives a tool with only its name set, so a filter that
   * inspects annotations should reject a bare name and let the fallback take
   * the turn.
   *
   * @param name - The tool name to test.
   * @returns True when this agent would use that tool.
   */
  owns(name: string): boolean {
    const filter = this.opts.tools;
    if (!filter) return true;
    try {
      return filter({ name } as ModelContextToolInfo);
    } catch {
      return false;
    }
  }

  /**
   * Place this agent's instructions at the head of the shared transcript,
   * replacing another agent's if one is there.
   */
  private applySystemPrompt(messages: ChatMessage[]): void {
    const prompt = this.opts.systemPrompt;
    if (!prompt) return;
    if (messages[0]?.role === 'system') {
      // The saved profile (`data`) travels with the system message, whichever agent's prompt it carries.
      if (messages[0].content !== prompt) messages[0] = { ...messages[0], content: prompt };
    } else {
      messages.unshift({ role: 'system', content: prompt });
    }
  }

  /**
   * Generate once more, instructing the model to call a tool.
   *
   * The instruction is added as a user turn, which carries the most weight in a
   * chat template mid-conversation, and is removed again afterwards so it never
   * remains in the transcript as something the user said.
   *
   * @returns The tool call, or null if the model still did not produce one.
   */
  private async retryForToolCall(
    messages: ChatMessage[],
    tools: ModelContextToolInfo[],
    bubble: StreamingBubble,
  ): Promise<ReturnType<typeof parseToolCall>> {
    const nudge: ChatMessage = {
      role: 'user',
      content:
        'Call the appropriate tool now with the fields you already have. ' +
        'Omit any field you do not know — do not ask me for it.',
    };
    messages.push(nudge);

    let completion: Completion;
    try {
      completion = await this.m.complete({
        messages,
        tools,
        onToken: (t) => bubble.update(t),
        signal: this.abort?.signal,
      });
    } catch (err) {
      // The nudge is the harness's own text, so it is removed however the retry
      // ends rather than being left in the transcript.
      messages.splice(messages.indexOf(nudge), 1);
      if (this.stopped || isAbort(err)) return null;
      throw err;
    }
    completion = this.steer(withTranscribedCall(completion));
    const call = completion.call ?? null;

    if (this.stopped) {
      messages.splice(messages.indexOf(nudge), 1);
      return null;
    }

    if (call) {
      // Keep the assistant's tool call; drop the nudge the user never said.
      messages.splice(messages.indexOf(nudge), 1);
      messages.push({ role: 'assistant', content: this.transcribe(completion) });
      bubble.finalize(completion.text || narrateCall(call, tools));
    } else {
      messages.splice(messages.indexOf(nudge), 1);
    }
    return call;
  }

  /**
   * Resolve a proposed call's arguments, then run it, confirm it, or ask.
   *
   * @internal Used by {@link act}; see {@link handoffPrompt}.
   *
   * @param tool - The tool the model chose.
   * @param rawArgs - Its arguments, before reconciliation against the schema.
   * @param messages - The live conversation.
   * @returns The decision taken and the values it was taken with.
   */
  private async act(
    tool: ModelContextToolInfo,
    rawArgs: Record<string, unknown> | undefined,
    messages: ChatMessage[],
  ): Promise<TurnResult> {
    // The form a handoff stands in for, held by this call's prompts until Send.
    const standIn = isHandoffTool(tool.name) ? this.standingIn : null;
    this.standingIn = null;
    // Named for what is being used — "Quote form" — since a surface showing
    // the journey reads this step as its title.
    const named = humanize(withoutSiteSuffix(tool.name));
    this.emitStep({
      id: 'choose',
      label: named.charAt(0).toUpperCase() + named.slice(1),
      status: 'done',
    });
    let schema = toolSchema(tool);
    const modelArgs = reconcileArgs(rawArgs, schema);

    // Keep values already typed while the model revises a call to the same
    // tool; discard them when it moves to a different one.
    const entered = this.liveTool?.name === tool.name ? this.entered : {};

    const resolveAgainst = (s: typeof schema) =>
      resolveSlots(s, {
        modelArgs,
        entered,
        profile: this.opts.profile?.(s),
        context: this.opts.context?.(tool),
      });
    let resolution = resolveAgainst(schema);

    // One site tool for a form on many pages whose fields differ (each event its own tiers): once the call says
    // which, it is checked against that form's fields, and asked and confirmed with only those.
    const fit = siteCallFit(tool, resolution.values, { ...modelArgs, ...entered });
    if (fit?.problem) return this.refuse(tool, fit.problem, messages);
    if (fit?.chosen) {
      schema = fit.schema;
      resolution = resolveAgainst(schema);
    }

    // The tool stage: refused (and said so), run, or confirmed first. Its tier is code's, not the tool's own claim.
    const verdict = await this.g.tool(tool, resolution.values, messages, this.renderer, visitFor(tool, resolution.values)?.pageUrl);
    if (verdict > 1) return { decision: 'none' };
    const policy = { ...policyFor(tool), confirmWhenSatisfied: verdict > 0 };
    const decision = decide(policy, resolution.missing.length);

    if (decision === 'execute') {
      await this.run(tool, resolution.values, messages, standIn);
      return { decision, tool, values: resolution.values };
    }

    if (decision === 'confirm') {
      this.liveTool = tool;
      this.emitStep({ id: 'confirm', label: 'Waiting for you to confirm', status: 'active' });
      this.renderer.confirm({
        tool,
        slots: summarySlots(resolution),
        values: resolution.values,
        ...handoffPrompt(tool, resolution.values),
        onSubmit: this.approved(tool, messages, standIn),
        onCancel: () => this.cancel(),
        onEdit: () => this.askAll(tool, resolution, messages, standIn),
      });
      return { decision, tool, values: resolution.values };
    }

    // decision === 'ask': the gaps only, stepped when there are several.
    this.liveTool = tool;
    this.emitStep({
      id: 'collect',
      label: 'Collecting details',
      status: 'active',
      detail: resolution.missing.map((s) => humanize(s.name).toLowerCase()).join(', '),
    });
    const plan = buildPlan(resolution.missing, this.opts.groupRelated !== false);
    if (!this.renderer.inlinePrompts) {
      this.renderer.message(
        'assistant',
        plan.stepped
          ? `I need ${plan.steps.length} more details for the ${formNoun(tool.name)}.`
          : `One more thing for the ${formNoun(tool.name)}.`,
      );
    }
    this.renderer.ask({
      tool,
      plan,
      resolution,
      onComplete: (answers) => {
        const values = { ...resolution.values, ...answers };
        this.entered = values;
        this.emitStep({ id: 'collect', label: 'Collected your details', status: 'done' });
        // The answer said which form, and so which fields it has: checked and confirmed against those.
        if (fit && !fit.chosen) {
          void this.act(tool, values, messages);
          return;
        }
        // A read was waiting only on the gap. A write still needs its
        // confirmation, now a summary rather than a form.
        if (policy.confirmWhenSatisfied) {
          this.renderer.confirm({
            tool,
            slots: summarySlots(resolveSlots(schema, { modelArgs: values })),
            values,
            ...handoffPrompt(tool, values),
            onSubmit: this.approved(tool, messages, standIn),
            onCancel: () => this.cancel(),
            onEdit: () => this.askAll(tool, resolution, messages, standIn),
          });
        } else {
          this.runAndAnswer(tool, values, messages, standIn);
        }
      },
      onCancel: () => this.cancel(),
    });
    return { decision, tool, values: resolution.values };
  }

  /**
   * Turn a call down before anything runs or is confirmed: the visitor reads why, and the model reads it with
   * the field names and may make the call again, once, as after a failed read.
   */
  private refuse(tool: ModelContextToolInfo, problem: { visitor: string; model: string }, messages: ChatMessage[]): TurnResult {
    this.renderer.toolError(tool, problem.visitor);
    messages.push({ role: 'user', content: `[${tool.name} did not go through]`, data: problem.model.slice(0, 600) });
    this.opts.onMessages?.(messages);
    this.failedRead = problem.model;
    return { decision: 'none' };
  }

  /**
   * What the visitor's press does: approve exactly these values for this tool in this conversation (single-use,
   * for two minutes), then run the call. The guardrails check and use the approval just before it executes.
   */
  private approved(tool: ModelContextToolInfo, messages: ChatMessage[], standIn: StandIn | null) {
    return (values: Record<string, unknown>): void => {
      this.g.approve(tool, values, messages);
      this.runAndAnswer(tool, values, messages, standIn);
    };
  }

  /**
   * Reopen a confirmation as an editable form covering every field, not only
   * the gaps. Reached through {@link ConfirmRequest.onEdit}.
   */
  private askAll(
    tool: ModelContextToolInfo,
    resolution: Resolution,
    messages: ChatMessage[],
    standIn: StandIn | null = null,
  ): void {
    const editable = resolution.all.filter((s) => s.name in resolution.values || s.required);
    this.renderer.ask({
      tool,
      plan: buildPlan(editable, false),
      resolution,
      onComplete: (answers) => this.approved(tool, messages, standIn)({ ...resolution.values, ...answers }),
      onCancel: () => this.cancel(),
    });
  }

  /**
   * Record a step, and tell the renderer about it.
   *
   * The journal is the source of truth — it survives the page change, and a
   * surface the host owns subscribes to it directly. Passing the step to the
   * renderer as well saves a renderer from subscribing to anything.
   */
  private emitStep(step: AgentStep): void {
    recordStep(step);
    this.renderer.step?.(step, journeySteps());
  }

  /**
   * The record to recommend from a search's results, when there are several
   * to choose between and the model can say why from what they state.
   */
  private async pickFrom(res: ModelContextToolResponse): Promise<{ pick: ResultPick; name: string } | null> {
    if (this.opts.recommend === false || !this.goal) return null;
    // Records of things, not rows of a type listing: something with a name and a kind.
    const records = extractRecords(res).filter((r) => typeof r.name === 'string' && r['@type'] != null);
    if (records.length < 2) return null;
    const bubble = this.renderer.streaming();
    bubble.thinking('Comparing them…');
    try {
      const pick = await recommend({
        provider: this.m,
        goal: this.goal,
        records,
        now: this.opts.now?.(),
        signal: this.abort?.signal,
        transcribe: withTranscribedCall,
      });
      return pick ? { pick, name: String(records[pick.index].name) } : null;
    } catch {
      // Stopped, or the model failed: the results stand on their own.
      return null;
    } finally {
      bubble.finalize('');
    }
  }

  /** Discard a live prompt and the values typed into it. */
  private cancel(): void {
    // A journey that stops here should say so, not sit waiting for a press
    // that will never come.
    this.emitStep({ id: 'submit', label: 'Cancelled', status: 'failed' });
    this.entered = {};
    this.liveTool = null;
    this.renderer.dismissPrompt?.();
    this.renderer.message('assistant', 'Okay — cancelled. Tell me what you’d like to do.');
  }

  /**
   * Execute a fully resolved call and render its result.
   *
   * Read tools render as records, writes as a detail card. Either way the
   * outcome is written into the transcript so the model can refer back to it.
   *
   * @param standIn - For a handoff, the form it stands in for, told to the
   * controller just before the handoff starts.
   */
  private async run(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
    messages: ChatMessage[],
    standIn: StandIn | null = null,
  ): Promise<void> {
    this.renderer.dismissPrompt?.();
    // Past this point the turn cannot be stopped: the call may reach a server
    // before an abort could arrive.
    this.renderer.stoppable?.(false);
    this.renderer.status(`Running ${humanize(withoutSiteSuffix(tool.name))}…`);
    // A remote tool call is another silence, and the generation bubble that
    // covered the last one has been finalized by now.
    const working = this.renderer.streaming();
    working.thinking(`Running ${humanize(withoutSiteSuffix(tool.name))}…`);
    // Asked before the call, not after: a registry may hand back only the
    // text of a response, dropping the structured part that would have said
    // so. The tool's own annotations are already enough to know.
    const visiting = visitFor(tool, values);
    const leaving = handoffFor(tool, values) ?? visiting;
    const readOnly = policyFor(tool).readOnly;
    if (!readOnly) this.emitStep({ id: 'confirm', label: 'You confirmed', status: 'done' });
    // Recorded before the call, because the call is what navigates: the
    // courier persists the journey as it leaves, and this step has to be in
    // it or the page it lands on shows no reason for being there.
    const handing = isHandoffTool(tool.name);
    const inFlight: AgentStep = handing
      ? { id: 'fill', label: 'Handing the conversation over', status: 'active' }
      : leaving
        ? { id: 'navigate', label: leaving.label ? `Opening ${leaving.label}` : readOnly ? 'Opening the results' : 'Opening its page', status: 'active' }
        : {
            id: 'fill',
            label: readOnly ? 'Looking that up' : `Filling in the ${formNoun(tool.name)}`,
            status: 'active',
          };
    this.emitStep(inFlight);
    // A failure ends the step that was running, so the card never shows it still under way.
    const failed = (detail: string) => {
      this.emitStep({ ...inFlight, label: 'It did not go through', status: 'failed', detail });
      // The model reads why on its next turn, and can act on it rather than repeat the call.
      messages.push({ role: 'user', content: `[${tool.name} did not go through]`, data: detail.slice(0, 400) });
      this.opts.onMessages?.(messages);
      if (readOnly) this.failedRead = detail;
    };
    if (handing) {
      // Noted now, at Send, for the target the visitor is sending to; a handoff
      // that stands in for no form clears whatever an earlier one left.
      const target = String(values.target ?? '');
      const controller = this.opts.handoff?.() ?? null;
      controller?.standIn(target, standIn && standIn.target === target ? standIn.run : null);
    }
    try {
      // Through the guardrails: limits, the approval, the timeout. A refusal throws, and is reported as a failure.
      const res: ModelContextToolResponse = await this.g.exec(this.toolSource, tool, values, messages);
      const text = extractResult(res);
      working.finalize('');
      this.renderer.status('');

      this.renderer.trace?.({
        tool,
        args: values,
        text,
        isError: !!res?.isError,
        count: countRecords(res, text),
      });

      if (res?.isError) {
        failed(text || 'Failed');
        this.renderer.toolError(tool, text || 'Failed');
        return;
      }

      this.entered = {};
      this.liveTool = null;

      // A call that left for another page has submitted nothing yet, so it
      // gets a line saying where it went rather than a card claiming it was
      // sent. The page it is going to finishes the job.
      if (leaving || res?.structuredContent?.[HANDOFF_RESULT]) {
        // Said from what we know, not from what came back: a registry may
        // return the whole response object as JSON, and that is not a
        // sentence to put in front of anyone.
        if (this.renderer.left) {
          const carried = res?.structuredContent?.[HANDOFF_RESULT] as { label?: string } | undefined;
          // `||`: an empty label is a destination nobody could name, not a name.
          this.renderer.left(tool, (visiting ?? leaving)?.label || carried?.label || null);
          return;
        }
        this.renderer.message(
          'assistant',
          visiting
            ? `Opening ${visiting.label}…`
            : readOnly
              ? leaving?.label ? `Opening ${leaving.label}…` : 'Opening the results…'
              : leaving?.label
                ? `Opening ${leaving.label} to submit this…`
                : 'Opening the page that can submit this…',
        );
        return;
      }

      // Handed off: what the target says arrives through the handoff controller's events, which the
      // renderer draws. There is nothing to show as "Submitted"; the model learns where it went.
      const started = res?.structuredContent?.[HANDOFF_SESSION_RESULT] as { label?: string } | undefined;
      if (handing && started) {
        const who = started.label ?? 'another agent';
        // Handing over is where this journey ends; the conversation carries on outside it. Without a
        // `submit` step the card would read as running for as long as the handoff lasts.
        this.emitStep({ id: 'fill', label: 'Handed the conversation over', status: 'done' });
        this.emitStep({ id: 'submit', label: `Handed to ${who}`, status: 'done' });
        messages.push({
          role: 'user',
          content: `[${tool.name}: the conversation was handed to ${who}. Their replies go to the visitor directly.]`,
        });
        this.opts.onMessages?.(messages);
        return;
      }

      // Opening the page already open, or one that could not be told: said
      // in words, since there are no records to draw.
      if (tool.name === OPEN_PAGE_TOOL) {
        this.emitStep({ id: 'submit', label: text, status: 'done' });
        this.renderer.message('assistant', text);
        messages.push({ role: 'user', content: `[${tool.name} returned]`, data: text });
        this.opts.onMessages?.(messages);
        return;
      }

      this.emitStep({ id: 'fill', label: readOnly ? 'Looked it up' : 'Filled the form', status: 'done' });
      this.emitStep({
        id: 'submit',
        label: readOnly ? 'Answered' : 'Submitted',
        status: 'done',
      });

      if (readOnly) {
        const picked = await this.pickFrom(res);
        this.renderer.results(tool, res, picked ? { pick: picked.pick } : undefined);
        // What came back is the tool's, so it is data; so is the pick, made from it.
        messages.push({
          role: 'user',
          // A type listing names what there is to search, not what the visitor asked about: said so, in the
          // harness's own words rather than the tool's, so the model searches next.
          content: isTypeListing(tool.name)
            ? `[${tool.name} returned the kinds of records this site has. To answer, search them with nxis_query next, unless the visitor asked what kinds there are]`
            : `[${tool.name} returned]`,
          data: text.slice(0, RESULT_CHARS) + (picked ? `\n(You recommended ${picked.name}: ${picked.pick.reasons.join(' ')})` : ''),
        });
        // Drawn, and not the end of the turn: the model answers from it, or reads on.
        this.lastRead = { tool, key: callKey(tool.name, values), count: countRecords(res, text) };
      } else {
        this.renderer.detail(tool, values, text);
        messages.push({
          role: 'user',
          content: `[${tool.name} submitted with: ${JSON.stringify(values)}]. Keep these unless I ask to change them.`,
        });
      }
      this.opts.onMessages?.(messages);
    } catch (err) {
      const message = String((err as Error)?.message || err);
      failed(message);
      working.finalize('');
      this.renderer.status('');
      // A call that threw is the main reason to open a trace.
      this.renderer.trace?.({ tool, args: values, text: message, isError: true });
      this.renderer.toolError(tool, message);
    }
  }
}
