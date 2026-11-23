/**
 * The authoritative record of a run.
 *
 * Capturing from the browser alone is not enough: the request body the harness
 * built — the system prompt, the tool list, the cache hint — is the thing a
 * failure has to be reproduced from, and intercepting it client-side is both
 * lossier and easier to get wrong than writing it here, where it is already in
 * hand. The browser's job is to prove the visitor saw the result; this file is
 * what explains it.
 *
 * One JSON object per line so a run can be appended to while it is read, and so
 * a single malformed entry cannot cost the rest of the file.
 *
 * @module
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where runs are written. Mounted out of the container so they survive it. */
const ROOT = process.env.TRANSCRIPT_DIR ?? '/runs';

/**
 * Append one turn to a run's transcript.
 *
 * Failures here are logged and swallowed: losing a line of the record is worth
 * far less than failing the visitor's turn over it.
 *
 * @param {object} entry
 * @param {string} entry.runId  - Groups the turns of one bench run.
 * @param {string} entry.modelId - The registry id, which is also the directory.
 * @param {string} entry.caseId - The suite case, or `ad-hoc` outside a run.
 * @param {Record<string, unknown>} entry.record
 * @returns {Promise<void>}
 */
export async function append({ runId, modelId, caseId, record }) {
  const path = join(ROOT, safe(runId), `${safe(modelId)}.jsonl`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), caseId, ...record })}\n`,
      'utf8',
    );
  } catch (err) {
    console.warn(`[transcript] could not write ${path}: ${err?.message ?? err}`);
  }
}

/**
 * Keep a caller-supplied id from escaping the runs directory.
 *
 * The run and case ids arrive on request headers, so they are untrusted input
 * that is about to become a path.
 *
 * @param {string} value
 * @returns {string}
 */
function safe(value) {
  return (value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}
