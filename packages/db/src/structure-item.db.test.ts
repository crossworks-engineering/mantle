/**
 * The structure item definer (migration 0315, gateway/structure-item.ts,
 * plan v3.2 S7b part b2): on an Admin area's narrow exit the Secrets root,
 * a secret, a peer, a contact, a documentation item and its folders are
 * made, edited and removed by mantle_structure_item, and each answer equals
 * the app's own statements on the full route (the five full-route spots
 * they replace): the row, its create home and readers (home_ws, read_ws,
 * write_ws), the index reset. Refused: an unlisted kind or operation, a
 * place the kind does not land at, the write role and the user role, no or
 * another acting login, a login without the kind's area, a scope.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureAdminUsers, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0315: the structure items on the narrow route', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let rr: typeof import('./runtime-role');
  let v: typeof import('./viewer');
  let m: typeof import('./index');
  let pools: typeof import('./gateway/pools');
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let wr: ReturnType<typeof postgres>;
  let ur: ReturnType<typeof postgres>;
  let brain = '';
  const admin = randomUUID();
  /** An Admin workspace member whose areas take keys away. */
  const noKeys = randomUUID();
  /** A login in no Admin workspace. */
  const plain = randomUUID();
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    for (const [id, role] of [
      [admin, 'admin'],
      [noKeys, 'admin'],
      [plain, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`${id}@example.test`}, 'x', ${role})`;
    }
    const ws = await ensureAdminUsers(su, [admin, noKeys]);
    await su`update workspace_users set limits = '{"areas": {"keys": "false"}}'::jsonb
              where workspace_id = ${ws} and login_id = ${noKeys}`;
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    // The narrow route whatever the run's switch (the switch-off run too):
    // the cells are about it. The test setup gives the narrow role its login.
    rr.setNarrowSystemForTests(true);
    v = await import('./viewer');
    m = await import('./index');
    pools = await import('./gateway/pools');
    const opts = { max: 1, prepare: false, onnotice: () => {} } as const;
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      opts,
    );
    wr = postgres(
      v.viewerDatabaseUrl(scratch.url, 'write', v.viewerRolePassword(KEY(), 'write')),
      opts,
    );
    ur = postgres(
      v.viewerDatabaseUrl(scratch.url, 'user', v.viewerRolePassword(KEY(), 'user')),
      opts,
    );
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    for (const c of [nl, wr, ur, su]) await c?.end();
    await scratch?.drop();
  });

  /** `fn` in the Admin area's request exit of `login`: the narrow route. */
  const exit = <T>(fn: () => Promise<T>, login = admin) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(login, 'rw'));
      m.noteRequestSystem('area');
      return fn();
    });
  /** The same, with `fn` on the full route, keeping the exit's actor (the
   *  app's own statements, as the spots ran them). */
  const exitFull = <T>(fn: () => Promise<T>) => exit(() => v.onFullSystemRoute('profile-row', fn));

  /** A row as the database holds it, less what differs per row. */
  const rowOf = async (id: string, drop: string[] = []) => {
    const [r] = await su<{ r: Record<string, unknown> }[]>`
      select to_jsonb(n) - ${['id', 'created_at', 'updated_at', ...drop]}::text[] as r
        from nodes n where n.id = ${id}`;
    return r?.r ?? null;
  };

  it('each listed kind made on the narrow route equals the full route: row, home, readers', async () => {
    expect(await exit(async () => pools.narrowRouteNow())).toBe(true);
    expect(await exitFull(async () => pools.narrowRouteNow())).toBe(false);
    const [grant] = await su<{ ins: boolean }[]>`
      select has_table_privilege('mantle_system_narrow', 'public.nodes', 'INSERT') as ins`;
    expect(grant!.ins).toBe(false);

    // The roots: made once on the narrow route, then a no-op on both.
    const rootValues = {
      ownerId: brain,
      title: 'Secrets',
      slug: 'secrets',
      path: 'secrets',
      data: { description: 'd' },
    };
    const root = await exit(() => m.insertStructureItem('secrets-root', rootValues));
    expect(root?.path).toBe('secrets');
    expect(await exit(() => m.insertStructureItem('secrets-root', rootValues))).toBeNull();
    expect(await exitFull(() => m.insertStructureItem('secrets-root', rootValues))).toBeNull();
    const docsRoot = await exit(() =>
      m.insertStructureItem('docs-folder', {
        ownerId: brain,
        title: 'Documentation',
        slug: null,
        path: 'documentation',
        data: { description: '', slug: 'documentation' },
      }),
    );
    expect(docsRoot?.type).toBe('branch');

    const cases = [
      ['secret-item', { title: 's', path: 'secrets', data: { kind: 'token' }, tags: ['a'] }, []],
      ['peer-item', { title: 'p', path: 'peers', data: { base_url: 'https://x.test' } }, []],
      [
        'contact-item',
        { title: 'c', path: 'contacts', data: { emails: ['a@b.test'] }, tags: [] },
        [],
      ],
      [
        'docs-item',
        {
          title: 'd.md',
          slug: null,
          path: 'documentation',
          data: { content: 'x' },
          tags: ['documentation'],
        },
        [],
      ],
      ['docs-folder', { title: 'a', slug: null, path: 'documentation.a', data: {} }, ['path']],
    ] as const;
    for (const [kind, values, drop] of cases) {
      const narrow = await exit(() =>
        m.insertStructureItem(kind, { ownerId: brain, ...values } as never),
      );
      const full = await exitFull(() =>
        m.insertStructureItem(kind, {
          ownerId: brain,
          ...values,
          ...(kind === 'docs-folder' ? { path: 'documentation.b' } : {}),
        } as never),
      );
      expect(narrow, kind).not.toBeNull();
      expect(full, kind).not.toBeNull();
      const a = await rowOf(narrow!.id, [...drop]);
      const b = await rowOf(full!.id, [...drop]);
      expect(a, kind).toEqual(b);
      expect(a!.type, kind).toBe(m.STRUCTURE_KINDS[kind]);
    }
  });

  it("a secret's sealed row in the definer's transaction; edit and remove equal the full route", async () => {
    const make = (run: typeof exit) =>
      run(() =>
        m.insertStructureItem(
          'secret-item',
          {
            ownerId: brain,
            title: 'k',
            path: 'secrets',
            data: { description: 'old' },
            tags: ['t'],
          },
          async (tx, row) => {
            await tx.insert(m.secrets).values({
              nodeId: row.id,
              ciphertext: Buffer.from('sealed'),
              keyVersion: 1,
            });
          },
        ),
      );
    const a = (await make(exit))!;
    const b = (await make(exitFull))!;
    for (const id of [a.id, b.id]) {
      expect((await su`select 1 from secrets where node_id = ${id}`).length).toBe(1);
      // A summary and a vector stamp the extract reset drops.
      await su`update nodes set data = data || '{"summary": "s", "entities": [1], "index_work": "embed",
                                                  "index_work_had_vector": true}'::jsonb
                where id = ${id}`;
    }
    const set = { title: 'k2', tags: ['t', 'u'], data: { description: 'new', kind: 'token' } };
    const changed = ['title', 'description', 'tags'];
    const ua = await exit(() => m.updateStructureItem('secret-item', brain, a.id, set, changed));
    const ub = await exitFull(() =>
      m.updateStructureItem('secret-item', brain, b.id, set, changed),
    );
    expect(ua?.id).toBe(a.id);
    expect(ub?.id).toBe(b.id);
    const ra = await rowOf(a.id);
    expect(ra).toEqual(await rowOf(b.id));
    expect(ra!.data).toEqual({ description: 'new', kind: 'token', index_work: 'extract' });
    expect(ra!.embedding).toBeNull();
    // An edit of nothing that feeds the index resets nothing, on both.
    const quiet = { data: { description: 'new', kind: 'token', x: 1 } };
    await exit(() => m.updateStructureItem('secret-item', brain, a.id, quiet, ['sealed']));
    await exitFull(() => m.updateStructureItem('secret-item', brain, b.id, quiet, ['sealed']));
    expect(await rowOf(a.id)).toEqual(await rowOf(b.id));
    // No such item: null on both.
    const none = randomUUID();
    expect(
      await exit(() => m.updateStructureItem('secret-item', brain, none, set, changed)),
    ).toBeNull();
    expect(
      await exitFull(() => m.updateStructureItem('secret-item', brain, none, set, changed)),
    ).toBeNull();
    // Remove: the item and (by its foreign key) the sealed row; an id of
    // another type is left alone on both.
    const peer = (await exit(() =>
      m.insertStructureItem('peer-item', { ownerId: brain, title: 'p2', path: 'peers' }),
    ))!;
    expect(await exit(() => m.deleteStructureItems('secret-item', brain, [a.id, peer.id]))).toEqual(
      [a.id],
    );
    expect(
      await exitFull(() => m.deleteStructureItems('secret-item', brain, [b.id, peer.id])),
    ).toEqual([b.id]);
    for (const id of [a.id, b.id]) {
      expect((await su`select 1 from nodes where id = ${id}`).length).toBe(0);
      expect((await su`select 1 from secrets where node_id = ${id}`).length).toBe(0);
    }
    expect(await exit(() => m.deleteStructureItems('peer-item', brain, [peer.id]))).toEqual([
      peer.id,
    ]);
  });

  it("a calendar's synced events removed on the narrow route as on the full route; another event left", async () => {
    const acct = randomUUID();
    const ev = () => randomUUID();
    const [s1, s2, own] = [ev(), ev(), ev()];
    await su`insert into nodes (id, owner_id, type, title, path, data) values
      (${s1}, ${brain}, 'event', 'synced 1', 'events', ${su.json({ external_account_id: acct })}),
      (${s2}, ${brain}, 'event', 'synced 2', 'events', ${su.json({ external_account_id: acct })}),
      (${own}, ${brain}, 'event', 'made by hand', 'events', '{}'::jsonb)`;
    // The narrow route removes a synced event and leaves one made by hand,
    // though both are named; the full route (the app's own delete) removes
    // what it is given, as before.
    expect(await exit(() => m.deleteStructureItems('calendar-event', brain, [s1, own]))).toEqual([
      s1,
    ]);
    expect((await su`select id from nodes where id in (${s1}, ${own})`).map((r) => r.id)).toEqual([
      own,
    ]);
    expect(await exitFull(() => m.deleteStructureItems('calendar-event', brain, [s2]))).toEqual([
      s2,
    ]);
    // The area is connectors: a login with keys taken away still holds it;
    // a login in no Admin workspace does not.
    expect(await call(su, def('calendar-event', 'delete', noKeys), [acting(noKeys)])).toBe('ok');
    expect(await call(su, def('calendar-event', 'delete', plain), [acting(plain)])).toMatch(
      /^42501: .*does not hold the area/,
    );
    expect(await call(su, def('calendar-event', 'insert', admin), [acting(admin)])).toMatch(
      /^42501: .*not an operation of this kind/,
    );
  });

  /** The definer sent raw on `on` in a transaction that rolls back, after
   *  `pre`: 'ok' or 'code: message'. */
  const call = async (on: ReturnType<typeof postgres>, text: string, pre: string[] = []) =>
    on
      .begin(async (t) => {
        for (const p of pre) await t.unsafe(p);
        await t.unsafe(text);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (err: { ok?: boolean; code?: string; message?: string }) =>
          err.ok ? 'ok' : `${err.code}: ${err.message}`,
      );
  const acting = (login: string) => `select set_config('mantle.acting_login', '${login}', true)`;
  const def = (kind: string, op: string, login: string, path = 'secrets', owner = brain) =>
    `select * from public.mantle_structure_item('${kind}', '${op}', '${login}'::uuid,
       '${owner}'::uuid, ${op === 'insert' ? 'null' : `'{${randomUUID()}}'::uuid[]`},
       '{"title": "x", "path": "${path}", "data": {}}'::jsonb)`;

  it('refused: an unlisted kind or operation, another place, another brain', async () => {
    const pre = [acting(admin)];
    expect(await call(nl, def('secret-item', 'insert', admin), pre)).toBe('ok');
    expect(await call(nl, def('note', 'insert', admin, 'notes'), pre)).toMatch(
      /^42501: .*not a listed kind/,
    );
    expect(await call(nl, def('branch', 'insert', admin), pre)).toMatch(
      /^42501: .*not a listed kind/,
    );
    expect(await call(nl, def('contact-item', 'delete', admin), pre)).toMatch(
      /^42501: .*not an operation of this kind/,
    );
    expect(await call(nl, def('secrets-root', 'update', admin), pre)).toMatch(
      /^42501: .*not an operation of this kind/,
    );
    expect(await call(nl, def('secret-item', 'insert', admin, 'notes'), pre)).toMatch(
      /^42501: .*not where this kind lands/,
    );
    expect(await call(nl, def('docs-item', 'insert', admin, 'notes'), pre)).toMatch(
      /^42501: .*not where this kind lands/,
    );
    expect(await call(nl, def('peer-item', 'insert', admin, 'secrets'), pre)).toMatch(
      /^42501: .*not where this kind lands/,
    );
    expect(
      await call(nl, def('secret-item', 'insert', admin, 'secrets', randomUUID()), pre),
    ).toMatch(/^42501: .*only on this brain/);
    expect(
      await call(nl, `${def('secret-item', 'insert', admin)}`, [
        ...pre,
        "select set_config('mantle.write_mode', 'ro', true)",
      ]),
    ).toMatch(/^42501: .*read-only caller/);
  });

  it('refused: no or another acting login, a login without the area, a scope', async () => {
    for (const [who, on] of [
      ['the narrow login', nl],
      ['the superuser', su],
    ] as const) {
      expect(await call(on, def('secret-item', 'insert', admin)), `${who}, none`).toMatch(
        /^42501: .*only the acting login/,
      );
      expect(
        await call(on, def('secret-item', 'insert', admin), [acting(plain)]),
        `${who}, another`,
      ).toMatch(/^42501: .*only the acting login/);
      expect(
        await call(on, def('secret-item', 'insert', admin), [acting(admin)]),
        `${who}, its own`,
      ).toBe('ok');
      // Not in the Admin workspace; in it with keys taken away (connectors kept).
      expect(
        await call(on, def('secret-item', 'insert', plain), [acting(plain)]),
        `${who}, plain`,
      ).toMatch(/^42501: .*does not hold the area/);
      expect(
        await call(on, def('secret-item', 'insert', noKeys), [acting(noKeys)]),
        `${who}, no keys`,
      ).toMatch(/^42501: .*does not hold the area/);
      expect(
        await call(on, def('peer-item', 'insert', noKeys, 'peers'), [acting(noKeys)]),
        `${who}, connectors`,
      ).toBe('ok');
      expect(
        await call(on, def('secret-item', 'insert', admin), [
          acting(admin),
          `select set_config('mantle.scope_login', '${admin}', true)`,
        ]),
        `${who}, a scope login`,
      ).toMatch(/^42501: .*only with no scope/);
    }
    // Through the gateway: an exit of a login without the area.
    const err = await exit(
      () => m.insertStructureItem('secret-item', { ownerId: brain, title: 'x', path: 'secrets' }),
      noKeys,
    ).then(
      () => null,
      (e: { code?: string; cause?: { code?: string; message?: string }; message?: string }) => e,
    );
    expect(err?.code ?? err?.cause?.code).toBe('42501');
    expect(`${err?.message} ${err?.cause?.message}`).toMatch(/does not hold the area/);
  });

  it('refused: the write role and the user role (no EXECUTE), even with no scope and the acting login', async () => {
    const clear = [
      `select set_config('mantle.ws', '', true), set_config('mantle.scope_login', '', true),
              set_config('mantle.login_id', '', true)`,
      acting(admin),
    ];
    for (const [who, on, name] of [
      ['the write role', wr, 'mantle_write_user'],
      ['the user role', ur, null],
    ] as const) {
      if (name) {
        const [me] = await on.unsafe<{ s: string }[]>('select session_user::text as s');
        expect(me!.s).toBe(name);
      }
      expect(await call(on, def('secret-item', 'insert', admin), clear), who).toMatch(
        /^42501: permission denied for function mantle_structure_item/,
      );
    }
    const [g] = await su<{ w: boolean; u: boolean; n: boolean; p: boolean }[]>`
      select has_function_privilege('mantle_write_user', p.oid, 'EXECUTE') as w,
             has_function_privilege(${v.viewerRoleName('user')}, p.oid, 'EXECUTE') as u,
             has_function_privilege('mantle_system_narrow', p.oid, 'EXECUTE') as n,
             has_function_privilege('public', p.oid, 'EXECUTE') as p
        from pg_proc p where p.proname = 'mantle_structure_item'`;
    expect(g).toEqual({ w: false, u: false, n: true, p: false });
  });
});
