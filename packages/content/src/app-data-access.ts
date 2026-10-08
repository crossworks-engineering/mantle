/**
 * The R and R/W pill (team apps Phase 3): what the VIEWER may do with an
 * app's data, worked out on the brain with the rule its database brokers
 * apply, so a client only shows it:
 *
 *  - an admin: always read and change (the owner broker never refuses an
 *    admin's write; Informational binds members and clients);
 *  - a member: `memberMayWriteAppData` (team and client apps unless
 *    informational; a public app only reads);
 *  - a client: a client app unless informational;
 *  - a member-built app: its runners change its data unless it is under
 *    review.
 */
import type { AppDataAccess } from '@mantle/client-types/app-nav';

export type { AppDataAccess };

/** The pill for a viewer who may (or may not) write the app's data. */
export function dataAccessOf(mayWrite: boolean): AppDataAccess {
  return mayWrite ? 'read_write' : 'read';
}
