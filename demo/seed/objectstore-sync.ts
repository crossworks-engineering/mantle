/**
 * Carry the object store's bucket between the bench and the site box, with
 * plain S3 calls.
 *
 *   tsx objectstore-sync.ts export <dir>   bucket  → <dir>/objects/<key> + <dir>/index.json
 *   tsx objectstore-sync.ts import <dir>   <dir>   → bucket (creates it if missing)
 *
 * pack.sh and restore.sh used MinIO's `mc mirror` for this. MinIO left open
 * source and its images are gone from every registry, and main moved the
 * bundled store to RustFS (v0.232.249), so a script that needs `mc` cannot run
 * on a new host. The app itself speaks plain S3 only (packages/storage), and
 * so does this: it works against any backend.
 *
 * Runs in two places, which is why every import is relative:
 *   - the bench, from a checkout:  pnpm -C server/web exec tsx ../../demo/seed/objectstore-sync.ts export DIR
 *   - the site box, INSIDE the server image, with this file mounted at
 *     /app/demo/seed/ (restore.sh does that; the bundle carries the file)
 *
 * The index carries each object's content type and sha256. Import re-hashes
 * what it read from disk and what it then reads back from the store, and
 * exits 1 on any difference: an attachment that arrives damaged looks like a
 * working demo until someone opens it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureBucket, getContent, listKeys } from '../../packages/storage/src/index.ts';
import {
  PutObjectCommand,
  S3Client,
} from '../../packages/storage/node_modules/@aws-sdk/client-s3/dist-cjs/index.js';

type Entry = { key: string; size: number; contentType: string | null; sha256: string };

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

async function read(key: string): Promise<{ buf: Buffer; contentType: string | null }> {
  const res = await getContent(key);
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) chunks.push(chunk as Buffer);
  return { buf: Buffer.concat(chunks), contentType: res.contentType ?? null };
}

/** A key becomes a path under <dir>/objects. Refuse one that would leave it. */
function fileOf(dir: string, key: string): string {
  if (key.split('/').some((part) => part === '..' || part === '') || key.startsWith('/')) {
    throw new Error(`refusing object key '${key}': it is not a plain relative path`);
  }
  return join(dir, 'objects', key);
}

async function exportBucket(dir: string): Promise<void> {
  const index: Entry[] = [];
  for await (const o of listKeys()) {
    const { buf, contentType } = await read(o.key);
    const file = fileOf(dir, o.key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    index.push({ key: o.key, size: buf.byteLength, contentType, sha256: sha(buf) });
  }
  index.sort((a, b) => a.key.localeCompare(b.key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`[objectstore-sync] exported ${index.length} object(s)`);
}

async function importBucket(dir: string): Promise<void> {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Entry[];
  const made = await ensureBucket();
  if (made.created) console.log(`[objectstore-sync] created bucket "${made.bucket}"`);
  // The same settings packages/storage uses (clientConfig), from the same env.
  const client = new S3Client({
    endpoint: need('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: { accessKeyId: need('S3_ACCESS_KEY'), secretAccessKey: need('S3_SECRET_KEY') },
    forcePathStyle: !/^(false|0|no)$/i.test(process.env.S3_FORCE_PATH_STYLE ?? ''),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bad: string[] = [];
  for (const e of index) {
    const buf = readFileSync(fileOf(dir, e.key));
    if (sha(buf) !== e.sha256) {
      bad.push(`${e.key}: the file in the bundle does not match its sha256`);
      continue;
    }
    await client.send(
      new PutObjectCommand({
        Bucket: need('S3_BUCKET'),
        Key: e.key,
        Body: buf,
        ...(e.contentType ? { ContentType: e.contentType } : {}),
      }),
    );
    if (sha((await read(e.key)).buf) !== e.sha256) bad.push(`${e.key}: read back different bytes`);
  }
  if (bad.length) {
    for (const line of bad) console.error(`[objectstore-sync] ✗ ${line}`);
    process.exit(1);
  }
  console.log(`[objectstore-sync] imported ${index.length} object(s), each read back and re-hashed`);
}

const [mode, dir] = process.argv.slice(2);
if ((mode !== 'export' && mode !== 'import') || !dir) {
  console.error('usage: objectstore-sync.ts <export|import> <dir>');
  process.exit(2);
}
(mode === 'export' ? exportBucket(dir) : importBucket(dir)).catch((err) => {
  console.error('[objectstore-sync] ✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
