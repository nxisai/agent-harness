/**
 * A turn about an emergency, and the number its result cards offer to call.
 *
 * When the visitor's words say something can't wait (a flood, a burst pipe, sewage backing up, a gas smell or carbon
 * monoxide, sparking or a fire), the first call a card offers must be the business's emergency line, never its main
 * one. The emergency line is a record whose name says so ("24-hour emergency service", "Emergency line"): its card
 * goes first, and a card whose number is a different one offers no call on that turn. With no such record, the cards
 * are left as they are (the main number is then the only one there is).
 *
 * @module
 */

/** What can't wait: tested against the visitor's words, lower-cased. */
const EMERGENCY =
  /\b(emergenc(y|ies)|flood(ed|ing)?|burst (pipe|main)|pipe (has )?burst|gas (leak|smell)|smell(s|ing)? (of )?gas|carbon monoxide|sewage (is )?(coming|backing) up|water (is )?(pouring|gushing|coming) (in|through|out)|spark(s|ing)|electrical fire|on fire)\b/;

/** A name that says it is the line for emergencies, or one that answers round the clock. */
const LINE = /\b(emergenc(y|ies)|24\s*(\/|-|\s)?\s*(7|hours?|hr))\b/i;

/** Whether the visitor's words describe an emergency. */
export const isEmergency = (said: string | undefined): boolean => !!said && EMERGENCY.test(said.toLowerCase());

const digits = (p: string | undefined): string => (p ?? '').replace(/\D/g, '');

type Obj = Record<string, unknown>;
const objs = (v: unknown): Obj[] => [v].flat().filter((x): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x));
const tel = (x: Obj): string | undefined => (typeof x.telephone === 'string' && x.telephone.trim() ? x.telephone.trim() : undefined);

/**
 * The number a record gives for its line: its own, else a contact point's, else its seller's or provider's (an Offer
 * for "24-hour emergency service" names the line on its seller).
 */
export function lineOf(record: Obj): string | undefined {
  return tel(record) ?? [...objs(record.contactPoint), ...objs(record.seller), ...objs(record.provider), ...objs(record.offeredBy)].map(tel).find(Boolean);
}

/**
 * The cards for an emergency turn, from the records they were drawn from (same order): the emergency line's cards
 * first, calling that line, and every other card's call left out when its number isn't the emergency line's.
 * Unchanged when no record is the emergency line.
 */
export function emergencyFirst<C extends { title: string; phone?: string }>(cards: C[], records: Obj[]): C[] {
  // Its name, and for an offer, the name of what it offers.
  const named = (c: C, r: Obj | undefined) => [c.title, ...objs(r?.itemOffered).map((x) => x.name)].some((n) => typeof n === 'string' && LINE.test(n));
  const lines = cards.map((c, i) => (named(c, records[i]) ? (c.phone ?? (records[i] ? lineOf(records[i]) : undefined)) : undefined));
  const at = lines.findIndex(Boolean);
  if (at < 0) return cards;
  const number = digits(lines[at]);
  const first: C[] = [];
  const rest: C[] = [];
  cards.forEach((c, i) => {
    if (lines[i] && digits(lines[i]) === number) first.push({ ...c, phone: lines[i] });
    else if (c.phone && digits(c.phone) !== number) {
      const { phone: _drop, ...other } = c;
      rest.push(other as C);
    } else rest.push(c);
  });
  return [...first, ...rest];
}
