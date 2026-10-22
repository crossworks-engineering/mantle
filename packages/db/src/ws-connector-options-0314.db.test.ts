/**
 * 0314: the connectors a workspace may hold (mantle_ws_connector_options),
 * the workspace screen's "add connector" list, on a database of its own
 * that the workspaces switch made live:
 *
 *  - the drift pin: every slug the list answers is one the attach definer
 *    (mantle_ws_resource_add, 0307) accepts, and every tool group the
 *    attach accepts is on the list, tried for every tool group there is:
 *    an MCP connector, an HTTP API connector, a plain tool group (neither)
 *    and another brain's connector. Each with its kind, and `held` once the
 *    workspace holds it;
 *  - who reads it: the scope's own login with the connectors area, on a
 *    workspace it may see (a user of it, or the users area); a Moderator
 *    who is no Admin user, an Admin user without the connectors area, an
 *    Admin user without the users area outside the workspace, and no scope
 *    at all answer no row;
 *  - the catalog: a definer with a fixed search_path, PUBLIC revoked, the
 *    workspace and write roles may run it;
 *  - the renumber proof: 0314's `when` is above every `when` before it, and
 *    a database just before it applies 0314 and only it;
 *  - the rollback: rollback/<tag>.revert.sql drops the function and takes
 *    0314 off the ledger; a roll forward applies it again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ws-connector-options-0314.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0314_ws_connector_options';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const FN = 'public.mantle_ws_connector_options(uuid)';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

const revertStatements = (): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

describe('0314 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

/** Rolls the transaction back once its cell has its answer. */
class Rollback extends Error {}

type Option = { slug: string; name: string; kind: string; held: boolean };

