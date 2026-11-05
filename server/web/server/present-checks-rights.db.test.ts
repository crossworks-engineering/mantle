/**
 * The image check overview of a traced P&ID canvas reads its drawings' answers
 * from their file rows with the viewer's rights, on one migrated scratch database
 * switched to workspaces, actor check and edit check on:
 *
 *  - a plain user of W reads the canvas (homed in W) and one of the two drawing
 *    files it names (homed in W); the other is homed in Admin;
 *  - GET /api/presents/:id/checks (runRoute: the full pipeline) and present_get
 *    with `checks: true` (an assistant turn of W) give that user the readable
 *    file's answer and only the COUNT of the one it does not read: no answer, no
 *    title, no id of it;
 *  - a saved canvas with old Table ids reads the same answers through the map,
 *    the table's `sourceFileId`, as the viewer reads it;
 *  - dwgSheetsByIds and readCircuitChecks in that user's scope, and node_read,
 *    give nothing of the file it does not read, and node_read leaves the answers
 *    out of a file it does;
 *  - a file turned private: every reader refuses at once, and its answers go;
 *  - the owner, who reads both, gets both answers (the control), and an owner's
 *    turn files an answer through the write role, keeping updated_at.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/present-checks-rights.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';
import { DWG_ANSWERS_KEY } from '@mantle/files/dwg-keys';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

const SHA = 'c'.repeat(64);
const REVISION = SHA.slice(0, 16);

type Checks = {
  traced: boolean;
  circuits: { circuit: string; counts: Record<string, number>; items: { sheet: string }[] }[];
  limits: string[];
};

describe.skipIf(!URL)('the image check overview reads drawing files as the viewer', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('@mantle/tools');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `pck${randomUUID().slice(0, 6)}`;
  const circuit = `${tag}-001`;
  const owner = randomUUID();
  /** A plain user of W. */
  const user = randomUUID();
  const ws = { admin: '', w: '' };
  /** The drawing files. */
  const t = { shared: '', hidden: '' };
  /** Their old Tables, as an old canvas names them. */
  const old = { shared: '', hidden: '' };
  const title = { shared: `${tag}-pid-shared`, hidden: `${tag}-pid-hidden` };
  let canvasId = '';
  let oldCanvasId = '';
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  /** Home `id` in `home` alone (Write off). */
  const homeIn = async (id: string, home: string) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${home}, false, true)`);
    });

  const storeOf = () => import('../../../packages/tools/src/circuit-trace/checks-store');
  const readOf = () => import('../../../packages/tools/src/circuit-trace/read');
  const sheetOf = (id: string, name: string) => ({
    tableId: id,
    title: name,
    sourceFileId: id,
    revision: REVISION,
    sourceSha: SHA,
    source: 'current' as const,
    circuitLayers: [],
    circuitRows: [],
    segments: [],
    nodes: [],
    inserts: [],
    texts: [],
    blocks: [],
    near: 1,
    limits: [],
  });
  const answerOf = (id: string, name: string, key = `end:${name}`) =>
    [
      {
        q: {
          id: 'q1',
          key,
          kind: 'end',
          tableId: id,
          sheet: name,
          sourceFileId: id,
          node: 2,
          handles: ['A1'],
          guess: `the pipe end #2 of ${name} belongs to "V-201"`,
          question: `Does the pipe end of ${name} connect to "V-201"?`,
          item: { id: 'q1', kind: 'point', at: [1, 0], pad: 4 },
          pidKey: 'x:2',
          alts: ['break', 'continues', 'open', 'other'],
          altAsk: 'If no, give "alt".',
        },
        verdict: 'yes',
        reason: `into its nozzle on ${name}`,
        model: 'test/vision-model',
        crops: [],
      },
    ] as never;

  /** A drawing file with its old Table and one sealed circuit_verify answer of
   *  `circuit` at its current revision, made as the system. */
  const drawingFile = async (name: string, bytes: string) => {
    const c = await import('@mantle/content');
    const files = await import('@mantle/files');
    const store = await storeOf();
    return m.asSystem(
      () =>
        m.withCreateHome({ createWs: ws.admin, privateWs: null, quiet: true }, async () => {
          const file = await files.upsertFile({
            ownerId: owner,
            parentPath: 'files',
            filename: `${name}.dwg`,
            bytes: Buffer.from(bytes),
          });
          // The revision the test seals under: this drawing's bytes stand in.
          await x(sql`update nodes set data = data || ${JSON.stringify({ sha256: SHA })}::jsonb
            where id = ${file.id}`);
          const table = await c.createTable(owner, {
            title: name,
            tags: ['auto-import'],
            sourceFileId: file.id,
            sourceSha256: SHA,
            description:
              'AutoCAD DWG model-space registry. ... within 2 drawing units of it ... (test)',
            tabs: [
              {
                ...c.tableDocFromGrid({
                  columns: [{ name: 'Layer', type: 'text' }],
                  rows: [['L']],
                }),
                name: 'Layers',
              },
            ],
          });
          const stored = await store.storeChecks(
            owner,
            sheetOf(file.id, name),
            circuit,
            answerOf(file.id, name),
            null,
            '2026-10-27T09:00:00.000Z',
          );
          expect(stored).toEqual({ stored: 1 });
          return { file: file.id, table: table.id };
        }),
      'test',
    );
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'present-checks-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'present-checks-rights-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    tools = await import('@mantle/tools');
    runRoute = (await import('./run-route')).runRoute;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${user}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    ws.admin = (
      await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin`)
    )[0]!.id;
    ws.w = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} W`}) returning id::text as id`)
    )[0]!.id;
    await su(sql`delete from workspace_users where workspace_id = ${ws.w}`);
    // The owner sits in W too (and in Admin): it reads the canvas and both tables.
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${user}, false), (${ws.w}, ${owner}, true)`);

    await m.asSystem(
      async () => (await import('@mantle/files')).ensureFilesRootBranch(owner),
      'test',
    );
    const shared = await drawingFile(title.shared, `AC1032 ${title.shared}`);
    const hidden = await drawingFile(title.hidden, `AC1032 ${title.hidden}`);
    t.shared = shared.file;
    t.hidden = hidden.file;
    old.shared = shared.table;
    old.hidden = hidden.table;
    for (const id of [shared.file, shared.table]) await homeIn(id, ws.w);
    for (const id of [hidden.file, hidden.table]) await homeIn(id, ws.admin);

    const { buildCanvas } = await import('@mantle/diagram-templates');
    const { createPresent } = await import('@mantle/content/presents');
    const canvas = async (tables: string[]) => {
      const data = {
        template: 'pid',
        title: `Circuit ${circuit}`,
        trace: { circuit, tables },
        equipment: [{ id: 'V-201', type: 'vertical-vessel' }],
      };
      const row = await m.asSystem(
        () =>
          m.withCreateHome({ createWs: ws.w, privateWs: null, quiet: true }, () =>
            createPresent(owner, {
              source: buildCanvas({ template: 'pid', data, mode: 'import' }),
              css: '',
            }),
          ),
        'test',
      );
      await homeIn(row.id, ws.w);
      return row.id;
    };
    canvasId = await canvas([t.shared, t.hidden]);
    oldCanvasId = await canvas([old.shared, old.hidden]);

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const checksOf = async (login: string, id = canvasId) => {
    const res = await runRoute(login, 'GET', `/api/presents/${id}/checks`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return { text, checks: (JSON.parse(text) as { checks: Checks }).checks };
  };

  /** What a user that does not read the hidden file may learn of it. */
  const onlyItsCount = (text: string, checks: Checks) => {
    expect(text).not.toContain(title.hidden);
    expect(text).not.toContain(t.hidden);
    expect(text).not.toContain(old.hidden);
    const c = checks.circuits[0]!;
    expect(c.counts).toEqual({ checked: 1, no: 0, unsure: 0 });
    expect(c.items.map((i) => i.sheet)).toEqual([title.shared]);
    expect(checks.limits.join(' ')).toMatch(
      /1 of the 2 drawings this canvas names could not be read/,
    );
  };

  it("the owner reads both files' answers (the control)", async () => {
    const { checks } = await checksOf(owner);
    expect(checks.traced).toBe(true);
    const c = checks.circuits[0]!;
    expect(c.circuit).toBe(circuit);
    expect(c.counts).toEqual({ checked: 2, no: 0, unsure: 0 });
    expect(c.items.map((i) => i.sheet)).toEqual([title.shared, title.hidden]);
  });

  it('GET /api/presents/:id/checks: a user who reads the canvas but not a file gets only its count', async () => {
    const { text, checks } = await checksOf(user);
    expect(checks.traced).toBe(true);
    onlyItsCount(text, checks);
  });

  it('present_get with checks: true in a turn of W says the same, and nothing of the hidden table', async () => {
    const builtin = {
      slug: 'present_get',
      name: 'present_get',
      description: 'present_get',
      handler: { kind: 'builtin', ref: 'present_get' },
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      externalAccess: null,
    } as unknown as Tool;
    const r = (await m.withTurnScope(
      { kind: 'assistant', loginId: user, ws: [ws.w], modWs: [] },
      () =>
        tools.dispatchTool(
          builtin,
          { id: canvasId, checks: true },
          {
            caller: tools.turnCaller(),
            ownerId: owner,
            surface: { kind: 'team', loginId: user },
          },
        ),
    )) as { ok: boolean; output?: { image_checks?: Checks }; error?: string };
    expect(r.ok, r.error).toBe(true);
    // The canvas's own data names both tables (the user reads the canvas);
    // the overview says nothing more of the hidden one than its count.
    const checks = r.output!.image_checks!;
    onlyItsCount(JSON.stringify(checks), checks);
    expect(JSON.stringify(r.output)).not.toContain(title.hidden);
  });

  it('a saved canvas with old table ids reads the same answers through the map', async () => {
    const owned = await checksOf(owner, oldCanvasId);
    expect(owned.checks.circuits[0]!.counts).toEqual({ checked: 2, no: 0, unsure: 0 });
    expect(owned.checks.circuits[0]!.items.map((i) => i.sheet)).toEqual([
      title.shared,
      title.hidden,
    ]);
    const { text, checks } = await checksOf(user, oldCanvasId);
    onlyItsCount(text, checks);
  });

  it("dwgSheetsByIds and readCircuitChecks in the user's scope give the readable file only", async () => {
    const { dwgSheetsByIds, readCircuitChecks } = await readOf();
    const scope = { kind: 'assistant' as const, loginId: user, ws: [ws.w], modWs: [] };
    const got = await m.withTurnScope(scope, () => dwgSheetsByIds(owner, [t.shared, t.hidden]));
    expect(got.map((s) => [s.id, s.title])).toEqual([[t.shared, title.shared]]);
    const mapped = await m.withTurnScope(scope, () =>
      dwgSheetsByIds(owner, [old.shared, old.hidden]),
    );
    expect(mapped.map((s) => s.id)).toEqual([t.shared]);
    const all = await m.asSystem(() => dwgSheetsByIds(owner, [t.hidden, t.shared]), 'test');
    expect(all.map((s) => s.id)).toEqual([t.hidden, t.shared]);
    // The answers themselves: a row the scope does not read gives nothing.
    const mine = await m.withTurnScope(scope, () => readCircuitChecks(owner, t.shared, circuit));
    expect(mine).toHaveLength(1);
    expect(
      await m.withTurnScope(scope, () => readCircuitChecks(owner, t.hidden, circuit)),
    ).toBeNull();
  });

  const nodeRead = (id: string) =>
    m.withViewer({ login: user }, () =>
      tools.BUILTIN_TOOLS.find((d) => d.slug === 'node_read')!.handler(
        { node_id: id },
        { ownerId: owner },
      ),
    );

  it('node_read leaves the answers out of a file it reads, and gives nothing of one it does not', async () => {
    const [before] = await x<{ has: boolean }>(
      sql`select data ? 'drawingChecks' as has from nodes where id = ${t.shared}`,
    );
    expect(before!.has).toBe(true);
    const read = await nodeRead(t.shared);
    if (!read.ok) throw new Error(read.error);
    const data = (read.output as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('drawingChecks');
    expect(data).not.toHaveProperty('dwgVerifyRuns');
    expect(data).toHaveProperty('sha256');
    const refused = await nodeRead(t.hidden);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(title.hidden);
  });

  it("an owner's turn files an answer on the write role, keeping updated_at", async () => {
    const store = await storeOf();
    const scope = {
      kind: 'assistant' as const,
      loginId: owner,
      ws: [ws.admin, ws.w],
      modWs: [ws.admin, ws.w],
    };
    const when = async () =>
      (
        await x<{ u: string }>(sql`select updated_at::text as u from nodes where id = ${t.shared}`)
      )[0]!.u;
    const before = await when();
    const sheet = sheetOf(t.shared, title.shared);
    const out = await m.withTurnScope(
      scope,
      async () => {
        const refused = await store.storeRefusal(owner, sheet, { dryRun: true });
        if (refused) return { refused };
        const claimed = await store.claimVerifyRun(
          owner,
          {
            circuit,
            by: 'login:x',
            at: '2026-10-27T10:00:00.000Z',
            sheets: [{ tableId: t.shared, revision: REVISION }],
            readFrom: [t.shared],
          },
          () => null,
        );
        return {
          claimed,
          stored: await store.storeChecks(
            owner,
            sheet,
            circuit,
            answerOf(t.shared, title.shared, 'end:second'),
            null,
            '2026-10-27T10:00:00.000Z',
          ),
        };
      },
      { writes: true },
    );
    expect(out).toEqual({ claimed: null, stored: { stored: 1 } });
    expect(await when()).toBe(before);
    const { readCircuitChecks } = await readOf();
    expect(
      await m.asSystem(() => readCircuitChecks(owner, t.shared, circuit), 'test'),
    ).toHaveLength(2);
  });

  it('a member with no Write on the drawing is refused before any spend', async () => {
    const store = await storeOf();
    const why = await m.withTurnScope(
      { kind: 'assistant', loginId: user, ws: [ws.w], modWs: [] },
      () => store.storeRefusal(owner, sheetOf(t.shared, title.shared), { dryRun: true }),
    );
    expect(why).toMatch(/you may not edit its file/);
  });

  it('a file turned private: every reader refuses at once, and its answers go', async () => {
    const files = await import('@mantle/files');
    const { dwgSheetsByIds } = await readOf();
    const store = await storeOf();
    // Flipped through the one door: the reset strips the keys.
    await m.asSystem(
      async () => files.setIndexingMode({ ownerId: owner, nodeId: t.hidden, mode: 'metadata' }),
      'test',
    );
    const [row] = await x<{ has: boolean }>(
      sql`select data ? ${DWG_ANSWERS_KEY}::text as has from nodes where id = ${t.hidden}`,
    );
    expect(row!.has).toBe(false);
    const { checks } = await checksOf(owner);
    expect(checks.circuits[0]!.items.map((i) => i.sheet)).toEqual([title.shared, title.shared]);
    expect(await m.asSystem(() => dwgSheetsByIds(owner, [t.hidden]), 'test')).toEqual([]);
    expect(
      await m.asSystem(() => store.storeRefusal(owner, sheetOf(t.hidden, title.hidden)), 'test'),
    ).toMatch(/set to stay out of the brain/);
  });
});
