/**
 * The interface between the harness and a user interface.
 *
 * The harness makes every decision about what to do; a renderer is asked only
 * to draw and to report what a person did. Keeping this interface narrow is
 * what allows the same harness to drive the bundled web component, an A2UI
 * surface, or a UI of your own.
 *
 * @module
 */

import type { ModelContextToolInfo, ModelContextToolResponse } from '../types.js';
import type { ClarificationPlan } from './plan.js';
import type { Resolution, Slot } from './slots.js';
import type { AgentStep } from './steps.js';
import type { ResultPick } from './recommend.js';

/** One tool call and its response, for renderers that show their work. */
export interface TraceEntry {
  /** The tool that was called. */
  tool: ModelContextToolInfo;
  /** Arguments as sent, after the harness reconciled and filled them. */
  args: Record<string, unknown>;
  /** The response, flattened to text. */
  text: string;
  /** Whether the tool reported a failure. */
  isError: boolean;
  /** How many records came back, when the response was a record set. */
  count?: number;
}

/**
 * The assistant's bubble for one phase of a turn.
 *
 * A turn is not one continuous stream. The harness opens a bubble, moves it
 * through its phases and finalizes it, then opens another when the next silence
 * begins, so {@link HarnessRenderer.streaming} is called more than once per turn
 * and each bubble should be treated as independent.
 *
 * The usual order:
 *
 * ```ts
 * bubble.thinking('Loading model…');        // no output yet
 * bubble.update('The nearest plumb');       // text has started arriving
 * bubble.finalize('The nearest plumber is…'); // the phase is over
 * ```
 */
export interface StreamingBubble {
  /**
   * Show that work is happening, before there is anything to show.
   *
   * A turn can be silent for a long time: loading model weights takes tens of
   * seconds on a first visit. Safe to call repeatedly, since each call replaces
   * the label in place rather than adding a bubble.
   *
   * @param label - The current phase, such as `'Loading model…'`. Omit it to
   * indicate work with nothing worth naming.
   */
  thinking(label?: string): void;

  /**
   * Stream the answer as it is produced.
   *
   * @param text - The whole visible answer so far, not the newest fragment.
   * Replace the bubble's contents with it; appending accumulates the answer on
   * itself. Tool-call markers are already stripped.
   */
  update(text: string): void;

  /**
   * Close the bubble with its final text.
   *
   * Usually the last call a bubble receives, but not guaranteed to be: when the
   * model answers with a question instead of calling a tool, the harness runs a
   * second generation into the same bubble, so `update` can follow a non-empty
   * `finalize`. Implementations should stay usable rather than throwing.
   *
   * @param text - The text to keep. Empty means the phase produced nothing
   * worth keeping (a failed load, a finished tool call, a generation that was
   * only a tool call), and the bubble should be removed rather than left blank.
   */
  finalize(text: string): void;
}

/** What the harness adds to a search's results. */
export interface ResultsExtra {
  /**
   * The record the model recommends, with reasons the record backs. Absent
   * when there was one result, the model gave no backed reason, or
   * recommendations are off: show the results as a list.
   */
  pick?: ResultPick;
}

/** A write tool with every value resolved, awaiting a human press. */
export interface ConfirmRequest {
  /** The tool about to be called. */
  tool: ModelContextToolInfo;
  /** Rows to display read-only. Nothing is missing, so nothing is editable. */
  slots: Slot[];
  /** The values that will be sent. */
  values: Record<string, unknown>;
  /**
   * What the submit button should say, when "Submit" would understate it.
   *
   * Set for a form on another page of the site, where pressing submit also
   * takes the visitor there: `'Open & submit'`. Short on purpose, since a
   * card in a window or a rail has little room; {@link destination} carries
   * the rest. A renderer that ignores both still works, but the page change
   * arrives unannounced.
   */
  submitLabel?: string;
  /**
   * The page pressing submit will open, named for the visitor:
   * `'Royal Oak Remodeling'`. Set with {@link submitLabel}, for a renderer
   * to say in a sentence what the button no longer has room to.
   */
  destination?: string;
  /** Call to proceed, optionally with values the user amended. */
  onSubmit(values: Record<string, unknown>): void;
  /** Call if the user declines. */
  onCancel(): void;
  /** Call to open the full editable form instead of confirming. */
  onEdit(): void;
}