describe.skipIf(!URL)(
  '0314: the connectors a workspace may hold (mantle_ws_connector_options)',
  () => {
    let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
    let sql: ReturnType<typeof postgres>;
    let m: typeof import('./index');
    let brain = '';
    let adminWs = '';
    const tag = `wco${randomUUID().slice(0, 8)}`;
    const W = randomUUID(); // a normal workspace: mod (Moderator)
    const L = {
      adm: randomUUID(), // role admin, in Admin (the switch puts it there)
      noConn: randomUUID(), // role admin, in Admin, the connectors area off
      noUsers: randomUUID(), // role admin, in Admin, the users area off
      mod: randomUUID(), // member, Moderator of W
      other: randomUUID(), // another brain's owner (no anchor: a row only)
    };
    /** The tool groups, by what they are. */
    const G = {
      mcp: `${tag}-mcp`, // an MCP connector of the brain
      api: `${tag}-api`, // an HTTP API connector of the brain
      plain: `${tag}-plain`, // a tool group with no integration
      elsewhere: `${tag}-else`, // another brain's API connector
    };

    /** The write role's settings for `login` (gateway/write-route.ts
     *  writeRoleSettingsSql): its scope, its login, its actor. */
    const asLogin = async (login: string): Promise<Record<string, string>> => {
      const scope = await m.loginScopeFor(login);
      const arr = (ids: readonly string[]) => `{${ids.join(',')}}`;
      return {
        'mantle.ws': arr(scope.ws),
        'mantle.mod_ws': arr(scope.modWs),
        'mantle.login_id': login,
        'mantle.actor': `login:rw:${login}`,
        'mantle.write_mode': 'rw',
      };
    };

    /** `q` in a transaction rolled back after it, with `settings` set
     *  transaction-local first. */
    const run = async <T>(
      settings: Record<string, string>,
      q: (tx: postgres.TransactionSql) => Promise<T>,
    ): Promise<T> => {
      let out: { v: T } | null = null;
      await sql
        .begin(async (tx) => {
          for (const [k, v] of Object.entries(settings)) {
            await tx`select set_config(${k}, ${v}, true)`;
          }
          out = { v: await q(tx) };
          throw new Rollback();
        })
        .catch((err: unknown) => {
          if (!(err instanceof Rollback)) throw err;
        });
      if (!out) throw new Error('run: no answer');
      return (out as { v: T }).v;
    };

    /** The list as the workspace role reads it (the route's role). */
    const options = async (tx: postgres.TransactionSql, ws: string = W): Promise<Option[]> => {
      await tx`set local role mantle_view_user`;
      const rows = await tx<Option[]>`
      select o.slug, o.name, o.kind, o.held from mantle_ws_connector_options(${ws}::uuid) o`;
      await tx`reset role`;
      return [...rows];
    };

    /** Whether the attach definer accepts `slug` on W: tried in a savepoint
     *  rolled back after it, so each try starts from the same rows. */
    const accepts = async (tx: postgres.TransactionSql, slug: string): Promise<boolean> => {
      let ok = false;
      await tx
        .savepoint(async (sp) => {
          await sp`select mantle_ws_resource_add(${brain}::uuid, ${W}::uuid, 'connector', ${slug}, false)`;
          ok = true;
          throw new Rollback();
        })
        .catch((err: unknown) => {
          if (err instanceof Rollback) return;
          const e = err as { code?: string; message?: string };
          // The one refusal a slug may get here: no such connector.
          expect(e.code, e.message).toBe('22023');
          expect(e.message).toMatch(/^mantle_ws:no_connector\b/);
        });
      return ok;
    };

    beforeAll(async () => {
      scratch = await createMigratedScratchDatabase(URL!);
      sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
      brain = await ensureTestAnchor(sql);
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      const email = (k: string) => `${tag}-${k}@example.invalid`;
      for (const [k, id] of Object.entries(L)) {
        const role = k === 'mod' || k === 'other' ? 'member' : 'admin';
        await sql`insert into auth.users (id, email, password_hash, role, display_name)
                values (${id}, ${email(k)}, 'x', ${role}, ${k})`;
      }
      await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
      await runWorkspacesSwitch(scratch.url);
      m = await import('./index');
      const [a] = await sql<{ id: string }[]>`
      select id::text from workspaces where owner_id = ${brain} and is_admin`;
      adminWs = a!.id;
      // The fixtures write the four tables as the superuser.
      await sql`delete from workspace_users where login_id = ${L.other}`;
      await sql`update workspace_users set limits = ${sql.json({ areas: { connectors: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noConn}`;
      await sql`update workspace_users set limits = ${sql.json({ areas: { users: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noUsers}`;
      await sql`insert into workspaces (id, owner_id, name) values (${W}, ${brain}, ${`${tag} W`})`;
      await sql`insert into workspace_users (workspace_id, login_id, moderator)
              values (${W}, ${L.mod}, true)`;
      await sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values
        (${brain}, ${G.mcp}, 'Beta MCP', ARRAY['b_do']::text[], 'admin', true,
         ${sql.json({ service: G.mcp, mcp: { url: 'https://mcp.example.invalid/mcp' } })}),
        (${brain}, ${G.api}, 'Alpha API', ARRAY['a_do']::text[], 'admin', false,
         ${sql.json({ service: 'example-api', baseUrl: 'https://api.example.invalid/v1' })}),
        (${brain}, ${G.plain}, 'Plain', ARRAY['p_do']::text[], 'admin', true, null),
        (${L.other}, ${G.elsewhere}, 'Elsewhere', ARRAY['e_do']::text[], 'admin', true,
         ${sql.json({ service: 'example-api', baseUrl: 'https://api.example.invalid/v2' })})`;
      const admins = await sql<{ id: string }[]>`
      select login_id::text as id from workspace_users where workspace_id = ${adminWs}`;
      expect(admins.map((r) => r.id)).toEqual(expect.arrayContaining([L.adm, L.noConn, L.noUsers]));
    }, 300_000);

    afterAll(async () => {
      await m?.closeDb();
      await sql?.end();
      await scratch?.drop();
    });

    it('the drift pin: the list is exactly what the attach accepts, every tool group tried', async () => {
      const out = await run(await asLogin(L.adm), async (tx) => {
        const listed = await options(tx);
        const every = await tx<{ slug: string }[]>`select slug from tool_groups order by slug`;
        const accepted: string[] = [];
        for (const g of every) if (await accepts(tx, g.slug)) accepted.push(g.slug);
        return { listed, accepted, tried: every.map((g) => g.slug) };
      });
      // Every tool group there is was tried, the four of the fixture among them.
      expect(out.tried).toEqual(expect.arrayContaining(Object.values(G)));
      // Each way: on the list <=> the attach takes it.
      expect(out.listed.map((o) => o.slug).sort()).toEqual([...out.accepted].sort());
      // What that is here: the two connectors of the brain, MCP and API (the
      // API one disabled: the attach takes it, so the list offers it).
      expect(out.listed.filter((o) => Object.values(G).includes(o.slug))).toEqual([
        { slug: G.api, name: 'Alpha API', kind: 'api', held: false },
        { slug: G.mcp, name: 'Beta MCP', kind: 'mcp', held: false },
      ]);
      expect(out.accepted).not.toContain(G.plain);
      expect(out.accepted).not.toContain(G.elsewhere);
    });

    it('held: a connector the workspace holds is on the list, held', async () => {
      const out = await run(await asLogin(L.adm), async (tx) => {
        await tx`select mantle_ws_resource_add(${brain}::uuid, ${W}::uuid, 'connector', ${G.api}, true)`;
        return options(tx);
      });
      expect(out.filter((o) => Object.values(G).includes(o.slug))).toEqual([
        { slug: G.api, name: 'Alpha API', kind: 'api', held: true },
        { slug: G.mcp, name: 'Beta MCP', kind: 'mcp', held: false },
      ]);
    });

    it('who reads it: the connectors area on a workspace it may see; no row for anyone else', async () => {
      // An Admin user without the users area still holds connectors: it sees
      // the Admin workspace's list (it is a user there), not W's.
      expect(
        (await run(await asLogin(L.noUsers), (tx) => options(tx, adminWs))).length,
      ).toBeGreaterThan(0);
      expect(await run(await asLogin(L.noUsers), (tx) => options(tx))).toEqual([]);
      // A Moderator of W who is no Admin user, an Admin user without the
      // connectors area, and no scope at all.
      expect(await run(await asLogin(L.mod), (tx) => options(tx))).toEqual([]);
      expect(await run(await asLogin(L.noConn), (tx) => options(tx))).toEqual([]);
      expect(await run({}, (tx) => options(tx))).toEqual([]);
      // Another login's scope with this login set: the scope's login is the
      // one asked (its areas), so the Moderator's scope answers nothing.
      const borrowed = { ...(await asLogin(L.mod)), 'mantle.login_id': L.adm };
      expect(await run(borrowed, (tx) => options(tx))).toEqual([]);
    });

    it('the catalog: a definer with a fixed search_path, PUBLIC revoked, the workspace and write roles may run it', async () => {
      const [fn] = await sql<{ secdef: boolean; config: string[]; acl: string }[]>`
      select p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl
        from pg_proc p where p.oid = to_regprocedure(${FN})`;
      expect(fn!.secdef).toBe(true);
      expect(fn!.config).toEqual(['search_path=public, pg_temp']);
      expect(fn!.acl).not.toMatch(/(^|[{,])=X/);
      const [can] = await sql<{ v: boolean; w: boolean }[]>`
      select has_function_privilege('mantle_view_user', ${FN}, 'execute') as v,
             has_function_privilege('mantle_write_user', ${FN}, 'execute') as w`;
      expect(can).toEqual({ v: true, w: true });
    });
  },
);

describe.skipIf(!URL)('0314: a database just before it, and the rollback', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const present = async () =>
    (
      await pg<{ n: number }[]>`select count(*)::int as n from pg_proc
                                where oid = to_regprocedure(${FN})`
    )[0]!.n;
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(pg, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    pg = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await pg`create schema if not exists "drizzle"`;
    await pg`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await pg`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
               values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await scratch?.drop();
  });

  it('the runner applies 0314 and only it', async () => {
    expect(await present()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(1);
  }, 120_000);

  it('rollback: the revert drops the function and takes 0314 off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    await pg.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await present()).toBe(0);
    expect(await ledger()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(1);
  }, 120_000);
});
