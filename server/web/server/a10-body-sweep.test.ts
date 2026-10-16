/**
 * The body sweep (A10 part 2, fold 1: one body reader; docs/request-plumbing.md).
 * Every write route of the manifest (POST, PUT, PATCH, DELETE) driven
 * through the full pipeline (the gate, the row, the caller's answer, the
 * handler), as a representative credential (the owner; a member too where
 * the row admits members; nobody on a public row), with six bodies:
 *
 *  - valid:     a body the route's own zod schema accepts (made from that
 *               schema, a10-body-sweep.samples.ts; kept in
 *               __snapshots__/a10-body-sweep.bodies.json so every run sends
 *               the same bytes); `{}` where none was found;
 *  - malformed: `{"a":` (not JSON);
 *  - empty:     no bytes at all;
 *  - nul:       the valid body with a NUL at the end of every string;
 *  - array:     `[]` (JSON, the wrong shape for an object schema);
 *  - chunked:   the route's ceiling plus 1 MB of spaces, streamed with no
 *               Content-Length (the read the gate cannot refuse up front).
 *
 * Per cell: the status, the content type, a redirect's location and the
 * body (cut at 400 characters). No database: the login rows are stood in,
 * a query finds no row, a statement finds one item the login may edit
 * (the guard sweep's READS, so the gate lets the owner through), and any
 * other database use throws "DATABASE_URL must be set", which the route
 * answers as it does. No network (fetch throws), no child process.
 *
 * Recorded on main (v0.300.41) BEFORE the move, in
 * __snapshots__/a10-body-sweep.txt (A10_BODY_SWEEP_RECORD=1 writes it; a
 * normal run only reads it). After the move every cell must answer as
 * recorded, or be a named change: __snapshots__/a10-body-sweep-changes.txt
 * lists each changed cell with its kind, its answer on main and its answer
 * now, and the test fails on a change no kind names.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';

const loginRow = (id: string, role: string, isOwner = false) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  getBrainId: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === ANCHOR_ID
      ? loginRow(ANCHOR_ID, 'admin', true)
      : id === MEMBER_ID
        ? loginRow(MEMBER_ID, 'member')
        : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
}));

// The audit row a write makes (fire and forget): never written.
vi.mock('../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: () => undefined,
}));

vi.mock('../lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => false,
  mcpTargetLogin: async () => null,
}));

vi.mock('../lib/mcp-oauth', async (importOriginal) => {
  const { SWEEP_OAUTH_CLIENT } = await import('./public-session-routes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    isRemoteMcpEnabled: async () => true,
    getClient: async (id: string) =>
      id === SWEEP_OAUTH_CLIENT.id
        ? { id, clientName: 'Sweep client', redirectUris: [SWEEP_OAUTH_CLIENT.redirectUri] }
        : null,
  };
});

vi.mock('../lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({
    id: '00000000-0000-4000-8000-0000000000c0',
    code: 'sweep-code-sweep-code-sweep',
    expiresAt: new Date('2026-10-01T00:01:30.000Z'),
  }),
  pairCodeStatus: async () => ({ status: 'pending', deviceLabel: null }),
}));

vi.mock('../lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveShareByToken: async () => null,
  resolveActiveShareRowByToken: async () => null,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRetiredTeamLinkToken: async () => false,
  isRetiredClientLinkToken: async () => false,
}));

// No child process is started from a sweep.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const refuse = () => {
    throw new Error('sweep: no child process');
  };
  return { ...real, spawn: refuse, exec: refuse, execFile: refuse, fork: refuse };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // The guard sweep's READS (a4-guard-sweep.test.ts): a query (db.select and
  // its chain) finds no row; a statement (db.execute) finds one item the
  // login may edit and manage; withViewer runs its function. Anything else
  // is the real module's, which wants a database and throws.
  const none: unknown = new Proxy(() => undefined, {
    get: (_t, k) =>
      k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, ko)
        : () => none,
  });
  const db = new Proxy(real.db, {
    get: (t, k) => {
      if (k === 'select') return () => none;
      if (k === 'execute') {
        return async (stmt: { queryChunks?: unknown[] }) => {
          // The files root's id by its definer (A6b: mantle_kind_root_id)
          // was read on the system pool on main, which wants a database
          // here: it throws as that read did.
          if (JSON.stringify(stmt?.queryChunks ?? []).includes('mantle_kind_root_id')) {
            throw new Error('DATABASE_URL must be set');
          }
          return [
            {
              id: '11111111-1111-4111-8111-111111111111',
              type: 'page',
              edit: true,
              manage: true,
              copy: false,
              home: null,
              held: false,
            },
          ];
        };
      }
      return Reflect.get(t, k);
    },
  });
  return {
    ...real,
    db,
    withViewer: ((_actsFor, fn) => fn()) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));
// The unpinned key picks (model picker fix round 1, L1) read through the
// keys package's own handle, not `db`; as a query here, they find no row,
// which is what the seeder's and the model combos' hand picks over `db`
// found on main.
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/api-keys')>()),
  findProviderKeyId: async () => null,
  findProviderKeyIds: async () => new Map<string, string>(),
}));

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { bodyCeilingFor, JSON_BODY_CEILING_BYTES } from '../lib/body-limit';
import {
  PROBE_KEY,
  SAMPLE_ID,
  hookSafeParse,
  sampleBody,
  takeMet,
  withNul,
} from './a10-body-sweep.samples';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}
const RECORD = process.env.A10_BODY_SWEEP_RECORD === '1';
const BASELINE = join(here, '__snapshots__/a10-body-sweep.txt');
const BODIES = join(here, '__snapshots__/a10-body-sweep.bodies.json');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MB = 1024 * 1024;
/** The clock the sweep starts at (a cookie's age, a timestamp in a body). */
const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** Each cell runs a day after the one before (by its place in the sweep),
 *  so every rate limit it meets starts empty, whatever ran before it. The
 *  probes of record mode run a year before the first cell. */
