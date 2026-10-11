/**
 * Workspaces W4b: an assistant turn's scope (withTurnScope) on a scratch
 * database of its own, migrated and with the workspaces live (0251, 0252) and the turn rules (0254).
 * Checked:
 *
 *  - every query runs on the workspace role, in its own short transaction
 *    (no transaction is held between queries, so none across an LLM call);
 *  - the scope reads what Team holds and nothing of Admin's;
 *  - a lost scope FAILS CLOSED: a query built in the turn and run after it
 *    ended, or run from a callback scheduled outside the turn, is refused,
 *    never sent on the system pool; a level question throws; nesting another
 *    scope is refused, the same scope runs as is;
 *  - the read rules 0254 adds for the workspace role: agents, tool groups
 *    (adminOnly, connectors as resources), and the per-login stores (R3).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/turn-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('assistant turn scope (W4b)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  const owner = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const ids: Record<string, string> = {};
  let admin = '';
  let team = '';

  const sys = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const node = async (key: string, audience: string) => {
    const id = randomUUID();
    await sys(sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${owner}, 'page', ${key}, 'pages', ${audience})`);
    ids[key] = id;
  };
  /** Whether `err` (or what it wraps: drizzle wraps a driver error) is the
   *  refusal of a lost scope. */
  const scopeLost = (err: unknown): boolean => {
    for (let e: unknown = err, d = 0; e && d < 5; d++) {
      if (e instanceof m.ScopeLostError) return true;
      e = (e as { cause?: unknown }).cause;
    }
    return false;
  };
  const scope = (login: string | null = member) => ({
    kind: 'assistant' as const,
    loginId: login,
    ws: [team],
    modWs: [] as string[],
  });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    await sys(sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, ${`o-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin', true),
      (${member}, ${`m-${member.slice(0, 8)}@example.invalid`}, 'x', 'member', false),
      (${other}, ${`x-${other.slice(0, 8)}@example.invalid`}, 'x', 'member', false)`);
    await node('adminPage', 'admin');
    await node('teamPage', 'team');
    const agent = async (slug: string, role: string, audience: string) => {
      const id = randomUUID();
      await sys(sql`insert into agents (id, owner_id, slug, name, role, audience, model, system_prompt)
        values (${id}, ${owner}, ${slug}, ${slug}, ${role}::agent_role, ${audience}, 'm', 'p')`);
      ids[slug] = id;
    };
    await agent('persona', 'responder', 'admin');
    await agent('team-responder', 'custom', 'team');
    await agent('helper', 'custom', 'admin');
    await sys(sql`insert into tool_groups (owner_id, slug, name, integration, audience, admin_only) values
      (${owner}, 'plain', 'p', null, 'team', false),
      (${owner}, 'email', 'e', null, 'admin', true),
      (${owner}, 'conn-team', 't', '{"mcp":{}}'::jsonb, 'team', false),
      (${owner}, 'conn-admin', 'a', '{"mcp":{}}'::jsonb, 'admin', false)`);
    await sys(sql`select * from mantle_ws_migrate()`);
    const ws = await sys<{ name: string; id: string }>(
      sql`select name, id::text as id from workspaces where owner_id = ${owner}`,
    );
    admin = ws.find((w) => w.name === 'Admin')!.id;
    team = ws.find((w) => w.name === 'Team')!.id;
    // R3 rows: Team rows of the member, of another member, with no login;
    // an Admin row (no workspace = Admin).
    const msg = async (key: string, ws: string | null, login: string | null) => {
      const id = randomUUID();
      await sys(sql`insert into assistant_messages (id, owner_id, agent_id, direction, text, channel, workspace_id, login_id)
        values (${id}, ${owner}, ${ids['team-responder']!}, 'inbound', ${key}, 'web', ${ws}, ${login})`);
      ids[key] = id;
    };
    await msg('mine', team, member);
    await msg('theirs', team, other);
    await msg('nobody', team, null);
    await msg('adminMsg', null, owner);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('runs every query on the workspace role, each in its own transaction', async () => {
    const seen = await m.withTurnScope(scope(), async () => {
      const a = (await m.db.execute(
        sql`select current_user as u, txid_current()::text as x`,
      )) as unknown as { u: string; x: string }[];
      // Between two queries no transaction of this role is left open, in
      // this test's database (other files' scratch databases share the
      // server and the role in a full run).
      const idle = await m.systemDb.execute(sql`select count(*)::int as n from pg_stat_activity
          where usename = 'mantle_view_user' and state like 'idle in transaction%'
            and datname = current_database()`);
      const b = (await m.db.execute(sql`select txid_current()::text as x`)) as unknown as {
        x: string;
      }[];
      return {
        user: a[0]!.u,
        twoTx: a[0]!.x !== b[0]!.x,
        idle: (idle as unknown as { n: number }[])[0]!.n,
      };
    });
    expect(seen).toEqual({ user: 'mantle_view_user', twoTx: true, idle: 0 });
  }, 60_000);

  it('reads what Team holds, nothing of Admin', async () => {
    const titles = await m.withTurnScope(scope(), async () =>
      (
        await m.db
          .select({ title: m.nodes.title })
          .from(m.nodes)
          .where(sql`${m.nodes.ownerId} = ${owner}`)
      ).map((r) => r.title),
    );
    expect(titles).toContain('teamPage');
    expect(titles).not.toContain('adminPage');
  });

  it('a query built in the turn and run after it ended is refused', async () => {
    // Wrapped, so the turn does not await it itself.
    const late = await m.withTurnScope(scope(), async () => ({
      q: m.db.select({ id: m.nodes.id }).from(m.nodes),
    }));
    const err = await late.q.then(
      () => null,
      (e: unknown) => e,
    );
    expect(scopeLost(err)).toBe(true);
  });

  it('a query run from a callback scheduled outside the turn is refused', async () => {
    // A work queue made OUTSIDE the turn (a timer with no scope), fed a query
    // built inside it: the query runs in the timer's context.
    const queue: PromiseLike<unknown>[] = [];
    const results: Promise<unknown>[] = [];
    const timer = setInterval(() => {
      // Settled where it runs (outside the turn), so nothing goes unhandled.
      while (queue.length) {
        results.push(
          Promise.resolve(queue.shift()!).then(
            () => ({ ok: true }),
            (reason: unknown) => ({ ok: false, reason }),
          ),
        );
      }
    }, 5);
    try {
      await m.withTurnScope(scope(), async () => {
        const built = m.db.select({ id: m.nodes.id }).from(m.nodes);
        // Hand the BUILDER to the outside queue; it is awaited there.
        queue.push({ then: (ok, bad) => built.then(ok, bad) });
      });
      // Let the timer pick it up and run it outside the turn.
      await new Promise((r) => setTimeout(r, 40));
      const all = (await Promise.all(results)) as { ok: boolean; reason?: unknown }[];
      expect(all).toHaveLength(1);
      expect(all[0]!.ok).toBe(false);
      expect(scopeLost(all[0]!.reason)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it('a level question throws; another scope is refused; the same scope nests', async () => {
    await m.withTurnScope(scope(), async () => {
      expect(() => m.currentViewerLevel()).toThrow(m.ScopeLevelError);
      await expect(m.withScope(scope(), async () => 1)).rejects.toThrow(/already inside/);
      await expect(m.withTurnScope({ ...scope(), ws: [admin] }, async () => 1)).rejects.toThrow(
        /another scope/,
      );
      expect(await m.withTurnScope(scope(), async () => 2)).toBe(2);
      await expect(m.withSystemTx(async () => 3)).rejects.toThrow();
    });
  });

  it('agents: an assistant of the scope or a helper, never the Admin assistant', async () => {
    const slugs = await m.withTurnScope(scope(), async () =>
      (
        await m.db
          .select({ slug: m.agents.slug })
          .from(m.agents)
          .where(sql`${m.agents.ownerId} = ${owner}`)
      ).map((r) => r.slug),
    );
    expect(slugs.sort()).toEqual(['helper', 'team-responder']);
  });

  it('tool groups: no adminOnly group; a connector only as a resource of Team', async () => {
    const slugs = await m.withTurnScope(scope(), async () =>
      (
        await m.db
          .select({ slug: m.toolGroups.slug })
          .from(m.toolGroups)
          .where(sql`${m.toolGroups.ownerId} = ${owner}`)
      ).map((r) => r.slug),
    );
    expect(slugs.sort()).toEqual(['conn-team', 'plain']);
    expect(await m.withTurnScope(scope(), () => m.scopeHoldsAdmin())).toBe(false);
  });

  it('per-login stores (R3): only the login’s own rows of the scope', async () => {
    const read = (login: string | null) =>
      m.withTurnScope(scope(login), async () =>
        (
          await m.db
            .select({ text: m.assistantMessages.text })
            .from(m.assistantMessages)
            .where(sql`${m.assistantMessages.ownerId} = ${owner}`)
        ).map((r) => r.text),
      );
    expect(await read(member)).toEqual(['mine']);
    expect(await read(other)).toEqual(['theirs']);
    // No login: nothing (a row with no login is Admin's).
    expect(await read(null)).toEqual([]);
  });

  it('0254 takes its eight locks together, short and retried: a busy table never stalls the rest', async () => {
    // Re-run 0254 (idempotent) while a reader holds runs for 4 s. The lock
    // statement waits at most 3 s, rolls back what it took, and retries;
    // meanwhile a reader of agents (locked before runs) is never held up
    // for the whole wait.
    const file = fileURLToPath(
      new globalThis.URL('../migrations/0254_workspaces_turns.sql', import.meta.url),
    );
    const text = readFileSync(file, 'utf8').split('--> statement-breakpoint').join('\n');
    const notices: string[] = [];
    const a = postgres(scratch.url, { max: 1, prepare: false });
    const b = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message)),
    });
    const c = postgres(scratch.url, { max: 1, prepare: false });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const didLock = new Promise<void>((r) => (locked = r));
      const holder = a.begin(async (tx) => {
        await tx`lock table runs in access share mode`;
        locked();
        await held;
      });
      await didLock;
      const t0 = Date.now();
      const migrate = b.begin((tx) => tx.unsafe(text));
      // A reader of agents while the migration waits on runs: it may wait
      // for one short attempt, never for the whole hold.
      await new Promise((r) => setTimeout(r, 500));
      const r0 = Date.now();
      await c`select count(*) from agents`;
      const readerWait = Date.now() - r0;
      await new Promise((r) => setTimeout(r, 3500));
      release();
      await holder;
      await migrate;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(3000);
      expect(readerWait).toBeLessThan(3500);
      expect(notices.some((n) => /tables busy \(attempt 1\)/.test(n))).toBe(true);
      // Still in place after the re-run.
      const [col] = await c`select count(*)::int as n from information_schema.columns
        where table_name = 'tool_groups' and column_name = 'admin_only'`;
      expect(col!.n).toBe(1);
    } finally {
      await Promise.all([a.end(), b.end(), c.end()]);
    }
  }, 60_000);
});
