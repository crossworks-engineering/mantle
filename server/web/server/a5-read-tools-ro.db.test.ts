/**
 * Every read builtin, run read only through the app brokers and the dev
 * console, with the actor check and the edit check on (workspaces arch A5
 * step 3b fix round 1, MEDIUM-1; docs/actors.md).
 *
 * Since step 3b the app brokers and the dev console call a tool through the
 * one gate, which runs a tool whose policy is a read READ ONLY (enterCall's
 * callActor: login(ro); system work it starts stays read only, systemUnder),
 * and the database refuses a read-only actor's change of an item table
 * (0280's mantle_edit_check_ro, detail ro_actor). The parity proof
 * (server/web/lib/app-broker-parity.test.ts) runs recorder handlers, so it
 * cannot see what that does to a real handler. Here, on a migrated scratch
 * database, every builtin whose policy says `effect: 'read'` runs with its
 * REAL handler and the REAL pre-run checks (its preconditions, the item
 * rights), with minimal arguments made from its input schema (ids of items
 * seeded first), through each entry's own caller and surface, as the route
 * builds them:
 *
 *  - the dev console (/api/dev-tools/execute-tool): ownerWebCaller(), the
 *    owner's web surface, in the owner's request scope;
 *  - an app broker at admin rules (an app the Admin workspace alone holds):
 *    appBrokerCaller(web), in the owner's request scope;
 *  - an app broker at team rules (an app another workspace holds):
 *    appBrokerCaller(team), in the app's viewer scope (withViewer, as the
 *    broker enters it), the owner running it.
 *
 * A call may fail on its own terms (an argument the sweep made up, an item
 * it did not make, an offline service, a surface that refuses it); it may
 * never fail because it wrote as a read-only actor. Two passes:
 *
 *  - edit check `on`: no call's answer, nor any database error a handler
 *    turned into text, is the read-only refusal (42501 ro_actor);
 *  - edit check `warn`: the refusal is a notice instead (an actor miss), so
 *    a handler that swallows the error is caught too: no call notes one.
 *
 * Plus a recipe whose steps are reads (a nested read runs read only too),
 * and a control: a read builtin of this test's own that writes an item, run
 * directly and as a recipe's step, IS caught by both passes, so neither is
 * vacuous. A real read tool caught here is a read-path write to name
 * (READ_PATH_WRITES) or move: report it, never list it to pass.
 *
 * No database on the Mac: CI runs this.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-read-tools-ro.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Every database error a handler turned into text (errorMessage): its
 *  SQLSTATE, its detail and the database's own message (a drizzle error's
 *  message is its SQL; the refusal is its cause). */
const seen = vi.hoisted(() => ({
  db: [] as { code: string; detail: string; text: string }[],
}));

vi.mock('@mantle/std', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/std')>();
  return {
    ...orig,
    errorMessage: (err: unknown) => {
      for (let e = err as Record<string, unknown> | null, i = 0; e && i < 4; i++) {
        const code = typeof e.code === 'string' ? e.code : '';
        if (code) {
          seen.db.push({
            code,
            detail: typeof e.detail === 'string' ? e.detail : '',
            text: typeof e.message === 'string' ? e.message : '',
          });
        }
        e = (e.cause ?? null) as Record<string, unknown> | null;
      }
      return orig.errorMessage(err);
    },
  };
});

type Json = Record<string, unknown>;
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  minimum?: number;
  minItems?: number;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
};

/** The read-only refusal in any of its words: the database's detail and
 *  message, and the one mapper's tool text (RO_ACTOR_MESSAGE). */
const RO_TEXT = /ro_actor|a read-only actor|This caller only reads/i;

/** A call that runs this long fails the sweep (it may still be writing). */
const CALL_TIMEOUT_MS = 30_000;

/** The control: a read builtin of this test's own whose handler writes an
 *  item (never a real tool). */
const PROBE = 'a5_ro_probe_write';

