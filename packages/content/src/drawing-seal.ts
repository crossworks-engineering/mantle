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
import { dataBlockCount, withHonestImageChecks } from '@mantle/diagram-templates';
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

/** The canonical body of a sealed payload for `purpose` (a short label,
 *  e.g. 'pid-crop v1'): tagged so it never reads as a Checks row's body or
 *  a mark's (those have their own fixed shapes). */
function purposeBody(purpose: string, payload: unknown): string {
  if (!/^[a-z][a-z0-9 ._-]{0,63}$/.test(purpose)) throw new Error('drawing seal: not a purpose');
  return JSON.stringify(['purpose', purpose, payload]);
}

/** The drawing check seal of `payload` (JSON-serializable, canonical: the
 *  caller fixes its order) for `purpose`, '' without a master key. The one
 *  helper any further drawing evidence is sealed with (a canvas's embedded
 *  crops, say), so there is never a second key path. */
export function sealPayload(purpose: string, payload: unknown): string {
  return drawingSeal(purposeBody(purpose, payload));
}

/** Whether `seal` is sealPayload's seal of `payload` for `purpose`, under
 *  the current or the staged master key. */
export function sealPayloadHolds(purpose: string, payload: unknown, seal: string): boolean {
  return drawingSealHolds(purposeBody(purpose, payload), seal);
}

/**
 * A canvas source as a save stores it: a `pid` canvas's image check marks
 * normalized against circuit_trace's seals and its counts recounted
 * (@mantle/diagram-templates withHonestImageChecks, keyed off the data
 * block as the runtime reads it); any other canvas, and a pid canvas that
 * needs nothing, byte for byte. A canvas whose data block the runtime could
 * read in a form this check does not (a second block, or one written
 * another way) is refused: the view would show data no save looked at.
 */
export function honestCanvasSource(source: string): string {
  const blocks = dataBlockCount(source);
  if (blocks.any === 0 && blocks.written === 0) return source;
  if (blocks.any !== 1 || blocks.written !== 1) {
    throw new InputError(
      'A diagram canvas holds exactly one data block, written as <script type="application/json" id="diagram-data">, and no other element with that id. Keep the one block present_create wrote and edit its data (present_update with data).',
    );
  }
  return withHonestImageChecks(source, drawingSealHolds);
}
