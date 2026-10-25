/**
 * The image check's seal: why a Checks row is trusted. Anyone who may edit
 * a drawing's table may edit its Checks tab like any other tab, so a row's
 * content alone proves nothing; a typed "yes" would turn a guess into
 * CHECKED BY IMAGE. circuit_verify signs each row it writes (the `Seal`
 * column): an HMAC over the table, the key, the question, the answer, the
 * model, the revision and the time, with a key derived from the brain's
 * MANTLE_MASTER_KEY (HKDF, a fixed label), which no table editor holds.
 * circuit_trace applies only rows whose seal checks; a row written or
 * changed by hand is kept in the tab, never applied, and said.
 *
 * A seal proves who wrote the row (this brain's circuit_verify), not that
 * the model was right: CHECKED BY IMAGE stays "a vision model saw it",
 * never certain. Without the master key nothing is sealed or trusted.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

const SEAL_INFO = 'mantle drawing check seal v1';
let cache: { master: string; key: Buffer } | undefined;

function sealKey(): Buffer | null {
  const master = env('MANTLE_MASTER_KEY');
  if (!master) return null;
  if (cache?.master !== master) {
    cache = {
      master,
      key: Buffer.from(
        hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32),
      ),
    };
  }
  return cache.key;
}

/** What a seal covers. */
export type SealedFields = {
  tableId: string;
  key: string;
  question: string;
  answer: string;
  model: string;
  revision: string;
  checkedAt: string;
};

/** The seal of one row, or '' when the brain has no master key. */
export function sealOf(f: SealedFields): string {
  const k = sealKey();
  if (!k) return '';
  const body = JSON.stringify([
    f.tableId.toLowerCase(),
    f.key,
    f.question,
    f.answer,
    f.model,
    f.revision,
    f.checkedAt,
  ]);
  return createHmac('sha256', k).update(body, 'utf8').digest('hex');
}

/** Whether `seal` is this brain's seal of the row. */
export function sealHolds(f: SealedFields, seal: string): boolean {
  const want = sealOf(f);
  if (!want || !/^[0-9a-f]{64}$/.test(seal)) return false;
  return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(seal, 'hex'));
}
