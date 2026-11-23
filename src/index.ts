/**
 * Headless entry point for `@nxisai/agent-harness`.
 *
 * Everything exported here runs without a UI. For the packaged chat element,
 * import `@nxisai/agent-harness/ui`; to keep this decision logic behind an
 * interface of your own, implement {@link HarnessRenderer}.
 *
 * @example
 * ```ts
 * import { AgentHarness } from '@nxisai/agent-harness';
 *
 * const harness = new AgentHarness({ renderer });
 * await harness.turn('book me in for Thursday', messages);
 * ```
 *
 * @module
 */

export { AgentHarness } from './harness/harness.js';

// ── Model providers ──────────────────────────────────────────────────────────
export { LocalGemmaProvider, AgentEngine, shouldUseCache } from './engine.js';
export { createProxyProvider } from './providers/proxy.js';
export type { ProxyProviderOptions } from './providers/proxy.js';
export { assessLocalCapability, requestPersistentStorage } from './providers/capability.js';
export type { LocalCapability } from './providers/capability.js';
export type {
  ModelProvider,
  CompletionRequest,
  Completion,
  CacheHint,
} from './providers/types.js';

// ── Tools, as the harness sees them ──────────────────────────────────────────
export { WebMcpTools } from './harness/tools/webmcp.js';
export {
  toolSchema,
  missingRequired,
  reconcileArgs,
  extractResult,
  proseAnswer,
} from './harness/tools/schema.js';
export type { HarnessOptions, TurnResult } from './harness/harness.js';

export { policyFor, decide } from './harness/policy.js';
export type { ToolPolicy, Decision } from './harness/policy.js';

export { resolveSlots, summarySlots } from './harness/slots.js';
export type { Slot, Resolution, ResolveSources } from './harness/slots.js';

export { buildPlan } from './harness/plan.js';

export { actionCta, cardCtas, mediaCtas, seriesCtas, seriesAccess, seriesParts, targetUrl } from './harness/cta.js';
export type { CardAction, CardButton, CardCtas, OpenAction } from './harness/cta.js';
export { groupBySeries, mediaLine, mediaLineText, mediaRow, seriesCard, SERIES_PARTS_SHOWN } from './harness/media.js';
export type { MediaRow, SeriesCard } from './harness/media.js';
export { arrangeEvents, calendarUrl, eventAccess, eventCard, eventFacts, recordKey } from './harness/happening.js';
export type { EventAccess, EventButton, EventCard, EventOptions, EventPart, EventRef, EventWhen } from './harness/happening.js';
export { clock, runtime } from './harness/entity.js';
export { openTarget, openWay, type OpenWay, type OpenTargetOptions } from './harness/tools/open-target.js';

export { AgentCoordinator } from './harness/router/coordinator.js';
export type { CoordinatorOptions, RoutedTurn, RouteSource } from './harness/router/coordinator.js';
export { matchRoute } from './harness/router/rules.js';
export type { RouteRule, RouteDecision } from './harness/router/rules.js';
export type { ClarificationPlan, PlanStep } from './harness/plan.js';

export type {
  HarnessRenderer,
  AskRequest,
  ConfirmRequest,
  ResultsExtra,
  StreamingBubble,
} from './harness/renderer.js';

export {
  parseToolCall,
  stripMarkers,
  humanize,
  lcFirst,
  escapeHtml,
  MODEL_ID,
  MODEL_HOST,
  MODEL_PATH_TEMPLATE,
  SYSTEM_PROMPT,
  MAX_STEPS,
  MAX_NEW_TOKENS,
  TOOLS_TIMEOUT_MS,
} from './engine.js';

/**
 * Brand marks and icons used by the packaged UI.
 *
 * Exported for custom renderers. Inline SVG using `currentColor`, so each icon
 * takes the surrounding text colour.
 */
export {
  NXIS_LOGO_SVG,
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
} from './engine.js';
export type {
  AgentEngineOptions,
  ChatMessage,
  ToolDef,
  GenerationUsage,
  ParsedToolCall,
  ProgressDetail,
  PreloadMode,
} from './engine.js';

