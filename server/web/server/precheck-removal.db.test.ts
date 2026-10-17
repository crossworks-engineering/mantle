/**
 * The pre-check removal's proof (docs/actors.md, "Pre-check deletion", A4
 * step 4 and A5 step 6b): for each tool whose TypeScript item pre-check
 * goes, the same refusal now comes from the database, with both checks on.
 *
 * Each cell runs the product's own path on a migrated scratch database with
 * the actor check and the edit check on: a tool call on the login's own MCP
 * surface (prepareCallerTools, an OAuth connection; the scope of all its
 * workspaces) or in an assistant turn of one workspace (dispatchTool, the
 * turn caller). Two logins: a member (a Moderator of H, a user of R and of
 * W) and the owner (an Admin user). Each item is placed so the login:
 *
 *   allowed   may manage it (the member: homed in H; the owner: in Admin)
 *   editOnly  may edit, not manage (homed in X, granted to W or to Admin
 *             with Write on)
 *   noEdit    reads it, may not edit (the member: homed in R; the owner:
 *             homed in X, granted to Admin with Write off)
 *   noRead    does not read it (the member: homed in O; the owner: homed
 *             in X, no grant to Admin)
 *
 * Every cell runs twice on fresh items: with the TypeScript item pre-check
 * (`was`) and with it bypassed (`now`: the database's refusal, or the
 * handler's own answer for an item the scope does not read). A refused
 * cell must leave the item as it was (pcr_probe: its rows, its content
 * rows, links, grants and history; the tables and files stores on disk),
 * an allowed one must make its write. Run on the code before the removal,
 * `was` recorded the pre-check's words (docs/actors.md names each changed
 * answer); every family here has lost its entries since, so the bypass
 * changes nothing and `was` must answer as `now`. Since Part 3 (the
 * `legacy` family: the last 29, each library asking the item first) no tool
 * item pre-check is left: `was` and `now` run the same code, and the cells
 * pin the answers. Every answer is printed at the end.
 *
 * It sets both checks on itself, so it runs in `pnpm test` only (not again
 * in `pnpm test:edit-on`, where its 160 cells were that run's long pole and
 * its load made other suites miss their limits on CI: fix round A).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/precheck-removal.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Was: the TypeScript item pre-check, bypassed while `on` is false. None is
 *  left since Part 3 (the mock went with toolItemWriteRefusalOf): `was` and
 *  `now` run the same code, so each cell pins that the answer is stable. */
const pre = vi.hoisted(() => ({ on: true }));

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
type Way = 'mcp' | 'turn';
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
const PLACES: readonly Place[] = ['noRead', 'noEdit', 'editOnly', 'allowed'];

/** What a store root holds: every file but SQLite's journals, its size,
 *  mtime and bytes. */