const cellTime = (n: number) => new Date(NOW.getTime() + n * DAY);

const VARIANTS = ['valid', 'malformed', 'empty', 'nul', 'array', 'chunked'] as const;
type Variant = (typeof VARIANTS)[number];

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
}

/** A body that declares no length: `bytes` of spaces in 1 MB chunks. */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(MB).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= bytes) return ctrl.close();
      ctrl.enqueue(chunk.slice());
      sent += MB;
    },
  });
}

/** The jackdaw tag this build is paired with (client-pair.tag at the repo
 *  root, read by lib/updates.ts) moves with every pair bump; POST
 *  /api/updates/check names it. The sweep holds the answer's shape, not the
 *  pair of the day, so the tag is stood in by a fixed placeholder (a null tag
 *  stays null, and still differs from the record). */
const PAIRED_TAG = /"pairedTag":"v\d+\.\d+\.\d+[^"]*"/g;
const pairedTagStandIn = (answer: string) =>
  answer
    .replace(PAIRED_TAG, '"pairedTag":"<client-pair.tag>"')
    .replace(CHECKED_AT, '"checkedAt":"<cell clock>"');
/** POST /api/updates/check stamps the cell's clock (cellTime), which moves
 *  by a day for every cell swept before it: a new write route earlier in
 *  the sweep shifts it. The sweep holds the answer's shape, so the stamp is
 *  stood in too. */
const CHECKED_AT = /"checkedAt":"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g;

/** The one 400 a body that is not JSON answers (lib/read-body.ts). */
const BAD_JSON = '400 application/json {"error":"invalid JSON"}';

