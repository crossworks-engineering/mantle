/**
 * The A10 lows (part 2 #1 to #3), on a migrated scratch database, through
 * the full HTTP pipeline (runRoute) as the owner:
 *
 *  - bad-id: every method of the event, journal, contact, heartbeat, table
 *    and formula routes under [id] (and their /api/v1 aliases), with an
 *    [id] that is not a uuid;
 *  - prose: the Studio prose history with an entityId that is not a uuid;
 *  - earliest: a heartbeat created or patched with an earliestAt that is no
 *    date;
 *  - dest: a Files move, copy or new file into a path that is no ltree;
 *  - key: an agent or AI worker that names an API key that is not there.
 *
 * Every cell's answer was recorded on main BEFORE the fix
 * (__snapshots__/a10-lows.main.txt, written with A10_LOWS_RECORD=1); now
 * every cell answers as recorded or is a named change (CHANGES: its kind
 * and its exact answer now).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a10-lows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
const RECORD = process.env.A10_LOWS_RECORD === '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '__snapshots__/a10-lows.main.txt');

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** Not a uuid, and not an ltree path. */
const BAD_ID = 'not-a-uuid';
const BAD_PATH = 'files.not a path!';
/** A uuid that names nothing. */
const NOBODY = '11111111-1111-4111-8111-111111111111';

/** The route families of part 2 #1: every route file under these [id]s. */
const FAMILIES = [
  '/api/events/:id',
  '/api/journal/:id',
  '/api/contacts/:id',
  '/api/heartbeats/:id',
  '/api/tables/:id',
  '/api/formulas/:id',
  '/api/v1/contacts/:id',
  '/api/v1/tables/:id',
];

/**
 * The named changes: by cell, its kind and its answer now. A cell not here
 * answers as recorded on main.
 */
const NOT_FOUND = '404 application/json {"error":"not found"}';
const BAD_ID_404 = 'bad-id-404 (the params gateway: an [id] that is not a uuid names nothing)';
/** The [id] cells that answer the gateway's 404 now (500 on main, or the
 *  evaluate route's own 404 text). */
const BAD_ID_CELLS = [
  'DELETE /api/contacts/:id',
  'DELETE /api/contacts/:id/shares',
  'DELETE /api/heartbeats/:id',
  'DELETE /api/journal/:id',
  'GET /api/contacts/:id',
  'GET /api/contacts/:id/shares',
  'GET /api/events/:id',
  'GET /api/formulas/:id',
  'GET /api/heartbeats/:id',
  'GET /api/heartbeats/:id/detail',
  'GET /api/journal/:id',
  'GET /api/tables/:id',
  'GET /api/tables/:id/export',
  'GET /api/tables/:id/history',
  'GET /api/tables/:id/history/:sid/download',
  'GET /api/tables/:id/rows',
  'GET /api/v1/contacts/:id',
  'GET /api/v1/tables/:id',
  'GET /api/v1/tables/:id/rows',
  'PATCH /api/contacts/:id',
  'PATCH /api/heartbeats/:id',
  'PATCH /api/journal/:id',
  'POST /api/contacts/:id/sharing',
  'POST /api/formulas/:id/evaluate',
  'POST /api/heartbeats/:id/fire',
  'POST /api/journal/:id/resolve',
];
/** The Files operation's own refusal (its text carries a dash: \u2014). */
const NO_FOLDER = (verb: string, fix: string) =>
  `400 application/json {"error":"${verb}: no folder at '${BAD_PATH}' \u2014 ${fix}"}`;
