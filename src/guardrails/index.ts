/**
 * Guardrails for the on-page agent: `@nxisai/agent-harness/guardrails`.
 *
 * Every turn passes through them, with the standard defaults on. The chat and the
 * headless harness never import this statically: they load it with a dynamic `import()` at the first open or the
 * first send, and a turn waits for it. If it can't load, no turn runs.
 *
 * @module
 */
import { Guardrails } from './runtime.js';
import type { ToolOrigin } from './context.js';
import type { GuardrailsConfig } from './types.js';
import type { GuardrailsHost } from './runtime.js';

// The public surface, kept small: every value exported here stays in the chunk. The rest is reachable from the
// modules themselves, for tests.
export { Guardrails, GuardrailRefusal } from './runtime.js';
export { STANDARD, STRICT, type Settings } from './defaults.js';
export { tierOf } from './tools.js';
export { hasSecret } from './patterns.js';
export { injected, exfiltrates } from './screen.js';
export type { ConversationState, GuardrailsHost, GuardrailsUi, Conversation, ToolRunner, RemotePolicy } from './runtime.js';
export { dataBlock, renderMessages, renderTools } from './context.js';
export type { ContextSources, ToolOrigin } from './context.js';
export type * from './types.js';
export type { GuardrailsPolicy, BrowserPolicy } from './policy-core.js';

/** What the guardrails are built from: a configuration, a runtime already built, or the element. */
export type GuardrailsSource = GuardrailsConfig | Guardrails | GuardrailsHost;

const built = new WeakMap<object, Guardrails>();


/**
 * The guardrails for a configuration: one runtime per object, so agents given the same one share its state.
 *
 * @param config - What the host configured; a runtime already built (returned as it is); or the `<nxis-agent>`
 * element, whose `guardrails` property (then attribute) is read live, and on which decisions are dispatched.
 * @param sources - Where each tool the harness registered came from. The harness passes its own record.
 */
export function createGuardrails(config: GuardrailsSource = {}, sources?: { get(name: string): ToolOrigin | undefined }): Guardrails {
  let g = config instanceof Guardrails ? config : built.get(config);
  if (!g) {
    g = new Guardrails(config as GuardrailsConfig | GuardrailsHost);
    built.set(config, g);
  }
  if (sources) g.sources = (n) => sources.get(n);
  return g;
}
