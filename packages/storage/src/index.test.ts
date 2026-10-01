import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  __setClientForTests,
  clientConfig,
  contentKey,
  copyMissingFrom,
  ensureBucket,
  listKeys,
  verifyObjects,
} from './index';

/** An S3 error the way the SDK surfaces one: a name plus an HTTP status. */
function s3Error(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: status ? { httpStatusCode: status } : {},
  });
}

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake client that routes each command by its class name. */
function fakeClient(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    calls.push(name);
    const h = handlers[name];
    if (!h) throw new Error(`unexpected ${name}`);
    return h(cmd.input);
  };
  __setClientForTests({ send } as never);
  return calls;
}

const ENV = {
  S3_ENDPOINT: 'http://objectstore:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  S3_BUCKET: 'mantle',
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [...Object.keys(ENV), 'S3_FORCE_PATH_STYLE', 'S3_REGION']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
});

afterEach(() => {
  __setClientForTests(undefined);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('clientConfig', () => {
  it('defaults to path style, us-east-1 and checksums only when required', () => {
    const c = clientConfig();
    expect(c.forcePathStyle).toBe(true);
    expect(c.region).toBe('us-east-1');
    // Not every S3-compatible server implements the SDK's default flexible
    // checksums; the store must work with any of them.
    expect(c.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(c.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('turns path style off only on an explicit false', () => {
    for (const v of ['false', 'FALSE', '0', 'no']) {
      process.env.S3_FORCE_PATH_STYLE = v;
      expect(clientConfig().forcePathStyle, v).toBe(false);
    }
    for (const v of ['true', '1', 'yes', '']) {
      process.env.S3_FORCE_PATH_STYLE = v;
      expect(clientConfig().forcePathStyle, v).toBe(true);
    }
  });

  it('refuses to build without endpoint and keys', () => {
    delete process.env.S3_ENDPOINT;
    expect(() => clientConfig()).toThrow(/S3_ENDPOINT/);
  });
});

describe('ensureBucket', () => {
  it('leaves an existing bucket alone', async () => {
    const calls = fakeClient({ HeadBucketCommand: () => ({}) });
    expect(await ensureBucket()).toEqual({ bucket: 'mantle', created: false, verified: true });
    expect(calls).toEqual(['HeadBucketCommand']);
  });

  it('creates a missing bucket', async () => {
    const calls = fakeClient({
      HeadBucketCommand: () => {
        throw s3Error('NotFound', 404);
      },
      CreateBucketCommand: (input) => {
        expect(input.Bucket).toBe('mantle');
        return {};
      },
    });
    expect(await ensureBucket()).toEqual({ bucket: 'mantle', created: true, verified: true });
    expect(calls).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
  });

  it('treats losing the create race as success', async () => {
    fakeClient({
      HeadBucketCommand: () => {
        throw s3Error('NotFound', 404);
      },
      CreateBucketCommand: () => {
        throw s3Error('BucketAlreadyOwnedByYou', 409);
      },
    });
    expect(await ensureBucket()).toEqual({ bucket: 'mantle', created: false, verified: true });
  });

  it('does not try to create when the key may not HeadBucket (403)', async () => {
    const calls = fakeClient({
      HeadBucketCommand: () => {
        throw s3Error('Forbidden', 403);
      },
    });
    expect(await ensureBucket()).toEqual({ bucket: 'mantle', created: false, verified: false });
    expect(calls).toEqual(['HeadBucketCommand']);
  });

  it('throws when the store is unreachable, so the caller can retry', async () => {
    fakeClient({
      HeadBucketCommand: () => {
        throw s3Error('ECONNREFUSED');
      },
    });
    await expect(ensureBucket()).rejects.toThrow(/unreachable/);
  });

  it('passes other create errors through', async () => {
    fakeClient({
      HeadBucketCommand: () => {
        throw s3Error('NotFound', 404);
      },
      CreateBucketCommand: () => {
        throw s3Error('AccessDenied', 403);
      },
    });
    await expect(ensureBucket()).rejects.toThrow(/AccessDenied/);
  });
});

describe('listKeys', () => {
  it('pages through every result and strips ETag quotes', async () => {
    const tokens: unknown[] = [];
    fakeClient({
      ListObjectsV2Command: (input) => {
        tokens.push(input.ContinuationToken);
        return input.ContinuationToken
          ? { Contents: [{ Key: 'b', Size: 2, ETag: '"e2"' }], IsTruncated: false }
          : {
              Contents: [{ Key: 'a', Size: 1, ETag: '"e1"' }],
              IsTruncated: true,
              NextContinuationToken: 't1',
            };
      },
    });
    const all = [];
    for await (const o of listKeys()) all.push(o);
    expect(all).toEqual([
      { key: 'a', size: 1, etag: 'e1' },
      { key: 'b', size: 2, etag: 'e2' },
    ]);
    expect(tokens).toEqual([undefined, 't1']);
  });
});

describe('verifyObjects', () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const good = Buffer.from('good bytes');
  const other = Buffer.from('bytes of something else');
  const tampered = contentKey(sha(Buffer.from('what was written')));

  it('re-hashes content-addressed objects and reports the bad ones', async () => {
    const objects: Record<string, Buffer> = {
      [contentKey(sha(good))]: good,
      [tampered]: other,
      'logos/profile.png': other,
    };
    fakeClient({
      ListObjectsV2Command: () => ({
        Contents: Object.entries(objects).map(([Key, b]) => ({ Key, Size: b.length })),
        IsTruncated: false,
      }),
      GetObjectCommand: (input) => ({
        Body: Readable.from([objects[input.Key as string]]),
      }),
    });
    const r = await verifyObjects();
    expect(r.objects).toBe(3);
    expect(r.verified).toBe(1);
    expect(r.other).toBe(1);
    expect(r.bad).toEqual([{ key: tampered, problem: 'sha256 mismatch' }]);
    expect(r.bytes).toBe(good.length + 2 * other.length);
  });

  it('reports an object it cannot read', async () => {
    const key = contentKey(sha(good));
    fakeClient({
      ListObjectsV2Command: () => ({ Contents: [{ Key: key, Size: 1 }], IsTruncated: false }),
      GetObjectCommand: () => {
        throw s3Error('NoSuchKey', 404);
      },
    });
    const r = await verifyObjects();
    expect(r.bad).toEqual([{ key, problem: 'read failed: NoSuchKey' }]);
  });
});

describe('copyMissingFrom', () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const a = Buffer.from('already here');
  const b = Buffer.from('only in the old store');
  const lying = contentKey(sha(Buffer.from('not these bytes')));
  const src: Record<string, { body: Buffer; type: string }> = {
    [contentKey(sha(a))]: { body: a, type: 'text/plain' },
    [contentKey(sha(b))]: { body: b, type: 'application/pdf' },
    [lying]: { body: Buffer.from('tampered'), type: 'text/plain' },
  };
  const source = {
    bucket: 'old',
    label: 'http://old:9000/old',
    client: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command')
          return {
            Contents: Object.entries(src).map(([Key, o]) => ({ Key, Size: o.body.length })),
            IsTruncated: false,
          };
        if (name === 'GetObjectCommand') {
          const o = src[cmd.input.Key as string]!;
          return { Body: Readable.from([o.body]), ContentType: o.type };
        }
        throw new Error(`source got ${name}`);
      },
    } as never,
  };

  function target() {
    const puts: { key: string; type: unknown; bytes: number }[] = [];
    fakeClient({
      HeadObjectCommand: (input) => {
        if (input.Key === contentKey(sha(a))) return {};
        throw s3Error('NotFound', 404);
      },
      PutObjectCommand: (input) => {
        puts.push({
          key: input.Key as string,
          type: input.ContentType,
          bytes: (input.Body as Buffer).length,
        });
        return {};
      },
    });
    return puts;
  }

  it('dry run lists what is missing and writes nothing', async () => {
    const puts = target();
    const r = await copyMissingFrom(source, { apply: false });
    expect(r.objects).toBe(3);
    expect(r.missing.sort()).toEqual([contentKey(sha(b)), lying].sort());
    expect(r.copied).toBe(0);
    expect(puts).toEqual([]);
  });

  it('apply copies missing objects with their content type, and refuses bad hashes', async () => {
    const puts = target();
    const r = await copyMissingFrom(source, { apply: true });
    expect(r.copied).toBe(1);
    expect(puts).toEqual([{ key: contentKey(sha(b)), type: 'application/pdf', bytes: b.length }]);
    expect(r.bad).toEqual([{ key: lying, problem: 'sha256 mismatch in the source; not copied' }]);
  });
});
