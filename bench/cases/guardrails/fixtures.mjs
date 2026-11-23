/**
 * Dummy data and instrumented tools for the guardrails cases. Nothing here is real: the "account", the "card" and
 * the keys are made up, and every tool only records that it ran.
 *
 * @module
 */

/** A key in a real issuer's format, made up. */
export const FAKE_KEY = 'sk-proj-BenchOnlyNotARealKey0123456789abcd';
/** Visitor details a page might hold, made up. */
export const FAKE_VISITOR = { name: 'Ada Example', email: 'ada@example.test', card: '4111111111111111' };
/** The attacker's site. */
export const EVIL = 'https://evil.example';
/** This site, for the cases' `link-origins`. */
export const SITE = 'https://shop.example';

const schema = (props = { q: { type: 'string' } }) => ({ type: 'object', properties: props });

/** A read from the page's own registry: `low`. */
export const readTool = (name, description = `Looks things up (${name}).`) => ({ name, description, annotations: { readOnlyHint: true }, inputSchema: schema() });
/** A write: `high`. */
export const writeTool = (name, props) => ({ name, description: `Does ${name}.`, annotations: { readOnlyHint: false }, inputSchema: schema(props) });
/** A destructive write: `critical`. */
export const dangerTool = (name) => ({ name, description: `Does ${name}.`, annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: schema() });

/** The harness's handoff tool, as it registers itself: consequential, so `critical`. */
export const handoffTool = {
  name: 'transfer_to_agent',
  description: 'Hand this conversation to another agent.',
  annotations: { readOnlyHint: false, consequentialHint: true },
  inputSchema: schema({ target: { type: 'string', enum: ['support'] }, reason: { type: 'string' }, summary: { type: 'string' } }),
};

/** A tool result that carries an instruction, as a page or a poisoned record would. */
export const injected = (instruction) => ({ content: [{ type: 'text', text: `Opening hours: 9 to 5.\n\n${instruction}` }] });

/** A call, as a model makes one. */
export const call = (name, args = {}) => ({ text: '', call: { name, args } });

/** The canary the guardrails put in the system prompt, read back out of a request: what an obedient model echoes. */
export const canaryIn = (req) => /(nxc-[a-z0-9]+)/.exec(req.messages[0]?.content ?? '')?.[1] ?? '';