/**
 * The named changes of fold 1, by cell and its answer now (null: none
 * names it, and the test fails):
 *
 *  - chunked-413: a chunked body over the route's ceiling is refused at
 *    the ceiling (the loader's capRequestBody), where the route read it in
 *    full and answered whatever `{}` gave it;
 *  - bad-json-400 (malformed): a body that is not JSON answers the one 400
 *    (readJson), where the route read it as `{}` or null and failed later
 *    with another answer, or refused it with a text of its own;
 *    `accepted as {} on main`: where `{}` passed and the route went on as
 *    if no field was sent;
 *  - opaque-500 (fold 2): a plain error (the database stand-in's, or a
 *    setting the sweep leaves unset, such as the vault's master key), whose
 *    text a route's hand catch put in its reply, answers the one opaque 500
 *    (docs/request-plumbing.md, fold 2), on a route fold 2 moves;
 *  - input-400 (fold 2): a refusal the caller fixes (an InputError now),
 *    which a hand catch said as a 500, answers 400 with the same body, on a
 *    route fold 2 moves;
 *  - bad-json-400 (empty): an empty body on a route that refuses one
 *    (readJson `refuseEmpty`) answers the one 400, where the route refused
 *    it with a text of its own;
 *  - ceiling-in-kb (A10 lows, part 2 #6): the 413 of a ceiling under 1 MB
 *    says it in KB ("at most 64 KB"), where it said "at most 0 MB";
 *  - item-check-first (F4 fix round 2): the bulk delete's item check of
 *    its ids and an app restore's manage check ask the database by
 *    @mantle/db's own client, which the stand-in does not reach (the real
 *    answers: f4-owner-flows.db.test.ts).
 */
/** The manifest pattern of a route file (app/api/x/[id]/route.ts). */
function patternOf(file: string): string {
  return file
    .replace(/^server\/web\/app/, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[\[?\.\.\.[^\]]+\]\]?/g, '*')
    .replace(/\[([^\]]+)\]/g, ':$1');
}

/** The routes fold 2 moves (the error sweep's list of files). */
const FOLD2_PATTERNS: ReadonlySet<string> = new Set(
  (
    JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '__snapshots__/a10-error-sweep.files.json'),
        'utf8',
      ),
    ) as string[]
  ).map(patternOf),
);

const OPAQUE = '500 application/json {"error":"internal error"}';

