/**
 * The app broker sweep (A10 #9: one runAppToolBroker; docs/request-plumbing.md,
 * "App tool broker"). The three live app tool brokers, driven as the route
 * loader hands them a request (the body capped at the route's ceiling,
 * capRequestBody; a thrown error answered as app.onError answers it):
 *
 *  - owner-admin: POST /api/apps/:id/tool-broker, an Admin user, an app the
 *    Admin workspace alone holds (admin rules);
 *  - owner-team:  the same route and login, an app another workspace holds
 *    (team rules, plan R2);
 *  - member:      the same route, a member login (lib/app-runner.ts);
 *  - link:        POST /s/:token/tool-broker, a contact share past its code
 *    gate.
 *
 * Each takes the same calls: an allowed read and an allowed write (an
 * outside tool; a write's input is logged), a tool the app does not declare
 * (refused by the verdict), a body the schema refuses, a body that is not
 * JSON, an empty body, a declared tool that does not exist, a tool that
 * fails, a body over 8 MB and an app the caller cannot find; the owner's
 * admin rules also the confirmation (asked, and a ticket that does not
 * match). Each cell records the answer (status, body), the app's Activity
 * rows (recordAppAccess), the share's trail (recordShareAccess), the app's
 * error rows (recordAppError), the export syncs scheduled, the verdict it
 * asked (its rules and the login it named), the rules a refusal named, and
 * the dispatch (the surface, the gate caller, the scope it ran in).
 *
 * The three db brokers (/api/apps/:id/db-broker as an Admin user and as a
 * member, /s/:token/db-broker as a contact that may write) take a query, a
 * write and a write whose SQL fails: the export syncs each schedules (one
 * after a write, none else) and the client-written mark.
 *
 * The rules are stood in (the verdicts, the refusal, the dispatch): what
 * they decide is pinned in app-broker-parity.test.ts and the tools tests;
 * this sweep pins what each BROKER does around them. No database.
 *
 * Recorded on main (v0.300.49) BEFORE the move, in
 * __snapshots__/a10-app-broker-sweep.txt (A10_APP_BROKER_RECORD=1 writes
 * it; a normal run only reads it). After the move every cell must answer
 * as recorded, or be a named change (NAMED_CHANGES below), whose new
 * answer is recorded in __snapshots__/a10-app-broker-sweep-changes.txt.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// adminFacts answers what the stood-in Login (loginStandIn) says of it.
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn((await import('@/server/run-route-stand-ins')).adminFactsStandIn),
}));

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN_LOGIN = '55555555-5555-4555-8555-555555555555';
const MEMBER_LOGIN = '22222222-2222-4222-8222-222222222222';
const APP = '77777777-7777-4777-8777-777777777777';
const OTHER_APP = '88888888-8888-4888-8888-888888888888';
const SHARE = '99999999-9999-4999-8999-999999999999';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'sweep-share-token';

const h = vi.hoisted(() => ({
  login: 'admin' as 'admin' | 'member',
  toolRules: 'admin' as 'admin' | 'team',
  /** The app the caller looks for is missing. */
  noApp: false,
  /** What one cell recorded. */
  rec: {} as Record<string, unknown[]>,
  /** The scope the code runs in now: a withViewer's actsFor, a system
   *  reason, or null (the request's own). */
  current: null as unknown,
  /** The next app SQL fails. */
  sqlFails: false,
}));

const push = (key: string, value: unknown) => {
  (h.rec[key] ??= []).push(value);
};

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const marked = async <T>(mark: unknown, fn: () => Promise<T>): Promise<T> => {
    const outer = h.current;
    h.current = mark;
    try {
      return await fn();
    } finally {
      h.current = outer;
    }
  };
  return {
    ...real,
    withViewer: vi.fn(async (actsFor: unknown, fn: () => Promise<unknown>) =>
      marked({ viewer: actsFor }, fn),
    ),
    asSystem: vi.fn(async (fn: () => Promise<unknown>, reason: string) =>
      marked({ system: reason }, fn),
    ),
  };
});

