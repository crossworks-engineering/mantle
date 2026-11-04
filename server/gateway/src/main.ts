/**
 * The service gateway (docs/gateway.md; Data sources plan, phase 1a): the
 * one internal door from the brain to the services of its box. It sits on
 * the default network (the brain reaches it at GATEWAY_URL) and on the
 * internal network mantle_services (the services), publishes no port and
 * has no Caddy route. It routes `/svc/<slug>/<path>` only to a service in
 * `gateway_services`, and writes one `gateway_calls` row per call.
 *
 * It holds no service secret: the brain adds the service's vault key at
 * call time, as it does for any http tool. Its own secret is GATEWAY_TOKEN,
 * which the brain sends on every call. Without one it serves no service
 * (503) and says so, so a box that has not had a roll since the gateway
 * came keeps running.
 *
 * Runs on Bun or Node (scripts/run-service.sh, MANTLE_RUNTIME).
 */
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import {
  closeDb,
  gatewayCallsSettled,
  getGatewayService,
  reapGatewayCalls,
  recordGatewayCall,
  runAsActor,
  systemActor,
} from '@mantle/db';
import { onShutdown } from '@mantle/std/shutdown';
import { createGateway } from './server';
import { checkedAddress, servicesCidrs } from './upstream';

const REAP_EVERY_MS = 60 * 60_000;

/** Who reads the registry for a call: the gateway itself (the actor check
 *  refuses a system pool statement with no actor bound). */
const ROUTE_ACTOR = systemActor('gateway:route');

function databaseHost(): string | null {
  const url = env('DATABASE_URL');
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (isBootSmoke()) await bootSmokeExit('gateway');

  const token = env('GATEWAY_TOKEN') ?? '';
  const port = envNum('GATEWAY_PORT');
  const host = env('GATEWAY_HOST') ?? '0.0.0.0';
  const net = await servicesCidrs(env('GATEWAY_UPSTREAM_CIDRS'), databaseHost());
  if (!token) {
    console.warn('[gateway] GATEWAY_TOKEN is not set: every service call answers 503 until it is');
  }
  console.log(
    `[gateway] services network: ${net.cidrs.map((c) => c.text).join(', ') || 'none'} (${net.how})`,
  );

  const server = createGateway({
    token,
    lookup: (slug) => runAsActor(ROUTE_ACTOR, () => getGatewayService(slug)),
    address: (h) => checkedAddress(h, net.cidrs),
    record: recordGatewayCall,
    maxBodyBytes: envNum('GATEWAY_MAX_BODY_BYTES'),
    idleTimeoutMs: envNum('GATEWAY_UPSTREAM_IDLE_MS'),
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`[gateway] listening on ${host}:${port}`);

  const reap = () =>
    reapGatewayCalls().then(
      (n) => n > 0 && console.log(`[gateway] removed ${n} call rows past their 90 days`),
      (err: unknown) => console.error('[gateway] call log reap failed', err),
    );
  const reaper = setInterval(() => void reap(), REAP_EVERY_MS);
  reaper.unref();
  void reap();

  onShutdown({
    name: 'gateway',
    deadlineMs: 10_000,
    stop: async () => {
      clearInterval(reaper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await gatewayCallsSettled();
      await closeDb();
    },
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[gateway] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