function changeKind(cell: string, main: string, now: string): string | null {
  const variant = cell.slice(cell.lastIndexOf(' ') + 1);
  const moved = FOLD2_PATTERNS.has(cell.split(' ')[1] ?? '');
  // F4 fix round 2 (items 4 and 12): a bulk delete checks every id it names
  // first, an app restore of the code asks manage first, each by
  // @mantle/db's own client (itemWriteVerdicts, itemWriteRefusalOf), which
  // the database stand-in does not reach: its error answers the one opaque
  // 500, where main read no row through the stand-in and answered on.
  if (
    now === OPAQUE &&
    (cell.startsWith('DELETE /api/files/files ') ||
      cell.startsWith('POST /api/apps/:id/snapshots/:sid/restore '))
  ) {
    return 'item-check-first (F4 fix round 2: asked of the database, the stand-in has none)';
  }
  // Fold 2 (one error answer): a plain error (the sweep's database stand-in
  // throws "DATABASE_URL must be set"; the vault has no master key) whose
  // text a route's catch put in the reply answers the one opaque 500 now.
  if (
    now === OPAQUE &&
    (/^\d{3} application\/json \{"error":"DATABASE_URL must be set"\}$/.test(main) ||
      (moved && /^[45]\d\d application\/json \{"error":"[^"]*"\}$/.test(main)))
  ) {
    return 'opaque-500 (fold 2: a plain error, its text was the reply)';
  }
  // Fix round 1 (L5): a failed item of a batch (the formula seed's `failed`
  // list) says a fixed text for a fault where it said the error's own (the
  // database stand-in's), the answer before the list as on main. (The longer
  // text runs past the 400 characters a cell keeps, so the list itself is
  // matched by its first item.)
  const failedAt = (x: string) => x.indexOf('"failed":[{');
  if (
    main.startsWith('200 ') &&
    failedAt(main) > 0 &&
    failedAt(now) === failedAt(main) &&
    now.slice(0, failedAt(now)) === main.slice(0, failedAt(main)) &&
    /"failed":\[\{"[a-z]+":"[^"]*","error":"DATABASE_URL must be set"\}/.test(main) &&
    /"failed":\[\{"[a-z]+":"[^"]*","error":"Could not [^"]*\. The details are in the server log\."\}/.test(
      now,
    )
  ) {
    return 'item-fault (fix round 1: a failed item says a fixed text for a fault)';
  }
  // A refusal the caller fixes, said as a 500 by a hand catch: 400 now.
  if (moved && main.startsWith('500 ') && now === `400${main.slice(3)}`) {
    return 'input-400 (fold 2: a refusal the caller fixes, said as a 500 on main)';
  }
  // A10 lows (part 2 #6): a ceiling under 1 MB is said in KB, where the
  // 413 said "at most 0 MB" (the 64 KB of the sign-in routes).
  if (
    main.includes('(at most 0 MB).') &&
    now === main.replace('(at most 0 MB).', '(at most 64 KB).')
  ) {
    return 'ceiling-in-kb (A10 lows: a ceiling under 1 MB is said in KB)';
  }
  if (
    variant === 'chunked' &&
    now.startsWith('413 application/json {"error":"This request is too large')
  ) {
    return 'chunked-413';
  }
  if ((variant === 'malformed' || variant === 'empty') && now === BAD_JSON) {
    return Number(main.slice(0, 3)) >= 400
      ? `bad-json-400 (${variant})`
      : `bad-json-400 (${variant}, accepted as {} on main)`;
  }
  return null;
}

type Cell = { row: string; method: string; pattern: string; cred: string };

describe.skipIf(!hasManifest)('A10 part 2 fold 1: every write route reads its body', () => {
  const realFetch = globalThis.fetch;
  let app: import('hono').Hono;
  const cells: Cell[] = [];
  const creds: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    // vi.stubEnv records each value it replaces; afterAll's vi.unstubAllEnvs
    // puts every one back (or unsets it, if it was unset).
    vi.stubEnv('SESSION_SECRET', 'a10-body-sweep-secret-that-is-at-least-32-chars');
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('MANTLE_API_CORS_ORIGINS', undefined);
    vi.stubEnv('MANTLE_DETACHED_DEV', undefined);
    // The answers were recorded on a host with neither: no master key (the
    // pdf-passwords cells answer "MANTLE_MASTER_KEY is not set"; seal() takes
    // MANTLE_MASTER_KEY_NEXT first, so that is cleared too) and no
    // tailscaled (network/deactivate answers "no tailscaled socket"). A host
    // with either (the workstation runs tailscaled) answered otherwise.
    vi.stubEnv('MANTLE_MASTER_KEY', undefined);
    vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
    vi.stubEnv('MANTLE_TAILSCALE_SOCK', '/nonexistent/a10-sweep/tailscaled.sock');
    globalThis.fetch = (async () => {
      throw new Error('sweep: no network');
    }) as typeof fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW.getTime() - 2 * 365 * DAY));
    hookSafeParse();
    const tokens = await import('../lib/auth/tokens');
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: 20 * 365 * 86_400 }).value}`,
    });
    creds.owner = cookie(ANCHOR_ID);
    creds.member = cookie(MEMBER_ID);
    creds.none = {};
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const { buildRoutePolicy } = await import('../lib/auth/route-policy');
    const policy = buildRoutePolicy(routeManifest);
    const entries = [...routeManifest].sort((a, b) =>
      a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0,
    );
    for (const e of entries) {
      for (const method of e.methods) {
        if (!WRITE_METHODS.has(method)) continue;
        const row = policy.get(`${method} ${e.pattern}`);
        if (!row || row.gone) continue;
        const who = row.public
          ? ['none']
          : row.logins && row.logins !== 'owner'
            ? ['owner', 'member']
            : ['owner'];
        for (const cred of who) {
          cells.push({ row: `${method} ${e.pattern}`, method, pattern: e.pattern, cred });
        }
      }
    }
  }, 120_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function send(
    method: string,
    pattern: string,
    cred: string,
    body: BodyInit | undefined,
  ): Promise<string> {
    const res = await app.request(concretePath(pattern), {
      method,
      headers: { ...creds[cred], 'content-type': 'application/json' },
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
    const type = res.headers.get('content-type') ?? '';
    const parts = [String(res.status), type.split(';')[0] || '-'];
    const location = res.headers.get('location');
    if (location) parts.push(`location=${location}`);
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      parts.push(text.length > 400 ? `${text.slice(0, 400)}…(${text.length})` : text);
    }
    return pairedTagStandIn(parts.join(' '));
  }

  /** The valid bodies: found at the read (record mode), else as kept. */
  async function validBodies(): Promise<Record<string, unknown>> {
    if (existsSync(BODIES))
      return JSON.parse(readFileSync(BODIES, 'utf8')) as Record<string, unknown>;
    expect(RECORD, `${BODIES} is missing: run with A10_BODY_SWEEP_RECORD=1 on main`).toBe(true);
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const c of cells) {
      if (c.row in out) continue;
      vi.setSystemTime(new Date(NOW.getTime() - 365 * DAY + n++ * 60_000));
      takeMet();
      await send(c.method, c.pattern, c.cred, JSON.stringify({ [PROBE_KEY]: 1 }));
      const [schema] = takeMet();
      out[c.row] = schema ? sampleBody(schema) : null;
    }
    writeFileSync(BODIES, `${JSON.stringify(out, null, 2)}\n`);
    return out;
  }

  function bodyOf(variant: Variant, valid: unknown, pattern: string): BodyInit | undefined {
    switch (variant) {
      case 'valid':
        return JSON.stringify(valid ?? {});
      case 'malformed':
        return '{"a":';
      case 'empty':
        return undefined;
      case 'nul':
        return JSON.stringify(withNul((valid ?? { text: 'sweep' }) as never));
      case 'array':
        return '[]';
      case 'chunked':
        return chunked((bodyCeilingFor(pattern) ?? JSON_BODY_CEILING_BYTES) + MB);
    }
  }

  /** Every cell's answer, `METHOD pattern cred variant` to its answer. */
  async function driveAll(): Promise<Map<string, string>> {
    const bodies = await validBodies();
    const out = new Map<string, string>();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let n = 0;
    try {
      for (const c of cells) {
        for (const variant of VARIANTS) {
          vi.setSystemTime(cellTime(n++));
          const body = bodyOf(variant, bodies[c.row], c.pattern);
          out.set(`${c.row} ${c.cred} ${variant}`, await send(c.method, c.pattern, c.cred, body));
        }
      }
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
    return out;
  }

  function readBaseline(): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(BASELINE, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf(' => ');
      out.set(line.slice(0, at), line.slice(at + 4));
    }
    return out;
  }

  it('answers every write route and body as recorded on main', async () => {
    const now = await driveAll();
    expect(now.size).toBeGreaterThan(1000);
    const lines = [...now].map(([cell, answer]) => `${cell} => ${answer}`);
    if (RECORD) {
      writeFileSync(
        BASELINE,
        [
          '# A10 part 2 fold 1: every write route and body, recorded on main (v0.300.41)',
          '# BEFORE the move. Written once (A10_BODY_SWEEP_RECORD=1); a10-body-sweep.test.ts',
          '# reads it back and holds every cell to it, or to a named change.',
          `# cells: ${now.size}`,
          ...lines,
          '',
        ].join('\n'),
      );
      return;
    }
    const before = readBaseline();
    expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...now].filter(([cell, answer]) => before.get(cell) !== answer);
    const unnamed = changed
      .filter(([cell, answer]) => changeKind(cell, before.get(cell)!, answer) === null)
      .map(([cell, answer]) => `${cell}: main ${before.get(cell)}; now ${answer}`);
    expect(unnamed).toEqual([]);
    const kinds = new Map<string, number>();
    for (const [cell, answer] of changed) {
      const k = changeKind(cell, before.get(cell)!, answer)!;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    await expect(
      [
        '# A10 part 2 fold 1: the cells that answer otherwise than on main, each with its',
        '# named kind (changeKind, a10-body-sweep.test.ts), its answer on main and now.',
        '# Every other cell of a10-body-sweep.txt answers byte for byte as recorded.',
        ...[...kinds].map(([k, n]) => `# ${k}: ${n} cells`),
        ...changed.flatMap(([cell, answer]) => [
          `${cell} [${changeKind(cell, before.get(cell)!, answer)}]`,
          `  main ${before.get(cell)}`,
          `  now  ${answer}`,
        ]),
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a10-body-sweep-changes.txt');
  }, 1_800_000);
});