// The owner row's Login (plan v3.2 section 2.2): an Admin user, or a member.
vi.mock('@/lib/auth', async (importOriginal) => {
  const { loginStandIn } = await import('@/server/run-route-stand-ins');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    ownerLoginCaller: vi.fn(() =>
      h.login === 'admin'
        ? loginStandIn({
            loginId: ADMIN_LOGIN,
            brainId: ANCHOR,
            email: 'jo@example.invalid',
            displayName: 'Jo',
            admin: true,
          })
        : loginStandIn({
            loginId: MEMBER_LOGIN,
            brainId: ANCHOR,
            email: 'pat@example.invalid',
            displayName: 'Pat',
          }),
    ),
  };
});

vi.mock('@/lib/member-apps', async (importOriginal) => {
  const { NextResponse } = await import('@/server/http-compat');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    memberAppOr404: vi.fn(async (anchor: string, id: string) =>
      h.noApp || id !== APP
        ? NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 })
        : {
            id,
            ownerId: anchor,
            title: 'Polls',
            writable: true,
            dataReadOnly: false,
            manifest: { toolSlugs: DECLARED, sqlite: undefined },
            publishedBuild: { ok: true },
          },
    ),
  };
});

vi.mock('@/lib/contact-share-gate', () => ({
  gateShare: vi.fn(async () => ({
    kind: 'ok',
    share: {
      id: SHARE,
      ownerId: ANCHOR,
      nodeId: APP,
      nodeType: 'app',
      contactId: CONTACT,
      canWrite: true,
    },
    contact: { id: CONTACT },
  })),
  contactCodeRequired: vi.fn(() => new Response('code required', { status: 401 })),
}));

vi.mock('@/lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  liveServedIds: vi.fn(async () => new Set([APP])),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async (_owner: string, id: string) =>
    h.noApp || id !== APP
      ? null
      : {
          id,
          toolRules: h.toolRules,
          authorLevel: 'admin',
          dataReadOnly: false,
          manifest: { toolSlugs: DECLARED, sqlite: undefined },
          publishedBuild: { ok: true },
        },
  ),
  memberMayWriteAppData: vi.fn(() => true),
  recordAppAccess: vi.fn((e: unknown) => push('access', e)),
  recordAppError: vi.fn((e: unknown) => push('errors', e)),
  recordShareAccess: vi.fn((e: unknown) => push('trail', e)),
}));

vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/app-broker')>();
  const sql = (op: string, owner: string, app: string, caller: { callerKey?: string }) => {
    push('sql', { op, owner, app, callerKey: caller?.callerKey, ran: h.current ?? 'request' });
    if (h.sqlFails) throw new real.AppSqlError('no such table: polls');
  };
  return {
    ...real,
    appDbQuery: vi.fn(async (o: string, a: string, _s: string, _p: unknown, _sc: unknown, c) => {
      sql('query', o, a, c as never);
      return [];
    }),
    appDbExec: vi.fn(async (o: string, a: string, _s: string, _p: unknown, _sc: unknown, c) => {
      sql('exec', o, a, c as never);
      return { changes: 1, lastInsertRowid: 1 };
    }),
    markAppClientWritten: vi.fn(async (o: string, a: string) => push('clientWritten', [o, a])),
  };
});

vi.mock('@mantle/content/app-table-exports', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scheduleAppTableExportSync: vi.fn((o: string, a: string) =>
    push('syncs', { owner: o, app: a, ran: h.current ?? 'request' }),
  ),
}));

/** The app's declared tools: every slug the sweep calls but `refused_tool`. */
const DECLARED = ['read_tool', 'write_tool', 'missing_tool', 'error_tool', 'confirm_tool'];

/** The verdict both verdict stand-ins give: the declared list, a missing
 *  tool, and an outside (http) tool, a write for `write_tool`. */
function verdictFor(declared: readonly string[], slug: string) {
  if (!declared.includes(slug)) {
    return { ok: false, status: 403, reason: `'${slug}' is not declared` } as const;
  }
  if (slug === 'missing_tool') {
    return { ok: false, status: 404, reason: `tool '${slug}' not found` } as const;
  }
  return {
    ok: true,
    write: slug === 'write_tool',
    tool: {
      slug,
      name: `Tool ${slug}`,
      description: `Does ${slug}.`,
      handler: { kind: 'http' },
      requiresConfirm: slug === 'confirm_tool',
    },
  } as const;
}

vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  return {
    ...real,
    appToolVerdict: vi.fn(
      async (
        level: string,
        _owner: string,
        declared: string[],
        slug: string,
        loginId?: string,
        check?: unknown,
      ) => {
        push('verdict', { level, loginId: loginId ?? null, check: check ?? null, ran: h.current });
        return verdictFor(declared, slug);
      },
    ),
    contactAppToolVerdict: vi.fn(async (_owner: string, declared: string[], slug: string) => {
      push('verdict', { level: 'contact', ran: h.current });
      return verdictFor(declared, slug);
    }),
    appToolRefusal: vi.fn(
      async (rules: string, _slug: string, v: { status: number; reason: string }) => {
        push('refusal', rules);
        return { status: v.status, error: v.reason };
      },
    ),
    dispatchTool: vi.fn(
      async (
        tool: { slug: string },
        input: unknown,
        ctx: { ownerId: string; surface: unknown; caller: Record<string, unknown> },
      ) => {
        const { appVerdict: _v, ...caller } = ctx.caller;
        push('dispatch', {
          slug: tool.slug,
          input,
          ownerId: ctx.ownerId,
          surface: ctx.surface,
          caller,
          ran: h.current ?? 'request',
        });
        return tool.slug === 'error_tool'
          ? { ok: false, error: 'the tool failed' }
          : { ok: true, output: { ran: tool.slug } };
      },
    ),
  };
});

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;
let ownerTool: Handler<{ id: string }>;
let linkTool: Handler<{ token: string }>;
let ownerDb: Handler<{ id: string }>;
let linkDb: Handler<{ token: string }>;
let capRequestBody: typeof import('../lib/body-limit').capRequestBody;
let bodyCeilingFor: typeof import('../lib/body-limit').bodyCeilingFor;
let appAnswerOf: typeof import('./test-support').appAnswerOf;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'a10-app-broker-sweep-secret-at-least-32-chars';
  ownerTool = (await import('../app/api/apps/[id]/tool-broker/route')).POST;
  linkTool = (await import('../app/s/[token]/tool-broker/route')).POST;
  ownerDb = (await import('../app/api/apps/[id]/db-broker/route')).POST;
  linkDb = (await import('../app/s/[token]/db-broker/route')).POST;
  ({ capRequestBody, bodyCeilingFor } = await import('../lib/body-limit'));
  ({ appAnswerOf } = await import('./test-support'));
}, 60_000);

// ── the cells ────────────────────────────────────────────────────────────────

type Broker = 'owner-admin' | 'owner-team' | 'member' | 'link';
const TOOL_BROKERS: readonly Broker[] = ['owner-admin', 'owner-team', 'member', 'link'];

/** Over the member's own read cap (8 MB) and the share routes' ceiling
 *  (1 MB), under the owner's /api/apps ceiling (128 MB); a valid call. */
const OVERSIZED = (() => {
  const head = '{"slug":"read_tool","input":{"pad":"';
  const tail = '"}}';
  return head + 'a'.repeat(8 * 1024 * 1024 + 1 - head.length - tail.length) + tail;
})();

/** A call: the body sent (a string as is, else JSON), on the app or not. */
type Call = { body: unknown; raw?: true; app?: string };

const TOOL_CASES: Record<string, Call> = {
  read: { body: { slug: 'read_tool', input: { q: 'x' } } },
  write: { body: { slug: 'write_tool', input: { name: 'x' } } },
  refused: { body: { slug: 'refused_tool', input: {} } },
  'bad-body': { body: { slug: '' } },
  'not-json': { body: '{"slug":', raw: true },
  'empty-body': { body: '', raw: true },
  'unknown-tool': { body: { slug: 'missing_tool' } },
  'tool-error': { body: { slug: 'error_tool', input: { a: 1 } } },
  oversized: { body: OVERSIZED, raw: true },
  'app-not-found': { body: { slug: 'read_tool' }, app: OTHER_APP },
};

/** The owner's admin rules only: the confirmation step. */
const CONFIRM_CASES: Record<string, Call> = {
  'confirm-asked': { body: { slug: 'confirm_tool', input: { id: 'n1' } } },
  'confirm-mismatch': { body: { slug: 'confirm_tool', input: { id: 'n1' }, confirmToken: 'x.y' } },
};

