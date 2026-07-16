import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

/**
 * Thin wrapper around an S3-compatible object store. In dev/prod we point this
 * at the self-hosted MinIO that runs alongside Postgres in docker compose; the
 * bytes never leave the machine. If we ever swap object stores, this is the
 * only file that knows.
 */

let _client: S3Client | undefined;
function client(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY must be set');
  }
  _client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    // MinIO uses path-style addressing (http://host/bucket/key) rather than
    // virtual-hosted style (http://bucket.host/key). Required for MinIO.
    forcePathStyle: true,
  });
  return _client;
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
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

export async function getSignedUrl(key: string, expiresInSec = 300): Promise<string> {
  return awsGetSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: expiresInSec,
  });
}

/**
 * Stream bytes back from object storage. Use this for proxied downloads when
 * the object store endpoint (e.g. internal MinIO) isn't reachable from the
 * browser, rather than getSignedUrl() + redirect.
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
 * pill only cares that MinIO answered), this DISTINGUISHES a missing bucket
 * from an unreachable store — because a missing `mantle` bucket is exactly the
 * silent break that fails every app build / upload while MinIO itself is "up".
 * Provisioned by `scripts/up.sh` (`mc mb local/mantle`); prod compose does not
 * create it, so a registry-pull box that never ran up.sh has no bucket.
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
