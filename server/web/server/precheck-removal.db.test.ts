/**
 * The pre-check removal's proof (docs/actors.md, "Pre-check deletion", A4
 * step 4 and A5 step 6b): for each tool whose TypeScript item pre-check
 * goes, the same refusal now comes from the database, with both checks on.
 *
 * Each cell runs the product's own path on a migrated scratch database with
 * the actor check and the edit check on: a tool call on the login's own MCP
 * surface (prepareCallerTools, an OAuth connection; the scope of all its
 * workspaces), and, for one tool per family, an assistant turn of the
 * workspace that holds the item (dispatchTool, the turn caller). Two
 * logins: a member (a Moderator of H, a user of R and of W) and the owner
 * (an Admin user). Each item is placed so the login:
 *
 *   allowed   may manage it (the member: homed in H; the owner: in Admin)
 *   editOnly  may edit, not manage (homed in X, granted to W or to Admin
 *             with Write on)
 *   noEdit    reads it, may not edit (the member: homed in R; the owner:
 *             homed in X, granted to Admin with Write off)
 *   noRead    does not read it (the member: homed in O; the owner: homed
 *             in X, no grant to Admin)
 *
 * Every refused cell runs twice on fresh items: with the TypeScript item
 * pre-check (`was`, its words) and with it bypassed (`now`: the database's
 * refusal, or the handler's own answer for an item the scope does not
 * read). Both must leave the item as it was (pcr_probe: its rows, its
 * content rows, its links, grants and history). An allowed cell runs with
 * the pre-check bypassed and must make its write. Once a family's entries
 * are gone the bypass changes nothing for it: `was` and `now` agree, and
 * the file pins `now`. Every answer is printed at the end
 * (docs/actors.md names each changed one).
 *
 * `pnpm test:edit-on` runs this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/precheck-removal.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The TypeScript item pre-check, bypassed while `on` is false. */
