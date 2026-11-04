/**
 * The service gateway (docs/gateway.md; Data sources plan, phase 1a): the
 * one internal door from the brain to the services of its box. It sits on
 * the default network (the brain reaches it at GATEWAY_URL) and on the
 * internal network mantle_services (the services), publishes no port and
 * has no Caddy route. It routes `/svc/<slug>/<path>` only to a service the
 * brain's registry names, and sends one call row per call back to the
 * brain.
 *
 * It holds no database login and no service secret: the registry and the
 * call log are the brain's (GATEWAY_BRAIN_URL, with GATEWAY_TOKEN), and the
 * brain adds the service's vault key at call time, as it does for any http
 * tool. Without a token it serves no service (503) and says so, so a box
 * that has not had a roll since the gateway came keeps running.
 *
 * Runs on Bun or Node (scripts/run-service.sh, MANTLE_RUNTIME).
 */
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import { onShutdown } from '@mantle/std/shutdown';
import { brainFetch, brainRegistry, callShipper } from './brain';
import { createGateway, createHealthServer, healthListenerHost } from './server';
import {
  checkedAddress,
  fromServices,
  listenAddress,
  ownAddresses,
  servicesCidrs,
} from './upstream';

async function main(): Promise<void> {
  if (isBootSmoke()) await bootSmokeExit('gateway');

  const token = env('GATEWAY_TOKEN') ?? '';
  const port = envNum('GATEWAY_PORT');
  const brain = (env('GATEWAY_BRAIN_URL') ?? 'http://web:3000').replace(/\/+$/, '');
  const cidrs = servicesCidrs(env('GATEWAY_UPSTREAM_CIDRS'));
  const own = ownAddresses();
  // Its one address outside mantle_services: nothing there can open a
  // connection to it at all. Without one (GATEWAY_UPSTREAM_CIDRS does not
  // match its networks) it never listens everywhere: loopback only, so the
  // brain cannot reach it and every service call fails.
  const outside = env('GATEWAY_HOST') ?? listenAddress(own, cidrs);
  if (!outside) {
    console.error(
      `[gateway] not serving: GATEWAY_UPSTREAM_CIDRS (${cidrs.map((c) => c.text).join(', ') || 'none'}) does not match this container's addresses (${own.join(', ')}); set MANTLE_SERVICES_SUBNET to mantle_services' subnet`,
    );
  }
  const host = outside ?? '127.0.0.1';
  if (!token) {
    console.warn('[gateway] GATEWAY_TOKEN is not set: every service call answers 503 until it is');
  }
  console.log(
    `[gateway] services network: ${cidrs.map((c) => c.text).join(', ') || 'none: GATEWAY_UPSTREAM_CIDRS is not set, every service is refused'}`,
  );

  const toBrain = brainFetch(cidrs);
  const shipper = callShipper({ url: brain, token, fetch: toBrain });
  const server = createGateway({
    token,
    lookup: brainRegistry({ url: brain, token, fetch: toBrain }),
    address: (h) => checkedAddress(h, cidrs, own),
    record: shipper.add,
    maxBodyBytes: envNum('GATEWAY_MAX_BODY_BYTES'),
    idleTimeoutMs: envNum('GATEWAY_UPSTREAM_IDLE_MS'),
    fromService: (remote) => fromServices(remote, cidrs),
  });
  // A service never calls the gateway: a connection from a services subnet
  // is dropped before a byte is read (Node; Bun: in the handler).
  server.on('connection', (socket) => {
    if (fromServices(socket.remoteAddress, cidrs)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`[gateway] listening on ${host}:${port}`);
  // The health check's own door (compose: 127.0.0.1:8097/healthz).
  const healthHost = healthListenerHost(host);
  const health = healthHost ? createHealthServer() : null;
  if (health && healthHost) {
    await new Promise<void>((resolve) => health.listen(port, healthHost, resolve));
    console.log(`[gateway] health on ${healthHost}:${port} (/healthz only)`);
  }

  onShutdown({
    name: 'gateway',
    deadlineMs: 10_000,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (health) await new Promise<void>((resolve) => health.close(() => resolve()));
      await shipper.flush();
    },
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[gateway] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
