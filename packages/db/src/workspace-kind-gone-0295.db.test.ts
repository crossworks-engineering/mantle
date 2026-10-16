/**
 * 0295 (workspaces arch A7): mantle_workspace_kind goes. On a scratch
 * database migrated to just before it, then through it:
 *
 *  - the function is gone and no function body names it;
 *  - every rule that called it answers as before: mantle_team_reads over
 *    every kind and level (the bridge of the manual switch), the three
 *    nodes level CHECKs (the same kinds, NOT VALID: no scan of nodes under
 *    the lock, and a write breaking the rule is still refused), and
 *    the contact share check (the registry's contactShare kinds, the old
 *    list without folders);
 *  - every list written in its place is the old list, nothing wider: no
 *    task, event or Recall map (they joined the workspace class in A1,
 *    never the tier model);
 *  - re-runnable: a second run changes nothing;
 *  - the operator's manual switch of a box that reports "clients present"
 *    still runs after it (mantle_ws_migrate_locked with
 *    mantle.ws_former_clients = 'reviewed'), while the boot step skips it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspace-kind-gone-0295.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kindsWhere, type ContactShareKind } from '@mantle/client-types/kinds';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0295_a7_workspace_kind_gone';
/** The functions 0295 writes again, each with the list in its body. */
const REWRITTEN = [
  'mantle_contact_share_check',
  'mantle_embedded_level',
  'mantle_inherited_level',
  'mantle_nodes_inherit_trg',
  'mantle_open_embedded',
  'mantle_team_reads',
  'mantle_ws_reach_diff',
];
const CHECKS = ['nodes_audience_kind_ck', 'nodes_embedded_level_ck', 'nodes_inherited_level_ck'];

/** The kind names of every `IN ('page', ...)` list in `text` that names a
 *  page (the lists 0295 wrote), each sorted. */