export { connectTools, waitForModelContext } from './harness/tools/source.js';
export {
  buildSiteActionTools,
  registerSiteActionTools,
  withoutShadowedTools,
  handoffFor,
  findPageTool,
  awaitPageTool,
  pageToolRef,
  siteToolName,
  sanitizeToolName,
  selectSiteTools,
  DEFAULT_SITE_TOOL_LIMIT,
} from './harness/tools/action-tools.js';
export {
  beginJourney,
  currentJourney,
  journeySteps,
  onJourneyChange,
  recordStep,
  restoreJourney,
} from './harness/steps.js';
export type { AgentStep, AgentStepId, AgentStepStatus } from './harness/steps.js';
export { resumePendingAction } from './harness/tools/resume.js';
export type { ResumeOutcome, ResumeOptions } from './harness/tools/resume.js';
// Arriving from the NxisAI app to use one of this page's forms.
export {
  HANDOFF_PARAM,
  INTENT_PARAM,
  readInboundHandoff,
  takeInboundHandoff,
  handoffUrl,
  findHandoffForm,
} from './harness/tools/inbound.js';
export type { InboundHandoff, ArrivalOutcome, ArrivalOptions } from './harness/tools/inbound.js';
export {
  loadSitePages,
  parsePage,
  pagesFromActions,
  mergePages,
  pageForEntity,
  findPage,
} from './harness/tools/site-pages.js';
export type { SitePage, SitePagesOptions } from './harness/tools/site-pages.js';
export { buildOpenPageTool, registerOpenPageTool, resolveDestination, visitFor, OPEN_PAGE_TOOL } from './harness/tools/open-page.js';
export { isRateLimited, retryAfterMs, withRetry } from './harness/tools/retry.js';
export { setSiteActionReporter, TRACK_TOOL, type PageFormRun, type SiteActionReport, type SiteActionReporter } from './harness/tools/report.js';
export type { RetryOptions } from './harness/tools/retry.js';
export {
  applyTrails,
  buildNav,
  buildPageLinksTool,
  describeNav,
  loadSiteTrails,
  nameOf,
  navFor,
  parentOf,
  parseTrail,
  registerPageLinksTool,
  PAGE_LINKS_TOOL,
} from './harness/tools/site-nav.js';
export type { NavLink, PageNav, SiteNav, SiteTrail, SiteTrailsOptions, TrailLevel } from './harness/tools/site-nav.js';
export type { OpenPageOptions, Destination } from './harness/tools/open-page.js';
export type { SiteActionTool, Handoff, PageToolRef } from './harness/tools/action-tools.js';
export {
  savePendingAction,
  takePendingAction,
  clearPendingAction,
  PENDING_TTL_MS,
  savePendingVisit,
  takePendingVisit,
  setConversationSource,
} from './harness/tools/pending-action.js';
export type { PendingAction, PendingVisit } from './harness/tools/pending-action.js';
export { findEmbeddedAction, loadSiteActions, parseAction, type EmbeddedActionQuery } from './harness/tools/site-actions.js';
export { extractRecords, openStatus, recordFacts, factLines, type OpenStatus, type RecordFacts } from './harness/records.js';
export { recommend, grounded, RECOMMEND_TOOL, type ResultPick, type RecommendRequest } from './harness/recommend.js';
export type { ConnectResult, ConnectOptions, SiteActionsOptions } from './harness/tools/source.js';
export type { BridgeOptions } from './harness/tools/bridge.js';

// Handing a conversation to another agent or a person, over A2A. See docs/handoff.md.
export * from './handoff/index.js';

export type {
  JsonSchema,
  ModelContext,
  ModelContextTool,
  ModelContextToolInfo,
  ModelContextToolResponse,
  McpServerInfo,
  NxisConfig,
} from './types.js';

export type {
  NxisAction,
  NxisEntryPoint,
  NxisPropertyValueSpecification,
  NxisValueOption,
} from './webmcp-contract.js';
