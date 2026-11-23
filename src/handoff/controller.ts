/**
 * Runs handoffs: one per conversation, to an agent or a person, over A2A
 * through the site's relay.
 *
 * The controller is headless. It starts a handoff, sends what the visitor types
 * while one is open, ends it, and turns what the target sends back into
 * {@link HandoffEvent}s, dispatched as `handoff` events. A UI renders those; the
 * packaged element does.
 *
 * A handoff outlives the page it started on. Its task id, and the key the
 * relay tied it to, are kept per conversation in `localStorage`, and
 * {@link HandoffController.resume} picks it up on the next page. A stream the
 * host cuts off mid-handoff is picked up the same way, after a short wait.
 *
 * @module
 */
import {
  A2AClient,
  A2AError,
  isTerminal,
  normaliseResponse,
  type A2AMessage,
  type A2AStream,
  type A2AStreamResponse,
  type A2ATask,
  type A2ATaskStatus,
  type A2ATaskState,
} from './a2a.js';
import {
  HANDOFF_EXTENSION,
  envelopeMessage,
  feedbackMessage,
  readHandBack,
  readOperator,
  readQueue,
  readAnswer,
  readableText,
  visitorMessage,
  type FeedbackValue,
  type HandBack,
  type HandoffAnswer,
  type HandoffEnvelope,
} from './envelope.js';
import { reportFormRun, type PageFormRun } from '../harness/tools/report.js';

/** Who a target is: software, or a person behind a desk. */
export type HandoffKind = 'agent' | 'person';

/** A target as the page knows it: a name, and how to present it. */
export interface HandoffTargetConfig {
  kind: HandoffKind;
  /** What the visitor reads: "You're talking with *Booking*". */
  label: string;
  /** What it handles, for the model choosing between targets. */
  description?: string;
  /**
   * The site forms this target takes in their place, by tool name:
   * `['quote_form']`.
   *
   * Matched without the site-wide suffix, so `'quote_form'` covers the page's
   * own `quote_form` and the site-wide `quote_form_anywhere` that reaches the
   * same form from any page. While the relay lists this target as available,
   * the model is not offered those forms, a call to one becomes a handoff to
   * this target, and a link from the NxisAI app that names one starts the
   * handoff instead of the form. A hand-back with outcome `resolved` is then
   * reported as that form being sent. Anything short of available leaves the
   * forms exactly as they are. See `docs/handoff.md`.
   */
  takes?: string[];
  /**
   * This target's A2A Agent Card, on the relay's origin: `/a2a/desk/agent-card.json`. Its description and
   * skills tell the model what the target handles. A card elsewhere is not read.
   */
  card?: string;
}

/** One thing a target can do, from its agent card. */
export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  examples?: string[];
}

/** Where handoffs go. */
export interface HandoffConfig {
  /** The relay: on the site's own origin (`/api/handoff`), or NxisAI's (`<edge>/v1/s/<site>/handoff`). */
  relay: string;
  /**
   * The targets, by the name the relay knows them by. Optional with NxisAI's relay, whose agent cards list
   * them; named here, a target keeps the kind, label and description given, and its card adds the rest.
   */
  targets?: Record<string, HandoffTargetConfig>;
}

/** A target as the relay reports it, merged with the page's config. */
export interface HandoffTarget extends HandoffTargetConfig {
  name: string;
  /** Whether it can take a handoff now. A desk outside its hours cannot. */
  available: boolean;
  /** When a desk is staffed, as a person should read it. */
  hours?: string;
  /** How many are waiting at a desk. */
  queueLength?: number;
  /** Expected wait at a desk, in minutes. */
  waitMinutes?: number | null;
  /** Whether the relay allows the recent transcript to be shared with it. */
  transcript: boolean;
  /** What it handles and can do, written for a model: its agent card's description and skills. */
  brief?: string;
  /** What it can do, from its agent card. */
  skills?: AgentSkill[];
}

/** Where a handoff stands. See the lifecycle table in `docs/handoff.md`. */
export type HandoffState =
  | 'connecting'
  | 'queued'
  | 'active'
  | 'awaiting-visitor'
  | 'handed-back'
  | 'ended'
  | 'failed';

