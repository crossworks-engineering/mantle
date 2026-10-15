/**
 * The grant sweep (arch A6, plan v2 page fcc4aee4: no hand-written grant
 * logic). Every answer the A6 move touches, on a real database, for a matrix
 * of logins x workspace kinds x item placements:
 *
 *  - logins: the brain's owner (an Admin user), an Admin user with every
 *    area, an Admin user without the users area, a member who moderates P
 *    and is a plain user of Q, a member who moderates Q and R, a plain user
 *    of Q, a member in no workspace; a public link scope and the system (no
 *    login) where the code reads a scope;
 *  - workspaces: Admin, three shared ones (P, Q, R) and the private
 *    workspace of the P Moderator;
 *  - items: homed in Admin, in P, in R, in the private workspace; granted to
 *    Q with Write on and off; a folder whose grant reaches what is inside
 *    it, with a row "Removed here"; a page that embeds items, with an open
 *    link; apps held by one or two workspaces; a deleted app whose snapshot
 *    names its home.
 *
 * What is recorded, per cell: the Grant Access panel (GET), its previews
 * (add, remove, move), its writes on a fresh item each (add, Write on and
 * off, remove, move home, hand, restore), the list chips and caps (system
 * and the login's scope), the link rules (linkRights, assertMayLink, the
 * serve candidates and a served list check), the member and login apps
 * (launcher, memberApp, the trash), the tree visibility diffs, the scope's
 * edit check (itemWriteRefusalOf), othersCanRead, the scope's search ids and
 * the workspace listing.
 *
 * Recorded on main BEFORE the move (A6_GRANT_RECORD=1 writes
 * __snapshots__/a6-grant-sweep.txt; a normal run only reads it). After the
 * move every cell must answer as recorded, or be a named change
 * (NAMED_CHANGES below, each with its reason), whose new answer is in
 * __snapshots__/a6-grant-sweep-changes.txt.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a6-grant-sweep.db.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const RECORD = process.env.A6_GRANT_RECORD === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP = join(HERE, '__snapshots__', 'a6-grant-sweep.txt');
const CHANGES = join(HERE, '__snapshots__', 'a6-grant-sweep-changes.txt');

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => undefined,
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

/** Cells whose answer changed on purpose, each with its reason. */
const NAMED_CHANGES: Record<string, string> = {};

type Json = Record<string, any>;

