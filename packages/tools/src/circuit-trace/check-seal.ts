/**
 * The image check's seal: why a Checks row is trusted. Anyone who may edit
 * a drawing's table may edit its Checks tab like any other tab, so a row's
 * content alone proves nothing; a typed "yes" would turn a guess into
 * CHECKED BY IMAGE. circuit_verify signs each row it writes (the `Seal`
 * column): an HMAC over the table, the key, the circuit, the question, the
 * answer, its reason, the model, the revision, the time and the crop ids,
 * with a key derived from the brain's master key (HKDF, a fixed label),
 * which no table editor holds: the drawing check seal of
 * @mantle/content/drawing-seal, which seals circuit_trace's marks too. circuit_trace applies only rows whose seal
 * checks; a row written or changed by hand is kept in the tab, never
 * applied, and said.
 *
 * Master key rotation (rotate:master-key, @mantle/crypto): while a new key
 * is staged in MANTLE_MASTER_KEY_NEXT, new rows are sealed under it (the
 * key that becomes MANTLE_MASTER_KEY when the rotation is promoted, as the
 * encrypted columns' writer does), and a seal is accepted under either key.
 * The rotation does not re-seal Checks rows: once the old key is dropped,
 * rows sealed only under it stop applying and circuit_verify asks those
 * guesses again (docs/scripts.md, rotate:master-key). A key rotated out is
 * never kept to vouch for rows: it may be the reason for the rotation.
 *
 * The alternative a no names (phase 6, the Alternative column) is sealed
 * with the row when it has one: appended to the sealed list, so a row with
 * no alternative (every row written before phase 6) seals exactly as it
 * did, and its seal still holds. Adding an alternative to such a row by
 * hand, or taking one off a sealed row, breaks the seal. The By column
 * (who ran the call, a kind and a keyed hash, which the guard against a
 * second call reads) is sealed the same way, after it, tagged.
 *
 * Known limit: a seal vouches for one row, not for the tab's history. A
 * table editor who deletes a newer sealed row brings back the older sealed
 * answer of the same key and revision (a real model answer, superseded);
 * no anchor outside the table records which row was the latest.
 *
 * A seal proves who wrote the row (this brain's circuit_verify), not that
 * the model was right: CHECKED BY IMAGE stays "a vision model saw it",
 * never certain. Without a master key nothing is sealed or trusted.
 */
import { randomBytes } from 'node:crypto';
import { drawingSeal, drawingSealHolds } from '@mantle/content/drawing-seal';
/** The purpose-labelled seal helpers (one key path for every drawing
 *  evidence seal), re-exported for the tools. */
export { sealPayload, sealPayloadHolds } from '@mantle/content/drawing-seal';
import {
  CHECK_LIMITS,
  mapImageChecks,
  provenanceSealBody,
  signImageChecks,
  withoutMarkWords,
} from '@mantle/diagram-templates';

/** What a seal covers. */
export type SealedFields = {
  tableId: string;
  key: string;
  circuit: string;
  question: string;
  answer: string;
  reason: string;
  model: string;
  revision: string;
  checkedAt: string;
  /** The Crops cell as written (the overview's and the crops' file ids). */
  crops: string;
  /** The Alternative cell; '' or absent when the row has none. */
  alt?: string;
  /** The By cell (who ran the call, never a raw id: builtins-circuits.ts
   *  callerOf); '' or absent on rows filed before it was sealed. */
  by?: string;
};

/** What a row's seal is made over. */
function bodyOf(f: SealedFields): string {
  return JSON.stringify([
    f.tableId.toLowerCase(),
    f.key,
    f.circuit,
    f.question,
    f.answer,
    f.reason,
    f.model,
    f.revision,
    f.checkedAt,
    f.crops,
    // Only when there is one: a row without it seals as before phase 6.
    ...(f.alt ? [f.alt] : []),
    // Only when there is one, and tagged (a list, never a string), so it
    // never reads as an alternative: a row filed before By was sealed
    // seals as it did, and blanking a sealed row's By breaks its seal.
    ...(f.by ? [['by', f.by]] : []),
  ]);
}

/** The seal of one row under the key new rows take, or '' when the brain
 *  has no master key. */
export function sealOf(f: SealedFields): string {
  return drawingSeal(bodyOf(f));
}

/** Whether `seal` is this brain's seal of the row, under its current or
 *  its staged next master key. */
export function sealHolds(f: SealedFields, seal: string): boolean {
  return drawingSealHolds(bodyOf(f), seal);
}

/**
 * circuit_trace's drawing, sealed (phase 6): each image check
 * mark carries `sig`, the drawing check seal of its fields and the element
 * it sits on under a fresh provenance id, and the drawing (a set: the
 * set) carries `provenance` { id, keys, sig }: every guess it marks, then `cutKeys` (guesses a cap
 * left unmarked), so a mark dropped later, or never drawn, still counts as
 * unchecked. A save keeps only marks whose seal holds
 * (@mantle/content/drawing-seal honestCanvasSource). Without a master key
 * nothing is sealed: the drawing comes back as it was (its labels without
 * trust words, as any save stores them), and a save shows
 * every mark unchecked (no answer applies without one either).
 */
export function sealedPid(
  drawn: Record<string, unknown>,
  cutKeys: readonly string[],
  limits: string[],
): Record<string, unknown> {
  // Sealed as a save stores it: no trust word in a label (the view draws
  // them from the marks), so a save finds each mark where it was sealed.
  const pid = withoutMarkWords(drawn);
  const id = randomBytes(8).toString('hex');
  const drawings: Record<string, unknown>[] = Array.isArray(pid.pages)
    ? (pid.pages as { data?: Record<string, unknown> }[]).flatMap((p) => (p?.data ? [p.data] : []))
    : [pid];
  const seen = new Set<string>();
  for (const d of drawings)
    mapImageChecks(d, (c) => {
      const key = (c as { key?: unknown } | null)?.key;
      if (typeof key === 'string') seen.add(key);
      return c;
    });
  for (const k of cutKeys) seen.add(k);
  const all = [...seen];
  const keys = all.slice(0, CHECK_LIMITS.provenanceKeys);
  if (all.length > keys.length)
    limits.push(
      `the drawing lists ${keys.length} of its ${all.length} guesses in its sealed provenance; a save counts the rest only while their marks stay on it.`,
    );
  const sig = drawingSeal(provenanceSealBody({ id, keys }));
  if (!sig) return pid;
  // The one sealing path (@mantle/diagram-templates signImageChecks): each
  // mark sealed on the element it sits on, as a save checks it.
  return { ...signImageChecks(pid, id, drawingSeal), provenance: { id, keys, sig } };
}
