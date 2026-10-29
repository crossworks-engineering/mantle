/**
 * The processes that run tools off HTTP write on the write role (arch
 * A2b2b; pre-check deletion blocker 2, docs/actors.md): the runs worker (a
 * run item's tool call, withRunScope), the stdio MCP server (each call in
 * the anchor login's turn scope) and the Telegram poller (an Approve tap,
 * the parked call in the scope it was asked in). Each opens the write pool
 * at its start (openLoginWritePool), so a scoped tool write there meets
 * the database's write and edit checks as one in web or api does.
 *
 * Each cell runs the product's own path on a migrated scratch database:
 *
 *   run       createRun, then executeRunItem as the runs worker runs it
 *             (system(worker:runs)), the run the anchor's (Admin) own
 *   stdio     buildMantleMcpServer(owner) over an in-memory transport, as
 *             login(owner) (server/mcp/src/server.ts, stdio-actor.ts)
 *   telegram  the call queued in the anchor's Admin turn (the tool loop's
 *             queue path), approved by the Telegram poller's handler
 *             (lib/telegram-approval.ts)
 *
 * The item: a note homed in another workspace, granted to Admin with
 * Write off (the Admin scope reads it, may not edit it), and one granted
 * with Write on (it may). The TypeScript item pre-check (gate-prerun.ts,
 * toolItemWriteRefusalOf) is bypassed where a cell says so, so only the
 * database stands:
 *
 *   - pool open (this branch), check on: the read-only edit is refused by
 *     the database, the note unchanged; the editable one is made, on the
 *     write role. Warn: the read-only edit is made and logged as a miss.
 *   - pool closed (main's shape of these three processes): the read-only
 *     edit is made, unchecked, in warn and on alike: the gap closed here.
 *   - off: the write role too since plan v3 S3 (its check reports, as warn).
 *   - (the pre-check in place, the same answer pool open or closed, went with
 *     note_update's item pre-check in the pre-check removal. The database's
 *     refusal above is the answer now; the bypass switch below changes
 *     nothing for it.)
 *
 * `pnpm test:edit-on` and `pnpm test:runtime-role` run this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/worker-write-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Was: the TypeScript item pre-check, bypassed while `on` is false. None
 *  is left since the pre-check removal Part 3. Since the R0 fix round (L2)
 *  it bypasses the queue-time item check (item-args.ts queueItemRefusal),
 *  so a queued call meets only the database, as each cell says. */
const pre = vi.hoisted(() => ({ on: true }));
vi.mock('../../../packages/tools/src/item-args', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/item-args')>();
  return {
    ...real,
    queueItemRefusal: (...args: Parameters<typeof real.queueItemRefusal>) =>
      pre.on ? real.queueItemRefusal(...args) : Promise.resolve(null),
  };
});

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|withTurnScope|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;
const WRITER = /^mantle_write_user/;
const EDIT_MISS = 'UPDATE on nodes: no edit of the item (refused when the check is on)';

type Mode = 'off' | 'warn' | 'on';
type Way = 'run' | 'stdio' | 'telegram';
type Outcome = { ok: boolean; text: string };
type Reply = { isError?: boolean; content?: { text?: string }[] };