function diskOf(root: string): string {
  if (!existsSync(root)) return '';
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/-(wal|shm)$/.test(e.name)) {
        const s = statSync(p);
        const h = createHash('md5').update(readFileSync(p)).digest('hex');
        out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs} ${h}`);
      }
    }
  };
  walk(root);
  return out.sort().join('\n');
}

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
    let f: typeof import('@mantle/files');
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
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    const idIn = (out: unknown): string => {
      const m0 = UUID.exec(typeof out === 'string' ? out : JSON.stringify(out));
      if (!m0) throw new Error(`no id in ${JSON.stringify(out).slice(0, 200)}`);
      return m0[0];
    };
    const n = () => randomUUID().slice(0, 8);

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
    const place = (who: Who, p: Place) => (id: string) => grant(id, grantsOf(who, p));

    /** The owner's items: a refused copy, split or conversion makes none. */
    const nodeCount = async () =>
      (
        await raw<{ c: number }[]>`select count(*)::int as c from nodes where owner_id = ${owner}`
      )[0]!.c;

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
    const viaMcp = async (
      who: Who,
      slug: string,
      input: Record<string, unknown>,
    ): Promise<Outcome> => {
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

    /** The workspace whose assistant runs `who`'s turn on a `p` item: one
     *  that reads it where the login does. */
    const turnWs = (who: Who, p: Place) =>
      who === 'admin' ? ws.admin : p === 'allowed' ? ws.H : p === 'editOnly' ? ws.W : ws.R;

    /** One call in an assistant turn, as `who`, the builtin's row (or one
     *  made for an MCP-only builtin, as /api/v1 makes it). */
    const viaTurn = async (
      who: Who,
      p: Place,
      slug: string,
      input: Record<string, unknown>,
    ): Promise<Outcome> => {
      const wsId = turnWs(who, p);
      const row =
        (await sys(() => t.resolveTool(owner, slug))) ??
        ({ slug, handler: { kind: 'builtin', ref: slug } } as never);
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

    /** The queue-time answer to the same call in the same turn (R0 fix
     *  round L2): what the tool loop asks before it queues a call for
     *  approval (turnCallRefusal), null when it would queue. */
    const queueInTurn = async (
      who: Who,
      p: Place,
      slug: string,
      input: Record<string, unknown>,
    ): Promise<string | null> => {
      const wsId = turnWs(who, p);
      const row =
        (await sys(() => t.resolveTool(owner, slug))) ??
        ({ slug, handler: { kind: 'builtin', ref: slug } } as never);
      const login = who === 'admin' ? owner : mem;
      return m.runAsActor(actorOf(who), () =>
        rt.withAgentScope(
          { id: agentOf[wsId]!, ownerId: owner, workspaceId: wsId },
          () =>
            t.turnCallRefusal(row, input, {
              ownerId: owner,
              surface: { kind: 'web', loginId: login } as never,
            }),
          { loginId: login },
        ),
      );
    };

    // ── the cells ───────────────────────────────────────────────────────────

    type Tool = {
      slug: string;
      need: Need;
      who: Who[];
      /** Make a fresh item for `who` placed at `p` (place it last). */
      make: (who: Who, p: Place) => Promise<Item>;
      input: (it: Item) => Record<string, unknown>;
      /** The ways in it runs on (MCP by default). */
      ways?: Way[];
      /** A kind that lives in Admin only: the member never reads it, the
       *  owner always may (one cell each). */
      adminKind?: true;
      /** Places whose `now` differs from what the need says (the database is
       *  stricter, or the tool refuses every call). */
      now?: Partial<Record<Place, 'refused' | 'ok'>>;
      /** A refused cell that changes the item before its refusal, as it did
       *  with the pre-check (`was` changed too): by login, its places. */
      partial?: Partial<Record<Who, Place[]>>;
      /** `now` by login, over `now`. */
      nowBy?: Partial<Record<Who, Partial<Record<Place, 'refused' | 'ok'>>>>;
      /** A store on disk a refused cell must leave as it was. */
      disk?: () => string;
      /** The placements it runs on (all by default): an allowed write whose
       *  success needs more than this fixture holds (a build, a schema, a
       *  seed) runs on the refused ones only. */
      places?: readonly Place[];
      /** A write that makes new items (a copy, a split, a conversion): a
       *  refused cell must make none (the owner's node count). */
      count?: true;
    };
    type Family = { name: string; tools: Tool[] };

    type Cell = Outcome & { changed: boolean };

    /** One cell: was (pre-check on) and now (bypassed) on fresh items. */
    const runCell = async (family: string, tool: Tool, who: Who, p: Place, way: Way) => {
      const effective: Place = tool.adminKind ? (who === 'admin' ? 'allowed' : 'noRead') : p;
      const allowed = ALLOWED[tool.need].includes(effective);
      const wantNow =
        tool.nowBy?.[who]?.[effective] ?? tool.now?.[effective] ?? (allowed ? 'ok' : 'refused');
      const once = async (precheck: boolean): Promise<Cell> => {
        const it = await tool.make(who, p);
        const before = await probe(it.id);
        const diskBefore = tool.disk?.() ?? '';
        const countBefore = tool.count ? await nodeCount() : 0;
        pre.on = precheck;
        let out: Outcome;
        try {
          const input = tool.input(it);
          out =
            way === 'mcp'
              ? await viaMcp(who, tool.slug, input)
              : await viaTurn(who, p, tool.slug, input);
        } finally {
          pre.on = true;
        }
        const changed =
          (await probe(it.id)) !== before ||
          (tool.disk ? tool.disk() !== diskBefore : false) ||
          (tool.count ? (await nodeCount()) !== countBefore : false);
        return { ...out, changed };
      };
      const was = await once(true);
      const now = await once(false);
      const line = (o: Cell) =>
        `${o.ok ? 'ok' : 'refused'}${o.changed ? ' changed' : ''}: ${o.text.slice(0, 170).replace(/\s+/g, ' ')}`;
      recorded.push(
        `${family} ${tool.slug} ${way} ${who}/${effective}\n      was ${line(was)}\n      now ${line(now)}`,
      );
      const partial = tool.partial?.[who]?.includes(effective) === true;
      return { was, now, wantNow, partial };
    };

    const check = (c: Awaited<ReturnType<typeof runCell>>, name: string) => {
      expect(c.now.text, name).not.toMatch(RAW);
      if (c.wantNow === 'refused') {
        expect(c.now.ok, `${name}: ${c.now.text}`).toBe(false);
        // A partial write is one the pre-check let through too.
        expect(c.now.changed, `${name} changed the item`).toBe(c.partial && c.was.changed);
      } else {
        expect(c.now.ok, `${name}: ${c.now.text}`).toBe(true);
      }
      // The entry is gone: bypassing the pre-check changes nothing (`was`,
      // run with it, answers as `now`): the same outcome, and a refusal in
      // the same words (ids and made-up names aside; a made item's reply
      // carries its own times).
      expect({ ok: c.was.ok, changed: c.was.changed }, name).toEqual({
        ok: c.now.ok,
        changed: c.now.changed,
      });
      if (!c.now.ok) expect(plain(c.was.text), name).toBe(plain(c.now.text));
    };
    /** A reply without what each run makes up: ids, the tag, random names. */
    const plain = (text: string) =>
      text
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
        .replace(new RegExp(UUID.source, 'g'), 'ID')
        .replace(new RegExp(`${tag}\\w*`, 'g'), 'TAG')
        // A made-up 8-hex suffix (a map's slug, TAG-map-cdfacaba) may hold
        // no digit: about 1 in 2,500 (a flake, 2026-10-17).
        .replace(/(?<=-)[0-9a-f]{8}\b/g, 'H')
        .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{4,}\b/g, 'H')
        .replace(/v_[a-z0-9]{8}/g, 'V');

    // ── makers ──────────────────────────────────────────────────────────────

    /** A node made by its create tool, then placed. */
    const viaCreate =
      (slug: string, input: () => Record<string, unknown>) => async (who: Who, p: Place) => {
        const id = idIn(await sysTool(slug, input()));
        await place(who, p)(id);
        return { id, extra: {} };
      };
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
    /** An Admin-only kind: always homed in Admin. */
    const adminKind =
      (slug: string, input: () => Record<string, unknown>) => async (_who: Who, _p: Place) => {
        const id = idIn(await sysTool(slug, input()));
        await grant(id, [[ws.admin, true, false]]);
        return { id, extra: {} };
      };
    const contact = adminKind('contact_create', () => ({ first_name: tag, last_name: n() }));
    const journal = adminKind('journal_create', () => ({ body: `${tag} entry ${n()}` }));

    const page = async (who: Who, p: Place, draft = false) => {
      const id = idIn(
        await sysTool('page_create', {
          title: `${tag} page ${n()}`,
          markdown: '# Head\n\nFirst paragraph.\n\nSecond paragraph.',
        }),
      );
      if (draft) await sysTool('page_update_draft', { id, markdown: 'A draft.\n\nIts second.' });
      await place(who, p)(id);
      return { id, extra: {} };
    };
    const draftPage = (who: Who, p: Place) => page(who, p, true);
    /** A page with an open public link. */
    const linkedPage = async (who: Who, p: Place) => {
      const it = await page(who, p);
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`insert into shares (token, owner_id, node_id, node_type)
                 values (${`${tag}-${randomUUID()}`}, ${owner}, ${it.id}, 'page')`;
      });
      return it;
    };
    /** A notes folder (a branch under notes), placed. */
    const notesFolder = async (who: Who, p: Place) => {
      const id = idIn(
        await sysTool('tree_folder_create', { kind: 'notes', name: `${tag} f ${n()}` }),
      );
      await place(who, p)(id);
      return { id, extra: {} };
    };
    /** A Recall map with two cards (and so a revision), placed. */
    const recall = async (who: Who, p: Place) => {
      const out = await sysTool('recall_map_create', {
        title: `${tag} map ${n()}`,
        enter_when: 'a test',
      });
      const ref = idIn(out);
      const [r0] = await raw<{ slug: string }[]>`
      select slug from recall_maps where (id = ${ref} or node_id = ${ref}) and owner_id = ${owner}`;
      const slug = r0!.slug;
      const version = async () =>
        (
          await raw<{ v: number }[]>`select version as v from recall_maps
                                     where slug = ${slug} and owner_id = ${owner}`
        )[0]!.v;
      for (const t0 of ['One', 'Two']) {
        await sysTool('recall_card_put', {
          map: slug,
          title: t0,
          body: `${t0}.`,
          version: await version(),
        });
      }
      const [r] = await raw<
        { node: string; v: number; rev: string | null; one: string; two: string }[]
      >`
      select m.node_id::text as node, m.version as v,
             (select v.id::text from recall_revisions v where v.map_id = m.id
               order by v.created_at desc limit 1) as rev,
             (select c.slug from recall_nodes c where c.map_id = m.id and c.title = 'One') as one,
             (select c.slug from recall_nodes c where c.map_id = m.id and c.title = 'Two') as two
        from recall_maps m where m.slug = ${slug} and m.owner_id = ${owner}`;
      await place(who, p)(r!.node);
      return {
        id: r!.node,
        extra: { map: slug, version: r!.v, rev: r!.rev ?? '', one: r!.one, two: r!.two },
      };
    };

    /** A table with two columns, two rows (one row id kept), placed. With
     *  `prep`, more set up as the owner first (a tab, a draft, a snapshot). */
    const table =
      (prep?: (id: string) => Promise<Record<string, string>>) => async (who: Who, p: Place) => {
        const id = idIn(
          await sysTool('table_create', {
            title: `${tag} table ${n()}`,
            columns: [
              { name: 'Name', type: 'text' },
              { name: 'Other', type: 'text' },
            ],
          }),
        );
        await sysTool('table_rows_add', {
          table_id: id,
          rows: [
            { Name: 'a', Other: '1' },
            { Name: 'b', Other: '2' },
          ],
        });
        await sysTool('table_commit', { id });
        const listed = (await sysTool('table_rows_list', { table_id: id })) as {
          rows: { id: string }[];
        };
        const extra: Record<string, string> = { row: listed.rows[0]!.id };
        if (prep) Object.assign(extra, await prep(id));
        await place(who, p)(id);
        return { id, extra };
      };
    const tableWithTab = table(async (id) => {
      await sysTool('table_tab_add', { table_id: id, name: 'Second' });
      await sysTool('table_commit', { id });
      return {};
    });
    const tableWithDraft = table(async (id) => {
      await sysTool('table_row_add', { table_id: id, cells: { Name: 'draft' } });
      return {};
    });
    const tableWithSnapshot = table(async (id) => {
      const out = (await sysTool('table_snapshot_create', { id, note: 'kept' })) as {
        snapshot: { id: string };
      };
      return { snapshot: out.snapshot.id };
    });
    const tableDisk = () => diskOf(path.join(dir, 'tables'));

    /** A Files folder, or a file, at the Files root, placed. */
    const filesFolder = async (who: Who, p: Place) => {
      const slug = `${tag}${n()}`;
      const r = await sys(() => f.createFolder({ ownerId: owner, parentPath: 'files', slug }));
      await place(who, p)(r.id);
      return { id: r.id, extra: { path: `files.${slug}` } };
    };
    const filesFile = async (who: Who, p: Place) => {
      const r = await sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `${tag}-${n()}.bin`,
          bytes: Buffer.from([0, 1, 2, 3, 255, 254]),
        }),
      );
      await place(who, p)(r.id);
      return { id: r.id, extra: {} };
    };
    /** A destination folder the login may create in (its own allowed one). */
    const withDest =
      (make: (who: Who, p: Place) => Promise<Item>) => async (who: Who, p: Place) => {
        const dest = await filesFolder(who, 'allowed');
        const it = await make(who, p);
        return { id: it.id, extra: { ...it.extra, dest: dest.extra.path! } };
      };
    const filesDisk = () => diskOf(path.join(dir, 'files'));

    /** An app with a draft file, placed. With `snapshot`, one snapshot. */
    const app =
      (snapshot = false) =>
      async (who: Who, p: Place) => {
        const id = idIn(await sysTool('app_create', { name: `${tag} app ${n()}` }));
        await sysTool('app_file_write', { id, path: 'extra.js', content: 'export const x = 1;' });
        const extra: Record<string, string> = {};
        if (snapshot) {
          const out = (await sysTool('app_snapshot_create', { id, note: 'kept' })) as {
            snapshot: { id: string };
          };
          extra.snapshot = out.snapshot.id;
        }
        await place(who, p)(id);
        return { id, extra };
      };

    const appsDisk = () => diskOf(path.join(dir, 'apps'));
    /** A page whose published blocks are named: its heading (h) and its two
     *  paragraphs (b, c). */
    const pageBlocks = async (who: Who, p: Place) => {
      const it = await page(who, p);
      const ids = (
        await raw<{ b: string }[]>`select e->'attrs'->>'id' as b
          from pages p, jsonb_array_elements(p.doc->'content') with ordinality as x(e, i)
         where p.node_id = ${it.id} order by i`
      ).map((r) => r.b);
      return { id: it.id, extra: { h: ids[0]!, b: ids[1]!, c: ids[2]! } };
    };
    /** A markdown file the conversion reads. */
    const mdFile = async (who: Who, p: Place) => {
      const r = await sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `${tag}-${n()}.md`,
          bytes: Buffer.from('# From a file\n\nIts paragraph.\n'),
        }),
      );
      await place(who, p)(r.id);
      return { id: r.id, extra: {} };
    };
    /** An open question in the Journal (Admin only). */
    const gap = adminKind('journal_create', () => ({ body: `${tag} gap ${n()}?`, kind: 'gap' }));

    // ── the families ────────────────────────────────────────────────────────

    const BOTH: Who[] = ['member', 'admin'];
    const ADMIN: Who[] = ['admin'];
    const title = (it: Item) => ({ id: it.id, title: `${tag} edited ${n()}` });
    const byId = (it: Item) => ({ id: it.id });
    const tid = (it: Item, more: Record<string, unknown> = {}) => ({ table_id: it.id, ...more });

    const FAMILIES: Family[] = [
      {
        name: 'node-edits',
        tools: [
          {
            slug: 'note_update',
            need: 'edit',
            who: BOTH,
            make: note,
            input: title,
            ways: ['mcp', 'turn'],
          },
          { slug: 'task_update', need: 'edit', who: BOTH, make: task, input: title },
          { slug: 'event_update', need: 'edit', who: BOTH, make: event, input: title },
          { slug: 'formula_update', need: 'edit', who: BOTH, make: formula, input: title },
          {
            slug: 'contact_update',
            need: 'edit',
            who: BOTH,
            adminKind: true,
            make: contact,
            input: (it) => ({ id: it.id, description: `${tag} edited` }),
          },
          {
            slug: 'journal_update',
            need: 'edit',
            who: BOTH,
            adminKind: true,
            make: journal,
            input: (it) => ({ id: it.id, body: `${tag} edited` }),
          },
        ],
      },
      {
        name: 'node-deletes',
        tools: [
          { slug: 'note_delete', need: 'manage', who: BOTH, make: note, input: byId },
          {
            slug: 'task_delete',
            need: 'manage',
            who: BOTH,
            make: task,
            input: byId,
            ways: ['mcp', 'turn'],
          },
          { slug: 'event_delete', need: 'manage', who: BOTH, make: event, input: byId },
          { slug: 'formula_delete', need: 'manage', who: BOTH, make: formula, input: byId },
          {
            slug: 'contact_delete',
            need: 'manage',
            who: BOTH,
            adminKind: true,
            make: contact,
            input: byId,
          },
          {
            slug: 'journal_delete',
            need: 'manage',
            who: BOTH,
            adminKind: true,
            make: journal,
            input: byId,
          },
        ],
      },
      {
        name: 'reads-and-grants',
        tools: [
          {
            slug: 'process_extraction',
            need: 'read',
            who: ADMIN,
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
          // An Admin user with the users area closes any link (closing only
          // narrows): the pre-check asks nothing of it, nor the database.
          {
            slug: 'page_unshare',
            need: 'edit',
            who: BOTH,
            make: linkedPage,
            input: byId,
            nowBy: { admin: { noEdit: 'ok' } },
          },
          {
            slug: 'node_unshare',
            need: 'edit',
            who: BOTH,
            make: linkedPage,
            input: byId,
            // A link it cannot see is no link to close: closed nothing.
            nowBy: { admin: { noEdit: 'ok', noRead: 'ok' } },
          },
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
            input: (it) => ({ kind: 'notes', folder_id: it.id, icon: 'lucide:star' }),
          },
          {
            slug: 'tree_folder_update',
            need: 'edit',
            who: BOTH,
            make: notesFolder,
            input: (it) => ({ kind: 'notes', folder_id: it.id, name: `${tag} renamed ${n()}` }),
            // A rename rewrites the paths below it: the database asks manage.
            now: { editOnly: 'refused' },
          },
          {
            slug: 'tree_folder_update',
            need: 'manage',
            who: BOTH,
            make: async (w, p) => {
              const dest = await notesFolder(w, 'allowed');
              const it = await notesFolder(w, p);
              return { id: it.id, extra: { dest: dest.id } };
            },
            input: (it) => ({
              kind: 'notes',
              folder_id: it.id,
              parent_id: it.extra.dest,
              confirm: true,
            }),
          },
        ],
      },
      {
        name: 'page-lifecycle',
        tools: [
          {
            slug: 'page_update',
            need: 'edit',
            who: BOTH,
            make: page,
            input: title,
            ways: ['mcp', 'turn'],
          },
          {
            slug: 'page_update_draft',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({ id: it.id, markdown: `${tag} draft` }),
          },
          {
            slug: 'page_update_draft',
            need: 'edit',
            who: BOTH,
            make: draftPage,
            input: (it) => ({ id: it.id, markdown: `${tag} over a draft` }),
          },
          { slug: 'page_commit', need: 'edit', who: BOTH, make: draftPage, input: byId },
          { slug: 'page_discard_draft', need: 'edit', who: BOTH, make: draftPage, input: byId },
          { slug: 'page_delete', need: 'manage', who: BOTH, make: page, input: byId },
          {
            slug: 'page_replace_from_file',
            need: 'edit',
            who: BOTH,
            make: async (w, p) => {
              // The source: a markdown file the login reads and may change.
              const file = await sys(() =>
                f.upsertFile({
                  ownerId: owner,
                  parentPath: 'files',
                  filename: `${tag}-${n()}.md`,
                  bytes: Buffer.from('# From a file\n\nIts paragraph.\n'),
                }),
              );
              await place(w, 'allowed')(file.id);
              const it = await page(w, p);
              return { id: it.id, extra: { file: file.id } };
            },
            input: (it) => ({ page_id: it.id, file_id: it.extra.file }),
          },
          {
            slug: 'page_move',
            need: 'manage',
            who: BOTH,
            make: async (w, p) => {
              const pageDest = idIn(
                await sysTool('tree_folder_create', { kind: 'pages', name: `${tag} pf ${n()}` }),
              );
              await place(w, 'allowed')(pageDest);
              const it = await page(w, p);
              return { id: it.id, extra: { dest: pageDest } };
            },
            input: (it) => ({ id: it.id, folder_id: it.extra.dest, confirm: true }),
          },
          {
            // Unconfirmed: a move that changes who sees the page names the
            // workspaces it adds (the destination's, the caller's own) and
            // waits for confirm; a scope that may not move the page hears
            // that first now, then the database's refusal once confirmed.
            slug: 'page_move',
            need: 'manage',
            who: BOTH,
            make: async (w, p) => {
              const pageDest = idIn(
                await sysTool('tree_folder_create', { kind: 'pages', name: `${tag} pf ${n()}` }),
              );
              await place(w, 'allowed')(pageDest);
              const it = await page(w, p);
              return { id: it.id, extra: { dest: pageDest } };
            },
            input: (it) => ({ id: it.id, folder_id: it.extra.dest }),
          },
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
          {
            slug: 'page_mention',
            need: 'edit',
            who: BOTH,
            make: async (w, p) => {
              const it = await draftPage(w, p);
              const target = await page(w, 'noEdit');
              return { id: it.id, extra: { target: target.id } };
            },
            input: (it) => ({ page_id: it.id, target_id: it.extra.target }),
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
            ways: ['mcp', 'turn'],
          },
          {
            slug: 'recall_card_delete',
            need: 'edit',
            who: BOTH,
            make: recall,
            input: (it) => ({ map: it.extra.map, card: it.extra.two, version: it.extra.version }),
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
            who: ADMIN,
            make: recall,
            input: (it) => ({ map: it.extra.map, published: true, version: it.extra.version }),
          },
          {
            slug: 'recall_cards_reorder',
            need: 'edit',
            who: ADMIN,
            make: recall,
            input: (it) => ({
              map: it.extra.map,
              slugs: [it.extra.two, it.extra.one],
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_map_set_slug',
            need: 'edit',
            who: ADMIN,
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
            who: ADMIN,
            make: recall,
            input: (it) => ({
              map: it.extra.map,
              card: it.extra.two,
              slug: 'deux',
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_prompt_confirm',
            need: 'edit',
            who: ADMIN,
            make: async (w, p) => {
              const it = await recall(w, p);
              await raw.begin(async (tx) => {
                await tx`select set_config('mantle.actor', 'system:test', true)`;
                await tx`update recall_nodes c set prompt_pending = true
                           from recall_maps m
                          where m.id = c.map_id and m.node_id = ${it.id} and c.slug = ${it.extra.two}`;
              });
              return it;
            },
            input: (it) => ({
              map: it.extra.map,
              card: it.extra.two,
              confirm: false,
              version: it.extra.version,
            }),
          },
          {
            slug: 'recall_revision_restore',
            need: 'edit',
            who: ADMIN,
            make: recall,
            input: (it) => ({ revision_id: it.extra.rev }),
          },
          {
            slug: 'recall_map_delete',
            need: 'manage',
            who: ADMIN,
            make: recall,
            input: (it) => ({ map: it.extra.map, confirm: true }),
          },
        ],
      },
      {
        name: 'tables',
        tools: (
          [
            ['table_column_add', table(), (it: Item) => tid(it, { name: 'Extra', type: 'text' })],
            [
              'table_column_update',
              table(),
              (it: Item) => tid(it, { column: 'Other', name: 'Renamed' }),
            ],
            ['table_column_delete', table(), (it: Item) => tid(it, { column: 'Other' })],
            [
              'table_set_aggregate',
              table(),
              (it: Item) => tid(it, { column: 'Name', kind: 'count' }),
            ],
            ['table_set_view', table(), (it: Item) => tid(it, { name: `${tag} view` })],
            ['table_row_add', table(), (it: Item) => tid(it, { cells: { Name: 'c' } })],
            ['table_rows_add', table(), (it: Item) => tid(it, { rows: [{ Name: 'd' }] })],
            [
              'table_rows_upsert',
              table(),
              (it: Item) => tid(it, { key: ['Name'], rows: [{ Name: 'e', Other: '5' }] }),
            ],
            [
              'table_row_update',
              table(),
              (it: Item) => tid(it, { row_id: it.extra.row, cells: { Name: 'u' } }),
            ],
            ['table_row_delete', table(), (it: Item) => tid(it, { row_id: it.extra.row })],
            [
              'table_cell_set',
              table(),
              (it: Item) => tid(it, { row_id: it.extra.row, column: 'Name', value: 'v' }),
            ],
            ['table_tab_add', table(), (it: Item) => tid(it, { name: 'Third' })],
            [
              'table_tab_rename',
              tableWithTab,
              (it: Item) => tid(it, { tab: 'Second', name: 'Renamed' }),
            ],
            ['table_tab_delete', tableWithTab, (it: Item) => tid(it, { tab: 'Second' })],
            ['table_update', table(), title],
            ['table_commit', tableWithDraft, byId],
            ['table_snapshot_create', table(), byId],
            [
              'table_snapshot_restore',
              tableWithSnapshot,
              (it: Item) => ({ id: it.id, snapshot_id: it.extra.snapshot }),
            ],
            [
              'table_snapshot_delete',
              tableWithSnapshot,
              (it: Item) => ({ id: it.id, snapshot_id: it.extra.snapshot }),
            ],
          ] as const
        )
          .map(([slug, make, input]): Tool => ({
            slug,
            need: 'edit',
            who: BOTH,
            make,
            input,
            disk: tableDisk,
            ...(slug === 'table_row_add' ? { ways: ['mcp', 'turn'] as Way[] } : {}),
          }))
          .concat([
            {
              slug: 'table_delete',
              need: 'manage',
              who: BOTH,
              make: table(),
              input: byId,
              disk: tableDisk,
            },
          ]),
      },
      {
        name: 'files',
        tools: [
          // On MCP these three are the hand-written tools; in a turn, the builtins.
          {
            slug: 'file_rename',
            need: 'edit',
            who: BOTH,
            make: filesFile,
            input: (it) => ({ file_id: it.id, new_stem: `${tag}-renamed-${n()}` }),
            ways: ['mcp', 'turn'],
            disk: filesDisk,
          },
          {
            slug: 'folder_rename',
            need: 'edit',
            who: BOTH,
            make: filesFolder,
            input: (it) => ({ folder_id: it.id, new_name: `${tag} Renamed ${n()}` }),
            ways: ['mcp', 'turn'],
            // A rename rewrites the paths below it: the database asks manage.
            now: { editOnly: 'refused' },
            disk: filesDisk,
          },
          {
            slug: 'folder_describe',
            need: 'edit',
            who: BOTH,
            make: filesFolder,
            input: (it) => ({ folder_id: it.id, description: `${tag} described` }),
            ways: ['mcp', 'turn'],
          },
          {
            slug: 'file_set_indexing',
            need: 'edit',
            who: BOTH,
            make: filesFile,
            input: (it) => ({ file_id: it.id, mode: 'metadata' }),
          },
          {
            // Manage of the folder (F4 fix round 3, M1): setIndexingMode
            // asks it (assertItemRight) before the flag changes.
            slug: 'folder_set_indexing',
            need: 'manage',
            who: BOTH,
            make: filesFolder,
            input: (it) => ({ folder_id: it.id, mode: 'metadata' }),
          },
          {
            slug: 'file_move',
            need: 'manage',
            who: BOTH,
            make: withDest(filesFile),
            input: (it) => ({ file_id: it.id, dest_path: it.extra.dest, confirm: true }),
            disk: filesDisk,
          },
          {
            slug: 'folder_move',
            need: 'manage',
            who: BOTH,
            make: withDest(filesFolder),
            input: (it) => ({ folder_id: it.id, dest_parent_path: it.extra.dest, confirm: true }),
            disk: filesDisk,
          },
          {
            slug: 'folder_delete',
            need: 'manage',
            who: BOTH,
            make: filesFolder,
            input: (it) => ({ folder_id: it.id }),
            disk: filesDisk,
          },
        ],
      },
      {
        name: 'app-code',
        tools: (
          [
            [
              'app_file_write',
              app(),
              (it: Item) => ({ id: it.id, path: 'index.html', content: '<p>x</p>' }),
            ],
            ['app_file_delete', app(), (it: Item) => ({ id: it.id, path: 'extra.js' })],
            [
              'app_source_set',
              app(),
              (it: Item) => ({
                id: it.id,
                entry: 'index.html',
                files: { 'index.html': '<p>y</p>' },
              }),
            ],
            ['app_tools_set', app(), (it: Item) => ({ id: it.id, tool_slugs: ['note_list'] })],
          ] as const
        ).map(([slug, make, input]): Tool => ({
          slug,
          // An app's code is a Moderator's of its home (owner decision D4;
          // F4 fix round 3, M3: lockAppRow asks it first). The author
          // ceiling asks manage too (lowerToTeamRules), so a caller that may
          // only edit the app lowers nothing: no partial write.
          need: 'manage',
          who: BOTH,
          make,
          input,
          ...(slug === 'app_file_write' ? { ways: ['mcp', 'turn'] as Way[] } : {}),
        })),
      },
      {
        name: 'app-history',
        tools: [
          { slug: 'app_snapshot_create', need: 'edit', who: BOTH, make: app(), input: byId },
          {
            slug: 'app_snapshot_delete',
            need: 'edit',
            who: BOTH,
            make: app(true),
            input: (it) => ({ id: it.id, snapshot_id: it.extra.snapshot }),
          },
        ],
      },
      {
        // Part 3: the 29 kept entries, each gone once its reason was (the
        // check moved first, before any side effect, or the answer fixed).
        // Recorded on the code before the removal (docs/actors.md, "Pre-check
        // removal Part 3"); since then `was` answers as `now`.
        name: 'legacy',
        tools: [
          // side-effect-before-check
          {
            slug: 'app_build',
            need: 'manage',
            who: BOTH,
            make: app(),
            input: byId,
            places: ['noRead', 'noEdit', 'editOnly'],
          },
          {
            slug: 'app_db_seed',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, table: 't', rows: [{ a: 'x' }] }),
            places: ['noRead', 'noEdit'] as const,
            disk: appsDisk,
          },
          {
            slug: 'app_db_schema_set',
            need: 'manage',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, schema_sql: 'create table if not exists t (a text);' }),
            places: ['noRead', 'noEdit', 'editOnly'],
            disk: appsDisk,
          },
          {
            slug: 'app_delete',
            need: 'manage',
            who: BOTH,
            make: app(),
            input: byId,
            disk: appsDisk,
          },
          {
            slug: 'app_snapshot_restore',
            need: 'manage',
            who: BOTH,
            make: app(true),
            input: (it) => ({ id: it.id, snapshot_id: it.extra.snapshot, mode: 'code' }),
            places: ['noRead', 'noEdit', 'editOnly'],
            disk: appsDisk,
          },
          {
            slug: 'app_snapshot_restore',
            need: 'edit',
            who: BOTH,
            make: app(true),
            input: (it) => ({ id: it.id, snapshot_id: it.extra.snapshot, mode: 'data' }),
            places: ['noRead', 'noEdit'] as const,
            disk: appsDisk,
          },
          {
            slug: 'app_update',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, name: `${tag} renamed ${n()}` }),
            ways: ['mcp', 'turn'],
          },
          {
            slug: 'file_delete',
            need: 'manage',
            who: BOTH,
            make: filesFile,
            input: (it) => ({ file_id: it.id }),
            disk: filesDisk,
          },
          {
            slug: 'file_delete',
            need: 'manage',
            who: BOTH,
            make: filesFile,
            input: (it) => ({ file_id: it.id, delete_derived: true }),
            disk: filesDisk,
          },
          {
            slug: 'journal_resolve_gap',
            need: 'edit',
            who: BOTH,
            adminKind: true,
            make: gap,
            input: (it) => ({ id: it.id, answer: `${tag} the answer` }),
            count: true,
          },
          {
            slug: 'page_split',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({ page_id: it.id, by: 'h1' }),
            count: true,
          },
          {
            slug: 'page_extract_section',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({ page_id: it.id, heading_block_id: it.extra.h }),
            count: true,
          },
          {
            slug: 'tree_folder_delete',
            need: 'manage',
            who: BOTH,
            make: notesFolder,
            input: (it) => ({ kind: 'notes', folder_id: it.id, confirm: true }),
          },
          {
            slug: 'tree_item_move',
            need: 'manage',
            who: BOTH,
            make: async (w, p) => {
              const dest = await notesFolder(w, 'allowed');
              const it = await note(w, p);
              return { id: it.id, extra: { dest: dest.id } };
            },
            input: (it) => ({
              kind: 'notes',
              item_ids: [it.id],
              folder_id: it.extra.dest,
              confirm: true,
            }),
          },
          // db-does-not-check
          {
            slug: 'app_table_export_set',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, table: 't' }),
            places: ['noRead', 'noEdit'] as const,
            count: true,
          },
          {
            slug: 'app_table_export_remove',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, table: 't' }),
            places: ['noRead', 'noEdit'] as const,
          },
          {
            slug: 'content_supersede',
            need: 'edit',
            who: ADMIN,
            make: note,
            input: (it) => ({ node_id: it.id }),
          },
          // read-not-asked (with_data false: a read; the data: an edit)
          {
            slug: 'app_duplicate',
            need: 'read',
            who: BOTH,
            make: app(),
            input: (it) => ({ id: it.id, with_data: false }),
            count: true,
          },
          {
            slug: 'app_duplicate',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: byId,
            places: ['noRead', 'noEdit'] as const,
            count: true,
          },
          {
            slug: 'app_export',
            need: 'read',
            // The owner: a member's export lands in an auto-made exports
            // folder its scope may not make under the Files root here (its
            // first call answers "createFolder: parent folder 'files' not
            // found", with and without the pre-check alike: not this check).
            who: ADMIN,
            make: app(),
            input: (it) => ({ id: it.id, with_data: false }),
            count: true,
          },
          {
            slug: 'app_export',
            need: 'edit',
            who: BOTH,
            make: app(),
            input: byId,
            places: ['noRead', 'noEdit'] as const,
            count: true,
          },
          // answer-worse
          {
            slug: 'app_publish',
            need: 'manage',
            who: BOTH,
            make: app(),
            input: byId,
            // No green build of the draft: the publish itself refuses. A
            // member that may manage the app lowers it to team rules first
            // (the author ceiling), as with the pre-check: its own app.
            now: { allowed: 'refused' },
            partial: { member: ['allowed'] },
          },
          { slug: 'node_share', need: 'edit', who: BOTH, make: page, input: byId },
          { slug: 'page_share', need: 'edit', who: BOTH, make: page, input: byId },
          {
            slug: 'page_block_append',
            need: 'edit',
            who: BOTH,
            make: page,
            input: (it) => ({ page_id: it.id, markdown: `${tag} appended` }),
            ways: ['mcp', 'turn'],
          },
          {
            slug: 'page_block_append',
            need: 'edit',
            who: BOTH,
            make: draftPage,
            input: (it) => ({ page_id: it.id, markdown: `${tag} appended` }),
          },
          {
            slug: 'page_block_update',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({ page_id: it.id, block_id: it.extra.b, markdown: `${tag} updated` }),
          },
          {
            slug: 'page_block_insert_after',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({
              page_id: it.id,
              after_block_id: it.extra.b,
              markdown: `${tag} after`,
            }),
          },
          {
            slug: 'page_block_insert_before',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({
              page_id: it.id,
              before_block_id: it.extra.b,
              markdown: `${tag} before`,
            }),
          },
          {
            slug: 'page_block_delete',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({ page_id: it.id, block_id: it.extra.c }),
          },
          {
            slug: 'page_blocks_apply',
            need: 'edit',
            who: BOTH,
            make: pageBlocks,
            input: (it) => ({
              page_id: it.id,
              ops: [{ op: 'update', block_id: it.extra.b, markdown: `${tag} applied` }],
            }),
          },
          {
            slug: 'page_from_note',
            need: 'edit',
            who: BOTH,
            make: note,
            input: (it) => ({ note_id: it.id }),
            count: true,
          },
          {
            slug: 'page_from_notes',
            need: 'edit',
            who: BOTH,
            make: note,
            input: (it) => ({ note_ids: [it.id], title: `${tag} stitched ${n()}` }),
            count: true,
          },
          {
            slug: 'page_from_file',
            need: 'edit',
            who: BOTH,
            make: mdFile,
            input: (it) => ({ file_id: it.id }),
            count: true,
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
      f = await import('@mantle/files');
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
      await sys(() => f.ensureFilesRootBranch(owner));
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
             from item_grants g where g.node_id = i),
          (select string_agg(row_to_json(c)::text, ',' order by c.id)
             from nodes c where c.path <@ n.path and c.id <> n.id and n.type = 'branch')))
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
            for (const way of tool.ways ?? ['mcp']) {
              it(`${tool.slug} (${tool.need}) as ${who} (${way}): refused by the database where the pre-check refused`, async () => {
                for (const p of tool.adminKind ? (['allowed'] as const) : (tool.places ?? PLACES)) {
                  const c = await runCell(family.name, tool, who, p, way);
                  check(c, `${tool.slug} ${way} ${who}/${p}`);
                }
              }, 300_000);
            }
          }
        }
      });
    }

    // Queue time (R0 fix round L2): a call that waits for approval is
    // refused before it is queued only where its run refuses it, in the
    // run's words (the same turn, the same item, asked first): the check
    // avoids asking an approver about a doomed call and decides nothing the
    // run does not. Each family's tools, each login, each placement.
    for (const family of FAMILIES) {
      it(`queue time (${family.name}): refused before it is queued only as its run refuses it`, async () => {
        let refusedAtQueue = 0;
        const mismatched: string[] = [];
        for (const tool of family.tools) {
          for (const who of tool.who) {
            for (const p of tool.adminKind ? (['allowed'] as const) : (tool.places ?? PLACES)) {
              const it0 = await tool.make(who, p);
              const input = tool.input(it0);
              const queued = await queueInTurn(who, p, tool.slug, input);
              const run = await viaTurn(who, p, tool.slug, input);
              const name = `${tool.slug} ${who}/${p}`;
              recorded.push(
                `queue ${family.name} ${name}: ${queued === null ? 'queues' : `refused: ${plain(queued).slice(0, 100)}`}; run ${run.ok ? 'ok' : `refused: ${plain(run.text).slice(0, 100)}`}`,
              );
              if (queued === null) continue;
              refusedAtQueue += 1;
              if (run.ok || plain(queued) !== plain(run.text)) {
                mismatched.push(
                  `${name}: queue "${queued}", run ${run.ok ? 'ok' : `"${run.text.slice(0, 200)}"`}`,
                );
              }
            }
          }
        }
        recorded.push(`queue ${family.name}: ${refusedAtQueue} refused before they were queued`);
        expect(mismatched).toEqual([]);
      }, 600_000);
    }

    it('link closes: in a turn narrower than the login, the close is refused and the link stays open', async () => {
      // The page: homed in X, Write on for W, read only for R. The member
      // edits it through W; R's assistant reads it and may not edit it. The
      // handler's own rule (assertMayLink) answers first, in the turn's
      // scope; the database's link_close backs it.
      for (const slug of ['page_unshare', 'node_unshare'] as const) {
        const tool: Tool = {
          slug,
          need: 'edit',
          who: ['member'],
          make: async () => {
            const it = await linkedPage('member', 'allowed');
            await grant(it.id, [
              [ws.X, true, false],
              [ws.W, false, true],
              [ws.R, false, false],
            ]);
            return it;
          },
          input: byId,
        };
        const c = await runCell('link-closes', tool, 'member', 'noEdit', 'turn');
        expect(c.was.ok, c.was.text).toBe(false);
        expect(c.was.changed).toBe(false);
        expect(c.now.ok, c.now.text).toBe(false);
        expect(c.now.changed).toBe(false);
        expect(c.now.text).toBe('Only someone who may edit this item may open or close its link.');
      }
    }, 120_000);

    it('legacy: an item the scope does not read answers as a random id, for every one of the 29', async () => {
      const legacy = FAMILIES.find((f0) => f0.name === 'legacy')!.tools;
      for (const tool of legacy) {
        for (const who of tool.who) {
          // An Admin-only kind: the member never reads it.
          if (tool.adminKind && who === 'admin') continue;
          const it0 = await tool.make(who, 'noRead');
          const hidden = await viaMcp(who, tool.slug, tool.input(it0));
          const random = randomUUID();
          const swap = (v: unknown): unknown =>
            v === it0.id ? random : Array.isArray(v) ? v.map(swap) : v;
          const input = Object.fromEntries(
            Object.entries(tool.input(it0)).map(([k, v]) => [k, swap(v)]),
          );
          const missing = await viaMcp(who, tool.slug, input);
          const name = `${tool.slug} ${who}`;
          recorded.push(`legacy hidden-vs-random ${name}: ${plain(hidden.text).slice(0, 120)}`);
          expect(hidden.ok, `${name}: ${hidden.text}`).toBe(false);
          expect(missing.ok, `${name}: ${missing.text}`).toBe(false);
          expect(plain(hidden.text), name).toBe(plain(missing.text));
        }
      }
    }, 300_000);

    it('tree_item_move: a list with one item the scope may not move moves none of them', async () => {
      for (const who of BOTH) {
        for (const precheck of [true, false]) {
          const dest = await notesFolder(who, 'allowed');
          const mine = await note(who, 'allowed');
          const theirs = await note(who, 'noEdit');
          const before = [await probe(mine.id), await probe(theirs.id)];
          pre.on = precheck;
          let out: Outcome;
          try {
            out = await viaMcp(who, 'tree_item_move', {
              kind: 'notes',
              item_ids: [mine.id, theirs.id],
              folder_id: dest.id,
              confirm: true,
            });
          } finally {
            pre.on = true;
          }
          const after = [await probe(mine.id), await probe(theirs.id)];
          recorded.push(
            `legacy tree_item_move list ${who} ${precheck ? 'was' : 'now'}: ${out.ok ? 'ok' : 'refused'}${after[0] !== before[0] ? ' moved-mine' : ''}${after[1] !== before[1] ? ' moved-theirs' : ''}: ${plain(out.text).slice(0, 170)}`,
          );
          expect(out.ok, `${who} ${precheck}: ${out.text}`).toBe(false);
          expect(after, `${who} ${precheck}: nothing moved`).toEqual(before);
        }
      }
    }, 120_000);

    // ── fix round A: the cheap rights read first ─────────────────────────────
    // A write whose handler answers from what the caller may not see (a
    // folder's hidden rows or emptiness, a draft's presence, a name taken by
    // an item it does not read), or stages a copy or takes locks first, asks
    // the caller's right first (assertItemRight, the one gateway): a caller
    // without it gets one answer, whatever the item holds. In on, and in
    // warn (where the database would make the write and log a miss: the
    // read refuses first, so no write and no miss).

    /** One MCP call as `who`, and whether `id` (and the files store) changed. */
    const callOnce = async (who: Who, slug: string, input: Record<string, unknown>, id: string) => {
      const before = await probe(id);
      const disk = filesDisk() + tableDisk();
      const out = await viaMcp(who, slug, input);
      const changed = (await probe(id)) !== before || filesDisk() + tableDisk() !== disk;
      return { ...out, changed, plain: plain(out.text) };
    };
    /** An item inside a folder, hidden from `who`: the rows it takes from
     *  the folder excluded, its home a workspace `who` does not read. */
    const hideIn = async (id: string, who: Who) => {
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`update item_grants set excluded = true, is_home = false, write = false
                  where node_id = ${id}`;
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${who === 'admin' ? ws.X : ws.O}, true, false)
                 on conflict (node_id, workspace_id)
                 do update set excluded = false, is_home = true, write = false, via_folder_id = null`;
      });
    };
    const editCheck = async (mode: 'on' | 'warn') => {
      await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    };
    const REFUSED = /You cannot change this item in your workspaces\./;

    it.each(['on', 'warn'] as const)(
      'M1 (edit check %s): a caller that may not delete or move a folder learns nothing of what it holds',
      async (mode) => {
        await editCheck(mode);
        try {
          for (const who of BOTH) {
            /** A folder the caller reads and may not manage, holding `what`. */
            const folder = async (what: 'empty' | 'visible' | 'hidden' | 'untracked') => {
              const it = await filesFolder(who, 'noEdit');
              const at = it.extra.path!;
              if (what === 'visible' || what === 'hidden') {
                const file = await sys(() =>
                  f.upsertFile({
                    ownerId: owner,
                    parentPath: at,
                    filename: `${tag}-in-${n()}.bin`,
                    bytes: Buffer.from([7, 7, 7]),
                  }),
                );
                // It takes the folder's rows (the caller reads it); hidden:
                // those rows excluded, homed where the caller reads nothing.
                if (what === 'hidden') await hideIn(file.id, who);
              }
              if (what === 'untracked') {
                const d = f.diskPathForLtree(at)!;
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, `${tag}-stray.txt`), 'not tracked');
              }
              return it;
            };
            const dest = (await filesFolder(who, 'allowed')).extra.path!;
            const answers: Record<string, string[]> = { folder_delete: [], folder_move: [] };
            for (const what of ['empty', 'visible', 'hidden', 'untracked'] as const) {
              for (const slug of ['folder_delete', 'folder_move'] as const) {
                const it = await folder(what);
                const input =
                  slug === 'folder_delete'
                    ? { folder_id: it.id }
                    : { folder_id: it.id, dest_parent_path: dest, confirm: true };
                const c = await callOnce(who, slug, input, it.id);
                const name = `${slug} ${who} ${what} (${mode})`;
                recorded.push(`fix-A M1 ${name}: ${c.ok ? 'ok' : 'refused'} ${c.plain}`);
                expect(c.ok, `${name}: ${c.text}`).toBe(false);
                expect(c.changed, `${name} changed it`).toBe(false);
                expect(c.text, name).toMatch(REFUSED);
                expect(c.text, name).not.toMatch(/hold|empty|on disk|track/i);
                answers[slug]!.push(c.plain);
              }
            }
            for (const [slug, got] of Object.entries(answers)) {
              expect(new Set(got).size, `${slug} ${who}: ${got.join(' / ')}`).toBe(1);
            }
          }
          expect(m.takeActorMisses()).toEqual([]);
        } finally {
          await editCheck('on');
        }
      },
      300_000,
    );

    it.each(['on', 'warn'] as const)(
      'drafts (edit check %s): a reader that may not edit gets one answer whether a draft is there or not',
      async (mode) => {
        await editCheck(mode);
        try {
          for (const who of BOTH) {
            const cells: [
              string,
              (w: Who, p: Place) => Promise<Item>,
              (it: Item) => Record<string, unknown>,
            ][] = [
              ['page_commit', page, byId],
              ['page_commit', draftPage, byId],
              ['table_commit', table(), byId],
              ['table_commit', tableWithDraft, byId],
              [
                'table_snapshot_restore',
                tableWithSnapshot,
                (it) => ({ id: it.id, snapshot_id: it.extra.snapshot }),
              ],
              [
                'table_snapshot_restore',
                table(async (id) => {
                  const out = (await sysTool('table_snapshot_create', { id })) as {
                    snapshot: { id: string };
                  };
                  await sysTool('table_row_add', { table_id: id, cells: { Name: 'draft' } });
                  return { snapshot: out.snapshot.id };
                }),
                (it) => ({ id: it.id, snapshot_id: it.extra.snapshot }),
              ],
            ];
            const answers = new Map<string, string[]>();
            for (const [slug, make, input] of cells) {
              const it = await make(who, 'noEdit');
              const c = await callOnce(who, slug, input(it), it.id);
              const name = `${slug} ${who} (${mode})`;
              recorded.push(`fix-A drafts ${name}: ${c.ok ? 'ok' : 'refused'} ${c.plain}`);
              expect(c.ok, `${name}: ${c.text}`).toBe(false);
              expect(c.changed, `${name} changed it`).toBe(false);
              expect(c.text, name).toMatch(REFUSED);
              answers.set(slug, [...(answers.get(slug) ?? []), c.plain]);
            }
            for (const [slug, got] of answers) {
              expect(new Set(got).size, `${slug} ${who}: ${got.join(' / ')}`).toBe(1);
            }
          }
          expect(m.takeActorMisses()).toEqual([]);
        } finally {
          await editCheck('on');
        }
      },
      300_000,
    );

    it('names (edit check on): a caller that may not move or rename a file is not told a name is taken by a file it does not read', async () => {
      for (const who of BOTH) {
        const answers: Record<string, string[]> = { file_move: [], file_rename: [] };
        for (const clash of [false, true]) {
          // file_move: a file the caller may not move, to a folder of its own
          // that holds (or not) a file of the same name the caller does not read.
          const dest = (await filesFolder(who, 'allowed')).extra.path!;
          const name = `${tag}-same-${n()}.bin`;
          const file = await sys(() =>
            f.upsertFile({
              ownerId: owner,
              parentPath: 'files',
              filename: name,
              bytes: Buffer.from([1]),
            }),
          );
          await place(who, 'noEdit')(file.id);
          if (clash) {
            const hidden = await sys(() =>
              f.upsertFile({
                ownerId: owner,
                parentPath: dest,
                filename: name,
                bytes: Buffer.from([2]),
              }),
            );
            await place(who, 'noRead')(hidden.id);
          }
          const mv = await callOnce(
            who,
            'file_move',
            { file_id: file.id, dest_path: dest, confirm: true },
            file.id,
          );
          // file_rename: to the stem of a file it does not read in its folder.
          const stem = `${tag}-taken-${n()}`;
          if (clash) {
            const hidden = await sys(() =>
              f.upsertFile({
                ownerId: owner,
                parentPath: 'files',
                filename: `${stem}.bin`,
                bytes: Buffer.from([3]),
              }),
            );
            await place(who, 'noRead')(hidden.id);
          }
          const rn = await callOnce(
            who,
            'file_rename',
            { file_id: file.id, new_stem: stem },
            file.id,
          );
          for (const [slug, c] of [
            ['file_move', mv],
            ['file_rename', rn],
          ] as const) {
            const cell = `${slug} ${who} ${clash ? 'taken' : 'free'}`;
            recorded.push(`fix-A names ${cell}: ${c.ok ? 'ok' : 'refused'} ${c.plain}`);
            expect(c.ok, `${cell}: ${c.text}`).toBe(false);
            expect(c.changed, `${cell} changed it`).toBe(false);
            expect(c.text, cell).toMatch(REFUSED);
            expect(c.text, cell).not.toMatch(/already exists/);
            answers[slug]!.push(c.plain.replace(/TAG-[\w.-]*/g, 'NAME'));
          }
        }
        for (const [slug, got] of Object.entries(answers)) {
          expect(new Set(got).size, `${slug} ${who}: ${got.join(' / ')}`).toBe(1);
        }
      }
    }, 300_000);
  },
);
