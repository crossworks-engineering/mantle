/**
 * Object-store one-shots, run with plain S3 calls so they work on any backend.
 *
 *   pnpm -C packages/storage objectstore:ensure   create S3_BUCKET if missing
 *   pnpm -C packages/storage objectstore:verify   re-hash every stored object
 *   pnpm -C packages/storage objectstore:copy-from --endpoint=<url> [--apply]
 *       copy objects the store lacks from another S3 store (dry run unless
 *       --apply). Optional --bucket, --access-key, --secret-key, --region
 *       (default: this store's S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY /
 *       S3_REGION) and --path-style=false (default true: the usual source is
 *       a self-hosted store, whatever style the target uses).
 *
 * `ensure` runs in compose's `migrate` gate on every boot and in scripts/up.sh
 * in dev. It replaced the old `createbuckets` service, which needed MinIO's
 * `mc` CLI. It waits for the store to answer first: compose already gates
 * `migrate` on the store's healthcheck, but up.sh does not.
 *
 * `verify` exits 1 when any object fails its hash, so it can gate a backend
 * swap or a data-dir move. `copy-from` exits 1 when any copy fails.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { env } from '@mantle/config';
import { clientConfig, copyMissingFrom, ensureBucket, verifyObjects } from './index';

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

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function copyFrom(): Promise<void> {
  const endpoint = flag('endpoint');
  if (!endpoint) {
    console.error('copy-from needs --endpoint=<url of the source S3 store>');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const base = clientConfig();
  const accessKeyId = flag('access-key') ?? env('S3_ACCESS_KEY')!;
  const secretAccessKey = flag('secret-key') ?? env('S3_SECRET_KEY')!;
  const bucketName = flag('bucket') ?? env('S3_BUCKET')!;
  const source = new S3Client({
    ...base,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    region: flag('region') ?? base.region,
    forcePathStyle: flag('path-style') !== 'false',
  });
  const r = await copyMissingFrom(
    { client: source, bucket: bucketName, label: `${endpoint}/${bucketName}` },
    { apply },
  );
  console.log(JSON.stringify({ ...r, missing: r.missing.slice(0, 50) }, null, 2));
  console.log(
    `[objectstore] ${r.objects} source objects, ${r.missing.length} missing here, ` +
      (apply ? `${r.copied} copied, ${r.bad.length} failed` : 'dry run: add --apply to copy'),
  );
  if (r.bad.length > 0) process.exit(1);
}

const cmd = process.argv[2];
const run =
  cmd === 'ensure'
    ? ensure
    : cmd === 'verify'
      ? verify
      : cmd === 'copy-from'
        ? copyFrom
        : undefined;
if (!run) {
  console.error('usage: cli.ts ensure|verify|copy-from');
  process.exit(2);
}
run().catch((err: unknown) => {
  console.error(`[objectstore] ${cmd} failed:`, err);
  process.exit(1);
});
