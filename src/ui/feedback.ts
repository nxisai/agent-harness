/**
 * Thumbs up and thumbs down (👍 and 👎) under a handoff target's answer, drawn as icons.
 *
 * The element loads this with a dynamic `import()` the first time it draws an answer that has an `answerId`, so a
 * page that never hands a conversation off pays nothing for it. It imports nothing at run time.
 *
 * The controls are enabled while the task the answer came on is open, and an answer gets one vote: kept with the
 * answer (so it survives a reload, and the controls stay pressed), and sent to the target as a feedback part. It
 * never reaches the page's model and is never drawn as something the visitor said.
 *
 * @module
 */
import type { HandoffSession } from '../handoff/controller.js';
import type { HandoffAnswer } from '../handoff/envelope.js';

/** 👍 or 👎. */
export type Vote = 'up' | 'down';

/** What the controls show: the vote given, if any, and whether a vote can be given now. */
export interface FeedbackState {
  value?: Vote;
  enabled: boolean;
}

export const FEEDBACK_CSS = `
.fb { display: flex; gap: 6px; padding-left: 4px; }
.fb-btn { min-width: 40px; min-height: 40px; padding: 0 9px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink); font: 15px var(--sans); display: inline-grid; place-items: center; cursor: pointer; }
.fb-btn svg { width: 20px; height: 20px; display: block; }
.fb-btn .fb-s, .fb-btn[aria-pressed="true"] .fb-o { display: none; }
.fb-btn[aria-pressed="true"] .fb-s { display: block; }
.fb-btn:hover:not(:disabled) { background: var(--blue-tint); }
.fb-btn[aria-pressed="true"] { border: 1.5px solid var(--blue); background: var(--blue-tint); }
.fb-btn:disabled { cursor: default; }
.fb-btn:disabled:not([aria-pressed="true"]) { opacity: .45; }
.fb-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
`;

// Heroicons v2.2.0, MIT, © Tailwind Labs (https://heroicons.com). See THIRD_PARTY_NOTICES.
/** A 24/outline icon, drawn while the button isn't pressed. */
const outline = (d: string) =>
  `<svg class="fb-o" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
/** The same icon, 24/solid: drawn once the button is pressed. */
const solid = (d: string) => `<svg class="fb-s" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
/** hand-thumb-up */
const THUMB_UP =
  outline('M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23H5.904m10.598-9.75H14.25M5.904 18.5c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 0 1-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 9.953 4.167 9.5 5 9.5h1.053c.472 0 .745.556.5.96a8.958 8.958 0 0 0-1.302 4.665c0 1.194.232 2.333.654 3.375Z') +
  solid('M7.493 18.5c-.425 0-.82-.236-.975-.632A7.48 7.48 0 0 1 6 15.125c0-1.75.599-3.358 1.602-4.634.151-.192.373-.309.6-.397.473-.183.89-.514 1.212-.924a9.042 9.042 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75A.75.75 0 0 1 15 2a2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H14.23c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23h-.777ZM2.331 10.727a11.969 11.969 0 0 0-.831 4.398 12 12 0 0 0 .52 3.507C2.28 19.482 3.105 20 3.994 20H4.9c.445 0 .72-.498.523-.898a8.963 8.963 0 0 1-.924-3.977c0-1.708.476-3.305 1.302-4.666.245-.403-.028-.959-.5-.959H4.25c-.832 0-1.612.453-1.918 1.227Z');