const DB_CASES: Record<string, Call & { fails?: true }> = {
  query: { body: { op: 'query', sql: 'select 1' } },
  exec: { body: { op: 'exec', sql: "insert into polls(q) values ('x')" } },
  'exec-fails': { body: { op: 'exec', sql: "insert into polls(q) values ('x')" }, fails: true },
};
type DbBroker = 'owner-admin' | 'member' | 'link';
const DB_BROKERS: readonly DbBroker[] = ['owner-admin', 'member', 'link'];

/** A long string stands in by its length (the oversized body's pad). */
function short(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v,
    ),
  );
}

function setUp(broker: Broker) {
  h.login = broker === 'member' ? 'member' : 'admin';
  h.toolRules = broker === 'owner-team' ? 'team' : 'admin';
}

/** One request through a broker, as the route loader serves it. */
async function drive(kind: 'tool' | 'db', broker: Broker, call: Call): Promise<string> {
  for (const k of Object.keys(h.rec)) delete h.rec[k];
  h.current = null;
  h.noApp = !!call.app;
  setUp(broker);
  const link = broker === 'link';
  const path = link ? `/s/${TOKEN}/${kind}-broker` : `/api/apps/${call.app ?? APP}/${kind}-broker`;
  const body = call.raw ? (call.body as string) : JSON.stringify(call.body);
  const req = capRequestBody(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    bodyCeilingFor(path) as number,
  );
  const handler =
    kind === 'tool'
      ? link
        ? linkTool(req, { params: Promise.resolve({ token: TOKEN }) })
        : ownerTool(req, { params: Promise.resolve({ id: call.app ?? APP }) })
      : link
        ? linkDb(req, { params: Promise.resolve({ token: TOKEN }) })
        : ownerDb(req, { params: Promise.resolve({ id: call.app ?? APP }) });
  const res = await appAnswerOf(handler, `http://localhost${path}`);
  const text = await res.text();
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    /* a plain text answer stays text */
  }
  // A confirmation ticket is signed with the time: its shape, not its value.
  const a = answer as { confirm?: { token?: unknown } };
  if (a && typeof a === 'object' && a.confirm?.token) a.confirm.token = '<ticket>';
  const cell: Record<string, unknown> = { status: res.status, body: answer };
  for (const key of [
    'verdict',
    'refusal',
    'access',
    'trail',
    'errors',
    'dispatch',
    'sql',
    'clientWritten',
    'syncs',
  ]) {
    if (h.rec[key]) cell[key] = h.rec[key];
  }
  return JSON.stringify(short(cell));
}

/** Every cell, keyed `kind broker case`. */
async function driveAll(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const broker of TOOL_BROKERS) {
    for (const [name, call] of Object.entries(TOOL_CASES)) {
      out.set(`tool ${broker} ${name}`, await drive('tool', broker, call));
    }
  }
  for (const [name, call] of Object.entries(CONFIRM_CASES)) {
    out.set(`tool owner-admin ${name}`, await drive('tool', 'owner-admin', call));
  }
  for (const broker of DB_BROKERS) {
    for (const [name, call] of Object.entries(DB_CASES)) {
      h.sqlFails = !!call.fails;
      try {
        out.set(`db ${broker} ${name}`, await drive('db', broker, call));
      } finally {
        h.sqlFails = false;
      }
    }
  }
  return out;
}

// ── record and compare ──────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, '__snapshots__/a10-app-broker-sweep.txt');
const CHANGES = join(HERE, '__snapshots__/a10-app-broker-sweep-changes.txt');

/**
 * The cells the move changed on purpose (A10 #9), each with its reason.
 * Every other cell answers as main recorded it.
 */
const OWNER_ADMIN_CALL =
  "the owner's call at admin rules lands its Activity row now, as every other run's call does (main logged none at admin rules)";
const OWNER_REFUSAL =
  "the owner's refused call lands its Activity row now (refused: the verdict's reason), as a member's and a contact's always did (main logged only the error row)";
const LINK_ERROR =
  "the link's refused or failed call lands its error row now (via 'contact', the share and the contact), as the owner's and a member's always did (main logged none)";
const ADMIN_APP_DATA_DOOR =
  "an Admin user's run reaches its app's database on the system pool by the app-data door, after the app's lookup in its scope, as a member's run does (F4 fix round 2, item 11: in its scope since F4, an Admin user who only reads the app was refused)";
