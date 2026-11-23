/**
 * Turning a captured turn into a verdict.
 *
 * Assertions first and alone where they suffice. A judge is asked only the
 * questions that are genuinely about prose, and its answer never overrides an
 * assertion: a model that called the wrong tool has failed whatever a judge
 * thinks of the wording.
 *
 * @module
 */

/**
 * Parse an `arg=/regex/` expectation.
 *
 * `*` as the arg name means "any argument value", which the navigation case
 * uses because the destination may arrive under `url`, `page` or `name`
 * depending on how the model reads the schema.
 *
 * @param {string} spec
 * @returns {{ arg: string, re: RegExp }}
 */
function parseArgSpec(spec) {
  const at = spec.indexOf('=/');
  const arg = spec.slice(0, at);
  const body = spec.slice(at + 2, spec.lastIndexOf('/'));
  // (?i) is not JavaScript syntax; it is written in the suite for readability
  // and lifted to a flag here.
  const ci = body.startsWith('(?i)');
  return { arg, re: new RegExp(ci ? body.slice(4) : body, ci ? 'i' : '') };
}

/** @param {unknown} v */
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/**
 * A call the model wrote out in the harness's transcript notation, read the
 * way the harness reads it.
 *
 * @param {string} text
 * @returns {{ name: string, args: Record<string, unknown> } | null}
 */
export function writtenCall(text) {
  const m = /\[called ([\w.-]+) with ([\s\S]*)\]\s*$/.exec(text);
  if (!m) return null;
  try {
    const args = JSON.parse(m[2].trim());
    return args && typeof args === 'object' && !Array.isArray(args) ? { name: m[1], args } : null;
  } catch {
    return null;
  }
}

/** A regex source as the suite writes it, `(?i)` lifted to a flag. */
const regex = (src) => {
  const ci = src.startsWith('(?i)');
  return new RegExp(ci ? src.slice(4) : src, ci ? 'i' : '');
};

/** The assertions about what a remote agent said. */
const REMOTE_KEYS = ['remoteMatches', 'remoteExcludes', 'remoteCards', 'remoteCardsFromOneScope', 'handback'];
/** The assertions about the page's own model turn. */
const MODEL_KEYS = ['tool', 'toolOneOf', 'noTool', 'maxCallsPerTurn', 'argMatches', 'argExcludes', 'argBlank', 'before', 'textMatches', 'textExcludes'];

/**
 * Check what a remote agent did in this case, after a handoff: its text, the
 * cards of its `answer` parts, and its hand-back.
 *
 * - `remoteMatches` / `remoteExcludes`: regexes over the remote text;
 * - `remoteCards`: `Type@id` entries every one of which an answer cited (and,
 *   when the page's state says what it drew, drew);
 * - `remoteCardsFromOneScope`: every card from one business, or the site's own;
 * - `handback`: the outcome, or any of a list.
 *
 * @param {Record<string, any>} a - The case's `assert`.
 * @param {import('./remote.mjs').RemoteView | null | undefined} remote
 * @param {{ remoteDrawn?: string[], scopeOf?: (card: Record<string, any>) => string }} [opts]
 * @returns {{ name: string, pass: boolean, detail: string }[]}
 */
export function assertRemote(a, remote, opts = {}) {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });
  if (!REMOTE_KEYS.some((k) => a[k] !== undefined)) return checks;
  if (!remote || (!remote.messages && !remote.handback)) {
    add('remote', false, 'the remote agent said nothing in this case');
    return checks;
  }
  const text = remote.text ?? '';
  for (const src of a.remoteMatches ?? []) {
    add(`remote:${src.slice(0, 28)}`, regex(src).test(text), regex(src).test(text) ? '' : `no match in: ${text.slice(0, 160)}`);
  }
  for (const src of a.remoteExcludes ?? []) {
    const m = regex(src).exec(text);
    add(`remote-excludes:${src.slice(0, 20)}`, !m, m ? `matched "${m[0]}"` : '');
  }
  for (const key of a.remoteCards ?? []) {
    const cited = remote.cardKeys.includes(key);
    const drawn = !opts.remoteDrawn || opts.remoteDrawn.includes(key);
    add(
      `remote-card:${key}`,
      cited && drawn,
      !cited ? `not cited; cards: ${remote.cardKeys.join(', ') || 'none'}` : !drawn ? 'cited, but not drawn on the page' : '',
    );
  }
  if (a.remoteCardsFromOneScope) {
    const scopeOf = opts.scopeOf ?? (() => 'site');
    const scopes = [...new Set(remote.cards.map((c) => scopeOf(c)).filter((s) => s !== 'site'))];
    add('remote-one-scope', scopes.length <= 1, scopes.length > 1 ? `cards from ${scopes.join(' and ')}` : '');
  }
  if (a.handback !== undefined) {
    const want = [a.handback].flat();
    const got = remote.handback?.outcome;
    add('handback', !!got && want.includes(got), got ? `expected ${want.join('/')}, got ${got}` : 'no hand-back');
  }
  return checks;
}

/**
 * Check one case's assertions.
 *
 * @param {import('../suite/copperline.mjs').BenchCase} kase
 * @param {Record<string, any> | null} record - The proxy's record of the turn.
 * @param {{ actionCard: boolean, transcript: string, remote?: import('./remote.mjs').RemoteView, remoteDrawn?: string[], scopeOf?: (card: Record<string, any>) => string }} state
 *   The page's side, with what the remote agent did in this case when there was a handoff.
 * @returns {{ pass: boolean, checks: {name: string, pass: boolean, detail: string}[] }}
 */
