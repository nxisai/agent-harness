/**
 * Recommending one result, with reasons the records support.
 *
 * After a search returns several records, the visitor's next question is
 * nearly always "which one?". The model answers it in one more completion:
 * it picks a record and gives a short lead and up to three reasons. Then the
 * harness checks every reason against the facts of the record it picked. A
 * number the record does not state, or a reason that shares no words with
 * it, is dropped. A pick with no reason left is no pick at all, and the
 * renderer shows the plain list instead.
 *
 * The model chooses and words it; the records decide what may be said.
 *
 * @module
 */
import type { ChatMessage } from '../engine.js';
import type { Completion, ModelProvider } from '../providers/types.js';
import type { ModelContextToolInfo } from '../types.js';
import { factLines, recordFacts, type RecordFacts } from './records.js';

/** The tool the model answers through. Never registered anywhere: offered for this one completion. */
export const RECOMMEND_TOOL = 'recommend';

/** A recommendation the renderer can show. */
export interface ResultPick {
  /** The picked record's position in the results, from 0. */
  index: number;
  /** Its key: `@id`, else its name. */
  key: string;
  /** One sentence for the visitor, naming it. */
  lead: string;
  /** Up to three reasons, each backed by the record. */
  reasons: string[];
}

/** What {@link recommend} needs. */
export interface RecommendRequest {
  provider: ModelProvider;
  /** What the visitor asked. */
  goal: string;
  /** The records, in the order the results show them. */
  records: Record<string, unknown>[];
  /** The time "open now" is judged at. Defaults to now. */
  now?: Date;
  signal?: AbortSignal;
  /** Reads a call the model wrote out as text. */
  transcribe?: (c: Completion) => Completion;
  /** How many records the model compares. Defaults to eight. */
  limit?: number;
}

const TOOL: ModelContextToolInfo = {
  name: RECOMMEND_TOOL,
  description: 'Recommend the one result that best fits what the visitor asked, with reasons taken from that result.',
  inputSchema: {
    type: 'object',
    properties: {
      pick: { type: 'integer', description: 'The number of the result you recommend.' },
      lead: { type: 'string', description: 'One short sentence for the visitor, naming it and saying why.' },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        description: 'Two or three short reasons, each restating a fact listed for that result.',
      },
    },
    required: ['pick', 'lead', 'reasons'],
  },
} as ModelContextToolInfo;

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });

/**
 * Ask the model which result fits, and keep only what the record supports.
 *
 * @returns The pick, or null when the model gave none, picked a result that
 * does not exist, or gave no reason the record backs.
 */
export async function recommend(req: RecommendRequest): Promise<ResultPick | null> {
  const now = req.now ?? new Date();
  const records = req.records.slice(0, req.limit ?? 8);
  if (records.length < 2) return null;
  const facts = records.map((r) => recordFacts(r, now));
  const listing = facts.map((f, i) => `${i + 1}. ${f.name}\n${factLines(f).map((l) => `   - ${l}`).join('\n')}`).join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You help a website visitor choose between search results.',
        `Call ${RECOMMEND_TOOL} once: pick is the number of the result that best fits what they asked; lead is one short sentence that names it and says why; reasons are two or three short reasons.`,
        'Every reason must restate a fact listed for the result you pick. Do not add facts, prices, times or numbers that are not listed.',
        'If they need help now, prefer one that is open now.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `The visitor asked: "${req.goal}"\nIt is now ${WEEKDAY.format(now)}.\n\nResults:`,
      // The results are what tools returned: data, not instructions.
      data: listing,
    },
  ];

  let completion: Completion;
  try {
    completion = await req.provider.complete({ messages, tools: [TOOL], signal: req.signal, maxTokens: 300 });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    console.warn('[nxis] recommendation failed:', err);
    return null;
  }
  if (req.transcribe) completion = req.transcribe(completion);
  const args = completion.call?.name === RECOMMEND_TOOL ? completion.call.args : readJson(completion.text);
  if (!args) return null;

  const index = Number(args.pick) - 1;
  const picked = facts[index];
  if (!Number.isInteger(index) || !picked) return null;
  const others = facts.filter((_, i) => i !== index).map((f) => f.name.toLowerCase());
  const reasons = (Array.isArray(args.reasons) ? args.reasons : [])
    .map((r) => String(r ?? '').trim())
    .filter((r) => r && r.length <= 200 && grounded(r, picked, others))
    .slice(0, 3);
  if (!reasons.length) return null;

  const said = String(args.lead ?? '').trim();
  const lead = said && said.length <= 200 && mentions(said, picked.name) && grounded(said, picked, others) ? said : `I'd go with ${picked.name}.`;
  return { index, key: picked.key, lead, reasons };
}

/** A call written as plain JSON: `{"pick": 1, …}`. */
function readJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const STOP = new Set(
  'about after also and are around been best both but can come does done each even from good great have here into just like more most much need only open other over same some than that their them then there these they this those very well were what when where which while will with would your'.split(
    ' ',
  ),
);

/** The words worth matching: four letters or more, not filler, roughly stemmed. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

const stem = (w: string): string => w.replace(/'s$/, '').replace(/(ing|ers|ed|es|s)$/, '').slice(0, 7);

/** The record's facts as one searchable text. */
function factText(f: RecordFacts): string {
  return [f.name, ...factLines(f)].join(' ').toLowerCase();
}

/**
 * Whether a sentence says only what the record says.
 *
 * Every number in it must appear in the record ("4.7", "412", "40", "24/7");
 * it must share at least one meaningful word with the record; and it must
 * not be about another result.
 */
export function grounded(sentence: string, f: RecordFacts, others: string[] = []): boolean {
  const text = factText(f);
  const lower = sentence.toLowerCase();
  if (others.some((name) => name && lower.includes(name))) return false;
  const numbers = lower.match(/\d+(?:[.:]\d+)?/g) ?? [];
  const numberText = text.replace(/,/g, '');
  if (!numbers.every((n) => numberText.includes(n))) return false;
  // Hours are claims about now, checked against the hours rather than the words:
  // every record says "open" somewhere, closed ones too.
  const always = ALWAYS.test(lower);
  const now = OPEN_NOW.test(lower);
  if (always && !(f.status?.always || /24\/7|24 hours/.test(text))) return false;
  if (now && !f.status?.open) return false;
  if (always || now) return true;
  const known = new Set(words(text));
  return words(sentence).some((w) => known.has(w));
}

/** A claim that it never closes. */
const ALWAYS = /24\/7|24 hours|around the clock|day (?:or|and) night|any ?time/;
/** A claim that it is open at this moment. */
const OPEN_NOW = /\bopen (?:right )?now\b|\bright now\b|\bopen today\b|\bstill open\b/;

/** Whether a sentence names the record: its full name, or its first distinctive word. */
function mentions(sentence: string, name: string): boolean {
  const lower = sentence.toLowerCase();
  if (lower.includes(name.toLowerCase())) return true;
  const first = words(name).find((w) => w.length >= 4);
  return !!first && words(sentence).includes(first);
}