function kindLists(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/(?:IN \(|ARRAY\[)((?:'[a-z_]+'(?:::[a-z_."]+)?(?:, )?)+)[)\]]/g)) {
    const names = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((n) => n[1]!);
    if (names.includes('page')) out.push(names.sort());
  }
  return out;
}

describe.skipIf(!URL)('0295: mantle_workspace_kind goes, every rule that read it unchanged', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  let oldKinds: string[] = [];
  let teamReadsBefore = '';
  let validBefore: Record<string, boolean> = {};

  const statements = () =>
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
  /** mantle_team_reads over every kind and every level it reads. */
  const teamReads = async () =>
    JSON.stringify(
      await sql`
        select t::text as t, a, i, e, mantle_team_reads(t, a, i, e) as r
          from unnest(enum_range(null::node_type)) t,
               unnest(array['admin', 'team', 'client', 'public', null]) a,
               unnest(array['team', 'client', null]) i,
               unnest(array['team', 'client', 'public', null]) e
         order by 1, 2, 3, 4`,
    );
  const valid = async () =>
    Object.fromEntries(
      (
        await sql<{ name: string; valid: boolean }[]>`
          select conname as name, convalidated as valid from pg_constraint
           where conrelid = 'public.nodes'::regclass and conname = any(${CHECKS})`
      ).map((r) => [r.name, r.valid]),
    );
  const bodies = async () =>
    (
      await sql<{ name: string; src: string }[]>`
        select p.proname as name, pg_get_functiondef(p.oid) as src from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = any(${REWRITTEN})
         order by 1`
    ).map((r) => `${r.name}\n${r.src}`);
  const checkDefs = async () =>
    (
      await sql<{ name: string; def: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'public.nodes'::regclass and conname = any(${CHECKS}) order by 1`
    ).map((r) => `${r.name} ${r.def}`);

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    oldKinds = (
      await sql<{ t: string }[]>`
        select t::text as t from unnest(enum_range(null::node_type)) t
         where mantle_workspace_kind(t) order by 1`
    ).map((r) => r.t);
    teamReadsBefore = await teamReads();
    validBefore = await valid();
    await scratch.migrateRest();
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the old list is the tier model kinds: no task, event or Recall map', () => {
    expect(oldKinds).toEqual(['app', 'branch', 'draw', 'file', 'formula', 'note', 'page', 'table']);
  });

  it('the function is gone, and no function body names it', async () => {
    expect(
      (await sql`select to_regprocedure('public.mantle_workspace_kind(public.node_type)') as f`)[0]!
        .f,
    ).toBeNull();
    const naming = await sql<{ name: string }[]>`
      select proname as name from pg_proc where prosrc ~ '\\mmantle_workspace_kind\\M'`;
    expect(naming).toEqual([]);
  });

  it('mantle_team_reads answers every kind and level as before', async () => {
    expect(await teamReads()).toBe(teamReadsBefore);
  });

  it('the level CHECKs name the old kinds, NOT VALID, and still refuse a breaking write', async () => {
    const defs = await checkDefs();
    expect(defs).toHaveLength(3);
    for (const def of defs) {
      expect(def).not.toContain('mantle_workspace_kind');
      expect(kindLists(def), def).toEqual([oldKinds]);
    }
    // Before: the audience and embedded CHECKs valid (0160, 0208), the
    // inherited one not (0204). After: all NOT VALID, so 0295 ran no scan
    // of nodes under its ACCESS EXCLUSIVE lock (the rows were proven by the
    // old CHECK, the same rule, dropped under that lock).
    expect(validBefore).toEqual({
      nodes_audience_kind_ck: true,
      nodes_embedded_level_ck: true,
      nodes_inherited_level_ck: false,
    });
    expect(await valid()).toEqual({
      nodes_audience_kind_ck: false,
      nodes_embedded_level_ck: false,
      nodes_inherited_level_ck: false,
    });
    // A NOT VALID CHECK guards every row written after it: a contact (not
    // a workspace kind) shared beyond Admin is refused, as before.
    const owner = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, 'a7-ck@example.invalid', 'x', 'admin', false)`;
    for (const [col, val, ck] of [
      ['audience', 'team', 'nodes_audience_kind_ck'],
      ['inherited_level', 'team', 'nodes_inherited_level_ck'],
      ['embedded_level', 'client', 'nodes_embedded_level_ck'],
    ] as const) {
      await expect(
        sql.begin((tx) =>
          tx.unsafe(
            `insert into nodes (id, owner_id, type, title, path, ${col})
             values ($1, $2, 'contact', 'a7 ck', 'contacts', $3)`,
            [randomUUID(), owner, val],
          ),
        ),
        col,
      ).rejects.toMatchObject({ code: '23514', constraint_name: ck });
    }
    await sql`delete from auth.users where id = ${owner}`;
  });

  it('every list written in a function is the old one; the contact share check is the registry’s', async () => {
    for (const body of await bodies()) {
      const name = body.split('\n')[0]!;
      const lists = kindLists(body);
      expect(lists.length, name).toBeGreaterThan(0);
      const want =
        name === 'mantle_contact_share_check' ? oldKinds.filter((k) => k !== 'branch') : oldKinds;
      for (const list of lists) expect(list, name).toEqual(want);
    }
    const contact = [...kindsWhere<ContactShareKind>((s) => s.contactShare)].sort();
    expect(contact).toEqual(oldKinds.filter((k) => k !== 'branch'));
  });

  it('a second run changes nothing', async () => {
    const before = [await bodies(), await checkDefs(), await valid()];
    await sql.begin(async (tx) => {
      for (const stmt of statements()) await tx.unsafe(stmt);
    });
    expect([await bodies(), await checkDefs(), await valid()]).toEqual(before);
  });

  it('the manual switch of a box that reports "clients present" still runs', async () => {
    const owner = randomUUID();
    const member = randomUUID();
    const page = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'a7-o@example.invalid', 'x', 'admin', true),
      (${member}, 'a7-m@example.invalid', 'x', 'member', false)`;
    // A former client (archived by 0272): the box reports clients present.
    await sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
      values (${randomUUID()}, 'a7-c@example.invalid', now(), 0)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'a7 team page', 'pages', 'team')`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toMatch(/^clients present/);
    // The boot step skips it.
    const boot = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(boot.map((r) => r.section)).toEqual(['skip']);
    // The operator's switch, by hand, after the clients were set up.
    const rows = await sql.begin(async (tx) => {
      await tx`set local mantle.ws_former_clients = 'reviewed'`;
      return tx<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    });
    expect(rows.filter((r) => r.section === 'skip' || r.section === 'reach-fail')).toEqual([]);
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    const admin = await sql<{ n: number }[]>`
      select count(*)::int as n from workspaces where owner_id = ${owner} and is_admin`;
    expect(admin[0]!.n).toBe(1);
    // The team page is read beyond Admin, as the bridge planned it.
    const reads = await sql<{ n: number }[]>`
      select count(*)::int as n from item_grants g join workspaces w on w.id = g.workspace_id
       where g.node_id = ${page} and not w.is_admin`;
    expect(reads[0]!.n).toBeGreaterThan(0);
  });
});