/** The node type a tool family reads, for its id arguments. */
const FAMILY_TYPE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^page/, 'page'],
  [/^note/, 'note'],
  [/^table/, 'table'],
  [/^file/, 'file'],
  [/^folder|^tree_folder/, 'branch'],
  [/^app/, 'app'],
  [/^task/, 'task'],
  [/^event/, 'event'],
];

function typeOfSchema(s: Schema | undefined): string {
  if (!s) return 'string';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  return alt ? typeOfSchema(alt) : 'string';
}

type Entry = 'dev console' | 'app broker, admin rules' | 'app broker, team rules';
const ENTRIES: readonly Entry[] = [
  'dev console',
  'app broker, admin rules',
  'app broker, team rules',
];

/** What one call did: its answer, and the read-only writes it met. */
type Outcome = { ok: boolean; error: string; ro: string[]; misses: string[] };

describe.skipIf(!URL)('every read builtin runs read only through the brokers (A5 step 3b)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let dir = '';
  const owner = randomUUID();
  const tag = `a5ro${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let teamWs = '';
  let appId = '';
  /** Seeded item ids by node type. */
  const ids = new Map<string, string>();
  /** The read builtins (the policy table's, before the probe joins it). */
  let reads: string[] = [];
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  const idFor = (key: string, slug: string): string => {
    const k = key.replace(/_?ids?$/i, '').toLowerCase();
    for (const [re, type] of FAMILY_TYPE) if (re.test(k) && ids.has(type)) return ids.get(type)!;
    for (const [re, type] of FAMILY_TYPE) if (re.test(slug) && ids.has(type)) return ids.get(type)!;
    return ids.get('page') ?? randomUUID();
  };

  const valueFor = (key: string, s: Schema | undefined, slug: string): unknown => {
    if (s?.enum && s.enum.length > 0) return s.enum[0];
    const type = typeOfSchema(s);
    if (type === 'string') {
      if (key === 'id' || /(_id|Id)$/.test(key)) return idFor(key, slug);
      if (/url/i.test(key)) return 'https://example.invalid/a5ro';
      if (key === 'parent' || /path/i.test(key)) return 'files';
      if (/email|^to$|address/i.test(key)) return 'nobody@example.invalid';
      if (s?.format === 'date-time' || /(_at|At|date|since|until|start|end)$/i.test(key)) {
        return new Date().toISOString();
      }
      if (/slug/i.test(key)) return `${tag}-${slug.replace(/_/g, '-')}`;
      if (/sql|query/i.test(key)) return 'select 1';
      if (/expression|formula/i.test(key)) return '1 + 1';
      return `${tag} ${slug}`;
    }
    if (type === 'number' || type === 'integer') return s?.minimum ?? 1;
    if (type === 'boolean') return false;
    if (type === 'array') {
      const n = s?.minItems ?? 0;
      if (n === 0) return [];
      return Array.from({ length: n }, () => valueFor(key.replace(/s$/, ''), s?.items, slug));
    }
    if (type === 'object') return argsFor(s ?? {}, slug);
    return tag;
  };

  /** The required arguments of a schema, made up. */
  const argsFor = (schema: Schema, slug: string): Json => {
    const out: Json = {};
    for (const k of schema.required ?? []) out[k] = valueFor(k, schema.properties?.[k], slug);
    return out;
  };

  /** A builtin's row, as the route resolves it (the seeded `tools` row);
   *  an MCP-only builtin has none, so one is made as seeding would. */
  const rowFor = async (slug: string): Promise<import('@mantle/db').Tool> => {
    const row = await inOwnerRequest(() => t.resolveTool(owner, slug));
    if (row) return row;
    const def = t.getBuiltin(slug);
    return {
      id: `row-${slug}`,
      ownerId: owner,
      slug,
      name: slug,
      description: def?.description ?? '',
      handler: { kind: 'builtin', ref: slug },
      inputSchema: def?.inputSchema ?? { type: 'object', properties: {} },
      requiresConfirm: false,
      enabled: true,
      externalAccess: null,
      createdBy: null,
    } as unknown as import('@mantle/db').Tool;
  };

  /** A recipe row whose steps call `steps`, in order. */
  const recipe = (slug: string, steps: { tool: string; input: Json }[]) =>
    ({
      id: `row-${slug}`,
      ownerId: owner,
      slug,
      name: slug,
      description: 'A recipe.',
      handler: { kind: 'recipe', steps },
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      enabled: true,
      externalAccess: null,
      createdBy: null,
    }) as unknown as import('@mantle/db').Tool;

  /** `fn` in the owner's request scope, as the session guard enters it for
   *  a POST (the dev console and the owner's app broker are POSTs). */
  const inOwnerRequest = async <T>(fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login: owner });
    return m.runAsActor(m.loginActor(owner, 'rw'), () =>
      m.runInRequestSlot(async () => {
        if (!m.enterRequestScope(scope, { writes: true, drafts: false })) {
          throw new Error('the request scope was not entered');
        }
        return fn();
      }),
    ) as Promise<T>;
  };

  /** One call of `tool` through `entry`, as its route makes it. */
  const dispatchAs = (entry: Entry, tool: import('@mantle/db').Tool, input: Json) =>
    inOwnerRequest(async () => {
      if (entry === 'dev console') {
        // /api/dev-tools/execute-tool: the owner's own web call.
        return t.dispatchTool(tool, input, {
          ownerId: owner,
          surface: { kind: 'web', loginId: owner },
          caller: t.ownerWebCaller(),
        });
      }
      // /api/apps/[id]/tool-broker, past its verdict: appToolScope at the
      // app's rules, run as the broker runs it.
      const level = entry === 'app broker, admin rules' ? 'admin' : 'team';
      const scope = t.appToolScope(level, { loginId: owner, name: 'Owner' }, { id: appId });
      const run = () =>
        t.dispatchTool(tool, input, {
          ownerId: owner,
          surface: scope.surface,
          caller: t.appBrokerCaller(scope.surface, { ok: true, tool }),
        });
      return scope.viewer === 'admin' ? run() : m.withViewer(scope.actsFor, run);
    });

  /** Run one call and read what it met: its answer, the read-only
   *  refusals among the database errors it turned into text (or threw),
   *  and the actor misses it noted (warn: the refusal as a notice). */
  const runOne = async (
    entry: Entry,
    tool: import('@mantle/db').Tool,
    input: Json,
  ): Promise<Outcome> => {
    seen.db.length = 0;
    m.takeActorMisses();
    let ok = false;
    let error: string;
    const thrown: { code: string; detail: string; text: string }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        dispatchAs(entry, tool, input),
        new Promise<'timeout'>((done) => {
          timer = setTimeout(() => done('timeout'), CALL_TIMEOUT_MS);
        }),
      ]);
      if (res === 'timeout') error = `timed out after ${CALL_TIMEOUT_MS} ms`;
      else {
        ok = res.ok;
        error = res.ok ? '' : String(res.error);
      }
    } catch (err) {
      error = `threw: ${(err as Error)?.message ?? String(err)}`;
      for (let e = err as Record<string, unknown> | null, i = 0; e && i < 4; i++) {
        if (typeof e.code === 'string') {
          thrown.push({
            code: e.code,
            detail: typeof e.detail === 'string' ? e.detail : '',
            text: typeof e.message === 'string' ? e.message : '',
          });
        }
        e = (e.cause ?? null) as Record<string, unknown> | null;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const ro: string[] = [];
    if (RO_TEXT.test(error)) ro.push(`answer: ${error.slice(0, 200)}`);
    for (const d of [...seen.db, ...thrown]) {
      if (d.code === '42501' && (d.detail === 'ro_actor' || RO_TEXT.test(d.text))) {
        ro.push(`database: ${d.detail} ${d.text.slice(0, 160)}`);
      }
    }
    const misses = m.takeActorMisses().map((x) => `${x.source} ${x.check} ${x.detail}`.trim());
    for (const miss of misses) if (RO_TEXT.test(miss)) ro.push(`notice: ${miss.slice(0, 200)}`);
    return { ok, error, ro, misses: misses.filter((miss) => !RO_TEXT.test(miss)) };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-read-tools-ro-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    // Nothing leaves the test: every outbound request answers 503.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A5 read sweep', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    (await import('@mantle/runtime/heartbeats')).registerHeartbeatTools();
    reads = t.listReadOnlyBuiltinSlugs();

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    // A workspace of the test's own beside Admin (a new brain makes none),
    // and the owner a user of it: the app it holds runs at team rules.
    teamWs = (
      await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Shop`}) returning id::text`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${owner}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');

    // Items to read, homed in Team: the owner's request scope reads them
    // (Admin and Team), and so does the app's (Team).
    const c = await import('@mantle/content');
    const files = await import('@mantle/files');
    await m.asSystem(() => files.ensureFilesRootBranch(owner), 'test');
    await m.asSystem(
      () =>
        m.withCreateHome({ createWs: teamWs, privateWs: null, quiet: true }, async () => {
          ids.set('page', (await c.createPage(owner, { title: `${tag} page` })).id);
          ids.set('note', (await c.createNote(owner, { title: `${tag} note`, content: 'x' })).id);
          ids.set('task', (await c.createTask(owner, { title: `${tag} task` })).id);
          ids.set(
            'event',
            (
              await c.createEvent(owner, {
                title: `${tag} event`,
                startsAt: new Date().toISOString(),
              })
            ).id,
          );
          ids.set('table', (await c.createTable(owner, { title: `${tag} table` })).id);
          const folder = await files.createFolder({
            ownerId: owner,
            parentPath: 'files',
            slug: `${tag}-dir`,
          });
          ids.set('branch', folder.id);
          const file = await files.upsertFile({
            ownerId: owner,
            parentPath: 'files',
            filename: `${tag}.txt`,
            bytes: Buffer.from('a read sweep file'),
          });
          ids.set('file', file.id);
        }),
      'test',
    );
    // The app the brokers run: held by Team (the team rules' scope), read
    // by Admin.
    appId = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${appId}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
    await x(sql`insert into apps (node_id) values (${appId})`);
    await m.withHeads([appId], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${appId}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${appId}, ${teamWs}, true, true), (${appId}, ${adminWs}, false, false)`);
    });
    ids.set('app', appId);

    // The control: a read builtin that changes an item (on the system
    // pool, as a handler's system work runs: still read only under a read
    // caller), and its row, so a recipe can call it.
    const target = ids.get('page')!;
    t.registerBuiltin({
      slug: PROBE,
      name: PROBE,
      description: 'A read tool that writes (the sweep control).',
      inputSchema: { type: 'object', properties: {} },
      policy: { effect: 'read', spends: 'none', scope: 'any' },
      readOnly: true,
      handler: async () => {
        await m.asSystem(
          () => m.db.execute(sql`update nodes set title = title where id = ${target}`),
          'app-data',
        );
        return { ok: true, output: { wrote: target } };
      },
    });
    await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
      values (${owner}, ${PROBE}, ${PROBE}, 'The sweep control.', ${'{"type":"object"}'}::jsonb,
              ${JSON.stringify({ kind: 'builtin', ref: PROBE })}::jsonb)`);

    // The box's checks on, as an operator switches them, and this
    // process's actor check (the write mode is sent with the actor).
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** One pass: every read builtin and the recipes through every entry. */
  const sweep = async (mode: 'on' | 'warn') => {
    await su(sql`select mantle_set_edit_check(${mode})`);
    const readOnlyWrites: Record<string, string[]> = {};
    const otherMisses: Record<string, string[]> = {};
    const stuck: string[] = [];
    const ran: Record<Entry, number> = {
      'dev console': 0,
      'app broker, admin rules': 0,
      'app broker, team rules': 0,
    };
    const note = (key: string, o: Outcome) => {
      if (o.ro.length > 0) readOnlyWrites[key] = o.ro;
      if (o.misses.length > 0) otherMisses[key] = o.misses;
      if (o.error.startsWith('timed out')) stuck.push(key);
    };
    for (const entry of ENTRIES) {
      for (const slug of reads) {
        const def = t.getBuiltin(slug);
        const o = await runOne(
          entry,
          await rowFor(slug),
          argsFor((def?.inputSchema ?? {}) as Schema, slug),
        );
        if (o.ok) ran[entry]++;
        note(`${entry}: ${slug}`, o);
      }
    }
    // A recipe whose steps are reads: each step runs through the gate as
    // the recipe's caller, read only.
    const readsRecipe = recipe(`${tag}_reads`, [
      { tool: 'note_list', input: {} },
      { tool: 'page_get', input: { id: ids.get('page')! } },
    ]);
    const recipes: Record<Entry, Outcome> = {} as Record<Entry, Outcome>;
    for (const entry of ENTRIES) {
      const o = await runOne(entry, readsRecipe, {});
      recipes[entry] = o;
      note(`${entry}: recipe of reads`, o);
    }
    // The control, directly and nested: caught on every entry it runs on.
    const control: Record<string, Outcome> = {};
    const probeRecipe = recipe(`${tag}_probe`, [{ tool: PROBE, input: {} }]);
    for (const entry of ENTRIES) {
      control[`${entry}: direct`] = await runOne(entry, await rowFor(PROBE), {});
      control[`${entry}: nested`] = await runOne(entry, probeRecipe, {});
    }
    return { readOnlyWrites, otherMisses, stuck, ran, recipes, control };
  };

  /** What both passes assert: each soft, so one run reports them all. */
  const check = (mode: string, r: Awaited<ReturnType<typeof sweep>>) => {
    // What ran, for the log (CI is the proof: no database on the Mac).
    console.info(
      `[a5 read sweep, edit check ${mode}] ${reads.length} read builtins per entry; ` +
        `answered ok: ${JSON.stringify(r.ran)}; ` +
        `read-only writes: ${JSON.stringify(Object.keys(r.readOnlyWrites))}`,
    );
    // THE FINDING: no read builtin, and no nested read step, wrote as a
    // read-only actor. A tool named here is a real read-path write.
    expect.soft(r.readOnlyWrites, 'read tools that wrote as a read-only actor').toEqual({});
    expect.soft(r.stuck, 'read tools that did not answer in time').toEqual([]);
    expect.soft(r.otherMisses, 'actor misses that are not the read-only refusal').toEqual({});
    // The sweep is not vacuous: the policy table's reads, most of them
    // answered on the owner's web, and some in the team scope.
    expect.soft(reads.length).toBeGreaterThan(50);
    expect.soft(reads).not.toContain(PROBE);
    expect.soft(r.ran['dev console'], 'dev console calls that answered ok').toBeGreaterThan(20);
    expect
      .soft(r.ran['app broker, admin rules'], 'admin rules calls that answered ok')
      .toBeGreaterThan(20);
    expect
      .soft(r.ran['app broker, team rules'], 'team rules calls that answered ok')
      .toBeGreaterThan(5);
    // The recipe of reads answers on the owner's web, both steps run.
    for (const entry of ['dev console', 'app broker, admin rules'] as const) {
      expect.soft(r.recipes[entry].error, entry).toBe('');
      expect.soft(r.recipes[entry].ok, entry).toBe(true);
    }
    // The control is caught, directly and as a recipe's step, on the
    // owner's web (both entries) and directly in the team scope.
    for (const key of [
      'dev console: direct',
      'dev console: nested',
      'app broker, admin rules: direct',
      'app broker, admin rules: nested',
      'app broker, team rules: direct',
    ]) {
      expect
        .soft(r.control[key]!.ro.length, `${key}: ${JSON.stringify(r.control[key])}`)
        .toBeGreaterThan(0);
    }
  };

  it('edit check on: no read builtin is refused for writing as a read-only actor', async () => {
    check('on', await sweep('on'));
  }, 900_000);

  it('edit check warn: no read builtin writes as a read-only actor, even swallowed', async () => {
    check('warn', await sweep('warn'));
  }, 900_000);
});