const pre = vi.hoisted(() => ({ on: true }));
vi.mock('../../../packages/tools/src/item-write-gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/item-write-gate')>();
  return {
    ...real,
    toolItemWriteRefusalOf: (...args: Parameters<typeof real.toolItemWriteRefusalOf>) =>
      pre.on ? real.toolItemWriteRefusalOf(...args) : Promise.resolve(null),
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

type Who = 'member' | 'admin';
type Place = 'allowed' | 'editOnly' | 'noEdit' | 'noRead';
type Need = 'read' | 'edit' | 'manage';
type Outcome = { ok: boolean; text: string };
type Reply = { isError?: boolean; content?: { text?: string }[] };
/** An item a cell acts on, with what its input needs. */
type Item = { id: string; extra: Record<string, string | number> };

/** What a need lets each placement do. */
const ALLOWED: Record<Need, Place[]> = {
  read: ['allowed', 'editOnly', 'noEdit'],
  edit: ['allowed', 'editOnly'],
  manage: ['allowed'],
};

describe.skipIf(!DB_URL)(
  'the pre-check removal: the database refuses what the pre-check did',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let raw: ReturnType<typeof postgres>;
    let m: typeof import('@mantle/db');
    let t: typeof import('@mantle/tools');
    let ls: typeof import('@mantle/mcp-core');
    let rt: typeof import('@mantle/runtime/agent');
    let actorMode: typeof import('../../../packages/db/src/actor');
    let dir = '';
    const tag = `pcr${randomUUID().slice(0, 6)}`;
    const owner = randomUUID();
    const mem = randomUUID();
    const ws = { admin: '', H: '', R: '', W: '', X: '', O: '' };
    const agentOf: Record<string, string> = {};
    const recorded: string[] = [];

    // ── the fixture ─────────────────────────────────────────────────────────

    const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:pcr', fn) as Promise<T>;

    /** A builtin called as the owner with no scope (the /api/v1 shape: the
     *  system pool, no item check): the fixture's own makes. */
    const sysTool = async (slug: string, input: Record<string, unknown>): Promise<unknown> => {
      const row = { slug, handler: { kind: 'builtin', ref: slug } } as never;
      const res = await sys(() =>
        t.dispatchTool(row, input, {
          ownerId: owner,
          surface: { kind: 'owner', via: 'api' },
          caller: t.apiV1Caller(),
        }),
      );
      if (!res.ok) throw new Error(`fixture ${slug}: ${String(res.error)}`);
      return res.output;
    };
    const idIn = (out: unknown): string => {
      const m0 = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
        typeof out === 'string' ? out : JSON.stringify(out),
      );
      if (!m0) throw new Error(`no id in ${JSON.stringify(out).slice(0, 200)}`);
      return m0[0];
    };

    /** The grants of `who`'s `place` (see the header). */
    const grantsOf = (who: Who, place: Place): [string, boolean, boolean][] => {
      if (who === 'member') {
        if (place === 'allowed') return [[ws.H, true, false]];
        if (place === 'noEdit') return [[ws.R, true, false]];
        if (place === 'editOnly')
          return [
            [ws.X, true, false],
            [ws.W, false, true],
          ];
        return [[ws.O, true, false]];
      }
      if (place === 'allowed') return [[ws.admin, true, false]];
      if (place === 'noEdit')
        return [
          [ws.X, true, false],
          [ws.admin, false, false],
        ];
      if (place === 'editOnly')
        return [
          [ws.X, true, false],
          [ws.admin, false, true],
        ];
      return [[ws.X, true, false]];
    };

    /** Give `id` exactly these grants (its own; none inherited). */
    const grant = async (id: string, grants: [string, boolean, boolean][]) => {
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`delete from item_grants where node_id = ${id}`;
        for (const [w, home, write] of grants) {
          await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${w}, ${home}, ${write})`;
        }
      });
    };

    /** Everything a refused write must leave as it was. */
    const probe = async (id: string) =>
      (await raw<{ p: string }[]>`select pcr_probe(${id}::uuid) as p`)[0]!.p;

    // ── the ways in ─────────────────────────────────────────────────────────

    const callerOf = (who: Who) => ({
      role: who === 'admin' ? ('admin' as const) : ('member' as const),
      anchorId: owner,
      loginId: who === 'admin' ? owner : mem,
      via: 'oauth' as const,
      write: true,
      oauthClientId: tag,
    });
    const actorOf = (who: Who) =>
      who === 'admin' ? m.loginActor(owner, 'owner') : m.loginActor(mem, 'rw');

    /** One call on the login's own MCP surface. */
    const viaMcp = async (who: Who, slug: string, input: Record<string, unknown>) => {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const server = new McpServer({ name: tag, version: '0' });
      ls.registerPreparedTools(server, await ls.prepareCallerTools(callerOf(who) as never));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        const r = (await m.runAsActor(actorOf(who), () =>
          c.callTool({ name: slug, arguments: input }),
        )) as Reply;
        return {
          ok: !(r.isError ?? false),
          text: (r.content ?? []).map((x) => x.text ?? '').join(' '),
        };
      } catch (err) {
        const msg = (err as Error).message;
        if (/Tool \S+ not found/.test(msg)) return { ok: false, text: `not listed: ${msg}` };
        return { ok: false, text: `THROWN ${msg}` };
      } finally {
        await c.close();
      }
    };

    /** One call in an assistant turn of workspace `wsId`, as `who`. */
    const viaTurn = async (
      who: Who,
      wsId: string,
      slug: string,
      input: Record<string, unknown>,
    ) => {
      const row = await sys(() => t.resolveTool(owner, slug));
      if (!row) return { ok: false, text: `no tool row ${slug}` };
      const login = who === 'admin' ? owner : mem;
      try {
        const res = await m.runAsActor(actorOf(who), () =>
          rt.withAgentScope(
            { id: agentOf[wsId]!, ownerId: owner, workspaceId: wsId },
            () =>
              t.dispatchTool(row, input, {
                ownerId: owner,
                surface: { kind: 'web', loginId: login } as never,
                caller: t.turnCaller(),
              }),
            { loginId: login },
          ),
        );
        return {
          ok: res.ok,
          text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error ?? ''),
        };
      } catch (err) {
        return { ok: false, text: `THROWN ${(err as Error).message}` };
      }
    };

    // ── the cells ───────────────────────────────────────────────────────────

    type Family = {
      name: string;
      /** Each tool: its need, how an item is made and its input. */
      tools: {
        slug: string;
        need: Need;
        who: Who[];
        make: (who: Who, place: Place) => Promise<Item>;
        input: (it: Item) => Record<string, unknown>;
        /** Places whose `now` differs from what the need says, and why. */
        now?: Partial<Record<Place, 'refused' | 'ok'>>;
      }[];
      /** The turn cell: the tool, and the workspace whose assistant runs it. */
      turn?: { slug: string; who: Who; place: Place };
    };

    /** One cell: was (pre-check on) and now (bypassed) on fresh items. */
    const runCell = async (
      family: string,
      tool: Family['tools'][number],
      who: Who,
      place: Place,
      way: (input: Record<string, unknown>, it: Item) => Promise<Outcome>,
      label = 'mcp',
    ) => {
      const allowed = ALLOWED[tool.need].includes(place);
      const wantNow = tool.now?.[place] ?? (allowed ? 'ok' : 'refused');
      const once = async (precheck: boolean) => {
        const it = await tool.make(who, place);
        const before = await probe(it.id);
        pre.on = precheck;
        let out: Outcome;
        try {
          out = await way(tool.input(it), it);
        } finally {
          pre.on = true;
        }
        const changed = (await probe(it.id)) !== before;
        return { ...out, changed };
      };
      const was = await once(true);
      const now = await once(false);
      const line = (o: Outcome & { changed: boolean }) =>
        `${o.ok ? 'ok' : 'refused'}${o.changed ? ' changed' : ''}: ${o.text.slice(0, 160).replace(/\s+/g, ' ')}`;
      recorded.push(
        `${family} ${tool.slug} ${label} ${who}/${place}\n      was ${line(was)}\n      now ${line(now)}`,
      );
      return { was, now, wantNow };
    };

    const check = (c: Awaited<ReturnType<typeof runCell>>, name: string) => {
      expect(c.now.text, name).not.toMatch(RAW);
      if (c.wantNow === 'refused') {
        expect(c.now.ok, `${name}: ${c.now.text}`).toBe(false);
        expect(c.now.changed, `${name} changed the item`).toBe(false);
      } else {
        expect(c.now.ok, `${name}: ${c.now.text}`).toBe(true);
      }
    };

    // ── makers ──────────────────────────────────────────────────────────────

    /** A node of `type` by its create tool, then placed. */
    const viaCreate =
      (slug: string, input: () => Record<string, unknown>) => async (who: Who, place: Place) => {
        const id = idIn(await sysTool(slug, input()));
        await grant(id, grantsOf(who, place));
        return { id, extra: {} };
      };
    const n = () => randomUUID().slice(0, 8);
    const note = viaCreate('note_create', () => ({ title: `${tag} note ${n()}`, content: 'body' }));
    const task = viaCreate('task_create', () => ({ title: `${tag} task ${n()}` }));
    const event = viaCreate('event_create', () => ({
      title: `${tag} event ${n()}`,
      startsAt: '2030-01-01T10:00:00Z',
    }));
    const formula = viaCreate('formula_create', () => ({
      title: `${tag} formula ${n()}`,
      spec: {
        id: `f${n()}`,
        name: 'F',
        source: { standard: 'none' },
        variables: [],
        expressions: [],
        piecewise: [],
        lookups: [],
        classifications: [],
      },
    }));
    /** An Admin-only kind: always homed in Admin (the member never reads it). */
    const adminKind =
      (slug: string, input: () => Record<string, unknown>) => async (_who: Who, _place: Place) => {
        const id = idIn(await sysTool(slug, input()));
        await grant(id, [[ws.admin, true, false]]);
        return { id, extra: {} };
      };
    const contact = adminKind('contact_create', () => ({
      first_name: `${tag}`,
      last_name: n(),
    }));
    const journal = adminKind('journal_create', () => ({ body: `${tag} entry ${n()}` }));
    const page = async (who: Who, place: Place, draft = false) => {
      const id = idIn(
        await sysTool('page_create', {
          title: `${tag} page ${n()}`,
          markdown: '# Head\n\nFirst paragraph.\n\nSecond paragraph.',
        }),
      );
      if (draft) await sysTool('page_update_draft', { id, markdown: 'A draft.' });
      await grant(id, grantsOf(who, place));
      return { id, extra: {} };
    };
    /** An open public link on a fresh page. */
    const linkedPage = async (who: Who, place: Place) => {
      const it = await page(who, place);
      await sysTool('page_share', { id: it.id });
      return it;
    };
    /** A notes folder (a branch under notes), placed. */
    const notesFolder = async (who: Who, place: Place) => {
      const id = idIn(
        await sysTool('tree_folder_create', { kind: 'notes', name: `${tag} f ${n()}` }),
      );
      await grant(id, grantsOf(who, place));
      return { id, extra: {} };
    };
    /** A Recall map with two cards (and so a revision), placed. */
    const recall = async (who: Who, place: Place) => {
      const slug = `${tag}-${n()}`;
      const id = idIn(
        await sysTool('recall_map_create', { slug, title: `${tag} map`, enter_when: 'a test' }),
      );
      await sysTool('recall_card_put', { map: slug, card: 'one', title: 'One', body: 'First.' });
      await sysTool('recall_card_put', { map: slug, card: 'two', title: 'Two', body: 'Second.' });
      const [r] = await raw<{ node: string; v: number; rev: string | null }[]>`
      select m.node_id::text as node, m.version as v,
             (select v.id::text from recall_revisions v where v.map_id = m.id
               order by v.created_at desc limit 1) as rev
        from recall_maps m where m.slug = ${slug} and m.owner_id = ${owner}`;
      await grant(r!.node, grantsOf(who, place));
      void id;
      return { id: r!.node, extra: { map: slug, version: r!.v, rev: r!.rev ?? '' } };
    };

    // ── the families ────────────────────────────────────────────────────────

    const BOTH: Who[] = ['member', 'admin'];
    const ADMIN: Who[] = ['admin'];
    const title = (it: Item) => ({ id: it.id, title: `${tag} edited ${n()}` });
    const byId = (it: Item) => ({ id: it.id });

    const FAMILIES: Family[] = [
      {
        name: 'node-edits',
        tools: [
          { slug: 'note_update', need: 'edit', who: BOTH, make: note, input: title },
          { slug: 'task_update', need: 'edit', who: BOTH, make: task, input: title },
          { slug: 'event_update', need: 'edit', who: BOTH, make: event, input: title },
          { slug: 'formula_update', need: 'edit', who: BOTH, make: formula, input: title },
          {
            slug: 'contact_update',
            need: 'edit',
            who: BOTH,
            make: contact,
            input: (it) => ({ id: it.id, description: `${tag} edited` }),
          },
          {
            slug: 'journal_update',
            need: 'edit',
            who: BOTH,
            make: journal,
            input: (it) => ({ id: it.id, body: `${tag} edited` }),
          },
        ],
        turn: { slug: 'note_update', who: 'member', place: 'noEdit' },
      },
      {
        name: 'node-deletes',
        tools: [
          { slug: 'note_delete', need: 'manage', who: BOTH, make: note, input: byId },
          { slug: 'task_delete', need: 'manage', who: BOTH, make: task, input: byId },
          { slug: 'event_delete', need: 'manage', who: BOTH, make: event, input: byId },
          { slug: 'formula_delete', need: 'manage', who: BOTH, make: formula, input: byId },
          { slug: 'contact_delete', need: 'manage', who: BOTH, make: contact, input: byId },
          { slug: 'journal_delete', need: 'manage', who: BOTH, make: journal, input: byId },
        ],
        turn: { slug: 'task_delete', who: 'admin', place: 'editOnly' },
      },
      {
        name: 'reads-and-grants',
        tools: [
          {
            slug: 'process_extraction',
            need: 'read',
            who: BOTH,
            make: note,
            input: (it) => ({ node_id: it.id }),
          },
          {
            slug: 'access_set',
            need: 'manage',
            who: ADMIN,
            make: note,
            input: (it) => ({ node_id: it.id }),
            // It writes nothing since the levels went: every call is refused.
            now: { allowed: 'refused' },
          },
        ],
      },
      {
        name: 'link-closes',
        tools: [
          { slug: 'page_unshare', need: 'edit', who: BOTH, make: linkedPage, input: byId },
          { slug: 'node_unshare', need: 'edit', who: BOTH, make: linkedPage, input: byId },
        ],
      },
      {
        name: 'tree-folder-update',
        tools: [
          {
            slug: 'tree_folder_update',
            need: 'edit',
            who: BOTH,
            make: notesFolder,
            input: (it) => ({ kind: 'notes', folder_id: it.id, icon: 'star' }),
          },
        ],
      },
      {
        name: 'page-lifecycle',
        tools: [
          { slug: 'page_update', need: 'edit', who: BOTH, make: page, input: title },
          {
            slug: 'page_update_draft',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({ id: it.id, markdown: `${tag} draft` }),
          },
          {
            slug: 'page_commit',
            need: 'edit',
            who: BOTH,
            make: (w, p) => page(w, p, true),
            input: byId,
          },
          {
            slug: 'page_discard_draft',
            need: 'edit',
            who: BOTH,
            make: (w, p) => page(w, p, true),
            input: byId,
          },
          { slug: 'page_delete', need: 'manage', who: BOTH, make: page, input: byId },
          {
            slug: 'page_mention',
            need: 'edit',
            who: BOTH,
            make: async (w, p) => {
              const it = await page(w, p);
              const target = await page(w, 'noEdit');
              return { id: it.id, extra: { target: target.id } };
            },
            input: (it) => ({ page_id: it.id, target_id: it.extra.target }),
          },
        ],
        turn: { slug: 'page_update', who: 'member', place: 'noEdit' },
      },
      {
        name: 'page-blocks',
        tools: [
          {
            slug: 'page_block_append',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({ page_id: it.id, markdown: `${tag} appended` }),
          },
          {
            slug: 'page_blocks_apply',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({
              page_id: it.id,
              ops: [{ op: 'append', markdown: `${tag} applied` }],
            }),
          },
          {
            slug: 'page_block_append',
            need: 'edit',
            who: BOTH,
            make: (w, p) => page(w, p, true),
            input: (it) => ({ page_id: it.id, markdown: `${tag} appended to a draft` }),
          },
        ],
      },
      {
        name: 'recall',
        tools: [
          {
            slug: 'recall_card_put',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, title: 'Three', body: 'Third.' }),
          },
          {
            slug: 'recall_card_delete',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, card: 'two', version: it.extra.version }),
          },
          {
            slug: 'recall_map_update',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, title: `${tag} renamed` }),
          },
          {
            slug: 'recall_map_publish',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, published: false, version: it.extra.version }),
          },
          {
            slug: 'recall_cards_reorder',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({
              map: it.extra.map,
              slugs: ['two', 'one'],
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_map_set_slug',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({
              map: it.extra.map,
              slug: `${it.extra.map}-x`,
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_card_set_slug',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({
              map: it.extra.map,
              card: 'two',
              slug: 'deux',
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_revision_restore',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ revision_id: it.extra.rev }),
          },
          {
            slug: 'recall_map_delete',
            need: 'manage',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, confirm: true }),
          },
        ],
      },
    ];

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(DB_URL!);
      dir = await mkdtemp(path.join(tmpdir(), 'precheck-removal-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.FILES_DIR = path.join(dir, 'files');
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'precheck-removal-secret-at-least-32-chars';
      delete process.env.MANTLE_DETACHED_DEV;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('offline in the pre-check removal test', { status: 503 })),
      );
      m = await import('@mantle/db');
      t = await import('@mantle/tools');
      ls = await import('@mantle/mcp-core');
      rt = await import('@mantle/runtime/agent');
      actorMode = await import('../../../packages/db/src/actor');
      raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${mem}, ${`${tag}-member@example.invalid`}, 'x', false, 'member', 'Member')`;
      await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
      await raw`select * from mantle_ws_migrate()`;
      ws.admin = (
        await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
      )[0]!.id;
      for (const key of ['H', 'R', 'W', 'X', 'O'] as const) {
        ws[key] = (
          await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
        )[0]!.id;
      }
      await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${owner}, ${mem})`;
      await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${mem}, true), (${ws.R}, ${mem}, false), (${ws.W}, ${mem}, false)`;
      for (const [key, wsId] of Object.entries(ws)) {
        const id = randomUUID();
        agentOf[wsId] = id;
        await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${owner}, ${`${tag}-${key}`}, ${key}, 'fake/model', 'p',
                ${key === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
      }
      await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
      // The probe: a definer, so it sees the rows whoever ran the cell.
      await raw.unsafe(`
      create or replace function pcr_probe(i uuid) returns text
        language sql stable security definer set search_path = public, pg_temp as $$
        select coalesce((select md5(concat_ws(' | ',
          row_to_json(n)::text,
          (select row_to_json(p)::text from pages p where p.node_id = i),
          (select row_to_json(t)::text from tables t where t.node_id = i),
          (select row_to_json(a)::text from apps a where a.node_id = i),
          (select row_to_json(d)::text from app_databases d where d.app_node_id = i),
          (select row_to_json(r)::text from recall_maps r where r.node_id = i),
          (select string_agg(row_to_json(c)::text, ',' order by c.id)
             from recall_nodes c join recall_maps r on r.id = c.map_id where r.node_id = i),
          (select count(*)::text from recall_revisions v join recall_maps r on r.id = v.map_id
            where r.node_id = i),
          (select string_agg(row_to_json(s)::text, ',' order by s.token)
             from shares s where s.node_id = i),
          (select string_agg(row_to_json(x)::text, ',' order by x.id)
             from node_snapshots x where x.node_id = i),
          (select string_agg(row_to_json(g)::text, ',' order by g.workspace_id)
             from item_grants g where g.node_id = i)))
          from nodes n where n.id = i), 'gone')
      $$;
      revoke all on function pcr_probe(uuid) from public;`);
      // Both checks on: the box's and this process's.
      await raw`select mantle_set_actor_check('on')`;
      await raw`select mantle_set_edit_check('on')`;
      process.env.MANTLE_ACTOR_CHECK = 'on';
      actorMode.noteBoxActorCheckMode('on');
      m.takeActorMisses();
    }, 300_000);

    afterAll(async () => {
      console.log(
        ['pre-check removal, each cell (was: the pre-check; now: bypassed):', ...recorded].join(
          '\n  ',
        ),
      );
      pre.on = true;
      process.env.MANTLE_ACTOR_CHECK = 'warn';
      vi.unstubAllGlobals();
      await raw?.end();
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    for (const family of FAMILIES) {
      describe(family.name, () => {
        for (const tool of family.tools) {
          for (const who of tool.who) {
            it(`${tool.slug} (${tool.need}) as ${who}: refused where it was, by the database now`, async () => {
              for (const place of ['noRead', 'noEdit', 'editOnly', 'allowed'] as const) {
                const c = await runCell(family.name, tool, who, place, (input) =>
                  viaMcp(who, tool.slug, input),
                );
                check(c, `${tool.slug} ${who}/${place}`);
              }
            }, 300_000);
          }
        }
        if (family.turn) {
          const turn = family.turn;
          it(`a turn: ${turn.slug} as ${turn.who}/${turn.place}`, async () => {
            const tool = family.tools.find((x) => x.slug === turn.slug)!;
            const wsId =
              turn.who === 'admin'
                ? ws.admin
                : turn.place === 'noEdit'
                  ? ws.R
                  : turn.place === 'editOnly'
                    ? ws.W
                    : ws.H;
            const c = await runCell(
              family.name,
              tool,
              turn.who,
              turn.place,
              (input) => viaTurn(turn.who, wsId, turn.slug, input),
              'turn',
            );
            check(c, `turn ${turn.slug} ${turn.who}/${turn.place}`);
          }, 120_000);
        }
      });
    }
  },
);
