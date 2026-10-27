/**
 * The image check overview of a traced P&ID canvas (DWG bones phase 6 v2)
 * reads its drawing tables with the viewer's rights, on one migrated
 * scratch database switched to workspaces, actor check and edit check on:
 *
 *  - a plain user of W reads the canvas (homed in W) and one of the two
 *    drawing tables it names (homed in W); the other is homed in Admin;
 *  - GET /api/presents/:id/checks (runRoute: the full pipeline) and
 *    present_get with `checks: true` (an assistant turn of W) give that
 *    user the readable table's answer and only the COUNT of the one it
 *    does not read: no row, no title, no id of it;
 *  - dwgTablesByIds in that user's scope returns the readable table only;
 *  - the owner, who reads both, gets both answers (the control).
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

describe.skipIf(!URL)('the image check overview reads drawing tables as the viewer', () => {
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
  const t = { shared: '', hidden: '' };
  const title = { shared: `${tag} PID-SHARED`, hidden: `${tag} PID-HIDDEN` };
  let canvasId = '';
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

  /** A drawing table with one sealed circuit_verify answer of `circuit`
   *  at its current revision, made as the system. */
  const drawingTable = async (name: string) => {
    const c = await import('@mantle/content');
    const store = await import('../../../packages/tools/src/circuit-trace/checks-store');
    const made = await m.asSystem(
      () =>
        m.withCreateHome({ createWs: ws.admin, privateWs: null, quiet: true }, async () => {
          const table = await c.createTable(owner, {
            title: name,
            tags: ['auto-import'],
            sourceFileId: randomUUID(),
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
          const sheet = {
            tableId: table.id,
            title: name,
            sourceFileId: randomUUID(),
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
          };
          const stored = await store.storeChecks(
            owner,
            sheet,
            circuit,
            [
              {
                q: {
                  id: 'q1',
                  key: `end:${name}`,
                  kind: 'end',
                  tableId: table.id,
                  sheet: name,
                  sourceFileId: sheet.sourceFileId,
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
            ] as never,
            null,
            '2026-10-27T09:00:00.000Z',
          );
          expect(stored).toEqual({ stored: 1 });
          return table.id;
        }),
      'test',
    );
    return made;
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
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${user}, false)`);

    t.shared = await drawingTable(title.shared);
    t.hidden = await drawingTable(title.hidden);
    await homeIn(t.shared, ws.w);
    await homeIn(t.hidden, ws.admin);

    const { buildCanvas } = await import('@mantle/diagram-templates');
    const { createPresent } = await import('@mantle/content/presents');
    const data = {
      template: 'pid',
      title: `Circuit ${circuit}`,
      trace: { circuit, tables: [t.shared, t.hidden] },
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
    canvasId = row.id;
    await homeIn(canvasId, ws.w);

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

  const checksOf = async (login: string) => {
    const res = await runRoute(login, 'GET', `/api/presents/${canvasId}/checks`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return { text, checks: (JSON.parse(text) as { checks: Checks }).checks };
  };

  /** What a user that does not read the hidden table may learn of it. */
  const onlyItsCount = (text: string, checks: Checks) => {
    expect(text).not.toContain(title.hidden);
    expect(text).not.toContain(t.hidden);
    const c = checks.circuits[0]!;
    expect(c.counts).toEqual({ checked: 1, no: 0, unsure: 0 });
    expect(c.items.map((i) => i.sheet)).toEqual([title.shared]);
    expect(checks.limits.join(' ')).toMatch(
      /1 of the drawing's 2 drawing tables could not be read/,
    );
  };

  it("the owner reads both tables' answers (the control)", async () => {
    const { checks } = await checksOf(owner);
    expect(checks.traced).toBe(true);
    const c = checks.circuits[0]!;
    expect(c.circuit).toBe(circuit);
    expect(c.counts).toEqual({ checked: 2, no: 0, unsure: 0 });
    expect(c.items.map((i) => i.sheet)).toEqual([title.shared, title.hidden]);
  });

  it('GET /api/presents/:id/checks: a user who reads the canvas but not a table gets only its count', async () => {
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
    const checks = r.output!.image_checks!;
    onlyItsCount(JSON.stringify(r.output), checks);
  });

  it("dwgTablesByIds in the user's scope returns the readable table only", async () => {
    const { dwgTablesByIds } = await import('../../../packages/tools/src/circuit-trace/read');
    const got = await m.withTurnScope(
      { kind: 'assistant', loginId: user, ws: [ws.w], modWs: [] },
      () => dwgTablesByIds(owner, [t.shared, t.hidden]),
    );
    expect(got.map((x) => [x.id, x.title])).toEqual([[t.shared, title.shared]]);
    const all = await m.asSystem(() => dwgTablesByIds(owner, [t.hidden, t.shared]), 'test');
    expect(all.map((x) => x.id)).toEqual([t.hidden, t.shared]);
  });
});
