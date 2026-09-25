/**
 * Object-store one-shots, run with plain S3 calls so they work on any backend.
 *
 *   pnpm -C packages/storage objectstore:ensure   create S3_BUCKET if missing
 *   pnpm -C packages/storage objectstore:verify   re-hash every stored object
 *
 * `ensure` runs in compose's `migrate` gate on every boot and in scripts/up.sh
 * in dev. It replaced the old `createbuckets` service, which needed MinIO's
 * `mc` CLI. It waits for the store to answer first: compose already gates
 * `migrate` on the store's healthcheck, but up.sh does not.
 *
 * `verify` exits 1 when any object fails its hash, so it can gate a backend
 * swap or a data-dir move.
 */

import { ensureBucket, verifyObjects } from './index';

const WAIT_MS = 60_000;
const STEP_MS = 2_000;

async function ensure(): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const r = await ensureBucket();
      if (r.created) console.log(`[objectstore] created bucket "${r.bucket}"`);
      else if (r.verified) console.log(`[objectstore] bucket "${r.bucket}" ready`);
      else
        console.warn(
          `[objectstore] bucket "${r.bucket}": the key may not HeadBucket, so it was not checked or created`,
        );
      return;
    } catch (err: unknown) {
      if (Date.now() >= deadline) throw err;
      console.log(`[objectstore] waiting for the object store: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, STEP_MS));
    }
  }
}

async function verify(): Promise<void> {
  const r = await verifyObjects();
  console.log(JSON.stringify(r, null, 2));
  if (r.bad.length > 0) {
    console.error(`[objectstore] ${r.bad.length} object(s) failed verification`);
    process.exit(1);
  }
  console.log(
    `[objectstore] ${r.verified} verified, ${r.other} not content-addressed, 0 bad (${r.objects} objects, ${r.bytes} bytes)`,
  );
}

const cmd = process.argv[2];
const run = cmd === 'ensure' ? ensure : cmd === 'verify' ? verify : undefined;
if (!run) {
  console.error('usage: cli.ts ensure|verify');
  process.exit(2);
}
run().catch((err: unknown) => {
  console.error(`[objectstore] ${cmd} failed:`, err);
  process.exit(1);
});
