/**
 * The code tools' draft write on Postgres (0351): changeDraftSource checks
 * the revision under the row lock and records what each write changed
 * (`pre_code_edit`, its id the write's edit_id); undoCodeEdit takes one
 * write back only while its files are as that write left them; the History
 * list and the lookups by id leave the rows out; the newest 20 are kept.
 * Seeds its own owner and apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/apps-code-edit.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the code tools draft write on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let snaps: typeof import('./app-snapshots');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);
  const opts = { actor: 'agent' as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'apps-code-edit-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    snaps = await import('./app-snapshots');
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`ce-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from node_snapshots where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const newApp = (title: string) => apps.createApp(owner, { title: `${tag} ${title}` });
  const setFile =
    (p: string, text: string) => (t: { entry: string; files: Record<string, string> }) => ({
      entry: t.entry,
      files: { ...t.files, [p]: text },
    });
  const codeRows = async (id: string) =>
    (
      await admin`select count(*)::int as n from node_snapshots
                  where node_id = ${id} and trigger = 'pre_code_edit'`
    )[0]!.n as number;

  const draftOf = async (id: string) => (await apps.getApp(owner, id))!.draft!.files;
  const undo = (id: string, o: { editId?: string; path?: string; baseRev?: string | null }) =>
    apps.undoCodeEdit(owner, id, { ...opts, ...o });

  it('writes the draft, records only what changed, and returns its edit_id', async () => {
    const app = await newApp('write');
    const rev0 = apps.sourceRev(apps.workingSource((await apps.getApp(owner, app.id))!));
    const res = await apps.changeDraftSource(owner, app.id, setFile('lib/a.ts', 'a1\n'), opts);
    expect(res).toMatchObject({ beforeRev: rev0, written: true, editId: expect.any(String) });
    expect((await draftOf(app.id))['lib/a.ts']).toBe('a1\n');
    // The rev a read gives is the rev the write returned.
    const after = await apps.getApp(owner, app.id);
    expect(apps.sourceRev(apps.workingSource(after!))).toBe(res!.rev);
    const [row] = await admin`select code->'source'->'files' as files,
                                     code->'codeEdit'->'changed' as changed
                                from node_snapshots where id = ${res!.editId}`;
    // A created file: absent before, its new text's hash after.
    expect(row!.files).toEqual({});
    expect(Object.keys(row!.changed as object)).toEqual(['lib/a.ts']);
  });

  it('a stale base_rev is refused with the current rev, and nothing is written', async () => {
    const app = await newApp('stale');
    const first = await apps.changeDraftSource(owner, app.id, setFile('x.ts', '1'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('y.ts', '2'), opts);
    const err = await apps
      .changeDraftSource(owner, app.id, setFile('x.ts', 'mine'), { ...opts, baseRev: first!.rev })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(apps.AppDraftRevError);
    expect((await draftOf(app.id))['x.ts']).toBe('1');
  });

  it('a throw inside the change, a dry run and a no-op write nothing', async () => {
    const app = await newApp('nothing');
    await expect(
      apps.changeDraftSource(
        owner,
        app.id,
        () => {
          throw new Error('old not found');
        },
        opts,
      ),
    ).rejects.toThrow('old not found');
    const dry = await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'x'), {
      ...opts,
      dryRun: true,
    });
    expect(dry).toMatchObject({ written: false, editId: null });
    const same = await apps.changeDraftSource(owner, app.id, (t) => t, opts);
    expect(same).toMatchObject({ written: false, editId: null });
    expect((await apps.getApp(owner, app.id))?.hasDraft).toBe(false);
    expect(await codeRows(app.id)).toBe(0);
  });

  it('undo by edit_id puts back every file that write changed', async () => {
    const app = await newApp('many');
    await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'a1'), opts);
    const tree = (await apps.getApp(owner, app.id))!.draft!;
    const set = await apps.changeDraftSource(
      owner,
      app.id,
      () => ({ entry: tree.entry, files: { ...tree.files, 'a.ts': 'a2', 'b.ts': 'b2' } }),
      opts,
    );
    const u = await undo(app.id, { editId: set!.editId! });
    expect(u?.files).toEqual(['a.ts', 'b.ts']);
    expect(u?.after.files['a.ts']).toBe('a1');
    expect(Object.hasOwn(u!.after.files, 'b.ts')).toBe(false);
    // The undo is a write with its own edit_id: undoing it redoes.
    const redo = await undo(app.id, { editId: u!.editId! });
    expect(redo?.after.files).toMatchObject({ 'a.ts': 'a2', 'b.ts': 'b2' });
    // With a path, only that file of the write.
    const one = await undo(app.id, { editId: redo!.editId!, path: 'b.ts' });
    // The redo created b.ts: taking back only that file removes it, a.ts stays.
    expect(one?.files).toEqual(['b.ts']);
    expect(one?.after.files['a.ts']).toBe('a2');
    expect(Object.hasOwn(one!.after.files, 'b.ts')).toBe(false);
  });

  it('undo last takes the newest write of the path; again, it redoes', async () => {
    const app = await newApp('last');
    await apps.changeDraftSource(owner, app.id, setFile('l.ts', 'v1'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('l.ts', 'v2'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('m.ts', 'other'), opts);
    const u1 = await undo(app.id, { path: 'l.ts' });
    expect(u1?.after.files['l.ts']).toBe('v1');
    const u2 = await undo(app.id, { path: 'l.ts' });
    expect(u2?.after.files['l.ts']).toBe('v2');
    await expect(undo(app.id, { path: 'never.ts' })).rejects.toBeInstanceOf(apps.AppUndoEmptyError);
  });

  it('never replaces later work on the file: another write, or the editor', async () => {
    const app = await newApp('stale-undo');
    const w1 = await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'agent'), opts);
    const w2 = await apps.changeDraftSource(owner, app.id, setFile('o.ts', 'other'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'agent 2'), opts);
    // w1's file changed since: refused, nothing written.
    await expect(undo(app.id, { editId: w1!.editId! })).rejects.toBeInstanceOf(
      apps.AppUndoStaleError,
    );
    // w2's file did not: fine.
    await undo(app.id, { editId: w2!.editId! });
    // The person saves s.ts in the editor (no code-tool row).
    const tree = (await apps.getApp(owner, app.id))!.draft!;
    await apps.saveDraftSource(owner, app.id, {
      ...tree,
      files: { ...tree.files, 's.ts': 'person' },
    });
    const now = apps.sourceRev(apps.workingSource((await apps.getApp(owner, app.id))!));
    for (const baseRev of [now, null]) {
      await expect(undo(app.id, { path: 's.ts', baseRev })).rejects.toBeInstanceOf(
        apps.AppUndoStaleError,
      );
    }
    expect((await draftOf(app.id))['s.ts']).toBe('person');
    // A stale base_rev answers first.
    await expect(undo(app.id, { path: 's.ts', baseRev: w1!.rev })).rejects.toBeInstanceOf(
      apps.AppDraftRevError,
    );
  });

  it('a deleted file comes back; the entry file is never undone away', async () => {
    const app = await newApp('entry');
    await apps.changeDraftSource(owner, app.id, setFile('d.ts', 'keep me'), opts);
    const del = await apps.changeDraftSource(
      owner,
      app.id,
      (t) => {
        const files = { ...t.files };
        delete files['d.ts'];
        return { entry: t.entry, files };
      },
      opts,
    );
    const back = await undo(app.id, { editId: del!.editId! });
    expect(back?.after.files['d.ts']).toBe('keep me');
    // An app_source_set that renamed the entry, then an undo of it.
    const renamed = await apps.changeDraftSource(
      owner,
      app.id,
      () => ({ entry: 'Main.tsx', files: { 'Main.tsx': 'm' } }),
      opts,
    );
    await expect(undo(app.id, { editId: renamed!.editId! })).rejects.toBeInstanceOf(
      apps.AppUndoEntryError,
    );
  });

  it('undo of code taken at team rules brings the author ceiling back to team', async () => {
    const app = await newApp('ceiling');
    await apps.setAppAuthorLevel(owner, app.id, 'team');
    await apps.changeDraftSource(owner, app.id, setFile('t.ts', 'member code'), opts);
    const owners = await apps.changeDraftSource(owner, app.id, setFile('t.ts', 'owner code'), opts);
    await apps.setAppAuthorLevel(owner, app.id, 'admin');
    const u = await undo(app.id, { editId: owners!.editId! });
    expect(u?.after.files['t.ts']).toBe('member code');
    expect(u?.teamRules).toBe(true);
    expect((await apps.getApp(owner, app.id))?.authorLevel).toBe('team');
  });

  it('an edit_id of another app, or unknown, is not found', async () => {
    const a = await newApp('a');
    const b = await newApp('b');
    const w = await apps.changeDraftSource(owner, a.id, setFile('a.ts', '1'), opts);
    await expect(undo(b.id, { editId: w!.editId! })).rejects.toBeInstanceOf(apps.AppUndoEmptyError);
    await expect(undo(a.id, { editId: randomUUID() })).rejects.toBeInstanceOf(
      apps.AppUndoEmptyError,
    );
  });

  it('a write that moved the entry is not undone', async () => {
    const app = await newApp('moved');
    const tree = (await apps.getApp(owner, app.id))!.source;
    // The entry moves to a file that existed, with no file changed.
    await apps.changeDraftSource(owner, app.id, setFile('Main.tsx', 'm'), opts);
    const moved = await apps.changeDraftSource(
      owner,
      app.id,
      (t) => ({ entry: 'Main.tsx', files: t.files }),
      opts,
    );
    expect(moved?.written).toBe(true);
    await expect(undo(app.id, { editId: moved!.editId! })).rejects.toBeInstanceOf(
      apps.AppUndoEntryError,
    );
    expect((await apps.getApp(owner, app.id))!.draft!.entry).toBe('Main.tsx');
    expect(tree.entry).not.toBe('Main.tsx');
  });

  it('an edit_id of a snapshot or a version, or of another owner, is not found', async () => {
    const app = await newApp('ids');
    await apps.changeDraftSource(owner, app.id, setFile('i.ts', '1'), opts);
    const snap = await snaps.createAppSnapshot(owner, app.id, { actor: 'owner', withData: false });
    await expect(undo(app.id, { editId: snap!.id })).rejects.toBeInstanceOf(apps.AppUndoEmptyError);
    const w = await apps.changeDraftSource(owner, app.id, setFile('i.ts', '2'), opts);
    await expect(
      apps.undoCodeEdit(randomUUID(), app.id, { ...opts, editId: w!.editId! }),
    ).resolves.toBeNull();
  });

  it('the rows are hidden from the History list and the lookups by id; 20 are kept', async () => {
    const app = await newApp('prune');
    let last = '';
    for (let i = 0; i <= apps.APP_CODE_EDIT_KEEP + 2; i++) {
      last = (await apps.changeDraftSource(owner, app.id, setFile('a.ts', `v${i}`), opts))!.editId!;
    }
    expect(await codeRows(app.id)).toBe(apps.APP_CODE_EDIT_KEEP);
    expect(await snaps.listAppSnapshots(owner, app.id)).toEqual([]);
    expect(await snaps.getAppSnapshot(owner, app.id, last)).toBeNull();
    expect(await snaps.setAppSnapshotNote(owner, app.id, last, 'x')).toBe(false);
    // A manual snapshot still lists.
    await snaps.createAppSnapshot(owner, app.id, { actor: 'owner', withData: false });
    expect((await snaps.listAppSnapshots(owner, app.id)).map((e) => e.trigger)).toEqual(['manual']);
  });

  it('fewer are kept when they pass APP_CODE_EDIT_MAX_MB', async () => {
    const app = await newApp('prune-mb');
    const was = process.env.APP_CODE_EDIT_MAX_MB;
    process.env.APP_CODE_EDIT_MAX_MB = '1';
    try {
      // Each row keeps the file as the write found it: 200 KB from the
      // second write on, so 1 MB holds the newest five, not twenty.
      for (let i = 0; i < 10; i++) {
        const body = String(i).repeat(200 * 1000);
        await apps.changeDraftSource(owner, app.id, setFile('big.ts', body), opts);
      }
      expect(await codeRows(app.id)).toBe(5);
    } finally {
      if (was === undefined) delete process.env.APP_CODE_EDIT_MAX_MB;
      else process.env.APP_CODE_EDIT_MAX_MB = was;
    }
  });
});