/** Whether a handoff in this state is over. */
export const isHandoffOver = (state: HandoffState): boolean =>
  state === 'handed-back' || state === 'ended' || state === 'failed';

/** One conversation's handoff, as kept between pages. */
export interface HandoffSession {
  conversationId: string;
  target: string;
  label: string;
  kind: HandoffKind;
  state: HandoffState;
  taskId?: string;
  contextId?: string;
  /** The relay's `Nxis-Handoff-Key`, proving this browser started the task. */
  key?: string;
  /** Who is speaking at the target, once a person or agent has said. */
  operator?: string;
  /** Place in a desk's queue, while queued. */
  queue?: { position?: number; waitMinutes?: number };
  handBack?: HandBack;
  /**
   * The site form this handoff took the place of, when its target `takes`
   * one: the action a resolved hand-back is reported as.
   */
  standsFor?: PageFormRun;
  /** Set once that report is made, so a resumed handoff never makes it twice. */
  reported?: boolean;
  /** Why it failed, in words for the visitor. */
  error?: string;
  /** 👍 or 👎 sent, by answer id: each answer gets one, kept across reloads. */
  feedback?: Record<string, FeedbackValue>;
  startedAt: number;
  updatedAt: number;
  /** Message ids already shown, so a resumed task's history is not shown twice. */
  seen: string[];
}

/** What the controller reports, as the `detail` of a `handoff` event. */
export type HandoffEvent =
  | { type: 'state'; conversationId: string; session: HandoffSession; state: HandoffState }
  | {
      type: 'message';
      conversationId: string;
      session: HandoffSession;
      /** Who said it: the operator's name, or the target's label. */
      from: string;
      fromKind: HandoffKind;
      text: string;
      /** The cards for the answer's sources, when the target sent an `answer` part. */
      answer?: HandoffAnswer;
    }
  | { type: 'handback'; conversationId: string; session: HandoffSession; handBack: HandBack };

/**
 * A handoff event as the page may see it: what happened, to which conversation and target, without the session
 * itself (which holds the key proving this browser started the task). The element dispatches one as an
 * `nxis-handoff` event for every {@link HandoffEvent}, for the site's own analytics and for tests.
 */
export type HandoffActivity =
  | { type: 'state'; conversationId: string; target: string; label: string; state: HandoffState }
  | { type: 'message'; conversationId: string; target: string; label: string; from: string; fromKind: HandoffKind; text: string; answer?: HandoffAnswer }
  | { type: 'handback'; conversationId: string; target: string; label: string; outcome: HandBack['outcome']; note: string; references: HandBack['references'] };

/** {@link HandoffActivity} for an event: a copy, so nothing a listener does reaches the conversation. */
export function handoffActivity(e: HandoffEvent): HandoffActivity {
  const base = { conversationId: e.conversationId, target: e.session.target, label: e.session.label };
  if (e.type === 'state') return { type: 'state', ...base, state: e.state };
  if (e.type === 'handback') {
    const { outcome, note, references } = e.handBack;
    return { type: 'handback', ...base, outcome, note, references: references.map((r) => ({ ...r })) };
  }
  return {
    type: 'message',
    ...base,
    from: e.from,
    fromKind: e.fromKind,
    text: e.text,
    ...(e.answer ? { answer: JSON.parse(JSON.stringify(e.answer)) as HandoffAnswer } : {}),
  };
}

/** Options for {@link HandoffController}. */
export interface HandoffControllerOptions extends HandoffConfig {
  /** `fetch` to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Where sessions are kept. Defaults to `localStorage`; null keeps them in memory only. */
  storage?: Storage | null;
  /** The clock. */
  now?: () => number;
  /** First wait before picking up a stream the host cut off. Doubles up to 15 s. */
  resumeDelayMs?: number;
}

