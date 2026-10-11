/**
 * Two creates racing for one file name (W8b). A create stages its bytes
 * beside the final name and places them only once its node insert wins, so
 * the loser's bytes never land under the winner's row: one node, whose
 * sha256 is the bytes on disk, and no staging file left behind. A disk file
 * with no node (an interrupted upload's residue) is still replaced by a
 * create of its name (the self-heal).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/create-race.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a same-name create race leaves one file, its bytes on disk', () => {
  type Db = typeof import('@mantle/db');
  type Ops = typeof import('./ops');
  type Files = typeof import('./index');
  let m: Db;
  let ops: Ops;
  let f: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `race-test-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;

  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
  const dir = () => path.dirname(f.diskPathForFile(top, 'x.txt')!);
  const staging = async () =>
    (await readdir(dir()).catch(() => [] as string[])).filter((n) => n.endsWith('.staged.tmp'));
  const rowsNamed = async (name: string) =>
    (await m.db.execute(sqlTag`
      select id::text as id, data->>'sha256' as sha from nodes
       where owner_id = ${owner} and type = 'file' and path = ${top}::ltree and slug = ${name}`)) as unknown as {
      id: string;
      sha: string;
    }[];
  const onDisk = async (name: string) => readFile(f.diskPathForFile(top, name)!);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-race-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ops = await import('./ops');
    f = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path) values
        (${owner}, 'branch', 'files', 'files', 'files'),
        (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree)
      on conflict do nothing`);
    await mkdir(dir(), { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('concurrent uploads of one name: one node, its sha256 the bytes on disk, no staging file', async () => {
    for (let round = 0; round < 5; round++) {
      const name = `same-${round}.bin`;
      const bodies = Array.from({ length: 6 }, (_, i) => Buffer.from(`round ${round} upload ${i}`));
      const results = await Promise.allSettled(
        bodies.map((bytes) =>
          ops.upsertFile({ ownerId: owner, parentPath: top, filename: name, bytes }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length, `round ${round}`).toBeGreaterThanOrEqual(1);
      const rows = await rowsNamed(name);
      expect(rows).toHaveLength(1);
      const disk = await onDisk(name);
      expect(rows[0]!.sha).toBe(sha(disk));
      expect(bodies.map((b) => sha(b))).toContain(rows[0]!.sha);
      // Every create that did not land was refused as a taken name.
      for (const r of results) {
        if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already exists/);
      }
      expect(await staging()).toEqual([]);
    }
  });

  it('concurrent spooled uploads of one name: the same', async () => {
    const name = 'spooled-same.bin';
    const bodies = Array.from({ length: 5 }, (_, i) => Buffer.from(`spooled upload ${i}`));
    const spooled = await Promise.all(
      bodies.map((b) => f.spoolUpload(Readable.from([b]), { maxBytes: 1024 })),
    );
    await Promise.allSettled(
      spooled.map((s) =>
        ops.upsertFile({ ownerId: owner, parentPath: top, filename: name, spooled: s }),
      ),
    );
    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha(await onDisk(name)));
    expect(await staging()).toEqual([]);
    // No spool file left either: each was placed or dropped.
    const spool = await readdir(f.spoolDir()).catch(() => [] as string[]);
    expect(spool.filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('the create that loses the insert is refused and its bytes never reach the name', async () => {
    const name = 'forced-race.txt';
    const winner = Buffer.from('WINNER');
    let failure: unknown;
    let upsert: Promise<unknown> | undefined;
    // Another create's insert, held open while this create stages its bytes
    // and reaches its own insert (which waits on this row). The winner puts
    // its bytes in place before it commits, as upsertFile does.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`insert into nodes (owner_id, type, title, slug, path, data, tags)
        values (${owner}, 'file', ${name}, ${name}, ${top}::ltree, ${JSON.stringify({
          filename: name,
          sha256: sha(winner),
          size_bytes: winner.byteLength,
        })}::jsonb, '{file}')`);
      upsert = ops
        .upsertFile({
          ownerId: owner,
          parentPath: top,
          filename: name,
          bytes: Buffer.from('LOSER'),
        })
        .catch((e: unknown) => {
          failure = e;
        });
      for (let i = 0; i < 200 && (await staging()).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Staged beside the name, not on it.
      expect(await staging()).toHaveLength(1);
      await expect(onDisk(name)).rejects.toThrow();
      await writeFile(f.diskPathForFile(top, name)!, winner);
      await new Promise((r) => setTimeout(r, 200));
    });
    await upsert;
    expect(failure).toBeInstanceOf(ops.FileNameTakenError);
    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha(winner));
    expect((await onDisk(name)).toString()).toBe('WINNER');
    expect(await staging()).toEqual([]);
  });

  it('an orphan disk file with no node is replaced by a create of its name', async () => {
    const name = 'orphan.txt';
    await writeFile(f.diskPathForFile(top, name)!, 'stale residue');
    const made = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: name,
      bytes: Buffer.from('fresh upload'),
    });
    const rows = await rowsNamed(name);
    expect(rows.map((r) => r.id)).toEqual([made.id]);
    expect((await onDisk(name)).toString()).toBe('fresh upload');
    expect(rows[0]!.sha).toBe(sha('fresh upload'));
    expect(await staging()).toEqual([]);

    // The same for a spooled upload.
    const spooledName = 'orphan-spooled.txt';
    await writeFile(f.diskPathForFile(top, spooledName)!, 'stale residue');
    const s = await f.spoolUpload(Readable.from([Buffer.from('fresh spooled')]), {
      maxBytes: 1024,
    });
    await ops.upsertFile({ ownerId: owner, parentPath: top, filename: spooledName, spooled: s });
    expect((await onDisk(spooledName)).toString()).toBe('fresh spooled');
    expect((await rowsNamed(spooledName))[0]!.sha).toBe(sha('fresh spooled'));
    expect(await staging()).toEqual([]);
  });
});