// Fixed ids, so a cell reads the same on every run.
const id = (n: number) => `a6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = {
  owner: id(1),
  adminAll: id(2),
  adminNoUsers: id(3),
  modP: id(4),
  modQR: id(5),
  userQ: id(6),
  outsider: id(7),
} as const;
type LoginKey = keyof typeof L;
const LOGINS = Object.keys(L) as LoginKey[];
const W = { P: id(101), Q: id(102), R: id(103) };
const I = {
  nAdmin: id(201),
  nP: id(202),
  nPQw: id(203),
  nPQr: id(204),
  nQP: id(205),
  nR: id(206),
  nPriv: id(207),
  fP: id(208),
  c1: id(209),
  c2: id(210),
  fQ: id(211),
  pg: id(212),
  aP: id(213),
  aQ: id(214),
  aAdmin: id(215),
  gone: id(216),
} as const;
type ItemKey = keyof typeof I;
const SHARE = id(301);

describe.skipIf(!URL)('the A6 grant sweep', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let g: typeof import('@/lib/grants');
  let lw: typeof import('@/lib/list-workspaces');
  let wsLib: typeof import('@/lib/workspaces');
  let rq: typeof import('@/lib/auth/rule-in-query');
  let content: typeof import('@mantle/content');
  let tree: typeof import('@mantle/content/tree');
  let trash: typeof import('@mantle/content/app-trash');
  let tools: typeof import('@mantle/tools');
  let search: typeof import('@mantle/search');

  const names = new Map<string, string>();
  let fresh = 1000;
  const cells: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A value with every known id named, and times blanked. */
  const norm = (v: unknown): unknown => {
    let s = JSON.stringify(v, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val));
    if (s === undefined) return null;
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
      return names.get(u.toLowerCase()) ?? `<uuid:${u.slice(0, 8)}>`;
    });
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>');
    return JSON.parse(s);
  };
  const cell = (key: string, v: unknown) => {
    cells.push(`${key} => ${JSON.stringify(norm(v))}`);
  };
  /** The answer of `fn`, or the refusal it threw (its status and code). */
  const answer = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return { ok: await fn() };
    } catch (err) {
      const e = err as { status?: number; code?: string; name?: string; message?: string };
      return {
        refused: {
          name: e.name,
          status: e.status ?? null,
          code: e.code ?? null,
          message: e.message,
        },
      };
    }
  };

  const callerOf = (who: LoginKey) => {
    const loginId = L[who];
    return who === 'owner' || who === 'adminAll' || who === 'adminNoUsers'
      ? {
          kind: 'admin' as const,
          loginId,
          anchorId: L.owner,
          user: {
            id: L.owner,
            email: `${who}@example.invalid`,
            actor: {
              id: loginId,
              email: `${who}@example.invalid`,
              displayName: who,
              isOwner: who === 'owner',
            },
          },
        }
      : { kind: 'member' as const, loginId, anchorId: L.owner, user: null };
  };
  const asLogin = <T>(who: LoginKey, fn: () => Promise<T>) => m.withViewer({ login: L[who] }, fn);
  /** The grants library as its route runs it: through the one exit. */
  const grantsAs = <T>(fn: () => Promise<T>) => rq.inRuleInQuery(fn);

  /** A node of the owner's brain. */
  const node = async (key: string, nid: string, type: string, title: string, path: string) => {
    names.set(nid, key);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${nid}, ${L.owner}, ${type}::node_type, ${title}, ${path}::ltree)`);
    return nid;
  };
  /** Home `nid` in `ws` (setup). */
  const homeIn = (nid: string, ws: string) =>
    m.withHeads([nid], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${nid}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${nid}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  const grant = (nid: string, ws: string, write = false) =>
    m.withSubtreeHeads(nid, [], async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${nid}, ${ws}, ${write})
                           on conflict (node_id, workspace_id) do update set write = excluded.write`);
    });
  const grantRows = async (nid: string) =>
    x<{ ws: string; write: boolean; home: boolean; via: string | null; excluded: boolean }>(
      sql`select workspace_id::text as ws, write, is_home as home, via_folder_id::text as via, excluded
            from item_grants where node_id = ${nid} order by workspace_id`,
    );
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-09-27T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });
  const app = async (key: string, nid: string, title: string) => {
    await node(key, nid, 'app', title, 'apps');
    await x(sql`insert into apps (node_id, manifest, published_build)
                values (${nid}, '{"description":"x"}'::jsonb, ${green}::jsonb)`);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'a6-grant-sweep-secret-at-least-32-characters';
    m = await import('@mantle/db');
    // The viewer roles are the cluster's (made by the base migrate); the
    // scratch database holds their grants (createMigratedScratchDatabase).
    g = await import('@/lib/grants');
    lw = await import('@/lib/list-workspaces');
    wsLib = await import('@/lib/workspaces');
    rq = await import('@/lib/auth/rule-in-query');
    content = await import('@mantle/content');
    tree = await import('@mantle/content/tree');
    trash = await import('@mantle/content/app-trash');
    tools = await import('@mantle/tools');
    search = await import('@mantle/search');

    for (const [k, v] of Object.entries(L)) names.set(v, `login:${k}`);
    for (const [k, v] of Object.entries(W)) names.set(v, `ws:${k}`);
    const role = (k: LoginKey) =>
      k === 'owner' || k === 'adminAll' || k === 'adminNoUsers' ? 'admin' : 'member';
    for (const k of LOGINS) {
      await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                  values (${L[k]}, ${`a6-${k}@example.invalid`}, 'x', ${k === 'owner'}, ${role(k)}, ${k})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const [adm] = await x<{ id: string }>(
      sql`select id::text as id from workspaces where owner_id = ${L.owner} and is_admin`,
    );
    names.set(adm!.id, 'ws:Admin');
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${W.P}, ${L.owner}, 'Proj'), (${W.Q}, ${L.owner}, 'Quay'), (${W.R}, ${L.owner}, 'Reef')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
        (${adm!.id}, ${L.adminAll}, false), (${adm!.id}, ${L.adminNoUsers}, false),
        (${W.P}, ${L.owner}, true), (${W.P}, ${L.modP}, true),
        (${W.Q}, ${L.modP}, false), (${W.Q}, ${L.modQR}, true), (${W.Q}, ${L.userQ}, false),
        (${W.R}, ${L.modQR}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    await x(sql`update workspace_users set limits = '{"areas":{"users":false}}'::jsonb
                 where workspace_id = ${adm!.id} and login_id = ${L.adminNoUsers}`);
    const [priv] = await x<{ id: string }>(
      sql`select mantle_ws_private_workspace(${L.modP}::uuid)::text as id`,
    );
    names.set(priv!.id, 'ws:privModP');
    // Any other workspace the migration made (a login's own) is named too.
    for (const w of await x<{ id: string; name: string }>(
      sql`select id::text as id, name from workspaces where owner_id = ${L.owner}`,
    )) {
      if (!names.has(w.id)) names.set(w.id, `ws:other(${w.name})`);
    }

    // Items.
    await node('nAdmin', I.nAdmin, 'note', 'admin note', 'notes');
    await node('nP', I.nP, 'note', 'p note', 'notes');
    await homeIn(I.nP, W.P);
    await node('nPQw', I.nPQw, 'note', 'p note q write', 'notes');
    await homeIn(I.nPQw, W.P);
    await grant(I.nPQw, W.Q, true);
    await node('nPQr', I.nPQr, 'note', 'p note q read', 'notes');
    await homeIn(I.nPQr, W.P);
    await grant(I.nPQr, W.Q);
    await node('nQP', I.nQP, 'note', 'q note p read', 'notes');
    await homeIn(I.nQP, W.Q);
    await grant(I.nQP, W.P);
    await node('nR', I.nR, 'note', 'r note', 'notes');
    await homeIn(I.nR, W.R);
    await node('nPriv', I.nPriv, 'note', 'private note', 'notes');
    await homeIn(I.nPriv, priv!.id);
    await node('fP', I.fP, 'branch', 'P folder', 'notes.fp');
    await homeIn(I.fP, W.P);
    await node('c1', I.c1, 'note', 'child one', 'notes.fp');
    await node('c2', I.c2, 'note', 'child two', 'notes.fp');
    await grant(I.fP, W.Q);
    await m.withHeads([I.c2], 'update', async (tx) => {
      await tx.execute(
        sql`select mantle_grant_change('exclude', ${I.c2}::uuid, ${W.Q}::uuid, false, ${L.owner}::uuid)`,
      );
    });
    await node('fQ', I.fQ, 'branch', 'Q folder', 'notes.fq');
    await homeIn(I.fQ, W.Q);
    await grant(I.fQ, W.R);
    await node('pg', I.pg, 'page', 'a page', 'pages');
    await homeIn(I.pg, W.P);
    await grant(I.pg, W.Q);
    await app('aP', I.aP, 'P app');
    await homeIn(I.aP, W.P);
    await grant(I.aP, W.Q, true);
    await app('aQ', I.aQ, 'Q app');
    await homeIn(I.aQ, W.Q);
    await grant(I.aQ, W.P);
    await app('aAdmin', I.aAdmin, 'Admin app');
    await x(sql`insert into node_embeds (from_id, to_id) values
      (${I.pg}, ${I.nR}), (${I.pg}, ${I.nP}), (${I.pg}, ${I.aQ})`);
    names.set(SHARE, 'share:pg');
    await x(sql`insert into shares (id, owner_id, node_id, node_type, token, settings)
      values (${SHARE}, ${L.owner}, ${I.pg}, 'page', 'a6-sweep-link', ${JSON.stringify({ served: [I.nP] })}::jsonb)`);
    // A deleted app: its last snapshot names its home (P).
    names.set(I.gone, 'gone');
    await x(sql`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, code)
      values (${L.owner}, ${I.gone}, 'app', 1, 'pre_delete', 'owner',
              ${JSON.stringify({ meta: { title: 'gone app', homeWs: W.P } })}::jsonb)`);

    // The world, as recorded: memberships and every item's grant rows.
    const members = norm(
      await x(sql`select workspace_id::text as ws, login_id::text as login, moderator, limits
                    from workspace_users u join workspaces w on w.id = u.workspace_id
                   where w.owner_id = ${L.owner}`),
    ) as Json[];
    cell('world members', members.map((r) => JSON.stringify(r)).sort());
    for (const k of Object.keys(I) as ItemKey[]) {
      if (k === 'gone') continue;
      cell(`world grants ${k}`, await grantRows(I[k]));
    }
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const ITEMS = (Object.keys(I) as ItemKey[]).filter((k) => k !== 'gone');
  const ws = () => ({ ...W, Admin: [...names].find(([, v]) => v === 'ws:Admin')![0] });

  it('records the Grant Access panel and its previews', async () => {
    for (const who of LOGINS) {
      const c = callerOf(who);
      for (const k of ITEMS) {
        cell(`grants.get ${who} ${k}`, await answer(() => grantsAs(() => g.getGrants(c, I[k]))));
      }
      for (const k of ['nP', 'nPQw', 'nQP', 'fP', 'aP'] as const) {
        for (const [wk, wid] of Object.entries(ws())) {
          cell(
            `grants.preview ${who} ${k} add=${wk}`,
            await answer(() => grantsAs(() => g.previewGrant(c, I[k], wid, null))),
          );
          cell(
            `grants.preview ${who} ${k} remove=${wk}`,
            await answer(() => grantsAs(() => g.previewGrant(c, I[k], null, wid))),
          );
        }
      }
      for (const [wk, wid] of Object.entries(ws())) {
        cell(
          `grants.movePreview ${who} [nP,nQP,nPQr] to=${wk}`,
          await answer(() =>
            grantsAs(() =>
              g.previewMove(c, { nodeIds: [I.nP, I.nQP, I.nPQr], toWorkspaceId: wid }),
            ),
          ),
        );
      }
      for (const fk of ['fP', 'fQ'] as const) {
        cell(
          `grants.movePreview ${who} [nP,nQP,nAdmin] into=${fk}`,
          await answer(() =>
            grantsAs(() =>
              g.previewMove(c, { nodeIds: [I.nP, I.nQP, I.nAdmin], toFolderId: I[fk] }),
            ),
          ),
        );
      }
    }
  }, 240_000);

  it('records the Grant Access writes, each on a fresh item', async () => {
    const W2 = ws();
    /** A fresh note homed in P, granted to Q (Write as given). */
    const freshNote = async (write: boolean) => {
      const nid = id(++fresh);
      await node(`fresh${fresh}`, nid, 'note', `fresh ${fresh}`, 'notes');
      await homeIn(nid, W.P);
      await grant(nid, W.Q, write);
      return nid;
    };
    /** A fresh folder homed in P granted to Q, with a child: derived Q. */
    const freshFolder = async (excluded: boolean) => {
      const f = id(++fresh);
      await node(`freshF${fresh}`, f, 'branch', `fresh folder ${fresh}`, `notes.ff${fresh}`);
      await homeIn(f, W.P);
      const child = id(++fresh);
      await node(`freshC${fresh}`, child, 'note', `fresh child ${fresh}`, `notes.ff${fresh - 1}`);
      await grant(f, W.Q);
      if (excluded) {
        await m.withHeads([child], 'update', async (tx) => {
          await tx.execute(
            sql`select mantle_grant_change('exclude', ${child}::uuid, ${W.Q}::uuid, false, ${L.owner}::uuid)`,
          );
        });
      }
      return child;
    };
    for (const who of LOGINS) {
      const c = callerOf(who);
      const ops: Array<[string, boolean, (nid: string) => Promise<unknown>]> = [
        ['add R', false, (n) => g.addGrant(c, n, { wsId: W.R })],
        ['add R write', false, (n) => g.addGrant(c, n, { wsId: W.R, write: true })],
        ['add Admin', false, (n) => g.addGrant(c, n, { wsId: W2.Admin })],
        ['write Q on', false, (n) => g.patchGrant(c, n, W.Q, { write: true })],
        ['write Q off', true, (n) => g.patchGrant(c, n, W.Q, { write: false })],
        ['write P off', false, (n) => g.patchGrant(c, n, W.P, { write: false })],
        ['remove Q', false, (n) => g.removeGrant(c, n, W.Q, false)],
        ['remove Q (write)', true, (n) => g.removeGrant(c, n, W.Q, false)],
        ['remove P', false, (n) => g.removeGrant(c, n, W.P, false)],
        ['move to Q', false, (n) => g.moveItems(c, { nodeIds: [n], toWorkspaceId: W.Q })],
        ['move to R', false, (n) => g.moveItems(c, { nodeIds: [n], toWorkspaceId: W.R })],
        [
          'move to R keep P',
          false,
          (n) => g.moveItems(c, { nodeIds: [n], toWorkspaceId: W.R, keepReadableIn: W.P }),
        ],
      ];
      for (const [label, write, op] of ops) {
        const nid = await freshNote(write);
        const res = await answer(() => grantsAs(() => op(nid)));
        cell(`grants.write ${who} ${label}`, { res, rows: await grantRows(nid) });
      }
      const handChild = await freshFolder(false);
      cell(`grants.write ${who} hand Q`, {
        res: await answer(() => grantsAs(() => g.handGrant(c, handChild, W.Q))),
        rows: await grantRows(handChild),
      });
      const exChild = await freshFolder(true);
      cell(`grants.write ${who} restore Q`, {
        res: await answer(() => grantsAs(() => g.restoreGrant(c, exChild, W.Q, false))),
        rows: await grantRows(exChild),
      });
      const placed = await freshNote(false);
      cell(`grants.write ${who} move into fQ`, {
        res: await answer(() =>
          grantsAs(() => g.moveItems(c, { nodeIds: [placed], toFolderId: I.fQ, confirm: true })),
        ),
        rows: await grantRows(placed),
      });
    }
  }, 600_000);

  it('records the list chips and caps', async () => {
    const all = ITEMS.map((k) => I[k]);
    const sorted = (mp: Map<string, unknown>) =>
      Object.fromEntries([...mp].sort(([a], [b]) => (a < b ? -1 : 1)));
    for (const who of LOGINS) {
      cell(`chips.system ${who}`, sorted(await lw.workspaceChips(L.owner, L[who], all)));
      cell(
        `chips.scope ${who}`,
        await answer(async () =>
          sorted(await asLogin(who, () => lw.workspaceChips(L.owner, L[who], all))),
        ),
      );
      cell(
        `caps.scope ${who}`,
        await answer(async () => sorted(await asLogin(who, () => lw.itemCaps(all)))),
      );
    }
    cell(`caps.system`, sorted(await lw.itemCaps(all)));
    cell(
      `caps.link`,
      await answer(async () =>
        sorted(await m.withViewer({ link: { served: [I.nP, I.pg] } }, () => lw.itemCaps(all))),
      ),
    );
  });

  it('records the link rules', async () => {
    const all = ITEMS.map((k) => I[k]);
    const page = { id: I.pg, type: 'page', path: 'pages' };
    const folder = { id: I.fP, type: 'branch', path: 'notes.fp' };
    for (const who of LOGINS) {
      const rights = await content.linkRights(L.owner, L[who], all);
      cell(
        `link.rights ${who}`,
        Object.fromEntries([...rights].sort(([a], [b]) => (a < b ? -1 : 1))),
      );
      for (const k of ITEMS) {
        cell(
          `link.assertMayLink ${who} ${k}`,
          await answer(async () => {
            const r = await content.assertMayLink(L.owner, L[who], I[k]);
            return { edit: r.edit, manage: r.manage, read: r.read };
          }),
        );
      }
      cell(
        `link.candidates ${who} pg`,
        await answer(() => content.listServeCandidates(L.owner, L[who], page)),
      );
      cell(
        `link.candidates ${who} fP`,
        await answer(() => content.listServeCandidates(L.owner, L[who], folder)),
      );
      for (const k of ['nR', 'nP', 'aQ'] as const) {
        cell(
          `link.checkServe ${who} pg +${k}`,
          await answer(() => content.checkServeList(L.owner, L[who], page, [I[k]], [])),
        );
      }
      for (const k of ['c1', 'c2'] as const) {
        cell(
          `link.checkServe ${who} fP +${k}`,
          await answer(() => content.checkServeList(L.owner, L[who], folder, [I[k]], [])),
        );
      }
    }
  });

  it('records the member and login apps', async () => {
    const W2 = ws();
    for (const who of LOGINS) {
      const author = { loginId: L[who], brainId: L.owner };
      cell(
        `apps.launcher ${who}`,
        await answer(() => asLogin(who, () => content.listMemberApps(L.owner))),
      );
      for (const [wk, wid] of Object.entries(W2)) {
        cell(
          `apps.launcher ${who} ws=${wk}`,
          await answer(() => asLogin(who, () => content.listMemberApps(L.owner, { ws: wid }))),
        );
      }
      for (const k of ['aP', 'aQ', 'aAdmin'] as const) {
        for (const o of [{}, { write: true }, { manage: true }, { edit: true }]) {
          cell(
            `apps.memberApp ${who} ${k} ${JSON.stringify(o)}`,
            await answer(() => content.memberApp(author, I[k], o)),
          );
        }
      }
      cell(`apps.loginApps ${who}`, await answer(() => content.listLoginApps(author)));
      cell(`apps.deleted ${who}`, await answer(() => content.listDeletedMemberApps(author)));
    }
    cell(`apps.deletedHomes`, await trash.deletedAppHomes(L.owner));
  });

  it('records the tree visibility diffs', async () => {
    const run = (label: string, fn: () => Promise<unknown>) => async (scope: string) =>
      cell(`tree.${label} ${scope}`, await answer(fn));
    const diffs: Array<[string, () => Promise<unknown>]> = [
      [
        'moveItems [nP,nQP,nPQr,nR]->fP',
        () => tree.moveItemsDiff(L.owner, 'notes', [I.nP, I.nQP, I.nPQr, I.nR], 'notes.fp'),
      ],
      [
        'moveItems [nP,nQP,nAdmin]->fQ',
        () => tree.moveItemsDiff(L.owner, 'notes', [I.nP, I.nQP, I.nAdmin], 'notes.fq'),
      ],
      [
        'moveItems [c1,c2]->root',
        () => tree.moveItemsDiff(L.owner, 'notes', [I.c1, I.c2], 'notes'),
      ],
      [
        'moveFolder fP->fQ',
        () => tree.moveFolderDiff(L.owner, { id: I.fP, path: 'notes.fp' }, 'notes.fq'),
      ],
      [
        'moveFolder fQ->fP',
        () => tree.moveFolderDiff(L.owner, { id: I.fQ, path: 'notes.fq' }, 'notes.fp'),
      ],
      ['lift fP', () => tree.liftDiff(L.owner, { id: I.fP, path: 'notes.fp' })],
      ['newItem fP', () => tree.newItemDiff(m.db, L.owner, 'notes', 'notes.fp', 'new')],
      ['newItem fQ', () => tree.newItemDiff(m.db, L.owner, 'notes', 'notes.fq', 'new')],
    ];
    for (const [label, fn] of diffs) {
      await run(label, fn)('system');
      for (const who of LOGINS) await run(label, () => asLogin(who, fn))(who);
    }
  });

  it('records the scope edit check, othersCanRead, the search ids and the workspace list', async () => {
    const all = ITEMS.map((k) => I[k]);
    for (const who of LOGINS) {
      for (const need of ['read', 'edit', 'manage'] as const) {
        const out: Record<string, unknown> = {};
        for (const k of ITEMS) {
          out[k] = await asLogin(who, () => m.itemWriteRefusalOf([I[k]], need));
        }
        cell(`refusal.${need} ${who}`, out);
      }
      cell(
        `search.scopeIds ${who}`,
        await answer(async () =>
          (
            (await asLogin(who, () =>
              m.db.execute(sql`select unnest(${search.scopeNodeIds(L.owner)})::text as id`),
            )) as unknown as { id: string }[]
          )
            .map((r) => names.get(r.id) ?? r.id)
            .sort(),
        ),
      );
      cell(
        `workspaces.list ${who}`,
        await answer(() => grantsAs(() => wsLib.listWorkspaces(callerOf(who)))),
      );
    }
    const others: Record<string, boolean> = {};
    for (const k of ITEMS) others[k] = await tools.othersCanRead(L.owner, I[k]);
    cell('othersCanRead', others);
    void all;
  });

  it('answers as recorded on main, or as a named change', () => {
    const text = `${cells.join('\n')}\n`;
    if (RECORD) {
      writeFileSync(SNAP, text);
      return;
    }
    expect(existsSync(SNAP)).toBe(true);
    const want = new Map(
      readFileSync(SNAP, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf(' => ')), l.slice(l.indexOf(' => ') + 4)]),
    );
    const got = new Map(
      cells.map((l) => [l.slice(0, l.indexOf(' => ')), l.slice(l.indexOf(' => ') + 4)]),
    );
    expect([...got.keys()]).toEqual([...want.keys()]);
    const changed: string[] = [];
    const unnamed: string[] = [];
    for (const [k, v] of got) {
      if (want.get(k) === v) continue;
      if (NAMED_CHANGES[k]) changed.push(`${k} => ${v}\n  # ${NAMED_CHANGES[k]}`);
      else unnamed.push(`${k}\n  main: ${want.get(k)}\n  now:  ${v}`);
    }
    if (process.env.A6_GRANT_CHANGES === '1') {
      writeFileSync(
        CHANGES,
        `# A6 named changes: the cell after the move, and why\n${changed.join('\n')}\n`,
      );
    }
    expect(unnamed).toEqual([]);
    const stale = Object.keys(NAMED_CHANGES).filter((k) => want.get(k) === got.get(k));
    expect(stale).toEqual([]);
  });
});
