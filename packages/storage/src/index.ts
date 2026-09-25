import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { env } from '@mantle/config';

/**
 * Thin wrapper around an S3-compatible object store: the bundled one that runs
 * alongside Postgres in docker compose (bytes never leave the machine), or any
 * other S3 endpoint. Nothing here may depend on which server answers: plain S3
 * calls only, no vendor admin APIs, no vendor CLI. That is what lets the
 * bundled store change (MinIO left open source in 2026) without app changes.
 * If we ever swap object stores, this is the only file that knows.
 */

/** The S3Client settings, from env. Exported for the tests. */
export function clientConfig(): S3ClientConfig {
  const endpoint = env('S3_ENDPOINT');
  const accessKeyId = env('S3_ACCESS_KEY');
  const secretAccessKey = env('S3_SECRET_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY must be set');
  }
  return {
    endpoint,
    region: env('S3_REGION') ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    // Path-style addressing (http://host/bucket/key) is what self-hosted
    // stores serve without DNS tricks, so it is the default. Set
    // S3_FORCE_PATH_STYLE=false for a provider that wants virtual-hosted
    // style (http://bucket.host/key).
    forcePathStyle: !/^(false|0|no)$/i.test(env('S3_FORCE_PATH_STYLE') ?? ''),
    // Since SDK 3.729 every PutObject carries a flexible checksum header
    // (x-amz-checksum-crc32) by default, and not every S3-compatible server
    // implements those. Send and check them only when an operation requires
    // one; integrity is ours anyway (keys are the sha256 of the bytes).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

/** The subset of S3Client this module calls, so the tests can pass a fake. */
type S3Sender = Pick<S3Client, 'send'>;

let _client: S3Sender | undefined;
function client(): S3Sender {
  if (_client) return _client;
  _client = new S3Client(clientConfig());
  return _client;
}

/** Test seam: swap the client (pass undefined to go back to the real one). */
export function __setClientForTests(c: S3Sender | undefined): void {
  _client = c;
}

function bucket(): string {
  const b = env('S3_BUCKET');
  if (!b) throw new Error('S3_BUCKET must be set');
  return b;
}

/** sha256 → "aa/bb/<full>" content-addressed key. */
export function contentKey(sha256: string): string {
  if (sha256.length !== 64) throw new Error('expected hex sha256');
  return `attachments/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function exists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

/**
 * Upload a buffer, deduplicated by sha256. Returns the storage key.
 * Content is sha256-keyed, so identical bytes always land at the same key.
 * If the key already exists we skip the upload and return deduped=true.
 */
export async function putContent(
  buf: Buffer,
  contentType: string,
): Promise<{ key: string; sha256: string; size: number; deduped: boolean }> {
  const sha256 = hashBuffer(buf);
  const key = contentKey(sha256);
  const size = buf.byteLength;
  if (await exists(key)) {
    return { key, sha256, size, deduped: true };
  }
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buf,
      ContentType: contentType,
    }),
  );
  return { key, sha256, size, deduped: false };
}

/**
 * Stream bytes back from object storage. Downloads are always proxied through
 * the app: the object store is an internal compose service the browser cannot
 * reach, which is why there is no presigned-URL helper here.
 */
export async function getContent(key: string): Promise<{
  body: Readable;
  contentType?: string;
  contentLength?: number;
}> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  return {
    body: res.Body as Readable,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
  };
}

export async function deleteContent(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * Liveness check for the object store — used by the dashboard health panel.
 * Never throws. A 403 still means we reached the server (key lacks
 * ListBucket/HeadBucket perms) → reachable=true; only a network/connection
 * failure → false.
 */
export async function bucketReachable(): Promise<boolean> {
  try {
    await client().send(new HeadBucketCommand({ Bucket: bucket() }));
    return true;
  } catch (err: unknown) {
    const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
    const status = e.$metadata?.httpStatusCode;
    // We got an HTTP response (e.g. 403/404) → the server is up and answered.
    if (typeof status === 'number') return true;
    return false;
  }
}

export type BucketStatus = {
  /** The S3_BUCKET name we probed. */
  bucket: string;
  /** False only when the object store itself couldn't be reached (network). */
  reachable: boolean;
  /** Whether the bucket exists. null = server answered but we can't tell (403 —
   *  the key lacks HeadBucket perms; the bucket may or may not exist). */
  exists: boolean | null;
};

/**
 * Stricter sibling of `bucketReachable()` for the sanity checker. Where
 * `bucketReachable()` deliberately reports a 404 as "reachable" (the dashboard
 * pill only cares that the store answered), this DISTINGUISHES a missing
 * bucket from an unreachable store, because a missing `mantle` bucket is
 * exactly the silent break that fails every app build / upload while the store
 * itself is "up". `ensureBucket()` creates it: compose's `migrate` one-shot
 * runs it on every boot, and so does `scripts/up.sh` in dev.
 */
export async function bucketStatus(): Promise<BucketStatus> {
  const name = bucket();
  try {
    await client().send(new HeadBucketCommand({ Bucket: name }));
    return { bucket: name, reachable: true, exists: true };
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    if (e.name === 'NotFound' || status === 404)
      return { bucket: name, reachable: true, exists: false };
    // Any other HTTP answer (e.g. 403) → store is up, existence indeterminate.
    if (typeof status === 'number') return { bucket: name, reachable: true, exists: null };
    return { bucket: name, reachable: false, exists: null };
  }
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
}

/**
 * Create the S3_BUCKET bucket if it is missing. Idempotent and safe to run on
 * every boot (compose's `migrate` one-shot does). Plain S3 CreateBucket, so it
 * works on any backend and needs no vendor CLI. New buckets are private: S3
 * grants no anonymous access unless a policy says so.
 *
 * Throws when the store is unreachable (the caller retries or fails the boot).
 * When the store answers but the key may not HeadBucket (403, possible on an
 * external S3 with a scoped key), it does not try to create anything and
 * reports `created: false, verified: false`, so a least-privilege key never
 * blocks the boot.
 */
export async function ensureBucket(): Promise<{
  bucket: string;
  created: boolean;
  verified: boolean;
}> {
  const s = await bucketStatus();
  if (!s.reachable) throw new Error(`object store unreachable (bucket "${s.bucket}")`);
  if (s.exists === true) return { bucket: s.bucket, created: false, verified: true };
  if (s.exists === null) return { bucket: s.bucket, created: false, verified: false };
  try {
    await client().send(new CreateBucketCommand({ Bucket: s.bucket }));
    return { bucket: s.bucket, created: true, verified: true };
  } catch (err: unknown) {
    // Another process won the race between the HEAD and the create.
    const name = errorName(err);
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      return { bucket: s.bucket, created: false, verified: true };
    }
    throw err;
  }
}

export type StoredObject = { key: string; size: number; etag?: string };

/** Every object in S3_BUCKET under `prefix`, paged through ListObjectsV2. */
export function listKeys(prefix = ''): AsyncGenerator<StoredObject> {
  return listKeysOf(client(), bucket(), prefix);
}

async function* listKeysOf(
  c: S3Sender,
  bucketName: string,
  prefix = '',
): AsyncGenerator<StoredObject> {
  let token: string | undefined;
  do {
    const res = await c.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) yield { key: o.Key, size: o.Size ?? 0, etag: o.ETag?.replace(/"/g, '') };
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

const CONTENT_KEY = /^attachments\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/;

export type VerifyReport = {
  bucket: string;
  /** Objects listed. */
  objects: number;
  bytes: number;
  /** Content-addressed objects whose bytes hash back to their key. */
  verified: number;
  /** Objects outside the content-addressed scheme: listed, not hashable. */
  other: number;
  /** Keys whose bytes do NOT hash to the key, or could not be read. */
  bad: { key: string; problem: string }[];
};

/**
 * Prove the store's contents are intact. Every key `putContent` writes is the
 * sha256 of its bytes, so each object checks itself: stream it back, hash it,
 * compare. Used after any object-store change (a backend swap, a data-dir
 * move) and by `pnpm -C packages/storage objectstore:verify`. Reads every byte
 * once, sequentially; fine for the data sizes a brain holds.
 */
export async function verifyObjects(): Promise<VerifyReport> {
  const report: VerifyReport = {
    bucket: bucket(),
    objects: 0,
    bytes: 0,
    verified: 0,
    other: 0,
    bad: [],
  };
  for await (const o of listKeys()) {
    report.objects += 1;
    report.bytes += o.size;
    const m = CONTENT_KEY.exec(o.key);
    if (!m) {
      report.other += 1;
      continue;
    }
    try {
      const { body } = await getContent(o.key);
      const h = createHash('sha256');
      for await (const chunk of body) h.update(chunk as Buffer);
      if (h.digest('hex') === m[1]) report.verified += 1;
      else report.bad.push({ key: o.key, problem: 'sha256 mismatch' });
    } catch (err: unknown) {
      report.bad.push({ key: o.key, problem: `read failed: ${(err as Error).message}` });
    }
  }
  return report;
}

export type CopyReport = {
  source: string;
  /** Objects listed in the source bucket. */
  objects: number;
  /** Source keys the target does not have. */
  missing: string[];
  /** Missing objects written to the target (0 on a dry run). */
  copied: number;
  bad: { key: string; problem: string }[];
};

/**
 * Copy every object the target store lacks from another S3 store: the repair
 * for writes that landed in the old store while a backend swap was rolling
 * out, and a way in from any external S3. Existing target objects are never
 * overwritten (the keys are content hashes, so same key = same bytes).
 * Content-addressed objects are re-hashed on the way through. Dry run unless
 * `apply`: it then only reports what is missing.
 */
export async function copyMissingFrom(
  source: { client: S3Sender; bucket: string; label: string },
  opts: { apply: boolean },
): Promise<CopyReport> {
  const report: CopyReport = {
    source: source.label,
    objects: 0,
    missing: [],
    copied: 0,
    bad: [],
  };
  for await (const o of listKeysOf(source.client, source.bucket)) {
    report.objects += 1;
    if (await exists(o.key)) continue;
    report.missing.push(o.key);
    if (!opts.apply) continue;
    try {
      const res = await source.client.send(
        new GetObjectCommand({ Bucket: source.bucket, Key: o.key }),
      );
      if (!res.Body) throw new Error('empty body');
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as Readable) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      const m = CONTENT_KEY.exec(o.key);
      if (m && hashBuffer(buf) !== m[1]) {
        report.bad.push({ key: o.key, problem: 'sha256 mismatch in the source; not copied' });
        continue;
      }
      await client().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: o.key,
          Body: buf,
          ContentType: res.ContentType,
        }),
      );
      report.copied += 1;
    } catch (err: unknown) {
      report.bad.push({ key: o.key, problem: `copy failed: ${(err as Error).message}` });
    }
  }
  return report;
}
