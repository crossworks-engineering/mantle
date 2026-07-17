/**
 * M2 end-to-end verification. Run against local Mantle (.env.local DB) + the
 * LIVE relay (https://push.crossworks.network, mock provider):
 *
 *   pnpm -C apps/web exec tsx scripts/verify-push-m2.ts
 *
 * Proves: (1) libsodium sealed-box round-trips; (2) Mantle's instance/ticket/
 * notify wire format is accepted by the deployed relay; (3) the DB-driven
 * pushOutbound() path seals the latest outbound turn and delivers it.
 *
 * Leaves push_instance + one subscription seeded so the worker test can fire a
 * pg_notify next; clean up with --cleanup.
 */
import { db, pushInstance } from '@mantle/db';
import { generateDeviceKeypair, openSealed, sealToDevice } from '../lib/push/seal';
import { generateInstanceToken } from '../lib/push/tokens';
import { mintTicket } from '../lib/push/ticket';
import { registerInstance, relayNotify } from '../lib/push/relay-client';
import { deleteAllSubscriptions, insertSubscription, savePushInstance } from '../lib/push/store';
import { pushOutbound } from '../lib/push/notify';

const OWNER = process.env.VERIFY_OWNER_ID ?? 'bc505da9-c323-43c7-bafb-6c06a2d443de';
const AGENT_SLUG = process.env.VERIFY_AGENT_SLUG ?? 'assistant';
const RELAY = process.env.MANTLE_PUSH_RELAY_URL ?? 'https://push.crossworks.network';

let passed = 0;
function ok(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${msg}`);
}

async function enroll(ticket: string, osPushToken: string): Promise<string> {
  const res = await fetch(`${RELAY}/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, platform: 'ios', osPushToken }),
  });
  const body = (await res.json()) as { routingToken?: string };
  if (!res.ok || !body.routingToken) throw new Error(`enroll failed: ${res.status}`);
  return body.routingToken;
}

async function cleanup(): Promise<void> {
  await deleteAllSubscriptions(OWNER);
  await db.delete(pushInstance);
  console.log('cleaned up local push_instance + subscriptions');
}

async function main(): Promise<void> {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    return;
  }

  // 1) Crypto round-trip with a realistic payload.
  const device = await generateDeviceKeypair();
  const samplePayload = JSON.stringify({
    v: 1,
    t: 'Saskia',
    b: 'You have 3 emails worth a look…',
    agentSlug: AGENT_SLUG,
    deepLink: `/chat/${AGENT_SLUG}`,
    ts: 1,
  });
  const ct = await sealToDevice(device.publicKey, samplePayload);
  const opened = await openSealed(ct, device.publicKey, device.secretKey);
  ok(opened === samplePayload, 'libsodium sealed-box seals + opens (device key round-trip)');

  // 2) Live-relay interop with Mantle's wire format.
  const instanceToken = generateInstanceToken();
  const { instanceId } = await registerInstance(RELAY, instanceToken);
  ok(typeof instanceId === 'string', `relay accepted instance registration → ${instanceId}`);

  const osPushToken = 'verify-os-token-' + Math.floor(Date.now()).toString(36);
  const ticket = mintTicket({ iid: instanceId, osPushToken, instanceToken });
  const routingToken = await enroll(ticket, osPushToken);
  ok(typeof routingToken === 'string', "relay accepted Mantle's enrollment ticket → routing token");

  const directNotify = await relayNotify(RELAY, instanceToken, {
    routingToken,
    ciphertext: ct,
    collapseKey: AGENT_SLUG,
  });
  ok(directNotify.ok, `relay accepted /notify of a sealed payload (status ${directNotify.status})`);

  // 3) DB-driven pushOutbound() — seal the latest real outbound turn + deliver.
  await savePushInstance({ instanceToken, relayInstanceId: instanceId, relayUrl: RELAY });
  await insertSubscription({
    ownerId: OWNER,
    routingToken,
    publicKey: device.publicKey,
    platform: 'ios',
    label: 'verify-device',
  });
  const result = await pushOutbound(OWNER, AGENT_SLUG);
  ok(
    result.delivered === 1 && result.attempted === 1,
    `pushOutbound delivered ${result.delivered}/${result.attempted} to the live relay (skipped: ${result.skipped ?? 'no'})`,
  );

  console.log(`\nall ${passed} checks passed ✅`);
  console.log(
    `\nseeded for worker test — instance ${instanceId}, routing ${routingToken.slice(0, 8)}…`,
  );
  console.log(
    `fire:   docker exec mantle_dev_pg psql -U postgres -d postgres -c "select pg_notify('conversation_changed','{\\"ownerId\\":\\"${OWNER}\\",\\"agentSlug\\":\\"${AGENT_SLUG}\\",\\"direction\\":\\"outbound\\"}')"`,
  );
  console.log(`then:   pnpm -C apps/web exec tsx scripts/verify-push-m2.ts --cleanup`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
