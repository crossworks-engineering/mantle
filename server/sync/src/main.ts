/**
 * The Sync sidecar (server/sync; Sync service plan, M2): the optional service
 * that holds every outside account sync. Off by default: Settings > Services
 * switches its compose profile `sync`, and while it is off the brain hides
 * those screens and tools. M2 serves IMAP/SMTP mailboxes and ICS calendar
 * feeds; Microsoft and Google follow (M3, M5).
 *
 * It holds no database login and no master key: its state lives in the
 * brain (service_state, sealed there), reached at SYNC_BRAIN_URL with
 * SYNC_TOKEN, as is every mail and event it fetches. Nothing on disk.
 *
 * Runs on Bun (scripts/run-service.sh), on its own image (Dockerfile target
 * `sync`, which adds the rclone binary).
 */
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import { onShutdown } from '@mantle/std/shutdown';
import { createBrain } from './brain';
import { rcloneVersion } from './rclone';
import { createLane, createScheduler } from './scheduler';
import { createSyncServer } from './server';
import { createState } from './state';

async function main(): Promise<void> {
  if (isBootSmoke()) await bootSmokeExit('sync');

  const port = envNum('SYNC_PORT');
  const rclone = await rcloneVersion();
  const token = env('SYNC_TOKEN') ?? '';
  const brainUrl = env('SYNC_BRAIN_URL') ?? 'http://web:3000';

  let deps = null;
  let scheduler = null;
  if (token) {
    const brain = createBrain({ url: brainUrl, token });
    const state = createState(brain);
    const lane = createLane();
    scheduler = createScheduler(brain, state, lane);
    deps = { brain, state, scheduler, lane, token };
    // The first look a minute after start, as every later one.
  }

  const server = createSyncServer({ rclone }, deps);
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  // Its own process with no @mantle/tracing, as the gateway: one line at
  // start says where it listens, whether rclone ran (/health is 503 without
  // it) and whether it has its token (without one it syncs nothing).
  console.log(
    `[sync] listening on :${port} (rclone ${rclone ?? 'did not run: /health is 503'}; ${
      token ? 'syncing' : 'no SYNC_TOKEN: nothing syncs'
    })`,
  );

  onShutdown({
    name: 'sync',
    deadlineMs: 10_000,
    stop: async () => {
      scheduler?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

main().catch((err: unknown) => {
  console.error('[sync] failed to start', err);
  process.exit(1);
});
