/**
 * The run, written for someone deciding which model to ship.
 *
 * A matrix first, because the question is usually "which of these is usable",
 * then the failures with the assertion that caught each one, so a cell can be
 * argued with. Cost and latency last: they only matter among models that passed
 * the gate.
 *
 * @module
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {number | null} n */
const ms = (n) => (n == null ? '—' : `${n.toLocaleString()}ms`);
/** @param {number | null} n */
const usd = (n) => (n == null ? '—' : `$${n.toFixed(4)}`);

/**
 * @param {string} dir
 * @param {Record<string, any>} summary
 * @returns {Promise<void>}
 */
export async function writeReport(dir, summary) {
  const { results, models, latency, runId, site, corpus } = summary;
  const ids = models.map((m) => m.id);
  const caseIds = [...new Set(results.map((r) => r.caseId))];

  const out = [];
  out.push(`# Model bench — ${runId}`, '');
  out.push(`Site: \`${site}\``);
  out.push(
    corpus
      ? `Corpus snapshot: \`${corpus}\``
      : 'Corpus snapshot: **not recorded** — results are not comparable with another run.',
  );
  out.push('', 'Caching is off for a bench run. A cache not keyed by model voids the matrix.', '');

  // Gates first: a disqualified model's other numbers are not a trade-off.
  const failedGate = ids.filter((id) =>
    results.some((r) => r.modelId === id && r.gate && !r.pass),
  );
  if (failedGate.length) {
    out.push('## Disqualified', '');
    for (const id of failedGate) {
      const bad = results.filter((r) => r.modelId === id && r.gate && !r.pass);
      const why = bad
        .flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `${c.name} — ${c.detail}`))
        .join('; ');
      out.push(`- **${label(models, id)}** failed the write-path gate: ${why}`);
    }
    out.push(
      '',
      'A model that fills in a visitor’s contact details cannot ship on a customer site, whatever else it scored.',
      '',
    );
  }

  out.push('## Matrix', '');
  out.push(`| Case | ${ids.map((i) => label(models, i)).join(' | ')} |`);
  out.push(`|---|${ids.map(() => '---').join('|')}|`);
  for (const caseId of caseIds) {
    const cells = ids.map((id) => {
      const r = results.find((x) => x.modelId === id && x.caseId === caseId);
      if (!r) return '—';
      return r.pass ? 'pass' : '**fail**';
    });
    out.push(`| ${caseId}${results.some((r) => r.caseId === caseId && r.gate) ? ' *(gate)*' : ''} | ${cells.join(' | ')} |`);
  }
  out.push('');

  const totals = ids.map((id) => {
    const rs = results.filter((r) => r.modelId === id);
    return { id, pass: rs.filter((r) => r.pass).length, n: rs.length };
  });
  out.push('## Totals', '');
  out.push('| Model | Passed | Lane | p50 | p95 | Run cost |');
  out.push('|---|---|---|---|---|---|');
  for (const t of totals) {
    const m = models.find((x) => x.id === t.id);
    const costs = results.filter((r) => r.modelId === t.id && r.costUsd != null);
    const total = costs.length ? costs.reduce((s, r) => s + r.costUsd, 0) : null;
    out.push(
      `| ${m.display} | ${t.pass}/${t.n} | ${m.lane} | ${ms(latency[t.id]?.p50)} | ` +
        `${ms(latency[t.id]?.p95)} | ${usd(total)} |`,
    );
  }
  out.push('');
  out.push(
    '> Lane A (on-device) latency is not comparable with a vendor’s: it tracks whatever else the workstation is doing. Lane B is containerised and local, lane C is a vendor API.',
    '',
  );

  // A handoff target's own models, apart: the page's model chose to hand off, but didn't spend these.
  const remote = summary.remoteAgent;
  if (remote) {
    out.push(`## Remote agent: ${remote.name}`, '');
    out.push(`Its own model calls, through the proxy (\`${remote.env}\`), per page model. Not counted in the totals above.`, '');
    out.push('| Page model | Remote calls | Failed | p50 per case | p95 per case | Remote cost | By model |');
    out.push('|---|---|---|---|---|---|---|');
    for (const id of ids) {
      const r = remote.byPageModel?.[id];
      if (!r) continue;
      const by = Object.entries(r.byModel).map(([m, u]) => `${m} ×${u.calls}`).join(', ') || '—';
      out.push(`| ${label(models, id)} | ${r.calls} | ${r.failed} | ${ms(r.p50)} | ${ms(r.p95)} | ${usd(r.costUsd)} | ${by} |`);
    }
    out.push('');
  }

  const failures = results.filter((r) => !r.pass);
  if (failures.length) {
    out.push('## Failures', '');
    for (const r of failures) {
      out.push(`### ${r.display} — ${r.caseId}`, '');
      out.push(`*${r.measures}*`, '');
      for (const c of r.checks.filter((x) => !x.pass)) {
        out.push(`- \`${c.name}\`${c.detail ? ` — ${c.detail}` : ''}`);
      }
      if (r.call) out.push('', `Called \`${r.call.name}\` with \`${JSON.stringify(r.call.args)}\``);
      if (r.text) out.push('', `> ${r.text.slice(0, 400).replace(/\n+/g, ' ')}`);
      if (r.remote?.text) out.push('', `Remote agent: > ${r.remote.text.slice(0, 400).replace(/\n+/g, ' ')}`);
      if (r.remote?.cards?.length) out.push('', `Remote cards: ${r.remote.cards.map((c) => `\`${c}\``).join(', ')}`);
      if (r.remote?.handback) out.push('', `Handed back: ${r.remote.handback.outcome}${r.remote.handback.note ? ` — ${r.remote.handback.note}` : ''}`);
      out.push('');
    }
  }

  const pending = results.filter((r) => r.judge && r.pass);
  if (pending.length) {
    out.push('## Awaiting a judge', '');
    out.push(
      `${pending.length} turn(s) passed their assertions and carry a prose question that only a judge can settle. They are recorded in \`report.json\` with the question; nothing here has been judged.`,
      '',
    );
  }

  await writeFile(join(dir, 'report.md'), `${out.join('\n')}\n`, 'utf8');
}

/** @param {{id: string, display: string}[]} models @param {string} id */
function label(models, id) {
  return models.find((m) => m.id === id)?.display ?? id;
}
