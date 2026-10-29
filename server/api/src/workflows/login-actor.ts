/**
 * Who a runner turn runs as. Deferred work done for a login runs as that
 * login as it is NOW, read when the work runs. A login disabled since is
 * bound anyway and named in one warning.
 */
import { loginActor, systemActor, type Actor } from '@mantle/db';

/** The shared check (packages/db gateway/scope-answers.ts). */
export { loginActorNow } from '@mantle/db';

/** The owner cases (a run with no login, the owner's turn with no user
 *  asking): login(owner). */
export function ownerActor(ownerId: string, entry: string): Actor {
  try {
    return loginActor(ownerId, 'owner');
  } catch {
    return systemActor(entry);
  }
}
