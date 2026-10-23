/**
 * The narrow route's denials, noted (plan v3.2 S7a): a right the narrow role
 * does not hold, and a statement the text check refused before it was sent
 * (narrow-sendable.ts). One note per error, in both pools' paths
 * (narrow-route.ts), and the one helper that runs the text check and notes
 * its refusal in both switch states (sendOrNote).
 */
import { env } from '@mantle/config';
import { causeChain } from '@mantle/std';
import { refusalOf } from '../pg-error';
import {
  actorSetting,
  currentActor,
  noteActorMiss,
  noteNarrowWouldRefuse,
  noteTestNarrowDenial,
} from '../actor';
import { narrowSendable, textRefusalOf, textReason } from './narrow-sendable';

/** The actor's setting, or 'none' with no actor bound. */
function whoNow(): string {
  const actor = currentActor();
  return actor ? actorSetting(actor) : 'none';
}

/**
 * A right the narrow role does not hold, met on the narrow route, or a
 * statement the text check refused there (`text:<what>`, never sent): noted
 * every time, a caught one too (the measurement: route the reason full with
 * its why, or grant narrowly; a text refusal is a bug of the statement).
 * Tests record it (vitest.setup.ts fails the test, as on a write-role gap);
 * elsewhere it is a miss row (check 'narrow-denied'). The caller's error
 * stays its error.
 */
export function noteNarrowDenial(err: unknown): void {
  markNarrowRaised(err);
  // Every 42501: a privilege gap, and a row rule's, a guard's or a
  // definer's refusal; and the text check's refusal, which carries no code.
  const what = refusalOf(err) ?? textRefusalOf(err);
  if (!what) return;
  // Once per error: a statement's denial is noted where it is met, not
  // again as the savepoint's or the transaction's error (the same error, or
  // a wrapper whose cause it is).
  const chain = causeChain(err);
  if (chain.some((e) => notedDenials.has(e))) return;
  for (const e of chain) notedDenials.add(e);
  const who = whoNow();
  if (env('NODE_ENV') === 'test') {
    // The refused statement's text too (postgres.js puts it on its error),
    // so the measurement names the writer.
    noteTestNarrowDenial(who, `${what.slice(0, 200)} | ${refusedQueryOf(err)}`);
    return;
  }
  noteActorMiss({ source: 'ts', check: 'narrow-denied', actor: who, detail: what.slice(0, 200) });
}

/**
 * The text check the narrow route runs before it sends a statement
 * (narrowSendable), its refusal noted: the one helper for both switch
 * states. On the route (`on`): noted as a denial, `text:<what>`
 * (noteNarrowDenial), and thrown, the statement never sent. Off it (the
 * switch off, on a route that would be narrow): counted as
 * narrow-would-refuse `text:<what> TEXT`, and the statement goes. `tagged`:
 * a tagged template's text, its values joined as `$1`.
 */
export function sendOrNote(query: string, tagged: boolean, on: boolean): void {
  try {
    narrowSendable(query, tagged);
  } catch (err) {
    if (on) {
      noteNarrowDenial(err);
      throw err;
    }
    noteNarrowWouldRefuse(whoNow(), `${textReason(err)} TEXT`);
  }
}

/** The denials already noted (noteNarrowDenial). */
const notedDenials = new WeakSet<object>();

/** Errors raised by a statement on the narrow route (noteNarrowDenial
 *  marks each on its cause chain), so a caller can tell the narrow role's
 *  refusal from a read-only database wherever it is caught (isWriteRefused:
 *  systemDb inside a turn or request scope runs narrow with no exit). */
const narrowRaised = new WeakSet<object>();

function markNarrowRaised(err: unknown): void {
  for (const e of causeChain(err)) narrowRaised.add(e);
}

/** Whether `err` (or an error on its cause chain) was raised on the narrow
 *  route. */
export function raisedOnNarrow(err: unknown): boolean {
  return causeChain(err).some((e) => narrowRaised.has(e));
}

/** Tests only: the start of the refused statement's text, from the
 *  driver's error or the one it is the cause of. */
function refusedQueryOf(err: unknown): string {
  type Carried = { query?: unknown; parameters?: unknown };
  for (const e of causeChain(err, 4) as Carried[]) {
    if (typeof e.query === 'string') {
      const params = Array.isArray(e.parameters)
        ? e.parameters.slice(0, 6).map((v) => String(v).slice(0, 40))
        : [];
      return `${e.query.replace(/\s+/g, ' ').slice(0, 240)} [${params.join(', ')}]`;
    }
  }
  return '?';
}
