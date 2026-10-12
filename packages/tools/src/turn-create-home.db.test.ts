/**
 * Where a create from an assistant turn lands (workspaces arch A0, F12), on
 * a scratch brain the workspaces migration made live, through dispatchTool
 * in a turn scope as the tool loop runs it:
 *
 *  - a workspace assistant's turn, for a login that moderates the
 *    workspace: the workspace;
 *  - the same turn for a login that only reads it: the login's private
 *    workspace (no folder named);
 *  - the Admin assistant's turn for an Admin user: Admin, as before.
 *
 * Before A0 a turn named no home, so the first two landed in Admin.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/turn-create-home.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('assistant turn creates follow the home rule (A0)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('./index');
  const owner = randomUUID();
  const mod = randomUUID(); // a Moderator of Team
  const reader = randomUUID(); // a user of Team, no Moderator
  const tag = `tch${randomUUID().slice(0, 6)}`;
  let team = '';
  let admin = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const noteCreate = {
    slug: 'note_create',
    name: 'note_create',
    description: 'note_create',
    handler: { kind: 'builtin', ref: 'note_create' },
    inputSchema: { type: 'object', properties: {} },
    requiresConfirm: false,
    externalAccess: null,
  } as unknown as Tool;

  /** Make a note from a turn of `ws` that answers `login`; its home. */
  const createIn = async (ws: string, login: string, modWs: string[]) => {
    const title = `${tag} ${randomUUID().slice(0, 8)}`;
    const res = await m.withTurnScope(
      { kind: 'assistant', loginId: login, ws: [ws], modWs },
      () =>
        tools.dispatchTool(
          noteCreate,
          { title, content: 'x' },
          {
            ownerId: owner,
            surface:
              ws === admin ? { kind: 'web', loginId: login } : { kind: 'team', loginId: login },
          },
        ),
      { writes: true },
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    const rows = await x<{ home: string | null }>(sql`
      select g.workspace_id::text as home from nodes n
        join item_grants g on g.node_id = n.id and g.is_home
       where n.title = ${title}`);
    return rows[0]?.home ?? null;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin'),
      (${mod}, ${`${tag}-m@example.invalid`}, 'x', false, 'member'),
      (${reader}, ${`${tag}-r@example.invalid`}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const wsRows = await x<{ id: string; key: string }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = wsRows.find((r) => r.key === 'team')!.id;
    admin = wsRows.find((r) => r.key === 'admin')!.id;
    await x(sql`update workspace_users set moderator = (login_id = ${mod})
                 where workspace_id = ${team} and login_id in (${mod}, ${reader})`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it("a Moderator's create in a workspace turn lands in that workspace", async () => {
    expect(await createIn(team, mod, [team])).toBe(team);
  });

  it("a reader's create in a workspace turn lands in its private workspace", async () => {
    const home = await createIn(team, reader, []);
    const own = await x<{ ws: string }>(sql`
      select workspace_id::text as ws from private_workspaces where login_id = ${reader}`);
    expect(own[0]?.ws).toBeTruthy();
    expect(home).toBe(own[0]!.ws);
  });

  it("an Admin user's create in the Admin assistant's turn lands in Admin", async () => {
    expect(await createIn(admin, owner, [admin])).toBe(admin);
  });
});
