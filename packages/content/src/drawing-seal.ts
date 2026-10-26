/**
 * The drawing check seal (DWG bones phase 6): the one key that vouches for
 * what circuit_verify and circuit_trace wrote, and the save-side check of
 * the image check marks a `pid` canvas carries.
 *
 * The key is derived from the brain's master key (HKDF, a fixed label),
 * which no table or canvas editor holds. Its two users:
 *  - the Checks tab rows circuit_verify files (@mantle/tools
 *    circuit-trace/check-seal.ts builds the row's body and calls `drawingSeal`
 *    / `drawingSealHolds`);
 *  - the marks and the provenance circuit_trace draws on a `pid` drawing
 *    (@mantle/diagram-templates pid/check.ts builds their bodies, each
 *    tagged so it never reads as a row's).
 *
 * Master key rotation (rotate:master-key, @mantle/crypto): while a new key
 * is staged in MANTLE_MASTER_KEY_NEXT, new seals are made under it (the
 * key that becomes MANTLE_MASTER_KEY when the rotation is promoted), and a
 * seal is accepted under either key. Nothing is re-sealed: once the old key
 * is dropped, rows and marks sealed only under it stop holding (a row is
 * asked again; a saved drawing's marks become unchecked on its next save,
 * until it is traced again). A key rotated out is never kept to vouch: it
 * may be the reason for the rotation. Without a master key nothing is
 * sealed and nothing holds.
 *
 * `honestCanvasSource` is what every save of a canvas runs
 * (createPresent, savePresentSource): a `pid` canvas keeps only the marks
 * circuit_trace sealed, and the counts of its own marks.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';
import {
  canvasDataReadable,
  dataBlockCount,
  withHonestImageChecks,
} from '@mantle/diagram-templates';
import { InputError } from '@mantle/std';

const SEAL_INFO = 'mantle drawing check seal v1';
const derived = new Map<string, Buffer>();

/** The seal keys, the one new seals are made under first: the staged
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

const hmac = (k: Buffer, body: string) =>
  createHmac('sha256', k).update(body, 'utf8').digest('hex');

/** The seal of `body` under the key new seals take, or '' when the brain
 *  has no master key. */
export function drawingSeal(body: string): string {
  const k = sealKeys()[0];
  return k ? hmac(k, body) : '';
}

/** Whether `seal` is this brain's seal of `body`, under its current or its
 *  staged next master key. */
export function drawingSealHolds(body: string, seal: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(seal)) return false;
  const got = Buffer.from(seal, 'hex');
  return sealKeys().some((k) => timingSafeEqual(Buffer.from(hmac(k, body), 'hex'), got));
}

/** `v` as canonical JSON: object keys sorted, `undefined` object members
 *  left out (as JSON does), and anything JSON cannot say exactly refused
 *  (a non-finite number, an `undefined` value or array item, a function,
 *  a bigint, a class instance), so two payloads seal alike only when they
 *  are the same data, and `null` never reads as a missing value. */
function canonical(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('drawing seal: a number that is not finite');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v
          .map((x) => {
            if (x === undefined) throw new Error('drawing seal: an undefined item');
            return canonical(x);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null)
        throw new Error('drawing seal: not plain data');
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(',')}}`;
    }
    default:
      throw new Error(`drawing seal: a ${typeof v} is not data`);
  }
}

/** The canonical body of a sealed payload for `purpose` (a short label,
 *  e.g. 'pid-crop v1'): tagged so it never reads as a Checks row's body or
 *  a mark's (those have their own fixed shapes). */
function purposeBody(purpose: string, payload: unknown): string {
  if (!/^[a-z][a-z0-9 ._-]{0,63}$/.test(purpose)) throw new Error('drawing seal: not a purpose');
  if (payload === undefined) throw new Error('drawing seal: no payload');
  return `["purpose",${JSON.stringify(purpose)},${canonical(payload)}]`;
}

/** The drawing check seal of `payload` for `purpose`, '' without a master
 *  key. The payload is plain JSON data, sealed canonically (keys in sorted
 *  order, so the caller need not fix one); a value JSON cannot say exactly
 *  (NaN, Infinity, undefined) throws. The one helper any further drawing
 *  evidence is sealed with (a canvas's embedded crops, say), so there is
 *  never a second key path. */
export function sealPayload(purpose: string, payload: unknown): string {
  return drawingSeal(purposeBody(purpose, payload));
}

/** Whether `seal` is sealPayload's seal of `payload` for `purpose`, under
 *  the current or the staged master key (false for a payload sealPayload
 *  would refuse). */
export function sealPayloadHolds(purpose: string, payload: unknown, seal: string): boolean {
  let body: string;
  try {
    body = purposeBody(purpose, payload);
  } catch {
    return false;
  }
  return drawingSealHolds(body, seal);
}

/** Why a save refuses a canvas, in words for whoever saved it (a person in
 *  the editor as much as an assistant; the tools' descriptions say how an
 *  assistant edits a diagram). */
const UNREADABLE_DIAGRAM =
  "This diagram was not saved: its data could not be checked. A diagram keeps its data in one block that the editor writes; this one has a second copy, another element with the same name, or data that does not read as written. Undo the change to the diagram's source, or edit the diagram's data instead, and save again.";

/**
 * A canvas source as a save stores it: a `pid` canvas's labels cleared of
 * typed trust words, its image check marks normalized against
 * circuit_trace's seals and its counts recounted
 * (@mantle/diagram-templates withHonestImageChecks, keyed off the data
 * block as the runtime reads it); any other canvas, and a pid canvas that
 * needs nothing, byte for byte. A canvas whose data block the runtime
 * could read in a form this check does not (a second block, one written
 * another way, or one block that does not read as a JSON object) is
 * refused: the view would show data no save looked at.
 */
export function honestCanvasSource(source: string): string {
  const blocks = dataBlockCount(source);
  if (blocks.any === 0 && blocks.written === 0) return source;
  if (blocks.any !== 1 || blocks.written !== 1 || !canvasDataReadable(source)) {
    throw new InputError(UNREADABLE_DIAGRAM);
  }
  return withHonestImageChecks(source, drawingSealHolds);
}