const STORAGE_KEY = 'nxis:handoffs:v1';
/** A finished handoff is kept a day, so its hand-back survives a reload; an open one a month. */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const KEEP_OPEN_MS = 30 * 24 * 60 * 60 * 1000;
const TARGETS_TTL_MS = 30 * 1000;
const MAX_SEEN = 200;
const MAX_RESUME_DELAY_MS = 15_000;
/** A stand-in is noted just before the tool that starts its handoff runs; one older than this was never used. */
const STAND_IN_TTL_MS = 60 * 1000;

/** The response header a relay ties a task to this browser with. */
export const HANDOFF_KEY_HEADER = 'Nxis-Handoff-Key';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A failure in words a visitor can read. */
function describeFailure(err: unknown, label: string): string {
  if (err instanceof A2AError) {
    if (err.status === 429) {
      return `${label} is busy right now.${err.retryAfter ? ` Try again in about ${Math.ceil(err.retryAfter / 60)} minute(s).` : ''}`;
    }
    if (err.status === 404) return `${label} isn't available on this site.`;
    if (err.status === 403) return `This conversation can't reach ${label} from here.`;
  }
  return `I couldn't reach ${label}.`;
}

/** Runs handoffs for every conversation on the page. Dispatches `handoff` events. */
export class HandoffController extends EventTarget {
  private readonly sessions = new Map<string, HandoffSession>();
  /** The stream open for each conversation, so a new one can close it first. */
  private readonly live = new Map<string, AbortController>();
  /** Consecutive resumes that brought nothing, per conversation, for backoff. */
  private readonly idle = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private targetsCache: { at: number; list: Promise<HandoffTarget[]> } | null = null;
  /** The ETags the agent cards were last read with; see ./cards.ts. */
  private readonly cards = {};
  /** Every target the relay has listed, by name, for {@link start}. */
  private readonly known = new Map<string, HandoffTarget>();
  /** The form the next handoff to each target stands in for; see {@link standIn}. */
  private readonly standIns = new Map<string, { run: PageFormRun; at: number }>();
  /** Events reported so far, so a stream can tell whether it brought anything new. */
  private reported = 0;
  private readonly storage: Storage | null;
  private loaded = false;

  constructor(private readonly opts: HandoffControllerOptions) {
    super();
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  }

  /** The page's target config. */
  get config(): HandoffConfig {
    return { relay: this.opts.relay, targets: this.opts.targets };
  }

  /**
   * The targets that can be offered: those on the relay's list that the page's
   * config names or the relay's agent cards describe, with the relay's
   * availability. See ./cards.ts.
   *
   * Read the first time it is asked, never on load, and cached for thirty
   * seconds. A relay that can't be reached offers none.
   */
  targets(): Promise<HandoffTarget[]> {
    const now = this.now();
    if (this.targetsCache && now - this.targetsCache.at < TARGETS_TTL_MS) return this.targetsCache.list;
    const list = this.fetchTargets().catch((err) => {
      console.warn('[nxis-handoff] could not read the relay:', err);
      this.targetsCache = null;
      return [];
    });
    this.targetsCache = { at: now, list };
    return list;
  }

  private async fetchTargets(): Promise<HandoffTarget[]> {
    const { loadTargets } = await import('./cards.js');
    const list = await loadTargets(this.opts, this.cards);
    for (const t of list) this.known.set(t.name, t);
    return list;
  }

  /** A conversation's handoff, open or finished, if it has one. */
  session(conversationId: string): HandoffSession | null {
    this.load();
    return this.sessions.get(conversationId) ?? null;
  }

  /** A conversation's handoff while it is open, else null. */
  active(conversationId: string | undefined): HandoffSession | null {
    if (!conversationId) return null;
    const s = this.session(conversationId);
    return s && !isHandoffOver(s.state) ? s : null;
  }

  /**
   * Say which site form the next handoff to a target stands in for.
   *
   * Noted by whatever runs the handoff tool, just before it runs — the harness
   * does, for a target that `takes` a form — and kept on the session that
   * {@link start} opens next for that target, so a resolved hand-back is
   * reported as that form being sent. `null` clears it. A note that no start
   * picks up within a minute is dropped.
   *
   * @param target - The target's name.
   * @param run - The form: its action's `@id` where known, and its tool name.
   */
  standIn(target: string, run: PageFormRun | null): void {
    if (run) this.standIns.set(target, { run: { ...run }, at: this.now() });
    else this.standIns.delete(target);
  }

