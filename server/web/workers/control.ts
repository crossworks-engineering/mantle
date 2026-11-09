/**
 * The control service (docs/control-center.md, plan section 6): one
 * container on the Control Center only (compose profile `control`). No
 * port, no MCP, no route: it has the CC database and outbound https.
 *
 * The private key lives only here, in the container's own volume
 * (/control-key, kept out of the box backup). It is made on the first
 * start; its public key line goes to the database (control_service) for
 * the Fleet screen, and its fingerprint to the log, so an operator can
 * check the key on the screen is this container's own.
 *
 * Every few seconds it runs the boxes due a run (lib/control/run.ts). Off
 * (MANTLE_IS_CONTROL_CENTER not on): it idles and calls nothing.
 */
import { feature } from '@mantle/config';
import { keyFingerprint, noteControlTick } from '@mantle/db';
import { log } from '@mantle/tracing';
import { runDueBoxes } from '../lib/control/run';
import { loadOrMakeKey } from '../lib/control/key';
import { runWorker } from './_runner';

/** The container's own volume (docker-compose.yml worker_control). */
const KEY_DIR = '/control-key';
const TICK_MS = 5_000;

runWorker('control', async () => {
  if (!feature('controlCenter')) {
    log('control').info('MANTLE_IS_CONTROL_CENTER is not on: the control service idles.');
    return;
  }
  const { privateKey, line } = loadOrMakeKey(KEY_DIR);
  await noteControlTick(line);
  log('control').info(`control key fingerprint ${keyFingerprint(line)}`);
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void noteControlTick(line)
      .then(() => runDueBoxes(privateKey))
      .catch((err) => log('control').error('tick failed:', err))
      .finally(() => {
        busy = false;
      });
  }, TICK_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
});
