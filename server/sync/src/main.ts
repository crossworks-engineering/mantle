/**
 * The Sync sidecar (server/sync; Sync service plan, M1): the optional
 * service that will hold every outside account sync (mail, contacts,
 * calendar feeds, Microsoft, later Google, Dropbox, Box). Off by default:
 * Settings > Services switches its compose profile `sync`, and while it is
 * off the brain hides those screens and tools.
 *
 * M1 is the skeleton: a health check and a status answer. It holds no
 * secret, opens no database and calls nothing outside.
 *
 * Runs on Bun (scripts/run-service.sh), on its own image (Dockerfile target
 * `sync`, which adds the rclone binary).
 */
import { bootSmokeExit, envNum, isBootSmoke } from '@mantle/config';
import { onShutdown } from '@mantle/std/shutdown';
import { rcloneVersion } from './rclone';
import { createSyncServer } from './server';

async function main(): Promise<void> {
  if (isBootSmoke()) await bootSmokeExit('sync');

  const port = envNum('SYNC_PORT');
  const rclone = await rcloneVersion();
  if (!rclone) console.error('[sync] rclone did not run: /health answers 503');

  const server = createSyncServer({ rclone });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`[sync] listening on :${port} (rclone ${rclone ?? 'missing'})`);

  onShutdown({
    name: 'sync',
    deadlineMs: 10_000,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

main().catch((err: unknown) => {
  console.error('[sync] failed to start', err);
  process.exit(1);
});
