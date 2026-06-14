/**
 * Push-notify worker. LISTENs on `conversation_changed` (the trigger from
 * migration 0091, also driving the SSE live stream) and, for every **outbound**
 * turn, seals a teaser to the owner's enrolled devices and hands it to Mantle
 * Push (push-notifications.md §8/§10). Its own dedicated LISTEN connection — a
 * separate process from the web app, so it doesn't share the web's in-process
 * realtime bridge.
 *
 * Runs as `pnpm worker:push:dev` locally and the `worker_push` service in prod.
 *
 * NOTE (M2): trigger policy is "push every outbound turn." Foreground
 * suppression (don't notify a device that's actively streaming) is handled
 * client-side in the app (M3/M4) — it drops the local notification when
 * foregrounded. A server-side belt (skip if the device pinged SSE <15s ago) is a
 * later refinement; see §10.
 */
import postgres from 'postgres';
import { PENDING_CHANGED_CHANNEL } from '@mantle/tools';
import { pushApproval, pushOutbound } from '../lib/push/notify';

interface ConversationChange {
  ownerId: string;
  agentSlug: string;
  direction: 'inbound' | 'outbound';
}

async function handleConversation(payload: string): Promise<void> {
  let c: ConversationChange;
  try {
    c = JSON.parse(payload) as ConversationChange;
  } catch {
    return; // malformed — drop rather than crash the listener
  }
  if (!c?.ownerId || !c?.agentSlug || c.direction !== 'outbound') return;

  try {
    const r = await pushOutbound(c.ownerId, c.agentSlug);
    if (!r.skipped) {
      console.log(
        `[push-notify] ${c.agentSlug}: delivered ${r.delivered}/${r.attempted}` +
          (r.dropped ? ` (dropped ${r.dropped} dead)` : ''),
      );
    }
  } catch (err) {
    console.error('[push-notify] send failed:', (err as Error).message);
  }
}

// pending_changed's payload IS the owner id (not JSON) — see @mantle/tools.
async function handlePending(ownerId: string): Promise<void> {
  if (!ownerId) return;
  try {
    const r = await pushApproval(ownerId);
    if (!r.skipped) {
      console.log(`[push-notify] approvals: delivered ${r.delivered}/${r.attempted}`);
    }
  } catch (err) {
    console.error('[push-notify] approval send failed:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  // Needed to decrypt the instance token at rest (@mantle/crypto).
  if (!process.env.MANTLE_MASTER_KEY) throw new Error('MANTLE_MASTER_KEY must be set');

  console.log('[push-notify] worker up — listening on conversation_changed + pending_changed');
  const sql = postgres(url, { max: 1, prepare: false });
  const subConversation = await sql.listen('conversation_changed', (payload) => {
    void handleConversation(payload);
  });
  const subPending = await sql.listen(PENDING_CHANGED_CHANNEL, (ownerId) => {
    void handlePending(ownerId);
  });

  const shutdown = async () => {
    console.log('[push-notify] shutting down…');
    try {
      await subConversation.unlisten();
      await subPending.unlisten();
      await sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
