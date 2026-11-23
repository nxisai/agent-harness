/**
 * The packaged chat element.
 *
 * Importing this module registers the `<nxis-agent>` custom element, and
 * `<nxis-agent-fullscreen>`, its deprecated old name.
 *
 * @example
 * ```ts
 * import '@nxisai/agent-harness/ui';
 * ```
 * ```html
 * <nxis-agent></nxis-agent>
 * ```
 *
 * @module
 */
export { NxisAgent, NxisAgentFullscreen } from './agent.js';
export type { AgentPreferences, AgentDefinition } from './agent.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUGGESTIONS,
  DEFAULT_EMPTY_STATE,
  DEFAULT_AGENT_NAME,
  DEFAULT_LOGO,
  THEME_TOKENS,
  PROFILE_ALIASES,
} from './config.js';
export type { AgentTheme } from './config.js';
export type { PreloadMode, ProgressDetail } from '../engine.js';
export { A2UI_THEME_CSS, NXIS_PRIMARY } from '../a2ui/theme.js';
export { viewJourney } from './journey.js';
export type { JourneyView } from './journey.js';