const FIRST = 'create it with folder_create first';
const CHANGES: Readonly<Record<string, { kind: string; now: string }>> = {
  ...Object.fromEntries(
    BAD_ID_CELLS.map((c) => [`bad-id ${c}`, { kind: BAD_ID_404, now: NOT_FOUND }]),
  ),
  'prose GET': {
    kind: 'prose-no-history (an entityId that is not a uuid has no versions)',
    now: '200 application/json {"versions":[]}',
  },
  'prose POST save': {
    kind: 'prose-400 (an entityId that is not a uuid names no entity)',
    now: '400 application/json {"error":"entity not found or not owned"}',
  },
  'prose POST revert': {
    kind: 'prose-400 (an entityId that is not a uuid has no version to go back to)',
    now: '400 application/json {"error":"version 1 not found"}',
  },
  'earliest POST': {
    kind: 'earliest-400 (earliestAt is an ISO date-time)',
    now: '400 application/json {"error":"earliestAt: Invalid ISO datetime"}',
  },
  'earliest PATCH': {
    kind: 'earliest-400 (earliestAt is an ISO date-time)',
    now: '400 application/json {"error":"earliestAt: Invalid ISO datetime"}',
  },
  'dest file move': {
    kind: 'dest-400 (a path that is no ltree is no folder)',
    now: NO_FOLDER(
      'moveFileById',
      'create it with folder_create, or find the right path with folder_list',
    ),
  },
  'dest file copy': {
    kind: 'dest-400 (a path that is no ltree is no folder)',
    now: NO_FOLDER('copyFileById', FIRST),
  },
  'dest folder move': {
    kind: 'dest-400 (a path that is no ltree is no folder)',
    now: NO_FOLDER('moveFolderById', FIRST),
  },
  'dest folder copy': {
    kind: 'dest-400 (a path that is no ltree is no folder)',
    now: NO_FOLDER('copyFolderById', FIRST),
  },
  'dest new file': {
    kind: 'dest-400 (a path that is no ltree is no folder)',
    now: `400 application/json {"error":"upsertFile: parent folder '${BAD_PATH}' not found"}`,
  },
  'key ai-worker PATCH backup': {
    kind: 'key-400 (a key id the vault has no key for)',
    now: '400 application/json {"error":"backupApiKeyId names no key in the vault."}',
  },
  'key agent PATCH tts': {
    kind: 'key-400 (a worker id that names no AI worker)',
    now: '400 application/json {"error":"ttsWorkerId names no AI worker."}',
  },
  'key ai-worker POST': {
    kind: 'key-400 (a key id the vault has no key for)',
    now: '400 application/json {"error":"apiKeyId names no key in the vault."}',
  },
  'key ai-worker PATCH': {
    kind: 'key-400 (a key id the vault has no key for)',
    now: '400 application/json {"error":"apiKeyId names no key in the vault."}',
  },
  'key agent POST': {
    kind: 'key-400 (a key id the vault has no key for)',
    now: '400 application/json {"error":"apiKeyId names no key in the vault."}',
  },
  'key agent PATCH': {
    kind: 'key-400 (a key id the vault has no key for)',
    now: '400 application/json {"error":"apiKeyId names no key in the vault."}',
  },
};

