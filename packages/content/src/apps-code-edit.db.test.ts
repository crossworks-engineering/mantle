/**
 * The code tools' draft write on Postgres (0350): changeDraftSource checks
 * the revision under the row lock and records the code as it stood
 * (`pre_code_edit`), undoDraftFile walks one file back through those rows,
 * the History list leaves them out, and they are pruned on their own line.
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

  it('writes the draft, records the old code, and the rev follows the content', async () => {
    const app = await newApp('write');
    const before = await apps.getApp(owner, app.id);
    const rev0 = apps.sourceRev(apps.workingSource(before!));
    const res = await apps.changeDraftSource(owner, app.id, setFile('lib/a.ts', 'a1\n'), opts);
    expect(res).toMatchObject({ beforeRev: rev0, written: true });
    const after = await apps.getApp(owner, app.id);
    expect(after?.draft?.files['lib/a.ts']).toBe('a1\n');
    // The rev a read gives is the rev the write returned (jsonb's own key
    // order is never hashed).
    expect(apps.sourceRev(apps.workingSource(after!))).toBe(res!.rev);
    expect(await codeRows(app.id)).toBe(1);
  });

  it('a stale base_rev is refused with the current rev, and nothing is written', async () => {
    const app = await newApp('stale');
    const first = await apps.changeDraftSource(owner, app.id, setFile('x.ts', '1'), opts);
    // Someone else writes meanwhile.
    await apps.changeDraftSource(owner, app.id, setFile('y.ts', '2'), opts);
    const err = await apps
      .changeDraftSource(owner, app.id, setFile('x.ts', 'mine'), { ...opts, baseRev: first!.rev })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(apps.AppDraftRevError);
    const now = await apps.getApp(owner, app.id);
    expect((err as InstanceType<typeof apps.AppDraftRevError>).currentRev).toBe(
      apps.sourceRev(apps.workingSource(now!)),
    );
    expect(now?.draft?.files['x.ts']).toBe('1');
    // With the current rev it goes through.
    const ok = await apps.changeDraftSource(owner, app.id, setFile('x.ts', 'mine'), {
      ...opts,
      baseRev: apps.sourceRev(apps.workingSource(now!)),
    });
    expect(ok?.written).toBe(true);
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
    expect(dry).toMatchObject({ written: false });
    expect(dry?.after.files['a.ts']).toBe('x');
    const same = await apps.changeDraftSource(owner, app.id, (t) => t, opts);
    expect(same).toMatchObject({ written: false });
    expect((await apps.getApp(owner, app.id))?.hasDraft).toBe(false);
    expect(await codeRows(app.id)).toBe(0);
  });

  it('undo steps one file back, edit by edit, past edits of other files', async () => {
    const app = await newApp('undo');
    await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'v1'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'v2'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('b.ts', 'other'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'v3'), opts);

    const u1 = await apps.undoDraftFile(owner, app.id, 'a.ts', opts);
    expect(u1?.after.files['a.ts']).toBe('v2');
    expect(u1?.after.files['b.ts']).toBe('other');
    const u2 = await apps.undoDraftFile(owner, app.id, 'a.ts', opts);
    expect(u2?.after.files['a.ts']).toBe('v1');
    // Before v1 the file did not exist: the undo removes it.
    const u3 = await apps.undoDraftFile(owner, app.id, 'a.ts', opts);
    expect(Object.hasOwn(u3!.after.files, 'a.ts')).toBe(false);
    await expect(apps.undoDraftFile(owner, app.id, 'a.ts', opts)).rejects.toBeInstanceOf(
      apps.AppUndoEmptyError,
    );
    // The draft read back is the undo's tree.
    const now = await apps.getApp(owner, app.id);
    expect(apps.sourceRev(apps.workingSource(now!))).toBe(u3!.rev);
  });

  it('the entry file is never undone away', async () => {
    const app = await newApp('entry');
    const entry = (await apps.getApp(owner, app.id))!.source.entry;
    // A row whose tree lacks the entry (an app_source_set that renamed it).
    await apps.changeDraftSource(
      owner,
      app.id,
      () => ({ entry: 'Main.tsx', files: { 'Main.tsx': 'm' } }),
      opts,
    );
    await apps.changeDraftSource(
      owner,
      app.id,
      (t) => ({ entry, files: { ...t.files, [entry]: 'e' } }),
      opts,
    );
    await expect(apps.undoDraftFile(owner, app.id, entry, opts)).rejects.toBeInstanceOf(
      apps.AppUndoEntryError,
    );
  });

  it('undo after undo walks back, never swinging between two texts (A, B, A, B)', async () => {
    const app = await newApp('swing');
    await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'A'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'B'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'A'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('s.ts', 'B'), opts);
    const seen: (string | undefined)[] = [];
    for (;;) {
      const u = await apps.undoDraftFile(owner, app.id, 's.ts', opts).catch((e: unknown) => e);
      if (u instanceof apps.AppUndoEmptyError) break;
      seen.push((u as { after: { files: Record<string, string> } }).after.files['s.ts']);
      expect(seen.length).toBeLessThan(10);
    }
    // B -> A -> B -> A -> (no file): each step one write further back.
    expect(seen).toEqual(['A', 'B', 'A', undefined]);
  });

  it('a new edit after an undo is what the next undo takes back', async () => {
    const app = await newApp('redo');
    await apps.changeDraftSource(owner, app.id, setFile('r.ts', 'v1'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('r.ts', 'v2'), opts);
    await apps.undoDraftFile(owner, app.id, 'r.ts', opts); // v1
    await apps.changeDraftSource(owner, app.id, setFile('r.ts', 'v3'), opts);
    const u = await apps.undoDraftFile(owner, app.id, 'r.ts', opts);
    expect(u?.after.files['r.ts']).toBe('v1');
  });

  it('an undo never replaces an editor save (base_rev or not); other files still undo', async () => {
    const app = await newApp('editor');
    const w = await apps.changeDraftSource(owner, app.id, setFile('e.ts', 'agent'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('o.ts', 'other'), opts);
    // The person saves e.ts in the editor (no code-tool row).
    const tree = (await apps.getApp(owner, app.id))!.draft!;
    await apps.saveDraftSource(owner, app.id, {
      ...tree,
      files: { ...tree.files, 'e.ts': 'person' },
    });
    // From the agent's stale read: the stale check answers.
    await expect(
      apps.undoDraftFile(owner, app.id, 'e.ts', { ...opts, baseRev: w!.rev }),
    ).rejects.toBeInstanceOf(apps.AppDraftRevError);
    // With the current rev, or none: the outside change is never replaced.
    const now = apps.sourceRev(apps.workingSource((await apps.getApp(owner, app.id))!));
    for (const baseRev of [now, null]) {
      await expect(
        apps.undoDraftFile(owner, app.id, 'e.ts', { ...opts, baseRev }),
      ).rejects.toBeInstanceOf(apps.AppUndoUntrackedError);
    }
    expect((await apps.getApp(owner, app.id))?.draft?.files['e.ts']).toBe('person');
    // Another file's undo is not held up by it, and keeps the person's text.
    const u = await apps.undoDraftFile(owner, app.id, 'o.ts', opts);
    expect(u?.after.files['e.ts']).toBe('person');
    expect(Object.hasOwn(u!.after.files, 'o.ts')).toBe(false);
  });

  it('a code-tool write after an outside change does not hide it from the undo', async () => {
    const app = await newApp('gap');
    await apps.changeDraftSource(owner, app.id, setFile('x.ts', 'a'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('x.ts', 'b'), opts);
    // The person saves x.ts = c in the editor, then an agent writes y.ts.
    const tree = (await apps.getApp(owner, app.id))!.draft!;
    await apps.saveDraftSource(owner, app.id, { ...tree, files: { ...tree.files, 'x.ts': 'c' } });
    await apps.changeDraftSource(owner, app.id, setFile('y.ts', 'y'), opts);
    // Undoing x.ts goes back past the editor's save: refused without base_rev.
    await expect(apps.undoDraftFile(owner, app.id, 'x.ts', opts)).rejects.toBeInstanceOf(
      apps.AppUndoUntrackedError,
    );
    // Undoing y.ts (the newest write, after the save) is fine.
    const u = await apps.undoDraftFile(owner, app.id, 'y.ts', opts);
    expect(u?.after.files['x.ts']).toBe('c');
  });

  it('the prune keeps one unbroken window: undos between kept writes stay', async () => {
    const app = await newApp('suffix');
    for (let i = 1; i <= apps.APP_CODE_EDIT_KEEP + 5; i++) {
      await apps.changeDraftSource(owner, app.id, setFile(`f${i % 3}.ts`, `v${i}`), opts);
      if (i % 4 === 0) await apps.undoDraftFile(owner, app.id, `f${i % 3}.ts`, opts);
    }
    const rows = await admin`select seq, trigger from node_snapshots
                              where node_id = ${app.id}
                                and trigger in ('pre_code_edit', 'pre_code_undo')
                              order by seq desc`;
    const edits = rows.filter((r) => r.trigger === 'pre_code_edit');
    expect(edits).toHaveLength(apps.APP_CODE_EDIT_KEEP);
    const oldestEdit = Math.min(...edits.map((r) => r.seq as number));
    // No undo row older than the oldest write kept, and every undo row
    // newer than it is kept (the window has no hole).
    expect(rows.filter((r) => (r.seq as number) < oldestEdit)).toEqual([]);
    expect(rows.filter((r) => r.trigger === 'pre_code_undo').length).toBeGreaterThan(0);
    // And an undo walks back without a false outside-change refusal.
    await expect(apps.undoDraftFile(owner, app.id, 'f1.ts', opts)).resolves.toBeTruthy();
  });

  it('undos keep their own line: they never push the writes out of the window', async () => {
    const app = await newApp('window');
    for (let i = 1; i <= apps.APP_CODE_EDIT_KEEP; i++) {
      await apps.changeDraftSource(owner, app.id, setFile('w.ts', `v${i}`), opts);
    }
    // 20 writes: the first row holds no w.ts; undo walks all the way back.
    const seen: (string | undefined)[] = [];
    for (;;) {
      const u = await apps.undoDraftFile(owner, app.id, 'w.ts', opts).catch((e: unknown) => e);
      if (u instanceof apps.AppUndoEmptyError) break;
      seen.push((u as { after: { files: Record<string, string> } }).after.files['w.ts']);
      expect(seen.length).toBeLessThanOrEqual(apps.APP_CODE_EDIT_KEEP);
    }
    expect(seen).toHaveLength(apps.APP_CODE_EDIT_KEEP);
    expect(seen.at(-1)).toBeUndefined();
    expect(await codeRows(app.id)).toBe(apps.APP_CODE_EDIT_KEEP);
  });

  it('undo to code taken at team rules brings the author ceiling back to team', async () => {
    const app = await newApp('ceiling');
    await apps.setAppAuthorLevel(owner, app.id, 'team');
    // A non-Admin login's code, then the owner's replacement (its row holds
    // the team-era code), then the owner trusts the app's tools.
    await apps.changeDraftSource(owner, app.id, setFile('t.ts', 'member code'), opts);
    await apps.changeDraftSource(owner, app.id, setFile('t.ts', 'owner code'), opts);
    await apps.setAppAuthorLevel(owner, app.id, 'admin');
    const u = await apps.undoDraftFile(owner, app.id, 't.ts', opts);
    expect(u?.after.files['t.ts']).toBe('member code');
    expect(u?.teamRules).toBe(true);
    expect((await apps.getApp(owner, app.id))?.authorLevel).toBe('team');
  });

  it('the rows are hidden from the snapshot lookups by id', async () => {
    const app = await newApp('byid');
    await apps.changeDraftSource(owner, app.id, setFile('h.ts', '1'), opts);
    const [row] = await admin`select id from node_snapshots
                               where node_id = ${app.id} and trigger = 'pre_code_edit' limit 1`;
    expect(await snaps.getAppSnapshot(owner, app.id, row!.id as string)).toBeNull();
    expect(await snaps.setAppSnapshotNote(owner, app.id, row!.id as string, 'x')).toBe(false);
  });

  it('the History list leaves the rows out; they keep their own line', async () => {
    const app = await newApp('prune');
    for (let i = 0; i <= apps.APP_CODE_EDIT_KEEP + 2; i++) {
      await apps.changeDraftSource(owner, app.id, setFile('a.ts', `v${i}`), opts);
    }
    expect(await codeRows(app.id)).toBe(apps.APP_CODE_EDIT_KEEP);
    const listed = await snaps.listAppSnapshots(owner, app.id);
    expect(listed.filter((e) => (e.trigger as string) === 'pre_code_edit')).toEqual([]);
    // A manual snapshot still lists, and is never pruned by the code line.
    await snaps.createAppSnapshot(owner, app.id, { actor: 'owner', withData: false });
    await apps.changeDraftSource(owner, app.id, setFile('a.ts', 'last'), opts);
    expect((await snaps.listAppSnapshots(owner, app.id)).map((e) => e.trigger)).toEqual(['manual']);
  });
});
