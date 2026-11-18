/**
 * File history (docs/files.md, "File history"; migration 0384), through the
 * full HTTP pipeline (runRoute: the gate, the route's row, the handler) on a
 * migrated scratch database, the checks on:
 *
 *  - an upload to a taken name: the same bytes answer 200 skipped ("Already
 *    here", nothing written); other bytes the 409 with the file there;
 *  - an overwrite (replace=true) keeps the old bytes as a version: listed,
 *    downloaded byte for byte, counted on the file row;
 *  - restore and delete of a version: an Admin user, a Moderator of the
 *    home, a Moderator of a workspace that holds the file, yes; a user with
 *    Write on, a plain reader, a read-only key, no; an outsider, not found;
 *  - listing and downloading: whoever reads the file;
 *  - the prune: FILE_HISTORY_KEEP per file and FILE_HISTORY_MAX_MB for the
 *    box, oldest first, the files removed;
 *  - the nightly purge: a deleted file's history 30 days after its newest
 *    version, not before.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/server/file-history.db.test.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Role = 'admin' | 'homeMod' | 'holderMod' | 'writeUser' | 'reader' | 'outsider';

describe.skipIf(!DB_URL)('file history (0384)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let fl: typeof import('@mantle/files');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `fh${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const L: Record<Role, string> = {
    admin: randomUUID(),
    homeMod: randomUUID(),
    holderMod: randomUUID(),
    writeUser: randomUUID(),
    reader: randomUUID(),
    outsider: randomUUID(),
  };
  const ws = { admin: '', H: '', W: '', V: '', R: '', O: '' };
  let roKey = '';

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:file-history', fn) as Promise<T>;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  /** A multipart upload of `content` as `name` into the files root. */
  const upload = (who: string, name: string, content: string, replace = false) => {
    const b = `fh${randomUUID().slice(0, 8)}`;
    const body = [
      `--${b}`,
      'Content-Disposition: form-data; name="parentPath"',
      '',
      'files',
      ...(replace ? [`--${b}`, 'Content-Disposition: form-data; name="replace"', '', 'true'] : []),
      `--${b}`,
      `Content-Disposition: form-data; name="file"; filename="${name}"`,
      'Content-Type: text/plain',
      '',
      content,
      `--${b}--`,
      '',
    ].join('\r\n');
    return runRoute(who, 'POST', '/api/files/files', undefined, {
      rawBody: body,
      headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    });
  };

  /** Give `id` exactly these grants: [workspace, home, write]. */
  const grant = async (id: string, grants: [string, boolean, boolean][]) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      for (const [w, home, write] of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${w}, ${home}, ${write})`;
      }
    });
  };

  /** A file in the root with two versions' worth of history: made, then
   *  replaced twice, then granted: home H; Admin, W and R (Write off) hold
   *  it; V holds it with Write on. Returns its id and its three
   *  contents, oldest first. */
  const fileWithHistory = async (): Promise<{ id: string; bodies: string[] }> => {
    const name = `${tag}-${randomUUID().slice(0, 6)}.txt`;
    const bodies = ['one ' + randomUUID(), 'two ' + randomUUID(), 'three ' + randomUUID()];
    const first = await upload(owner, name, bodies[0]!);
    expect(first.status, await first.clone().text()).toBe(200);
    const id = ((await first.json()) as { file: { id: string } }).file.id;
    for (const b of bodies.slice(1)) {
      const r = await upload(owner, name, b, true);
      expect(r.status, await r.clone().text()).toBe(200);
    }
    // Admin holds it too (Write off), so the owner's own reads find it.
    await grant(id, [
      [ws.H, true, false],
      [ws.admin, false, false],
      [ws.W, false, false],
      [ws.R, false, false],
      [ws.V, false, true],
    ]);
    return { id, bodies };
  };

  const history = async (who: string, id: string) => {
    const r = await runRoute(who, 'GET', `/api/files/files/${id}/history`);
    return {
      status: r.status,
      body: (await r.json()) as {
        versions: { id: string; seq: number; trigger: string; sha256: string | null }[];
        rights: { mayRestore: boolean };
      },
    };
  };
  const versionCount = async (id: string) =>
    Number(
      (
        await raw<{ n: number }[]>`select count(*)::int as n from node_snapshots
                                     where node_id = ${id} and node_kind = 'file'`
      )[0]!.n,
    );
  const fileSha = async (id: string) =>
    (await raw<{ s: string }[]>`select data->>'sha256' as s from nodes where id = ${id}`)[0]!.s;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'file-history-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'file-history-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the file history test', { status: 503 })),
    );
    m = await import('@mantle/db');
    fl = await import('@mantle/files');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    const people = Object.entries(L) as [Role, string][];
    await asSuperuser()`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner')`;
    for (const [role, id] of people) {
      await asSuperuser()`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${role.toLowerCase()}@example.invalid`}, 'x', false,
                ${role === 'admin' ? 'admin' : 'member'}, ${role})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'W', 'V', 'R', 'O'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    const logins = [owner, ...Object.values(L)];
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin and u.login_id = any(${logins}::uuid[])`;
    // The Admin user reads the file through R (a plain user there): an
    // Admin user manages what it reads (0383).
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.admin}, true), (${ws.R}, ${L.admin}, false),
             (${ws.H}, ${L.homeMod}, true),
             (${ws.W}, ${L.holderMod}, true),
             (${ws.V}, ${L.writeUser}, false),
             (${ws.R}, ${L.reader}, false),
             (${ws.O}, ${L.outsider}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`;
    const keys = await import('../lib/access-keys');
    const minted = await m.asSystem(
      () =>
        keys.mintAccessKey({
          name: `${tag} read only`,
          loginId: L.holderMod,
          access: 'read_only',
          areas: null,
          riskyTools: [],
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          createdBy: L.holderMod,
          maxLive: 50,
        }),
      'test',
    );
    roKey = minted!.key;
    await sys(() => fl.ensureFilesRootBranch(owner));
  }, 300_000);

  afterAll(async () => {
    delete process.env.FILE_HISTORY_KEEP;
    delete process.env.FILE_HISTORY_MAX_MB;
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('an upload to a taken name: same bytes skipped, other bytes the 409 with the file', async () => {
    const name = `${tag}-clash.txt`;
    const first = await upload(owner, name, 'alpha');
    expect(first.status).toBe(200);
    const id = ((await first.json()) as { file: { id: string } }).file.id;

    const same = await upload(owner, name, 'alpha');
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({
      skipped: true,
      reason: 'same-bytes',
      existing: { id, sha256: sha('alpha') },
    });
    expect(await versionCount(id)).toBe(0);

    const other = await upload(owner, name, 'beta!');
    expect(other.status).toBe(409);
    const body = (await other.json()) as Record<string, unknown>;
    expect(body.reason).toBe('name-taken');
    expect(body.existing).toEqual({ id, sha256: sha('alpha'), sizeBytes: 5, name });
    expect(await fileSha(id)).toBe(sha('alpha'));
    expect(await versionCount(id)).toBe(0);
  });

  it('an overwrite keeps the old bytes: listed, counted, downloaded byte for byte', async () => {
    const { id, bodies } = await fileWithHistory();
    expect(await fileSha(id)).toBe(sha(bodies[2]!));
    const h = await history(owner, id);
    expect(h.status).toBe(200);
    expect(h.body.versions.map((v) => [v.seq, v.trigger, v.sha256])).toEqual([
      [2, 'replace', sha(bodies[1]!)],
      [1, 'replace', sha(bodies[0]!)],
    ]);
    const row = await runRoute(owner, 'GET', `/api/files/files/${id}`);
    expect(((await row.json()) as { file: { versions: number } }).file.versions).toBe(2);
    // Each version's bytes sit under the history folder, by uuids only.
    const paths = await raw<{ p: string }[]>`select db_path as p from node_snapshots
                                               where node_id = ${id} order by seq`;
    for (const { p } of paths) {
      expect(p).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.bin$/);
      expect(existsSync(path.join(dir, 'files', '.file-history', p))).toBe(true);
    }
    const dl = await runRoute(
      L.reader,
      'GET',
      `/api/files/files/${id}/history/${h.body.versions[1]!.id}/download`,
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(bodies[0]);
  });

  it('reading the history and a version: whoever reads the file; an outsider not found', async () => {
    const { id } = await fileWithHistory();
    const v = (await history(owner, id)).body.versions[0]!;
    for (const who of ['reader', 'writeUser', 'holderMod', 'homeMod', 'admin'] as const) {
      const h = await history(L[who], id);
      expect(h.status, who).toBe(200);
      expect(h.body.versions.length, who).toBe(2);
      expect(h.body.rights.mayRestore, who).toBe(
        who === 'holderMod' || who === 'homeMod' || who === 'admin',
      );
    }
    const out = await runRoute(L.outsider, 'GET', `/api/files/files/${id}/history`);
    expect(out.status).toBe(404);
    const outDl = await runRoute(
      L.outsider,
      'GET',
      `/api/files/files/${id}/history/${v.id}/download`,
    );
    expect(outDl.status).toBe(404);
  });

  it('restore: Admin, home Moderator, holder Moderator yes; Write user, reader, read-only key no', async () => {
    const { id, bodies } = await fileWithHistory();
    const versions = (await history(owner, id)).body.versions;
    const v1 = versions.find((v) => v.seq === 1)!;
    const restore = (who: Parameters<typeof runRoute>[0]) =>
      runRoute(who, 'POST', `/api/files/files/${id}/history/${v1.id}/restore`);

    for (const who of ['writeUser', 'reader'] as const) {
      const r = await restore(L[who]);
      expect(r.status, `${who}: ${await r.clone().text()}`).toBe(403);
    }
    expect((await restore(L.outsider)).status).toBe(404);
    const ro = await restore({ key: roKey });
    expect([401, 403, 404], `read-only key: ${ro.status}`).toContain(ro.status);
    expect(await versionCount(id)).toBe(2);
    expect(await fileSha(id)).toBe(sha(bodies[2]!));

    // A holder's Moderator: v1 is the file's again, and the bytes it
    // replaced are kept as a pre_restore version naming v1.
    const r = await restore(L.holderMod);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { file: { sha256: string }; restored: { seq: number } };
    expect(body.restored.seq).toBe(1);
    expect(body.file.sha256).toBe(sha(bodies[0]!));
    expect(await fileSha(id)).toBe(sha(bodies[0]!));
    const after = (await history(owner, id)).body.versions;
    expect(after[0]).toMatchObject({ seq: 3, trigger: 'pre_restore', sha256: sha(bodies[2]!) });
    const raw3 = await raw<{ r: number }[]>`select restored_from as r from node_snapshots
                                             where node_id = ${id} and seq = 3`;
    expect(raw3[0]!.r).toBe(1);

    // The home's Moderator undoes it, and an Admin user restores again.
    const undo = await runRoute(
      L.homeMod,
      'POST',
      `/api/files/files/${id}/history/${after[0]!.id}/restore`,
    );
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(await fileSha(id)).toBe(sha(bodies[2]!));
    const byAdmin = await restore(L.admin);
    expect(byAdmin.status, await byAdmin.clone().text()).toBe(200);
    expect(await fileSha(id)).toBe(sha(bodies[0]!));
    expect(await versionCount(id)).toBe(5);
  });

  it('delete a version: a Moderator yes, a Write user no; its file is tombstoned', async () => {
    const { id } = await fileWithHistory();
    const v = (await history(owner, id)).body.versions[1]!;
    const del = (who: string) => runRoute(who, 'DELETE', `/api/files/files/${id}/history/${v.id}`);
    expect((await del(L.writeUser)).status).toBe(403);
    expect((await del(L.reader)).status).toBe(403);
    expect((await del(L.outsider)).status).toBe(404);
    expect(await versionCount(id)).toBe(2);
    const ok = await del(L.holderMod);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await versionCount(id)).toBe(1);
    const tomb = await raw<{ n: number }[]>`select count(*)::int as n from store_tombstones
                                              where store = 'filesnap' and path like ${`%/${id}/%`}`;
    expect(Number(tomb[0]!.n)).toBe(1);
    expect((await del(L.holderMod)).status).toBe(404);
  });

  it('the prune: FILE_HISTORY_KEEP per file, oldest first, files removed', async () => {
    process.env.FILE_HISTORY_KEEP = '3';
    try {
      const name = `${tag}-keep.txt`;
      const write = (s: string) =>
        sys(() =>
          fl.upsertFile({
            ownerId: owner,
            parentPath: 'files',
            filename: name,
            bytes: Buffer.from(s),
            overwrite: true,
          }),
        );
      const f = await write('k0');
      for (let i = 1; i <= 5; i++) await write(`k${i}`);
      const rows = await raw<{ seq: number; p: string; s: string }[]>`
        select seq, db_path as p, source_hash as s from node_snapshots
         where node_id = ${f.id} order by seq`;
      expect(rows.map((r) => r.seq)).toEqual([3, 4, 5]);
      expect(rows.map((r) => r.s)).toEqual([sha('k2'), sha('k3'), sha('k4')]);
      const root = path.join(dir, 'files', '.file-history', owner, f.id);
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(root).length).toBe(3);
    } finally {
      delete process.env.FILE_HISTORY_KEEP;
    }
  });

  it('the prune: FILE_HISTORY_MAX_MB for the whole box, oldest first, the newest always', async () => {
    process.env.FILE_HISTORY_MAX_MB = '1';
    try {
      const big = (c: string) => Buffer.alloc(400 * 1024, c);
      const write = (name: string, bytes: Buffer) =>
        sys(() =>
          fl.upsertFile({
            ownerId: owner,
            parentPath: 'files',
            filename: name,
            bytes,
            overwrite: true,
          }),
        );
      const a = await write(`${tag}-capa.bin`, big('a'));
      const b = await write(`${tag}-capb.bin`, big('b'));
      await write(`${tag}-capa.bin`, big('c')); // a's first version: 400 KB
      await write(`${tag}-capb.bin`, big('d')); // b's: 800 KB in all
      await write(`${tag}-capa.bin`, big('e')); // 1200 KB: the oldest goes
      const left = await raw<{ node: string; s: string }[]>`
        select node_id::text as node, source_hash as s from node_snapshots
         where node_kind = 'file' and node_id in (${a.id}, ${b.id}) order by created_at`;
      const total = (
        await raw<{ t: number }[]>`select coalesce(sum(db_bytes), 0)::bigint as t
                                     from node_snapshots where node_kind = 'file'`
      )[0]!.t;
      expect(Number(total)).toBeLessThanOrEqual(1024 * 1024);
      const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      expect(left.map((r) => r.s)).not.toContain(shaOf(big('a')));
      expect(left.map((r) => r.s)).toContain(shaOf(big('c')));
      // One version bigger than the cap still stays: the newest always.
      process.env.FILE_HISTORY_MAX_MB = '1';
      const huge = Buffer.alloc(1200 * 1024, 'h');
      const hfile = await write(`${tag}-caph.bin`, huge);
      await write(`${tag}-caph.bin`, Buffer.alloc(10, 'x'));
      expect(await versionCount(hfile.id)).toBe(1);
    } finally {
      delete process.env.FILE_HISTORY_MAX_MB;
    }
  });

  it('the nightly purge: a deleted file’s history after 30 days, not before', async () => {
    const write = (name: string, s: string) =>
      sys(() =>
        fl.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from(s),
          overwrite: true,
        }),
      );
    const old = await write(`${tag}-gone-old.txt`, 'o1');
    await write(`${tag}-gone-old.txt`, 'o2');
    const fresh = await write(`${tag}-gone-new.txt`, 'n1');
    await write(`${tag}-gone-new.txt`, 'n2');
    const [oldPath] = await raw<{ p: string }[]>`select db_path as p from node_snapshots
                                                   where node_id = ${old.id}`;
    for (const f of [old, fresh]) {
      const res = await sys(() => fl.deleteFileById({ ownerId: owner, fileId: f.id }));
      expect(res.ok).toBe(true);
    }
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`update node_snapshots set created_at = now() - interval '31 days'
                where node_id = ${old.id}`;
    });
    const dry = await sys(() => fl.purgeOrphanFileHistory({ dryRun: true }));
    expect(dry.files).toBeGreaterThanOrEqual(1);
    await sys(() => fl.purgeOrphanFileHistory());
    expect(await versionCount(old.id)).toBe(0);
    expect(await versionCount(fresh.id)).toBe(1);
    expect(existsSync(path.join(dir, 'files', '.file-history', oldPath!.p))).toBe(false);
  });
});
