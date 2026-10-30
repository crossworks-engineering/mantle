/**
 * The decider's privacy level, read from the worker's params. The one read:
 * `decide()` and the worker's Test button both come here, and the adapter
 * maps the level to the wire (`decisionProviderPrefs`).
 *
 * `params.privacy` is the new key; `params.zdr` is the old one and is still
 * read: `true` is `zdr`, `false` is `no_training`. A box with no new setting
 * keeps its level (`zdr: false` used to send no privacy block at all; it now
 * sends `data_collection: 'deny'`, which is stricter). When the two keys
 * disagree the stricter wins, and a value that is neither fails closed to
 * `zdr`, so no stale or mistyped key can loosen a call.
 */

import type { DeciderParams } from '@mantle/db';
import type { DecisionPrivacy } from '@mantle/voice';

export function deciderPrivacy(
  params: Pick<DeciderParams, 'privacy' | 'zdr'> | null | undefined,
): DecisionPrivacy {
  const privacy: unknown = params?.privacy;
  const zdr: unknown = params?.zdr;
  if (privacy !== undefined && privacy !== 'zdr' && privacy !== 'no_training') return 'zdr';
  if (zdr !== undefined && typeof zdr !== 'boolean') return 'zdr';
  if (privacy === 'zdr' || zdr === true) return 'zdr';
  if (privacy === 'no_training' || zdr === false) return 'no_training';
  return 'zdr';
}
