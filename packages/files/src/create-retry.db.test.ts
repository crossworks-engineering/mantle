/**
 * A file create whose insert transaction is retried after its bytes were
 * placed (W8b fix round 1): the first attempt wins the insert, renames its
 * staged bytes onto the name, then rolls back (a deadlock). The retry wins
 * the insert again, with nothing left to place. If the name meanwhile holds
 * other bytes (another create put them there), the retry is refused as a
 * taken name and no row names them; if it still holds this create's bytes,
 * the retry lands as usual.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/create-retry.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Set to fail the next insert transaction once, after its body ran: `then`
 *  runs first (with the bytes already placed), then a deadlock is thrown. */
const hook = vi.hoisted(() => ({ failOnce: null as null | (() => Promise<void>), attempts: 0 }));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...orig,
    withNodeInsertHeads: <T>(
      ownerId: string,
      items: readonly { type: string; path: string }[],
      fn: Parameters<typeof orig.withNodeInsertHeads<T>>[2],
    ) =>
      orig.withNodeInsertHeads(ownerId, items, async (tx) => {
        hook.attempts++;
        const out = await fn(tx);
        const then = hook.failOnce;
        if (then) {
          hook.failOnce = null;
          await then();
          throw Object.assign(new Error('deadlock detected (test)'), { code: '40P01' });
        }
        return out;
      }),
  };
});

describe.skipIf(!URL)('a create retried after placing its bytes', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ops: typeof import('./ops');
  let f: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  let root = '';
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `retry-test-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;

  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
  const dir = () => path.dirname(f.diskPathForFile(top, 'x.txt')!);
  const staging = async () =>
    (await readdir(dir()).catch(() => [] as string[])).filter((n) => n.endsWith('.staged.tmp'));
  const rowsNamed = async (name: string) =>
    (await m.systemDb.execute(sqlTag`
      select id::text as id, data->>'sha256' as sha from nodes
       where owner_id = ${owner} and type = 'file' and path = ${top}::ltree and slug = ${name}`)) as unknown as {
      id: string;
      sha: string;
    }[];
  const onDisk = async (name: string) => readFile(f.diskPathForFile(top, name)!);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-retry-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ops = await import('./ops');
    f = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, is_owner, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', true, 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path) values
        (${owner}, 'branch', 'files', 'files', 'files'),
        (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree)
      on conflict do nothing`);
    await mkdir(dir(), { recursive: true });
  }, 180_000);

  afterAll(async () => {
    hook.failOnce = null;
    await m?.closeDb();
    await scratch?.drop();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses the retry when another create put its bytes on the name in between', async () => {
    const name = 'retried-overwritten.txt';
    const mine = Buffer.from('MINE');
    hook.attempts = 0;
    hook.failOnce = async () => {
      // This create's bytes are in place now; another create's land over them.
      expect((await onDisk(name)).toString()).toBe('MINE');
      await writeFile(f.diskPathForFile(top, name)!, 'THEIRS');
    };
    await expect(
      ops.upsertFile({ ownerId: owner, parentPath: top, filename: name, bytes: mine }),
    ).rejects.toBeInstanceOf(ops.FileNameTakenError);
    expect(hook.attempts).toBe(2);
    // No row names bytes that are not its own.
    expect(await rowsNamed(name)).toEqual([]);
    expect((await onDisk(name)).toString()).toBe('THEIRS');
    expect(await staging()).toEqual([]);
  });

  it('lands the retry when the name still holds this create’s bytes', async () => {
    const name = 'retried-intact.txt';
    const mine = Buffer.from('STILL MINE');
    hook.attempts = 0;
    hook.failOnce = async () => {};
    const made = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: name,
      bytes: mine,
    });
    expect(hook.attempts).toBe(2);
    const rows = await rowsNamed(name);
    expect(rows.map((r) => r.id)).toEqual([made.id]);
    expect(rows[0]!.sha).toBe(sha(mine));
    expect((await onDisk(name)).toString()).toBe('STILL MINE');
    expect(await staging()).toEqual([]);
  });
});
