/**
 * The image check's seal: why a stored answer is trusted. Anyone who may edit
 * a drawing's file may write its row's data, as `drawingChecks` is no derived
 * key, so an answer's content alone proves nothing; a typed "yes" would turn a
 * guess into CHECKED BY IMAGE. circuit_verify signs each answer it writes: an
 * HMAC over the sheet's id (the file's), the key, the circuit, the question, the
 * answer, its reason, the model, the revision, the time and the crop ids,
 * with a key derived from the brain's master key (HKDF, a fixed label),
 * which no editor holds. circuit_trace applies only answers whose seal
 * checks; one written or changed by hand is kept on the file, never
 * applied, and said. The revision is sealed, so an answer cannot apply to other
 * bytes.
 *
 * Master key rotation (rotate:master-key, @mantle/crypto): while a new key
 * is staged in MANTLE_MASTER_KEY_NEXT, new rows are sealed under it (the
 * key that becomes MANTLE_MASTER_KEY when the rotation is promoted, as the
 * encrypted columns' writer does), and a seal is accepted under either key.
 * The rotation does not re-seal answers: once the old key is dropped,
 * rows sealed only under it stop applying and circuit_verify asks those
 * guesses again (docs/scripts.md, rotate:master-key). A key rotated out is
 * never kept to vouch for rows: it may be the reason for the rotation.
 *
 * The alternative a no names is sealed with the answer when it has one:
 * appended to the sealed list, so an answer with no alternative seals without
 * it. Adding an alternative by hand, or taking one off a sealed answer, breaks
 * the seal. Who ran the call (a kind and a keyed hash, which the guard against a
 * second call reads) is sealed the same way, after it, tagged.
 *
 * Known limit: a seal vouches for one answer, not for the list's history.
 * Someone who writes the row's data can put back an older sealed answer of the
 * same key and revision (a real model answer, superseded); no anchor outside
 * the row records which was the latest.
 *
 * A seal proves who wrote the answer (this brain's circuit_verify), not that
 * the model was right: CHECKED BY IMAGE stays "a vision model saw it", a
 * help and not a guarantee. Without a master key nothing is sealed or
 * trusted.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

const SEAL_INFO = 'mantle drawing check seal v1';
/** The key the caller's hash is made under: its own label, so it is
 *  never an answer's seal. */
const BY_INFO = 'mantle drawing check by v1';
const derived = new Map<string, Buffer>();

/** The seal keys, the one new answers are sealed under first: the staged
 *  MANTLE_MASTER_KEY_NEXT during a rotation, then MANTLE_MASTER_KEY. */
function sealKeys(info: string = SEAL_INFO): Buffer[] {
  const masters = [env('MANTLE_MASTER_KEY_NEXT'), env('MANTLE_MASTER_KEY')].filter(
    (m): m is string => !!m,
  );
  const out: Buffer[] = [];
  for (const m of [...new Set(masters)]) {
    // Four derived keys stay cached at most (current and staged, per label).
    const at = `${info}\n${m}`;
    let k = derived.get(at);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', Buffer.from(m, 'utf8'), Buffer.alloc(0), info, 32));
      if (derived.size >= 4) derived.clear();
      derived.set(at, k);
    }
    out.push(k);
  }
  return out;
}

/** What a seal covers. */
export type SealedFields = {
  /** The sheet's one id: its file's. */
  tableId: string;
  key: string;
  circuit: string;
  question: string;
  answer: string;
  reason: string;
  model: string;
  revision: string;
  checkedAt: string;
  /** The crops as written (the overview's and the crops' file ids, each
   *  crop's followed by the sha256 of its bytes). */
  crops: string;
  /** The alternative; '' or absent when the answer has none. */
  alt?: string;
  /** Who ran the call, never a raw id (builtins-circuits.ts callerOf); '' or
   *  absent when unknown. */
  by?: string;
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
    // Only when there is one.
    ...(f.alt ? [f.alt] : []),
    // Only when there is one, and tagged (a list, never a string), so it
    // never reads as an alternative, and blanking it breaks the seal.
    ...(f.by ? [['by', f.by]] : []),
  ]);
  return createHmac('sha256', k).update(body, 'utf8').digest('hex');
}

/** The seal of one answer under the key new answers take, or '' when the brain
 *  has no master key. */
export function sealOf(f: SealedFields): string {
  const k = sealKeys()[0];
  return k ? hmac(k, f) : '';
}

/** Whether `seal` is this brain's seal of the answer, under its current or
 *  its staged next master key. */
export function sealHolds(f: SealedFields, seal: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(seal)) return false;
  const got = Buffer.from(seal, 'hex');
  return sealKeys().some((k) => timingSafeEqual(Buffer.from(hmac(k, f), 'hex'), got));
}

/** A keyed hash of who runs a call (builtins-circuits.ts callerOf), 24 hex
 *  characters, under a key derived from the master key with its own label:
 *  the answers never hold a login or agent id, and no
 *  one without the key can tell whose it is. '' without a master key. */
export function callerHash(kind: string, id: string): string {
  const k = sealKeys(BY_INFO)[0];
  return k
    ? createHmac('sha256', k)
        .update(JSON.stringify([kind, id]), 'utf8')
        .digest('hex')
        .slice(0, 24)
    : '';
}
