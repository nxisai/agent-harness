/**
 * Handoff targets that take a site form's place.
 *
 * A site with an agent for quotes wants quotes to go to it, not into the
 * page's quote form. A prompt line saying so loses to a tool named for exactly
 * what the visitor asked: the model sees `quote_form` and calls it. So a
 * target says which forms it `takes` (see {@link HandoffTargetConfig.takes}),
 * and while the relay lists it as available:
 *
 * - the model is not offered those forms;
 * - a call to one anyway becomes the handoff to the target, built from the
 *   call's own arguments, and confirmed like any handoff;
 * - the handoff remembers which form it stands in for, so a resolved
 *   hand-back is reported as that form being sent.
 *
 * Anything short of a clear "available" — the relay down or slow, the target
 * away or not listed — leaves the forms exactly as they were.
 *
 * @module
 */
import { actionIdFor, chooserOf, isSiteTool, withoutSiteSuffix } from '../harness/tools/action-tools.js';
import type { PageFormRun } from '../harness/tools/report.js';
import type { ModelContextToolInfo } from '../types.js';
import type { HandoffController, HandoffKind, HandoffTarget, HandoffTargetConfig } from './controller.js';
import { TALK_TO_A_PERSON_TOOL, TRANSFER_TO_AGENT_TOOL } from './tools.js';

/**
 * How long a turn waits for the relay's answer before going ahead with the
 * forms offered. The answer is normally cached already: the element reads it
 * when it registers the handoff tools.
 */
export const TAKERS_WAIT_MS = 1500;

/** The handoff tool that reaches a target of this kind. */
export const handoffToolFor = (kind: HandoffKind): string => (kind === 'agent' ? TRANSFER_TO_AGENT_TOOL : TALK_TO_A_PERSON_TOOL);

/**
 * Whether a target takes a form, by the form's tool name.
 *
 * Both sides are read without the site-wide suffix, so `'quote_form'` covers
 * `quote_form` and `quote_form_anywhere`.
 */
export function takesForm(target: Pick<HandoffTargetConfig, 'takes'>, toolName: string): boolean {
  if (!target.takes?.length || !toolName) return false;
  const stem = withoutSiteSuffix(toolName);
  return target.takes.some((name) => typeof name === 'string' && name && withoutSiteSuffix(name) === stem);
}

/**
 * The targets the controller lists now, waiting at most `waitMs` for them.
 *
 * @returns Null when there is no controller or the relay is slow: what a turn
 * offers then stays as it was. A relay that errs lists none.
 */
export async function listedTargets(
  controller: HandoffController | null | undefined,
  opts: { waitMs?: number } = {},
): Promise<HandoffTarget[] | null> {
  if (!controller) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      controller.targets(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), opts.waitMs ?? TAKERS_WAIT_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Of these targets, the ones taking forms now: those that `take` any, listed as available. */
export const takingNow = (listed: HandoffTarget[] | null): HandoffTarget[] =>
  (listed ?? []).filter((t) => t.available === true && !!t.takes?.length);

/**
 * The targets taking forms right now: those that `take` any, as the relay
 * lists them, and only those it lists as available.
 *
 * Reads the controller's cached list, waiting at most `waitMs` for it. A
 * relay that errs, is slow, or leaves a target out means that target takes
 * nothing this time.
 */
export async function formTakers(
  controller: HandoffController | null | undefined,
  opts: { waitMs?: number } = {},
): Promise<HandoffTarget[]> {
  if (!controller || !Object.values(controller.config.targets ?? {}).some((t) => t.takes?.length)) return [];
  return takingNow(await listedTargets(controller, opts));
}

/** The first of these targets that takes a form, or null. */
export function takerOf(toolName: string, takers: HandoffTarget[]): HandoffTarget | null {
  return takers.find((t) => takesForm(t, toolName)) ?? null;
}

/**
 * The available target that takes a form, if any, read as {@link formTakers}
 * reads it. For a host deciding whether to open a form or hand off instead.
 */
export async function formTakenBy(
  controller: HandoffController | null | undefined,
  toolName: string,
  opts: { waitMs?: number } = {},
): Promise<HandoffTarget | null> {
  return takerOf(toolName, await formTakers(controller, opts));
}

/** `full_name` → `full name`. */
const humanize = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

/** A value the call gave, as one short piece of text; empty for nothing, or for something that is not a value. */
function said(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(said).filter(Boolean).join(', ');
  return '';
}

/** Why, in one line: "Wants a quote from McManus Electric", "Wants to use the booking form". */
function wants(noun: string, choice: string): string {
  if (/quote/.test(noun)) return choice ? `Wants a quote from ${choice}` : 'Wants a quote';
  const form = /\bform\b/.test(noun) ? noun : `${noun} form`;
  return choice ? `Wants to use the ${form} for ${choice}` : `Wants to use the ${form}`;
}

/**
 * The handoff that takes the place of a call to a form.
 *
 * The reason says what the form is for, in the words a result card's button
 * uses ("Wants a quote from McManus Electric"); the summary repeats the values
 * the call carried, by field, and nothing else — no value is made up, and the
 * visitor reads both before pressing Send.
 *
 * @param target - The target that takes the form.
 * @param form - The form tool called; only its name and annotations are read.
 * @param args - The call's arguments.
 * @returns A call to `transfer_to_agent` or `talk_to_a_person`.
 */
export function handoffCallFor(
  target: Pick<HandoffTarget, 'name' | 'kind'>,
  form: ModelContextToolInfo,
  args: Record<string, unknown> | undefined,
): { name: string; args: Record<string, unknown> } {
  const noun = humanize(withoutSiteSuffix(form.name)).toLowerCase() || 'form';
  // Which business a site-wide form is for goes in the reason, not again in the summary.
  const chooser = chooserOf(form);
  const choice = chooser ? said(args?.[chooser]) : '';
  const reason = wants(noun, choice);
  const given = Object.entries(args ?? {})
    .filter(([key]) => !(choice && key === chooser))
    .map(([key, value]) => [humanize(key), said(value)] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  const summary = given.length ? `${reason}. ${given.join('; ')}.` : `${reason}.`;
  return { name: handoffToolFor(target.kind), args: { target: target.name, reason, summary } };
}

/**
 * The form a call stands for, as a report would name it: the action's `@id`
 * where the tool records it (or, for a site-wide tool, where the call says
 * which business), and the tool's name.
 */
export function standInFor(form: ModelContextToolInfo, args: Record<string, unknown> | undefined): PageFormRun {
  const actionId = actionIdFor(form, args);
  return { toolName: form.name, ...(actionId ? { actionId } : {}) };
}

/**
 * The page's own form a target takes, when the model handed off directly
 * instead of calling it: the one form on this page the handoff replaces.
 *
 * Only a page's own tool counts — a site-wide one reaches every business's
 * form, and nothing in a direct handoff says which — and only when exactly one
 * is registered.
 *
 * @returns The form, or null when the page has none or several.
 */
export function pageFormTakenBy(target: Pick<HandoffTarget, 'takes'>, registered: ModelContextToolInfo[]): PageFormRun | null {
  const own = registered.filter((t) => takesForm(target, t.name) && !isSiteTool(t));
  return own.length === 1 ? standInFor(own[0], undefined) : null;
}
