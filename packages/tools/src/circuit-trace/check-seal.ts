/**
 * The image check's seal: why a Checks row is trusted. Anyone who may edit
 * a drawing's table may edit its Checks tab like any other tab, so a row's
 * content alone proves nothing; a typed "yes" would turn a guess into
 * CHECKED BY IMAGE. circuit_verify signs each row it writes (the `Seal`
 * column): an HMAC over the table, the key, the circuit, the question, the
 * answer, its reason, the model, the revision, the time and the crop ids,
 * with a key derived from the brain's master key (HKDF, a fixed label),
 * which no table editor holds. circuit_trace applies only rows whose seal
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
 * Known limit: a seal vouches for one row, not for the tab's history. A
 * table editor who deletes a newer sealed row brings back the older sealed
 * answer of the same key and revision (a real model answer, superseded);
 * no anchor outside the table records which row was the latest.
 *
 * A seal proves who wrote the row (this brain's circuit_verify), not that
 * the model was right: CHECKED BY IMAGE stays "a vision model saw it",
 * never certain. Without a master key nothing is sealed or trusted.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

const SEAL_INFO = 'mantle drawing check seal v1';
const derived = new Map<string, Buffer>();

/** The seal keys, the one new rows are sealed under first: the staged
 *  MANTLE_MASTER_KEY_NEXT during a rotation, then MANTLE_MASTER_KEY. */
function sealKeys(): Buffer[] {
  const masters = [env('MANTLE_MASTER_KEY_NEXT'), env('MANTLE_MASTER_KEY')].filter(
    (m): m is string => !!m,
  );
  const out: Buffer[] = [];
  for (const m of [...new Set(masters)]) {
    // Two derived keys stay cached at most (current and staged).
    let k = derived.get(m);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', Buffer.from(m, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32));
      if (derived.size >= 2) derived.clear();
      derived.set(m, k);
    }
    out.push(k);
  }
  return out;
}

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
};

function hmac(k: Buffer, f: SealedFields): string {
  const body = JSON.stringify([
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
  ]);
  return createHmac('sha256', k).update(body, 'utf8').digest('hex');
}

/** The seal of one row under the key new rows take, or '' when the brain
 *  has no master key. */
export function sealOf(f: SealedFields): string {
  const k = sealKeys()[0];
  return k ? hmac(k, f) : '';
}

/** Whether `seal` is this brain's seal of the row, under its current or
 *  its staged next master key. */
export function sealHolds(f: SealedFields, seal: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(seal)) return false;
  const got = Buffer.from(seal, 'hex');
  return sealKeys().some((k) => timingSafeEqual(Buffer.from(hmac(k, f), 'hex'), got));
}
