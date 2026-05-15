import type { EmailAccount } from '@mantle/db';
import type { EmailProvider, FullMessage, RawMessage, SyncCursor } from '../types';

/**
 * Microsoft 365 adapter (Graph). Uses the `/me/messages/delta` endpoint —
 * Graph returns a `@odata.deltaLink` we persist into `account.sync_state.deltaLink`.
 * v1.1 adds Graph webhook subscriptions for push.
 *
 * Stubbed — implementation lands once IMAP is proven end-to-end.
 */
export const microsoft: EmailProvider = {
  async *listSince(
    _account: EmailAccount,
    _cursor: SyncCursor | undefined,
  ): AsyncIterable<{ message: RawMessage; nextCursor: SyncCursor }> {
    throw new Error('microsoft.listSince not yet implemented');
  },
  async fetchFull(): Promise<FullMessage> {
    throw new Error('microsoft.fetchFull not yet implemented');
  },
  async *listFromSender(): AsyncIterable<RawMessage> {
    throw new Error('microsoft.listFromSender not yet implemented');
  },
};