export function assertCase(kase, record, state) {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });
  const a0 = kase.assert ?? {};
  const remoteChecks = assertRemote(a0, state?.remote, { remoteDrawn: state?.remoteDrawn, scopeOf: state?.scopeOf });

  // A turn the remote agent answers (Send on a handoff, or a message typed while handed off) has no model turn of
  // its own: scored on what the remote agent did alone.
  if (!record && remoteChecks.length && !MODEL_KEYS.some((k) => a0[k] !== undefined)) {
    return { pass: remoteChecks.every((c) => c.pass), checks: remoteChecks };
  }

  if (!record) {
    add('transcript', false, 'no proxy record for this case');
    return { pass: false, checks };
  }
  if (record.ok === false) {
    add('completed', false, String(record.error ?? 'request failed'));
    return { pass: false, checks };
  }
  add('completed', true);

  const a = kase.assert ?? {};
  // A call written out as text ("[called talk_to_a_person with {…}]") is one the
  // harness acts on (readTranscribedCall), so it is scored as the call it is.
  const call = record.response?.call ?? writtenCall(record.response?.text ?? '');
  const args = call?.args ?? {};
  const text = record.response?.text ?? '';

  if (a.tool) {
    add('tool', call?.name === a.tool, `expected ${a.tool}, got ${call?.name ?? 'none'}`);
  }
  if (a.toolOneOf) {
    add(
      'tool',
      !!call && a.toolOneOf.includes(call.name),
      `expected one of ${a.toolOneOf.join('/')}, got ${call?.name ?? 'none'}`,
    );
  }
  if (a.noTool === false && !a.tool && !a.toolOneOf) {
    // "noTool: false" reads as "a tool call is not required here". It is not an
    // assertion that none happened — answering from context and answering via
    // one read are both defensible — so only a write is wrong.
    const wrote = !!call && !/^(nxis_query|open_page|page_links)$/.test(call.name);
    add('no-write', !wrote, wrote ? `called ${call.name} for a read-only question` : '');
  }
  if (typeof a.maxCallsPerTurn === 'number') {
    // The contract allows one call per turn; the provider warns and drops the
    // rest, so more than one in the record is the endpoint misbehaving.
    const n = record.response?.calls?.length ?? (call ? 1 : 0);
    add('one-call-per-turn', n <= a.maxCallsPerTurn, `${n} calls`);
  }
  for (const spec of a.argMatches ?? []) {
    const { arg, re } = parseArgSpec(spec);
    const hay = arg === '*' ? asText(args) : asText(args[arg]);
    add(`arg:${arg}`, re.test(hay), `${re} vs ${hay.slice(0, 120)}`);
  }
  for (const spec of a.argExcludes ?? []) {
    const { arg, re } = parseArgSpec(spec);
    const hay = arg === '*' ? asText(args) : asText(args[arg]);
    add(`arg-excludes:${arg}`, !re.test(hay), `${re} matched ${hay.slice(0, 120)}`);
  }
  for (const arg of a.argBlank ?? []) {
    const v = args[arg];
    const blank = v === undefined || v === null || String(v).trim() === '';
    // The gate. A value here was never given by the visitor.
    add(`arg-not-invented:${arg}`, blank, blank ? '' : `invented ${arg}="${String(v)}"`);
  }
  for (const state_ of a.before ?? []) {
    if (state_ === 'action_card_rendered') {
      add('action-card', state.actionCard, state.actionCard ? '' : 'no confirmation card rendered');
    }
    if (state_ === 'tool_succeeded') {
      // A read that errored found nothing, whatever name its card repeats.
      const failed = /It did not go through|failed · error/.test(state.transcript ?? '');
      add('tool-succeeded', !failed, failed ? 'the tool call failed' : '');
    }
    if (state_ === 'pick_shown') {
      // A pick only shows when at least one of the model's reasons survived the
      // check against the record, so this is also a grounding measure.
      add('pick', !!state.pickShown, state.pickShown ? `picked ${state.pickName}` : state.recommended ? 'recommended, but no reason was backed by the record' : 'no recommendation');
    }
  }
  for (const src of a.textMatches ?? []) {
    const ci = src.startsWith('(?i)');
    const re = new RegExp(ci ? src.slice(4) : src, ci ? 'i' : '');
    // Either the model's own words or what the page ended up showing, less the
    // visitor's own question: a name they typed is not one the agent found.
    const shown = (state.transcript ?? '').split(kase.prompt).join(' ');
    add(`text:${src.slice(0, 28)}`, re.test(text) || re.test(shown));
  }
  for (const src of a.textExcludes ?? []) {
    const ci = src.startsWith('(?i)');
    const re = new RegExp(ci ? src.slice(4) : src, ci ? 'i' : '');
    add(`text-excludes:${src.slice(0, 20)}`, !re.test(text));
  }
  checks.push(...remoteChecks);

  return { pass: checks.every((c) => c.pass), checks };
}

/**
 * Cost of one turn, where the registry carries a rate card.
 *
 * @param {Record<string, any>} record
 * @param {import('../proxy/registry.mjs').ModelEntry} entry
 * @returns {number | null} USD, or null when no rate is configured.
 */
export function turnCost(record, entry) {
  const u = record?.response?.usage;
  if (!u || entry?.inputPerMTok == null || entry?.outputPerMTok == null) return null;
  return (
    (u.promptTokens / 1e6) * entry.inputPerMTok +
    (u.outputTokens / 1e6) * entry.outputPerMTok
  );
}

/**
 * Percentile from a list of numbers.
 *
 * @param {number[]} xs
 * @param {number} p - 0..1
 * @returns {number | null}
 */
export function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  // Nearest-rank, which for the handful of samples a bench run produces is
  // less misleading than interpolating between two of them.
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