  /**
   * Hand a conversation to a target.
   *
   * Resolves once the relay has accepted it; what the target says arrives as
   * events. Call only after the visitor has confirmed what is being sent.
   *
   * @throws When the target is not configured, the conversation is already
   * handed off, or the relay refuses. The session is marked failed first.
   */
  async start(conversationId: string, target: string, envelope: HandoffEnvelope): Promise<HandoffSession> {
    const config = this.opts.targets?.[target] ?? this.known.get(target);
    if (!config) throw new Error(`"${target}" is not a handoff target on this page.`);
    if (this.active(conversationId)) throw new Error('This conversation is already handed off.');

    const now = this.now();
    const noted = this.standIns.get(target);
    this.standIns.delete(target);
    const standsFor = noted && now - noted.at < STAND_IN_TTL_MS ? noted.run : undefined;
    const session: HandoffSession = {
      conversationId,
      target,
      label: config.label,
      kind: config.kind,
      state: 'connecting',
      startedAt: now,
      updatedAt: now,
      seen: [],
      ...(standsFor ? { standsFor } : {}),
    };
    this.sessions.set(conversationId, session);
    this.setState(session, 'connecting');

    const message = envelopeMessage(envelope);
    session.seen.push(message.messageId);
    let stream: A2AStream;
    const abort = this.openLive(conversationId);
    try {
      stream = await this.client(target).stream(
        'SendStreamingMessage',
        { message, configuration: { acceptedOutputModes: ['text/plain', 'application/json'] } },
        { signal: abort.signal },
      );
    } catch (err) {
      this.live.delete(conversationId);
      session.error = describeFailure(err, config.label);
      this.setState(session, 'failed');
      throw err;
    }
    const key = stream.headers.get(HANDOFF_KEY_HEADER);
    if (key) session.key = key;
    this.save();
    void this.pump(session, stream, abort);
    return session;
  }

  /**
   * Send what the visitor typed to the target handling this conversation.
   *
   * @throws When nothing is handed off, or the target hasn't answered yet.
   */
  async send(conversationId: string, text: string): Promise<void> {
    const session = this.active(conversationId);
    if (!session) throw new Error('This conversation is not handed off.');
    if (!session.taskId && !session.contextId) throw new Error(`Still connecting to ${session.label}.`);
    const message = visitorMessage(text, { taskId: session.taskId, contextId: session.contextId });
    this.remember(session, message.messageId);
    const abort = this.openLive(conversationId);
    try {
      const stream = await this.client(session.target).stream(
        'SendStreamingMessage',
        { message, configuration: { acceptedOutputModes: ['text/plain', 'application/json'] } },
        { signal: abort.signal, headers: this.keyHeader(session) },
      );
      void this.pump(session, stream, abort);
    } catch (err) {
      if (abort.signal.aborted) return;
      this.live.delete(conversationId);
      session.error = describeFailure(err, session.label);
      this.setState(session, 'failed');
      throw err;
    }
  }

