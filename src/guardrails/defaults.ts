/**
 * The presets' numbers, and the settings a check reads: the preset's, with whatever the host set on top.
 *
 * @module
 */
import type { GuardrailsConfig } from './types.js';

/** Every limit the rules read. */
export interface Settings {
  strict: boolean;
  input: { maxLength: number; sendsPerMinute: number };
  tools: {
    /** Tool calls per turn: what `MAX_STEPS` (src/engine.ts) was for. */
    maxPerTurn: number;
    perMinute: number;
    timeoutMs: number;
    /** Consecutive failed calls that stop the turn. */
    maxFailures: number;
    /** The longest a call's arguments may be, as JSON. */
    maxArgChars: number;
  };
  output: { maxLength: number };
  /** Generations per turn, and output tokens per turn where the provider reports them. */
  model: { maxSteps: number; maxTokens: number };
  /** How long a visitor's approval of one call stays usable. */
  approvalMs: number;
}

/** `preset: 'standard'`, the default. */
export const STANDARD: Settings = {
  strict: false,
  input: { maxLength: 4000, sendsPerMinute: 10 },
  tools: { maxPerTurn: 3, perMinute: 30, timeoutMs: 20_000, maxFailures: 5, maxArgChars: 10_000 },
  output: { maxLength: 8000 },
  model: { maxSteps: 8, maxTokens: 16_000 },
  approvalMs: 120_000,
};

/** `preset: 'strict'`: tighter caps. What else it changes is in the rules. */
export const STRICT: Settings = {
  strict: true,
  input: { maxLength: 2000, sendsPerMinute: 6 },
  tools: { maxPerTurn: 2, perMinute: 15, timeoutMs: 15_000, maxFailures: 3, maxArgChars: 4000 },
  output: { maxLength: 4000 },
  model: { maxSteps: 6, maxTokens: 8000 },
  approvalMs: 60_000,
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

/** The settings for a configuration: its preset's, with the host's numbers on top. */
export function settingsFor(c: GuardrailsConfig): Settings {
  const p = c.preset === 'strict' ? STRICT : STANDARD;
  const t = c.tools ?? {};
  const i = c.input ?? {};
  return {
    ...p,
    input: { maxLength: num(i.maxLength, p.input.maxLength), sendsPerMinute: num(i.sendsPerMinute, p.input.sendsPerMinute) },
    output: { maxLength: num(c.output?.maxLength, p.output.maxLength) },
    tools: {
      ...p.tools,
      maxPerTurn: num(t.maxPerTurn, p.tools.maxPerTurn),
      perMinute: num(t.perMinute, p.tools.perMinute),
      timeoutMs: num(t.timeoutMs, p.tools.timeoutMs),
    },
  };
}
