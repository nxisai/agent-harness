/**
 * Handing a conversation to another agent or a person, over A2A.
 *
 * See `docs/handoff.md`.
 *
 * @module
 */
export { A2AClient, A2AError, A2A_VERSION, isTerminal, normaliseResponse, taskState } from './a2a.js';
export type {
  A2AArtifact,
  A2AClientOptions,
  A2AMessage,
  A2APart,
  A2AReply,
  A2AStream,
  A2AStreamResponse,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
} from './a2a.js';
export {
  HANDOFF_EXTENSION,
  HANDOFF_UI,
  MAX_ANSWER_CARDS,
  buildEnvelope,
  cleanPageUrl,
  envelopeMessage,
  feedbackMessage,
  pageEntity,
  readAnswer,
  readHandBack,
  readOperator,
  readQueue,
  readableText,
} from './envelope.js';
export type { AnswerCite, CardFocus, CardRecord, EnvelopeInput, FeedbackValue, HandBack, HandoffAnswer, HandoffEnvelope, HandoffUi } from './envelope.js';
export { HANDOFF_KEY_HEADER, HandoffController, handoffActivity, isHandoffOver } from './controller.js';
export type {
  HandoffActivity,
  HandoffConfig,
  HandoffControllerOptions,
  HandoffEvent,
  HandoffKind,
  HandoffSession,
  HandoffState,
  HandoffTarget,
  HandoffTargetConfig,
} from './controller.js';
export {
  HANDOFF_SESSION_RESULT,
  TALK_TO_A_PERSON_TOOL,
  TRANSFER_TO_AGENT_TOOL,
  availability,
  buildHandoffTools,
  isHandoffTool,
  registerHandoffTools,
} from './tools.js';
export type { HandoffToolOptions } from './tools.js';
export {
  TAKERS_WAIT_MS,
  formTakenBy,
  formTakers,
  handoffCallFor,
  handoffToolFor,
  pageFormTakenBy,
  standInFor,
  takerOf,
  takesForm,
} from './takes.js';