  /**
   * 👍 or 👎 on one of the target's answers: a `feedback` part sent with `SendMessage` on the same task. It is
   * not a visitor message, and the page's model never sees it. What the target says back is reported like any
   * reply. At most once per answer, even when sending fails: the vote is recorded before it is sent.
   *
   * @returns Whether it was sent. False when nothing is handed off, the handoff is over or has no task yet,
   * the answer already has a vote, or the relay or target refused it.
   */
  async feedback(conversationId: string, answerId: string, value: FeedbackValue): Promise<boolean> {
    const session = this.active(conversationId);
    if (!session || (!session.taskId && !session.contextId)) return false;
    const given = (session.feedback ??= {});
    if (given[answerId]) return false;
    given[answerId] = value;
    this.save();
    try {
      // The task's history echoes it back as the visitor's: that is skipped, like every visitor message.
      const { result } = await this.client(session.target).call<A2AStreamResponse>(
        'SendMessage',
        { message: feedbackMessage(answerId, value, session) },
        { headers: this.keyHeader(session) },
      );
      if (result && !isHandoffOver(session.state)) this.apply(session, normaliseResponse(result));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * End a handoff at the visitor's request: "Back to the assistant".
   *
   * Cancels the task at the target. A target that won't cancel still loses the
   * visitor: the handoff is ended here either way.
   */
  async end(conversationId: string): Promise<void> {
    const session = this.active(conversationId);
    if (!session) return;
    this.closeLive(conversationId);
    if (session.taskId) {
      try {
        await this.client(session.target).call('CancelTask', { id: session.taskId }, { headers: this.keyHeader(session) });
      } catch {
        // Already finished, or unreachable: the visitor has left it regardless.
      }
    }
    this.setState(session, 'ended');
  }

  /**
   * Pick up an open handoff after a page change or reload.
   *
   * Subscribes to the task while it runs, or reads it once when it is waiting
   * on the visitor. Safe to call for any conversation, at any time: it does
   * nothing when there is no open handoff or a stream is already open.
   */
  async resume(conversationId: string): Promise<void> {
    const session = this.active(conversationId);
    if (!session || this.live.has(conversationId)) return;
    if (!session.taskId) {
      // It never got as far as a task: the page left before the target answered.
      session.error = `The connection to ${session.label} was lost before it started.`;
      this.setState(session, 'failed');
      return;
    }
    // An agent waiting on the visitor has nothing more to say until they answer. A person might.
    if (session.state === 'awaiting-visitor' && session.kind === 'agent') {
      await this.readOnce(session);
      return;
    }
    const abort = this.openLive(conversationId);
    try {
      const stream = await this.client(session.target).stream(
        'SubscribeToTask',
        { id: session.taskId },
        { signal: abort.signal, headers: this.keyHeader(session) },
      );
      void this.pump(session, stream, abort);
    } catch (err) {
      this.live.delete(conversationId);
      if (abort.signal.aborted) return;
      if (err instanceof A2AError && (err.status === 403 || err.status === 404)) {
        session.error = `The conversation with ${session.label} has expired.`;
        this.setState(session, 'failed');
        return;
      }
      // Finished while we were away (subscribing to a finished task is refused), or a blip.
      await this.readOnce(session);
    }
  }

  /** Stop every stream and pending resume. The sessions stay saved for the next page. */
  dispose(): void {
    for (const id of [...this.live.keys()]) this.closeLive(id);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── Streams ────────────────────────────────────────────────────────────────

  private client(target: string): A2AClient {
    const relay = this.opts.relay.replace(/\/+$/, '');
    return new A2AClient({
      endpoint: `${relay}/${encodeURIComponent(target)}`,
      extensions: [HANDOFF_EXTENSION],
      fetchImpl: this.opts.fetchImpl,
    });
  }

  private keyHeader(session: HandoffSession): Record<string, string> {
    return session.key ? { [HANDOFF_KEY_HEADER]: session.key } : {};
  }

  /** A fresh abort signal for a conversation's stream, closing the one before it. */
  private openLive(conversationId: string): AbortController {
    this.closeLive(conversationId);
    const abort = new AbortController();
    this.live.set(conversationId, abort);
    return abort;
  }

  private closeLive(conversationId: string): void {
    this.live.get(conversationId)?.abort();
    this.live.delete(conversationId);
    const timer = this.timers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(conversationId);
  }

  /** Read a stream to its end, then resume it if the task is still running. */
  private async pump(session: HandoffSession, stream: A2AStream, abort: AbortController): Promise<void> {
    const id = session.conversationId;
    // Progress is what the visitor would notice: a new message, a new state. A resubscribe that only
    // repeats the task as it stood is not progress, and must back off like an empty one.
    const before = this.reported;
    try {
      for await (const event of stream.events) {
        if (abort.signal.aborted) return;
        this.apply(session, event);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.warn(`[nxis-handoff] stream from ${session.label} broke:`, err);
    }
    if (abort.signal.aborted) return;
    if (this.live.get(id) === abort) this.live.delete(id);
    if (isHandoffOver(session.state)) return;
    // Waiting on the visitor: their next message opens the next stream.
    if (session.state === 'awaiting-visitor' && session.kind === 'agent') return;

    // The stream ended with the task still running: the host cut it off. Come back for the rest.
    const quiet = this.reported > before ? 0 : (this.idle.get(id) ?? 0) + 1;
    this.idle.set(id, quiet);
    const base = this.opts.resumeDelayMs ?? 1000;
    const delay = Math.min(base * 2 ** Math.max(0, quiet - 1), MAX_RESUME_DELAY_MS);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.resume(id);
      }, delay),
    );
  }

  /** Read a task once, for a handoff that can't or needn't be streamed. */
  private async readOnce(session: HandoffSession): Promise<void> {
    if (!session.taskId) return;
    try {
      const { result } = await this.client(session.target).call<A2ATask | { task: A2ATask }>(
        'GetTask',
        { id: session.taskId, historyLength: 50 },
        { headers: this.keyHeader(session) },
      );
      const task = (result as { task?: A2ATask }).task ?? (result as A2ATask);
      this.apply(session, { task });
    } catch (err) {
      session.error =
        err instanceof A2AError && (err.status === 403 || err.status === 404)
          ? `The conversation with ${session.label} has expired.`
          : describeFailure(err, session.label);
      this.setState(session, 'failed');
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private apply(session: HandoffSession, event: A2AStreamResponse): void {
    if (event.task) {
      const task = event.task;
      this.adopt(session, task.id, task.contextId);
      for (const message of task.history ?? []) this.message(session, message);
      for (const artifact of task.artifacts ?? []) this.parts(session, artifact.parts, artifact.artifactId);
      this.status(session, task.status);
    } else if (event.statusUpdate) {
      this.adopt(session, event.statusUpdate.taskId, event.statusUpdate.contextId);
      this.status(session, event.statusUpdate.status);
    } else if (event.artifactUpdate) {
      this.adopt(session, event.artifactUpdate.taskId, event.artifactUpdate.contextId);
      const a = event.artifactUpdate.artifact;
      this.parts(session, a.parts, a.artifactId);
    } else if (event.message) {
      // A reply with no task: the target answered at once. The context carries the conversation on.
      this.adopt(session, event.message.taskId, event.message.contextId);
      this.message(session, event.message);
      if (session.state === 'connecting' || session.state === 'queued') this.setState(session, 'active');
    }
  }

  private adopt(session: HandoffSession, taskId?: string, contextId?: string): void {
    let changed = false;
    if (taskId && session.taskId !== taskId) {
      session.taskId = taskId;
      changed = true;
    }
    if (contextId && session.contextId !== contextId) {
      session.contextId = contextId;
      changed = true;
    }
    if (changed) this.save();
  }

  private status(session: HandoffSession, status: A2ATaskStatus): void {
    const queue = readQueue(status.message?.parts);
    if (queue) session.queue = queue;
    // Who is speaking is known before what they say, so "Sam has joined" comes first.
    const operator = readOperator(status.message?.parts);
    if (operator) session.operator = operator.name;
    // A hand-back is read before the state is decided: it is what makes COMPLETED "handed back".
    const handBack = readHandBack(status.message?.parts);
    const next = handBack && status.state === 'TASK_STATE_COMPLETED' ? 'handed-back' : this.stateFor(status.state, session);
    const changed = !!next && (next !== session.state || !!queue);
    // A state that continues the conversation is announced before the message that comes with it;
    // one that ends it after the last word.
    if (changed && !isHandoffOver(next!)) this.setState(session, next!);
    if (status.message) this.message(session, status.message);
    if (!next) return;
    if (changed && isHandoffOver(next)) this.setState(session, next);
    if (isHandoffOver(next)) this.closeLive(session.conversationId);
  }

  private stateFor(state: A2ATaskState, session: HandoffSession): HandoffState | null {
    switch (state) {
      case 'TASK_STATE_SUBMITTED':
        return session.kind === 'person' ? 'queued' : 'connecting';
      case 'TASK_STATE_WORKING':
        return 'active';
      case 'TASK_STATE_INPUT_REQUIRED':
        return 'awaiting-visitor';
      case 'TASK_STATE_COMPLETED':
        return session.handBack ? 'handed-back' : 'ended';
      case 'TASK_STATE_CANCELED':
        return 'ended';
      case 'TASK_STATE_AUTH_REQUIRED':
        session.error = `${session.label} needs you to sign in, which isn't supported here yet.`;
        return 'failed';
      case 'TASK_STATE_FAILED':
      case 'TASK_STATE_REJECTED':
        session.error ??= `${session.label} couldn't take this conversation.`;
        return 'failed';
      default:
        return null;
    }
  }

  /** One message from the target: who is speaking, a hand-back, and the words. */
  private message(session: HandoffSession, message: A2AMessage): void {
    if (message.role === 'ROLE_USER') {
      this.remember(session, message.messageId);
      return;
    }
    if (message.messageId && session.seen.includes(message.messageId)) return;
    this.remember(session, message.messageId);
    this.parts(session, message.parts);
  }

  private parts(session: HandoffSession, parts: A2AMessage['parts'] = [], artifactId?: string): void {
    if (artifactId) {
      const seenKey = `artifact:${artifactId}`;
      if (session.seen.includes(seenKey)) return;
      this.remember(session, seenKey);
    }
    const operator = readOperator(parts);
    if (operator) {
      session.operator = operator.name;
      this.save();
    }
    const handBack = readHandBack(parts);
    const text = readableText(parts);
    const answer = readAnswer(parts);
    // The last words first, then what they hand back: the references follow the goodbye.
    if (text || answer) {
      this.emit({
        type: 'message',
        conversationId: session.conversationId,
        session,
        from: session.operator ?? session.label,
        fromKind: operator?.kind ?? session.kind,
        text,
        ...(answer ? { answer } : {}),
      });
    }
    if (handBack && !session.handBack) {
      session.handBack = handBack;
      this.reportResolved(session);
      this.save();
      this.emit({ type: 'handback', conversationId: session.conversationId, session, handBack });
    }
  }

  /**
   * A target that took a form's place and resolved it: reported as that form
   * sent, through the same reporter a page form's run goes to, with the
   * report token a link brought for the action. Only for `resolved`, and
   * once: the flag is saved with the session, so a hand-back read again after
   * a reload is not counted again.
   */
  private reportResolved(session: HandoffSession): void {
    if (!session.standsFor || session.reported || session.handBack?.outcome !== 'resolved') return;
    session.reported = true;
    try {
      reportFormRun({ ...session.standsFor });
    } catch {
      // Counting it is best effort; the hand-back stands either way.
    }
  }

  private remember(session: HandoffSession, id: string | undefined): void {
    if (!id || session.seen.includes(id)) return;
    session.seen.push(id);
    if (session.seen.length > MAX_SEEN) session.seen.splice(0, session.seen.length - MAX_SEEN);
    this.save();
  }

  private setState(session: HandoffSession, state: HandoffState): void {
    session.state = state;
    session.updatedAt = this.now();
    if (state !== 'queued') delete session.queue;
    if (isHandoffOver(state)) this.idle.delete(session.conversationId);
    this.save();
    this.emit({ type: 'state', conversationId: session.conversationId, session, state });
  }

  private emit(detail: HandoffEvent): void {
    this.reported++;
    this.dispatchEvent(new CustomEvent<HandoffEvent>('handoff', { detail }));
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const raw = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}') as Record<string, HandoffSession>;
      const now = this.now();
      for (const [id, s] of Object.entries(raw)) {
        const keep = isHandoffOver(s.state) ? KEEP_FINISHED_MS : KEEP_OPEN_MS;
        if (s && typeof s.target === 'string' && now - (s.updatedAt ?? 0) < keep && !this.sessions.has(id)) {
          this.sessions.set(id, { ...s, seen: Array.isArray(s.seen) ? s.seen : [] });
        }
      }
    } catch {
      // Unreadable: start afresh.
    }
  }

  private save(): void {
    if (!this.storage) return;
    this.load();
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.sessions)));
    } catch {
      // Full or blocked: the handoff still runs, it just won't survive a reload.
    }
  }
}