/** hand-thumb-down */
const THUMB_DOWN =
  outline('M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715a12.137 12.137 0 0 1-.068-1.285c0-2.848.992-5.464 2.649-7.521C5.287 4.247 5.886 4 6.504 4h4.016a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23h1.294M7.498 15.25c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.75 2.25 2.25 0 0 0 9.75 22a.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384m-10.253 1.5H9.7m8.075-9.75c.01.05.027.1.05.148.593 1.2.925 2.55.925 3.977 0 1.487-.36 2.89-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398-.306.774-1.086 1.227-1.918 1.227h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 0 0 .303-.54') +
  solid('M15.73 5.5h1.035A7.465 7.465 0 0 1 18 9.625a7.465 7.465 0 0 1-1.235 4.125h-.148c-.806 0-1.534.446-2.031 1.08a9.04 9.04 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.499 4.499 0 0 0-.322 1.672v.633A.75.75 0 0 1 9 22a2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282H3.622c-1.026 0-1.945-.694-2.054-1.715A12.137 12.137 0 0 1 1.5 12.25c0-2.848.992-5.464 2.649-7.521C4.537 4.247 5.136 4 5.754 4H9.77a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23ZM21.669 14.023c.536-1.362.831-2.845.831-4.398 0-1.22-.182-2.398-.52-3.507-.26-.85-1.084-1.368-1.973-1.368H19.1c-.445 0-.72.498-.523.898.591 1.2.924 2.55.924 3.977a8.958 8.958 0 0 1-1.302 4.666c-.245.403.028.959.5.959h1.053c.832 0 1.612-.453 1.918-1.227Z');

const VOTES: readonly [Vote, string, string][] = [
  ['up', THUMB_UP, 'Helpful'],
  ['down', THUMB_DOWN, 'Not helpful'],
];

/** The part of a remote message the controls read and write. */
export interface FeedbackItem {
  answer?: HandoffAnswer;
  /** The task the answer came on. */
  task?: string;
  feedback?: Vote;
}

/** What the controls need of the element: the conversation's open handoff, and a way to send a vote. */
export interface FeedbackHost {
  session(): HandoffSession | null | undefined;
  /** Save the conversation (the item now holds the vote) and send the vote to the target. */
  send(answerId: string, value: Vote): void;
}

/** Whether the answer's task is the conversation's open handoff, and what was voted. */
export function feedbackState(item: FeedbackItem, session: HandoffSession | null | undefined): FeedbackState {
  return { value: item.feedback, enabled: !!item.task && !!session && (session.taskId ?? session.contextId) === item.task };
}

/** Every set of controls drawn, and how to read its answer's state. */
const painted = new Map<HTMLElement, () => FeedbackState>();

/**
 * Draw the controls on an answer. Each is a toggle button (`aria-pressed`) named by its meaning (its icon is
 * hidden from assistive technology), in a group named by the question. Once a vote is given, or a vote can't be given, both are disabled; the one
 * given stays pressed.
 *
 * @param answer - The answer's element, `.remote[data-answer-id]`, already in the thread.
 * @param item - The remote message: its answer, its task, and the vote once given, which a click sets.
 */
export function paintFeedback(answer: HTMLElement, item: FeedbackItem, host: FeedbackHost): void {
  const state = () => feedbackState(item, host.session());
  const doc = answer.ownerDocument;
  const root = answer.getRootNode();
  const styles = root instanceof ShadowRoot ? root : doc.head;
  if (!styles.querySelector('style[data-fb]')) {
    const style = doc.createElement('style');
    style.dataset.fb = '';
    style.textContent = FEEDBACK_CSS;
    styles.append(style);
  }
  for (const old of answer.querySelectorAll('.fb')) old.remove();
  const group = doc.createElement('div');
  group.className = 'fb';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Was this answer helpful?');
  for (const [value, icon, label] of VOTES) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'fb-btn';
    b.dataset.feedback = value;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon;
    b.addEventListener('click', () => {
      if (b.disabled || item.feedback || !item.answer) return;
      item.feedback = value;
      host.send(item.answer.answerId, value);
      syncFeedback();
    });
    group.append(b);
  }
  answer.append(group);
  painted.set(group, state);
  update(group, state());
}

/** Bring every answer's controls up to date, as their state now reads; answers no longer on the page are forgotten. */
export function syncFeedback(): void {
  for (const [group, state] of painted) {
    if (group.isConnected) update(group, state());
    else painted.delete(group);
  }
}

function update(group: HTMLElement, { value, enabled }: FeedbackState): void {
  for (const b of group.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.feedback === value));
    b.disabled = !enabled || !!value;
  }
}