/** A tool call missing required values, and the plan for asking about them. */
export interface AskRequest {
  /** The tool waiting on the answers. */
  tool: ModelContextToolInfo;
  /** The questions to ask, as one step or several. */
  plan: ClarificationPlan;
  /** What is already known, and from where. */
  resolution: Resolution;
  /** Call with the merged values once the last step is answered. */
  onComplete(values: Record<string, unknown>): void;
  /** Call if the user abandons the questions. */
  onCancel(): void;
}

/**
 * Everything the harness needs from a user interface.
 *
 * Required members are called during an ordinary turn. Optional ones may be
 * omitted by a renderer that has nothing to show for them.
 */
export interface HarnessRenderer {
  /** Add a complete message, already known in full. */
  message(role: 'user' | 'assistant', text: string): void;

  /**
   * Open a bubble for the phase about to start.
   *
   * Called several times per turn: once before the model is touched, so the
   * thread is never silent while weights download, and again around each tool
   * call. Each bubble is finalized before the next is requested.
   *
   * @returns The bubble the harness will drive through that phase.
   */
  streaming(): StreamingBubble;

  /**
   * Show a one-line status outside the thread, such as a header strip.
   *
   * @param text - The status. Empty clears it.
   * @param isError - Whether to present the status as a failure.
   */
  status(text: string, isError?: boolean): void;

  /** Ask for missing values, as one question or a stepper. */
  ask(req: AskRequest): void;
  /** Present a write for confirmation. Nothing is missing. */
  confirm(req: ConfirmRequest): void;

  /** A read tool returned records. */
  results(tool: ModelContextToolInfo, res: ModelContextToolResponse, extra?: ResultsExtra): void;
  /** A write tool succeeded. */
  detail(tool: ModelContextToolInfo, values: Record<string, unknown>, text: string): void;
  /** A tool failed, or returned something that cannot be rendered. */
  toolError(tool: ModelContextToolInfo, message: string): void;

  /**
   * Record the exchange behind a rendered card.
   *
   * Distinct from {@link HarnessRenderer.results} and
   * {@link HarnessRenderer.detail}, which draw the outcome the user asked for.
   * A trace is the underlying call and raw response, suited to a collapsed
   * panel. Omit it to record nothing.
   */
  trace?(entry: TraceEntry): void;

  /**
   * Report what the agent is doing, for a surface that shows progress.
   *
   * The thread says what was said; this says that the page is about to
   * change, or that a form is being filled right now. A chat panel can ignore
   * it — the status line and the cards already cover the same ground — and a
   * copilot surface beside the page is built on it.
   *
   * @param step - The step that changed.
   * @param all - Every step of this journey, oldest first, including the ones
   * taken before a page change.
   */
  step?(step: AgentStep, all: AgentStep[]): void;

  /** Tear down any live ask or confirm UI. */
  dismissPrompt?(): void;

  /**
   * Whether this renderer's ask and confirm prompts say for themselves what
   * they need and where they go.
   *
   * When true, the harness adds no "One more thing for …" line of its own
   * before an ask: the prompt already reads as the assistant speaking.
   */
  inlinePrompts?: boolean;

  /**
   * A confirmed call is leaving for the page that can submit it.
   *
   * Called instead of the harness's own "Opening … to submit this…" message,
   * for a renderer that shows the departure on the prompt the visitor just
   * confirmed. The page it opens finishes the call.
   *
   * @param tool - The tool whose call is travelling.
   * @param destination - The page it is going to, named for the visitor, or
   * null when the harness cannot tell which.
   */
  left?(tool: ModelContextToolInfo, destination: string | null): void;

  /**
   * Report whether the turn can still be stopped.
   *
   * Called with `true` when a turn starts and `false` when it ends, and also
   * `false` as soon as a tool is invoked: past that point the call may already
   * have reached a server, so it can no longer be cancelled.
   *
   * @param canStop - Whether {@link AgentHarness.stop} would still take effect.
   */
  stoppable?(canStop: boolean): void;
}