const TEAM_CALL_INPUT =
  "a call at team rules hands its input to the verdict now (check.input), which names the Table a team app's row write changes: only one homed in a workspace that holds the app runs (task 2178377a, member-app-tools.ts rule 6)";
const NAMED_CHANGES: Readonly<Record<string, string>> = {
  'db owner-admin query': ADMIN_APP_DATA_DOOR,
  'db owner-admin exec': ADMIN_APP_DATA_DOOR,
  'db owner-admin exec-fails': ADMIN_APP_DATA_DOOR,
  'tool owner-admin read': OWNER_ADMIN_CALL,
  'tool owner-admin write': OWNER_ADMIN_CALL,
  'tool owner-admin tool-error': OWNER_ADMIN_CALL,
  'tool owner-admin oversized': OWNER_ADMIN_CALL,
  'tool owner-admin refused': OWNER_REFUSAL,
  'tool owner-admin unknown-tool': OWNER_REFUSAL,
  'tool owner-team refused': `${OWNER_REFUSAL}; ${TEAM_CALL_INPUT}`,
  'tool owner-team unknown-tool': `${OWNER_REFUSAL}; ${TEAM_CALL_INPUT}`,
  'tool owner-admin confirm-mismatch':
    'a confirmation that expired or does not match lands its Activity row now (refused: the reason), beside the error row main wrote',
  'tool owner-team read': TEAM_CALL_INPUT,
  'tool owner-team write': TEAM_CALL_INPUT,
  'tool owner-team tool-error': TEAM_CALL_INPUT,
  'tool owner-team oversized': TEAM_CALL_INPUT,
  'tool member read': TEAM_CALL_INPUT,
  'tool member write': TEAM_CALL_INPUT,
  'tool member refused': TEAM_CALL_INPUT,
  'tool member unknown-tool': TEAM_CALL_INPUT,
  'tool member tool-error': TEAM_CALL_INPUT,
  'tool link refused': LINK_ERROR,
  'tool link unknown-tool': LINK_ERROR,
  'tool link tool-error': LINK_ERROR,
};

function readCells(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf(' => ');
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 4));
  }
  return out;
}

/** The top-level fields of two recorded cells that differ. */
function fieldsThatDiffer(was: string, now: string): string[] {
  const a = JSON.parse(was) as Record<string, unknown>;
  const b = JSON.parse(now) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

function writeCells(file: string, cells: Map<string, string>, header: string): void {
  const lines = [...cells].map(([k, v]) => `${k} => ${v}`);
  writeFileSync(file, `${header}\n${lines.join('\n')}\n`);
}

describe('A10 #9 app broker sweep', () => {
  it('every broker answers each call as main recorded it, or as a named change', async () => {
    const now = await driveAll();
    if (process.env.A10_APP_BROKER_RECORD === '1') {
      writeCells(RECORD, now, '# A10 #9 app broker sweep, recorded on main v0.300.49');
      return;
    }
    const recorded = readCells(RECORD);
    expect([...now.keys()]).toEqual([...recorded.keys()]);
    // Every cell that differs from main, and the fields that do.
    const differs = new Map<string, string[]>();
    for (const [key, value] of now) {
      const was = recorded.get(key);
      if (value !== was) differs.set(key, fieldsThatDiffer(was ?? '{}', value));
    }
    const unnamed = [...differs.keys()].filter((k) => !NAMED_CHANGES[k]);
    expect(unnamed, 'cells that differ from main without a named change').toEqual([]);
    const unchanged = Object.keys(NAMED_CHANGES).filter((k) => !differs.has(k));
    expect(unchanged, 'named changes whose cell answers as main did').toEqual([]);
    const changed = new Map(
      [...differs].map(([k, fields]) => [
        k,
        `${now.get(k)}\n  # ${fields.join(', ')}: ${NAMED_CHANGES[k]}`,
      ]),
    );
    if (process.env.A10_APP_BROKER_RECORD_CHANGES === '1') {
      writeCells(CHANGES, changed, '# A10 #9 named changes: the cell after the move, and why');
      return;
    }
    const recordedChanges = readCells(CHANGES);
    expect([...changed.keys()].sort()).toEqual([...recordedChanges.keys()].sort());
    for (const [key, value] of changed) {
      expect(value.split('\n')[0], key).toBe(recordedChanges.get(key));
    }
  }, 120_000);
});