describe.skipIf(!DB_URL)('A10 lows: bad ids, dates, paths and keys answer as the caller’s', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const owner = randomUUID();
  const tag = `lows${randomUUID().slice(0, 6)}`;
  let ownerKey = '';
  const answers = new Map<string, string>();

  const answer = async (res: Response): Promise<string> => {
    const type = (res.headers.get('content-type') ?? '-').split(';')[0];
    const text = await res.text();
    return `${res.status} ${type} ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
  };
  let n = 0;
  const call = (login: string | { key: string }, method: string, p: string, body?: unknown) =>
    runRoute(login, method, p, body, {
      // A fresh address per call: no per-address limit is the answer.
      headers: { 'x-forwarded-for': `10.9.${Math.floor(n / 250) % 250}.${n++ % 250}` },
    });
  const cell = async (name: string, method: string, p: string, body?: unknown) => {
    const v1 = p.startsWith('/api/v1/');
    answers.set(name, await answer(await call(v1 ? { key: ownerKey } : owner, method, p, body)));
  };
  /** A setup call: it must answer 2xx; its JSON. */
  const setup = async (method: string, p: string, body: unknown): Promise<Record<string, any>> => {
    const res = await call(owner, method, p, body);
    const text = await res.text();
    expect(res.status, `${method} ${p}: ${text}`).toBeLessThan(300);
    return JSON.parse(text) as Record<string, any>;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a10-lows-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a10-lows-secret-at-least-32-characters-long';
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A10 lows test', { status: 503 })),
    );
    m = await import('@mantle/db');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'owner')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    const keys = await import('../lib/access-keys');
    const minted = await m.asSystem(
      () =>
        keys.mintAccessKey({
          name: `${tag} owner`,
          loginId: owner,
          access: 'read_write',
          areas: null,
          riskyTools: [],
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          createdBy: owner,
          maxLive: 50,
        }),
      'test',
    );
    ownerKey = minted!.key;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('every cell answers as on main, or as its named change', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // ── bad-id: every route of the families, every method ──
      const bodies = JSON.parse(
        readFileSync(path.join(here, '__snapshots__/a10-body-sweep.bodies.json'), 'utf8'),
      ) as Record<string, unknown>;
      const { routeManifest } = await import('./route-manifest.gen');
      const routes = [...routeManifest]
        .filter((e) => FAMILIES.some((f) => e.pattern === f || e.pattern.startsWith(`${f}/`)))
        .sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
      for (const e of routes) {
        for (const method of e.methods) {
          const p = e.pattern.replace(':id', BAD_ID).replace(/:[A-Za-z]+/g, NOBODY);
          const body =
            method === 'GET' || method === 'DELETE'
              ? undefined
              : (bodies[`${method} ${e.pattern}`] ?? {});
          await cell(`bad-id ${method} ${e.pattern}`, method, p, body);
        }
      }

      // ── prose: an entityId that is not a uuid ──
      const prose = { entityType: 'agent', entityId: BAD_ID, field: 'system_prompt' };
      await cell(
        'prose GET',
        'GET',
        `/api/studio/prose?entityType=agent&entityId=${BAD_ID}&field=system_prompt`,
      );
      await cell('prose POST save', 'POST', '/api/studio/prose', { ...prose, body: 'x' });
      await cell('prose POST revert', 'POST', '/api/studio/prose', { ...prose, revertTo: 1 });

      // ── earliest: a heartbeat date that is no date ──
      const hb = {
        slug: `${tag}-hb`,
        name: 'lows',
        agentSlug: 'lows',
        skillSlug: 'lows',
        schedule: { kind: 'manual' },
        surface: { kind: 'web' },
      };
      await cell('earliest POST', 'POST', '/api/heartbeats', {
        ...hb,
        slug: `${tag}-hb2`,
        earliestAt: 'not a date',
      });
      const made = await setup('POST', '/api/heartbeats', hb);
      await cell('earliest PATCH', 'PATCH', `/api/heartbeats/${made.heartbeat.id}`, {
        earliestAt: 'not a date',
      });

      // ── dest: a Files path that is no ltree ──
      const folder = await setup('POST', '/api/files/folders', {
        parentPath: 'files',
        slug: `${tag}_dir`,
      });
      const file = await setup('POST', '/api/files/files', {
        parentPath: 'files',
        filename: `${tag}.md`,
        content: 'lows',
      });
      const folderId = (folder.folder ?? folder).id as string;
      const fileId = (file.file ?? file).id as string;
      await cell('dest file move', 'PATCH', `/api/files/files/${fileId}`, { move: BAD_PATH });
      await cell('dest file copy', 'POST', `/api/files/files/${fileId}`, { copy_to: BAD_PATH });
      await cell('dest folder move', 'PATCH', `/api/files/folders/${folderId}`, {
        move: BAD_PATH,
      });
      await cell('dest folder copy', 'POST', `/api/files/folders/${folderId}`, {
        copy_to: BAD_PATH,
      });
      await cell('dest new file', 'POST', '/api/files/files', {
        parentPath: BAD_PATH,
        filename: `${tag}-2.md`,
        content: 'lows',
      });

      // ── key: an API key id that names no key ──
      await cell('key ai-worker POST', 'POST', '/api/ai-workers', {
        kind: 'reflector',
        name: `${tag} worker`,
        provider: 'openrouter',
        model: 'lows/model',
        apiKeyId: NOBODY,
      });
      const worker = await setup('POST', '/api/ai-workers', {
        kind: 'reflector',
        name: `${tag} worker 2`,
        provider: 'openrouter',
        model: 'lows/model',
      });
      await cell('key ai-worker PATCH', 'PATCH', `/api/ai-workers/${worker.worker.id}`, {
        apiKeyId: NOBODY,
      });
      await cell('key ai-worker PATCH backup', 'PATCH', `/api/ai-workers/${worker.worker.id}`, {
        backupApiKeyId: NOBODY,
      });
      await cell('key agent POST', 'POST', '/api/agents', {
        slug: `${tag}-agent`,
        name: 'lows',
        role: 'assistant',
        model: 'lows/model',
        apiKeyId: NOBODY,
        systemPrompt: 'lows',
      });
      const agent = await setup('POST', '/api/agents', {
        slug: `${tag}-agent2`,
        name: 'lows 2',
        role: 'assistant',
        model: 'lows/model',
        apiKeyId: null,
        systemPrompt: 'lows',
      });
      await cell('key agent PATCH', 'PATCH', `/api/agents/${agent.agent.id}`, {
        apiKeyId: NOBODY,
      });
      await cell('key agent PATCH tts', 'PATCH', `/api/agents/${agent.agent.id}`, {
        ttsWorkerId: NOBODY,
      });
    } finally {
      quiet.mockRestore();
    }

    const lines = [...answers].map(([k, v]) => `${k} => ${v}`).sort();
    if (RECORD) {
      writeFileSync(
        MAIN,
        [
          '# A10 lows: each cell recorded on main BEFORE the fix (A10_LOWS_RECORD=1);',
          '# a10-lows.db.test.ts compares every cell with this or its named change.',
          ...lines,
          '',
        ].join('\n'),
      );
      return;
    }
    expect(existsSync(MAIN), `${MAIN} is missing: record it on main`).toBe(true);
    const main = new Map(
      readFileSync(MAIN, 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const at = l.indexOf(' => ');
          return [l.slice(0, at), l.slice(at + 4)] as const;
        }),
    );
    expect([...answers.keys()].sort(), 'the cells are the recorded ones').toEqual(
      [...main.keys()].sort(),
    );
    const wrong: string[] = [];
    for (const [name, now] of answers) {
      const change = CHANGES[name];
      const want = change ? change.now : main.get(name)!;
      if (now !== want)
        wrong.push(`${name}\n  main ${main.get(name)}\n  want ${want}\n  now  ${now}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
    // A named change that answers as on main names nothing.
    for (const [name, c] of Object.entries(CHANGES)) {
      expect(main.get(name), `${name} [${c.kind}] answers as on main`).not.toBe(c.now);
    }
  }, 300_000);
});
