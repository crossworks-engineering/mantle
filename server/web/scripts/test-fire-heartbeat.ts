/**
 * One-shot diagnostic: directly invoke forceFire() on the
 * get_to_know_user heartbeat, bypassing the UI / server action /
 * concurrently / tsx-watch layer. Used to reproduce the "trace
 * shows success but state not persisted" bug with the diagnostic
 * console.error lines added in commit 5cbb626.
 *
 * Usage:
 *   pnpm -C server/web tsx --env-file-if-exists=./.env.local \
 *     scripts/test-fire-heartbeat.ts
 *
 * Reads the heartbeat row from DB, runs forceFire (which runs the
 * tool loop including heartbeat_update_state if Saskia chooses to
 * call it), then re-reads the row and prints state before/after so
 * we can see whether the UPDATE landed in THIS process (separate
 * from the apps/agent process the UI Zap button would hit).
 */

import { and, eq } from 'drizzle-orm';
import { db, heartbeats } from '@mantle/db';
import { forceFire, registerHeartbeatTools } from '@mantle/heartbeats';
import { registerAgentInvoker } from '@mantle/tools';
import { invokeAgent } from '@mantle/agent-runtime';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

// Same boot sequence as apps/agent/src/main.ts.
registerAgentInvoker(invokeAgent);
registerHeartbeatTools();

async function main() {
  const [hb] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, USER_ID!), eq(heartbeats.slug, 'get_to_know_user')))
    .limit(1);
  if (!hb) {
    console.error('heartbeat get_to_know_user not found');
    process.exit(1);
  }

  console.error('=== STATE BEFORE FIRE ===');
  console.error('updated_at:', hb.updatedAt.toISOString());
  console.error('fire_count:', hb.fireCount);
  console.error('state:', JSON.stringify(hb.state, null, 2));

  console.error('\n=== INVOKING forceFire ===');
  const result = await forceFire(hb);
  console.error('disposition:', result.disposition);
  if (result.error) console.error('error:', result.error);
  if (result.replyText) console.error('reply (first 200c):', result.replyText.slice(0, 200));

  console.error('\n=== STATE AFTER FIRE ===');
  const [after] = await db.select().from(heartbeats).where(eq(heartbeats.id, hb.id)).limit(1);
  if (!after) {
    console.error('post-fire reload returned null!');
    process.exit(1);
  }
  console.error('updated_at:', after.updatedAt.toISOString());
  console.error('fire_count:', after.fireCount);
  console.error('state:', JSON.stringify(after.state, null, 2));

  console.error('\n=== VERDICT ===');
  if (after.updatedAt.getTime() === hb.updatedAt.getTime()) {
    console.error('❌ updated_at unchanged — UPDATE never landed');
  } else if (JSON.stringify(after.state) === JSON.stringify(hb.state)) {
    console.error(
      '⚠️  updated_at changed but state unchanged — the post-fire UPDATE landed (fire_count etc) but heartbeat_update_state never persisted',
    );
  } else {
    console.error('✅ state changed — heartbeat_update_state worked');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