describe.skipIf(!DB_URL)(
  'the runs worker, the stdio MCP server and the Telegram poller write on the write role',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let raw: ReturnType<typeof postgres>;
    let m: typeof import('@mantle/db');
    let t: typeof import('@mantle/tools');
    let ls: typeof import('@mantle/mcp-core');
    let rt: typeof import('@mantle/runtime/agent');
    let runs: typeof import('@mantle/runs');
    let tracing: typeof import('@mantle/tracing');
    let actorMode: typeof import('../../../packages/db/src/actor');
    let ex: typeof import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    let runItem: typeof import('../lib/runs/execute-item');
    let approval: typeof import('../lib/telegram-approval');
    let dir = '';
    const tag = `wwr${randomUUID().slice(0, 6)}`;
    const owner = randomUUID();
    const adminAgent = randomUUID();
    let adminWs = '';
    let otherWs = '';
    let noteRoot = '';
    const recorded: string[] = [];

    /** A note homed in the other workspace, granted to Admin with `write`. */
    const makeNote = async (write: boolean): Promise<string> => {
      const id = randomUUID();
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${noteRoot}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${owner}, 'note', ${`${tag} note ${id.slice(0, 8)}`},
                       'notes'::ltree, ${raw.json({ rank: 'a0' })})`;
      });
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${otherWs}, true, false), (${id}, ${adminWs}, false, ${write})`;
      });
      return id;
    };

    const titleOf = async (id: string) =>
      (await raw<{ t: string }[]>`select title as t from nodes where id = ${id}`)[0]?.t ?? 'gone';

    /** Who sent the writes to nodes that `fn` caused (session_user each). */
    const writersOf = async <T>(fn: () => Promise<T>): Promise<{ out: T; who: string[] }> => {
      const [top] = await raw<{ n: number }[]>`select coalesce(max(id), 0)::int as n from wwr_seen`;
      const out = await fn();
      const rows = await raw<{ who: string }[]>`
      select who from wwr_seen where id > ${top!.n} order by id`;
      return { out, who: rows.map((r) => r.who) };
    };

    /** The box's checks and the process's, together (as the matrix does). */
    const setMode = async (mode: Mode) => {
      await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
      await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
      process.env.MANTLE_ACTOR_CHECK = mode;
      actorMode.noteBoxActorCheckMode(mode);
      expect(m.actorCheckMode()).toBe(mode);
    };

    /** This process's write pool, open (this branch) or closed (main's
     *  shape of the runs worker, the stdio server and the Telegram poller). */
    const setPool = (open: boolean) => {
      (globalThis as { __mantleLoginWritePool?: boolean }).__mantleLoginWritePool = open;
    };

    // ── The three ways in ──────────────────────────────────────────────────

    /** A run item of the anchor's own run, run as the runs worker runs it. */
    const viaRun = async (input: Record<string, unknown>): Promise<Outcome> => {
      const { runId } = await m.runAsSystem('worker:runs', () =>
        runs.createRun(m.db, {
          ownerId: owner,
          title: `${tag} run`,
          loginId: owner,
          plan: {
            kind: 'seq',
            children: [{ kind: 'tool_call', payload: { tool: 'note_update', args: input } }],
          } as never,
        }),
      );
      const [item] = await raw<{ id: string }[]>`
      select id::text as id from run_items where run_id = ${runId} and kind = 'tool_call'`;
      await m.runAsSystem('worker:runs', () => runItem.executeRunItem(item!.id));
      const [row] = await raw<
        {
          state: string;
          result: { output?: unknown; failure?: { type?: string; message?: string } };
        }[]
      >`select state, result from run_items where id = ${item!.id}`;
      if (row?.state === 'done')
        return { ok: true, text: JSON.stringify(row.result?.output ?? '') };
      const f = row?.result?.failure;
      return { ok: false, text: `${row?.state} ${f?.type}: ${f?.message ?? ''}` };
    };

    /** One call to the stdio server's surface, as login(owner). */
    const viaStdio = async (input: Record<string, unknown>): Promise<Outcome> => {
      const { InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const server = ls.buildMantleMcpServer(owner);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        const r = (await m.runAsActor(m.loginActor(owner, 'owner'), () =>
          c.callTool({ name: 'note_update', arguments: input }),
        )) as Reply;
        return {
          ok: !(r.isError ?? false),
          text: (r.content ?? []).map((x) => x.text ?? '').join(' '),
        };
      } finally {
        await c.close();
      }
    };

    /** note_update waits for approval (`on`) or not, as system(test). */
    const confirmNoteUpdate = (on: boolean) =>
      raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`update tools set requires_confirm = ${on}
               where owner_id = ${owner} and slug = 'note_update'`;
      });

    /** The call queued in the anchor's Admin turn, then an Approve tap. */
    const viaTelegram = async (input: Record<string, unknown>): Promise<Outcome> => {
      await confirmNoteUpdate(true);
      const pendingIds: string[] = [];
      try {
        const row = await m.asSystem(() => t.resolveTool(owner, 'note_update'), 'test');
        const surface = { kind: 'web', loginId: owner };
        const res = await m.runAsActor(m.loginActor(owner, 'owner'), () =>
          rt.withAgentScope(
            { id: adminAgent, ownerId: owner, workspaceId: adminWs, role: 'responder' },
            () =>
              tracing.startTrace(
                { kind: 'responder_turn', ownerId: owner, agentId: adminAgent, loginId: owner },
                () =>
                  ex.executeToolCall({
                    args: {
                      ownerId: owner,
                      agentId: adminAgent,
                      agentSlug: `${tag}-admin`,
                      surface,
                    } as never,
                    slug: 'note_update',
                    call: {
                      id: `call-${randomUUID().slice(0, 6)}`,
                      function: { name: 'note_update', arguments: JSON.stringify(input) },
                    },
                    tool: row!,
                    input,
                    argParseError: null,
                    argValidation: null,
                    argValidationMode: 'off',
                    lastUserMessage: undefined,
                    pendingIds,
                  }),
              ),
            { loginId: owner },
          ),
        );
        if (pendingIds.length !== 1) {
          return { ok: false, text: `not queued: ${JSON.stringify(res).slice(0, 200)}` };
        }
      } finally {
        await confirmNoteUpdate(false);
      }
      const r = await approval.telegramApprovalHandlers.onApproval!({
        ownerId: owner,
        loginId: owner,
        decision: 'approve',
        pendingId: pendingIds[0]!,
      });
      // An approved call that ran and failed says so (telegram-approval.ts).
      return { ok: r.ok && !/it ran but failed/.test(r.text), text: r.text };
    };

    const WAYS: Record<Way, (input: Record<string, unknown>) => Promise<Outcome>> = {
      run: viaRun,
      stdio: viaStdio,
      telegram: viaTelegram,
    };

    /** One cell: `way` edits a fresh note (`write`: granted with Write on)
     *  with the pool open or closed and the pre-check on or bypassed. What it
     *  answered, whether the note changed, who wrote nodes, and the misses. */
    const cell = async (
      name: string,
      way: Way,
      opts: { write: boolean; pool: boolean; precheck: boolean },
    ) => {
      const id = await makeNote(opts.write);
      const before = await titleOf(id);
      setPool(opts.pool);
      pre.on = opts.precheck;
      m.takeActorMisses();
      let res: { out: Outcome; who: string[] };
      try {
        res = await writersOf(() => WAYS[way]({ id, title: `${tag} edited ${name}` }));
      } finally {
        setPool(true);
        pre.on = true;
      }
      const misses = m.takeActorMisses().map((x) => x.check);
      const changed = (await titleOf(id)) !== before;
      recorded.push(
        `${name}: ${res.out.ok ? 'ok' : 'refused'} changed=${changed} role=${
          res.who.some((w) => WRITER.test(w)) ? 'write' : 'system'
        } misses=${misses.length} ${res.out.text.slice(0, 120).replace(/\s+/g, ' ')}`,
      );
      return { ...res.out, changed, who: res.who, misses };
    };

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(DB_URL!);
      dir = await mkdtemp(path.join(tmpdir(), 'worker-write-role-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.FILES_DIR = path.join(dir, 'files');
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'worker-write-role-secret-at-least-32-chars';
      delete process.env.MANTLE_DETACHED_DEV;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('offline in the worker write role test', { status: 503 })),
      );
      m = await import('@mantle/db');
      t = await import('@mantle/tools');
      ls = await import('@mantle/mcp-core');
      rt = await import('@mantle/runtime/agent');
      runs = await import('@mantle/runs');
      tracing = await import('@mantle/tracing');
      actorMode = await import('../../../packages/db/src/actor');
      ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
      runItem = await import('../lib/runs/execute-item');
      approval = await import('../lib/telegram-approval');
      raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner')`;
      await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
              on conflict (id) do nothing`;
      await raw`select * from mantle_ws_migrate()`;
      adminWs = (
        await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${owner} and is_admin`
      )[0]!.id;
      // The other workspace: the anchor is no user of it; its notes reach the
      // Admin scope only by their grant to Admin.
      otherWs = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} other`}) returning id::text as id`
      )[0]!.id;
      await raw`delete from workspace_users where workspace_id = ${otherWs}`;
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${adminAgent}, ${owner}, ${`${tag}-admin`}, 'Admin', 'fake/model', 'p', 'responder',
              ${adminWs})`;
      await raw`insert into nodes (owner_id, type, title, path)
              select ${owner}, 'branch', 'notes', 'notes'::ltree
               where not exists (select 1 from nodes where owner_id = ${owner}
                                   and type = 'branch' and path = 'notes'::ltree)`;
      noteRoot = (
        await raw<{ id: string }[]>`select id::text as id from nodes
        where owner_id = ${owner} and type = 'branch' and path = 'notes'::ltree`
      )[0]!.id;
      await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
      // Which role sent each write to nodes (this scratch database only).
      await raw`create table wwr_seen (id bigserial primary key, who text not null)`;
      await raw.unsafe(`create function wwr_seen_trg() returns trigger language plpgsql
      security definer set search_path = public as $$
      begin insert into wwr_seen (who) values (session_user); return null; end $$`);
      await raw`create trigger zz_wwr_seen after update on nodes
      for each statement execute function wwr_seen_trg()`;
      m.takeActorMisses();
    }, 300_000);

    afterAll(async () => {
      console.log(['worker write role, each cell’s answer:', ...recorded].join('\n  '));
      setPool(true);
      pre.on = true;
      process.env.MANTLE_ACTOR_CHECK = 'warn';
      vi.unstubAllGlobals();
      await raw?.end();
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    for (const way of ['run', 'stdio', 'telegram'] as const) {
      it(`${way}: on refuses a read-only edit at the database, the pre-check bypassed; an editable one is made on the write role`, async () => {
        await setMode('on');
        const ro = await cell(`${way} on read-only`, way, {
          write: false,
          pool: true,
          precheck: false,
        });
        expect(ro.ok, ro.text).toBe(false);
        expect(ro.changed).toBe(false);
        expect(ro.text).not.toMatch(RAW);
        const rw = await cell(`${way} on editable`, way, {
          write: true,
          pool: true,
          precheck: false,
        });
        expect(rw.ok, rw.text).toBe(true);
        expect(rw.changed).toBe(true);
        expect(
          rw.who.some((w) => WRITER.test(w)),
          rw.who.join(','),
        ).toBe(true);
        expect(rw.misses).toEqual([]);
      }, 120_000);

      it(`${way}: warn makes the read-only edit and logs it as a miss; the editable one logs none`, async () => {
        await setMode('warn');
        const ro = await cell(`${way} warn read-only`, way, {
          write: false,
          pool: true,
          precheck: false,
        });
        expect(ro.ok, ro.text).toBe(true);
        expect(ro.changed).toBe(true);
        expect(
          ro.who.some((w) => WRITER.test(w)),
          ro.who.join(','),
        ).toBe(true);
        expect(ro.misses).toContain(EDIT_MISS);
        const rw = await cell(`${way} warn editable`, way, {
          write: true,
          pool: true,
          precheck: false,
        });
        expect(rw.ok, rw.text).toBe(true);
        expect(rw.changed).toBe(true);
        expect(rw.misses).toEqual([]);
      }, 120_000);

      it(`${way}: main's shape (the pool closed) made the read-only edit unchecked in warn and on; off runs on the write role (plan v3 S3)`, async () => {
        for (const mode of ['warn', 'on'] as const) {
          await setMode(mode);
          const ro = await cell(`${way} ${mode} read-only, pool closed`, way, {
            write: false,
            pool: false,
            precheck: false,
          });
          expect(ro.ok, ro.text).toBe(true);
          expect(ro.changed).toBe(true);
          expect(ro.who.filter((w) => WRITER.test(w))).toEqual([]);
          expect(ro.misses).not.toContain(EDIT_MISS);
        }
        // Changed in S3: off ran it on the system pool (the rollout switch);
        // the write role now, its check reporting as warn does.
        await setMode('off');
        const off = await cell(`${way} off read-only`, way, {
          write: false,
          pool: true,
          precheck: false,
        });
        expect(off.ok, off.text).toBe(true);
        expect(
          off.who.some((w) => WRITER.test(w)),
          off.who.join(','),
        ).toBe(true);
        expect(off.misses).toContain(EDIT_MISS);
      }, 180_000);
    }
  },
);
