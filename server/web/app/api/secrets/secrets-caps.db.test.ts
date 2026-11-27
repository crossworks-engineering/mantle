/**
 * The caps on the secrets routes (plan page 0f5ce59b), through the real
 * handlers on a migrated scratch brain on workspaces, both checks on (as on
 * a box), each call in the caller's own request scope. Only the caller the
 * gate would answer is stood in.
 *
 *  - every row of GET /api/secrets carries `workspaces`, `hasLink`,
 *    `mayEdit`, `mayManage` and `mayMove`, as a note's row does;
 *  - GET /api/secrets/:id, and the secret a POST or a PATCH answers, carry
 *    the three caps;
 *  - a user of the secret's home with Write off: mayEdit false; with Write
 *    on: mayEdit true, still no manage and no move; the Moderator of its
 *    home: all three;
 *  - a login outside its workspaces lists nothing and gets a 404;
 *  - no response carries a value.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/secrets/secrets-caps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The reader a handler calls: the caller the gate answered.
  ownerCaller: vi.fn(() => h.user),
}));

// The seal itself is @mantle/crypto's (its own tests). Here a stand-in that
// keeps the bytes readable, so the test keeps the lane's shared master key
// (as packages/content/src/secrets.db.test.ts).
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: (plain: string, aad: string) => ({
    ciphertext: Buffer.from(JSON.stringify({ aad, plain })),
    keyVersion: 1,
  }),
  open: (ciphertext: Buffer, aad: string) => {
    const box = JSON.parse(ciphertext.toString()) as { aad: string; plain: string };
    if (box.aad !== aad) throw new Error('sealed for another row');
    return box.plain;
  },
}));

type Json = Record<string, any>;

describe.skipIf(!URL)('the secrets routes carry the caller’s caps', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  let list: typeof import('./route');
  let one: typeof import('./[id]/route');

  const tag = `sc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const VALUE = `${tag}-value-never-in-a-response`;
  const owner = randomUUID();
  const MOD = randomUUID(); // Moderator of W
  const USER = randomUUID(); // a user of W, no Moderator
  const OUT = randomUUID(); // in O only
  const W = randomUUID();
  const O = randomUUID();
  let secret = '';

  /** Run `fn` as `who`, in its own request scope (as the gate enters it). */
  const as = async <T>(who: string, writes: boolean, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.loginScopeFor(who);
    h.user = {
      id: owner,
      email: `${tag}@example.invalid`,
      actor: { id: who, email: `${tag}@example.invalid`, displayName: null, isOwner: false },
    };
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes, drafts: false });
      return fn();
    });
  };
  const answer = async (res: Response) => ({
    status: res.status,
    body: (await res.json()) as Json,
  });
  const getList = (who: string) =>
    as(who, false, async () =>
      answer(await list.GET(new Request('http://brain.test/api/secrets'))),
    );
  const getOne = (who: string, id: string) =>
    as(who, false, async () =>
      answer(
        await one.GET(new Request(`http://brain.test/api/secrets/${id}`), {
          params: Promise.resolve({ id }),
        }),
      ),
    );
  const rowOf = async (who: string) =>
    ((await getList(who)).body.secrets as Json[]).find((r) => r.id === secret);

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'secrets-caps-db-test-secret-at-least-32-characters';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${MOD}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mo'),
      (${USER}, ${`${tag}-u@example.invalid`}, 'x', 'member', 'Una'),
      (${OUT}, ${`${tag}-x@example.invalid`}, 'x', 'member', 'Xan')`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${O}, ${owner}, ${`${tag} O`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${MOD}, ${USER}, ${OUT})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W}, ${MOD}, true), (${W}, ${USER}, false), (${O}, ${OUT}, true)`);
    list = await import('./route');
    one = await import('./[id]/route');
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('POST: the Moderator makes a secret in W and the answer carries its caps', async () => {
    const made = await as(MOD, true, () =>
      m.withCreateHome({ createWs: W, privateWs: null }, async () =>
        answer(
          await list.POST(
            new Request('http://brain.test/api/secrets', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                title: `${tag} deploy env`,
                kind: 'env',
                note: `API_TOKEN=${VALUE}`,
                fields: [{ label: 'user', value: VALUE }],
              }),
            }),
          ),
        ),
      ),
    );
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatchObject({
      kind: 'env',
      hasNote: true,
      fieldCount: 1,
      mayEdit: true,
      mayManage: true,
      mayMove: true,
    });
    expect(JSON.stringify(made.body)).not.toContain(VALUE);
    secret = made.body.secret.id as string;
  });

  it('GET: a user of W with Write off reads it, with no edit, manage or move', async () => {
    const all = await getList(USER);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 1, page: 1 });
    const row = (all.body.secrets as Json[]).find((r) => r.id === secret);
    expect(row).toMatchObject({
      workspaces: [expect.objectContaining({ id: W, name: `${tag} W` })],
      hasLink: false,
      mayEdit: false,
      mayManage: false,
      mayMove: false,
    });
    expect(JSON.stringify(all.body)).not.toContain(VALUE);

    const got = await getOne(USER, secret);
    expect(got.status).toBe(200);
    expect(got.body.secret).toMatchObject({
      id: secret,
      mayEdit: false,
      mayManage: false,
      mayMove: false,
    });
    expect(JSON.stringify(got.body)).not.toContain(VALUE);
  });

  it('GET: the Moderator of its home may edit, manage and move it', async () => {
    const caps = { mayEdit: true, mayManage: true, mayMove: true };
    expect(await rowOf(MOD)).toMatchObject({
      ...caps,
      workspaces: [expect.objectContaining({ id: W })],
    });
    expect((await getOne(MOD, secret)).body.secret).toMatchObject({ id: secret, ...caps });
  });

  it('Write on: the same user may edit, on the list, the item and its own PATCH; still no manage or move', async () => {
    // The Write switch of the home grant, with the item's head held (both
    // ids are this test's own uuids).
    await su(
      sqlTag.raw(`do $$ begin
        perform mantle_lock_heads(array['${secret}']::uuid[], 'update');
        update item_grants set write = true
         where node_id = '${secret}' and workspace_id = '${W}';
      end $$`),
    );
    const caps = { mayEdit: true, mayManage: false, mayMove: false };
    expect(await rowOf(USER)).toMatchObject(caps);
    expect((await getOne(USER, secret)).body.secret).toMatchObject({ id: secret, ...caps });
    const patched = await as(USER, true, async () =>
      answer(
        await one.PATCH(
          new Request(`http://brain.test/api/secrets/${secret}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: `${tag} deploy env 2` }),
          }),
          { params: Promise.resolve({ id: secret }) },
        ),
      ),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.secret).toMatchObject({ title: `${tag} deploy env 2`, ...caps });
    expect(JSON.stringify(patched.body)).not.toContain(VALUE);
  });

  it('a login outside its workspaces lists nothing and gets a 404', async () => {
    const all = await getList(OUT);
    expect(all.body).toMatchObject({ secrets: [], total: 0 });
    expect(await getOne(OUT, secret)).toEqual({ status: 404, body: { error: 'not found' } });
  });
});
