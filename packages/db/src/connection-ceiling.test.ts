/**
 * The connection ceiling: on every box shape, the sum of every Postgres pool
 * the code can open stays at or under 90% of the box's max_connections.
 *
 * Postgres refuses a connection past max_connections, so a box whose pools
 * can grow past it fails under a burst (a crash-looping service, a flood of
 * requests), not at idle. This test is the worst case, worked out from the
 * code and the compose files, never from a copied list:
 *
 *   - max_connections:  the postgres `command` in docker-compose.yml.
 *   - the processes:    the compose services that take the app env (it
 *                       carries DATABASE_URL), less the one-shot gate
 *                       (restart 'no'), less the services the core override
 *                       turns off on a core box.
 *   - each pool's size: the `max` at its call site, or the library default
 *                       read from the installed library.
 *   - which process opens a pool: SITES below. That is the one hand-kept
 *                       part, and the scan keeps it complete: every pool call
 *                       in runtime code must be in SITES (or ONE_SHOT), so a
 *                       new pool fails this test until it is counted.
 *
 * The 10% left over is for what the sum leaves out on purpose: the one-shot
 * `migrate` gate during a roll, an operator script (scripts/maintain, one at
 * a time per box), a psql session.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POOL_ROLES, viewerRoleStatements } from './viewer-roles';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** The share of max_connections the pools may take. */
const CEILING_SHARE = 0.9;

// ── The compose files ───────────────────────────────────────────────────

const compose = read('docker-compose.yml');
const coreOverride = read('docker-compose.core.yml');

/** `name -> block` for each service of a compose file. */
function serviceBlocks(text: string): Map<string, string> {
  const services = text.slice(text.indexOf('\nservices:\n'));
  const blocks = services.split(/\n(?= {2}[a-z_]+:\n)/).slice(1);
  return new Map(blocks.map((b) => [b.slice(2, b.indexOf(':')), b]));
}

const services = serviceBlocks(compose);

function maxConnectionsOf(block: string | undefined): number | null {
  const m = block?.match(/max_connections=(\d+)/);
  return m ? Number(m[1]) : null;
}

const MAX_CONNECTIONS = maxConnectionsOf(services.get('postgres'));

/** Long-running services that reach Postgres: they take the app env. */
const DB_PROCESSES = [...services]
  .filter(([, b]) => b.includes('<<: *app-env') && !/^\s+restart: ['"]no['"]$/m.test(b))
  .map(([name]) => name);

/** Services the core override gates behind a profile: off on a core box. */
const CORE_OFF = [...serviceBlocks(coreOverride)]
  .filter(([, b]) => /^\s+profiles:/m.test(b))
  .map(([name]) => name);

/** The worker entry file a service runs (`tsx workers/<x>.ts`). */
function workerEntry(service: string): string | null {
  const m = services.get(service)?.match(/'workers\/([\w-]+\.ts)'/);
  return m ? `server/web/workers/${m[1]}` : null;
}

// ── The installed libraries' defaults ───────────────────────────────────

/** A dependency's directory as Node resolves it from `fromDir` (pnpm or a
 *  hoisted layout alike), real path. */
function depDir(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate =
      basename(dir) === 'node_modules' ? join(dir, name) : join(dir, 'node_modules', name);
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} not found from ${fromDir}`);
  }
}

/** A library fact this test relies on. Fails when an upgrade changes it. */
function pinned(file: string, pattern: RegExp, what: string): RegExpMatchArray {
  const m = readFileSync(file, 'utf8').match(pattern);
  if (!m) throw new Error(`${what}: ${file} no longer matches ${pattern}; read the library again`);
  return m;
}

const pgBossDir = depDir(join(repoRoot, 'packages/runs'), 'pg-boss');
const pgPoolDir = depDir(depDir(pgBossDir, 'pg'), 'pg-pool');
const dbosDir = depDir(join(repoRoot, 'server/api'), '@dbos-inc/dbos-sdk');
const postgresJsDir = depDir(join(repoRoot, 'packages/db'), 'postgres');

/** pg-boss hands its own config to pg.Pool, so a PgBoss without `max` gets
 *  pg-pool's default. */
const PG_BOSS_MAX = (() => {
  pinned(join(pgBossDir, 'dist/db.js'), /new pg\.Pool\(this\.config\)/, 'pg-boss pool');
  const m = pinned(
    join(pgPoolDir, 'index.js'),
    /this\.options\.max = this\.options\.max \|\| this\.options\.poolSize \|\| (\d+)/,
    'pg-pool default max',
  );
  return Number(m[1]);
})();

/** pg-boss opens a LISTEN client outside its pool only with useListenNotify,
 *  off unless a caller sets it (each site is checked below). */
pinned(
  join(pgBossDir, 'dist/attorney.js'),
  /config\.useListenNotify = \('useListenNotify' in config\) \? config\.useListenNotify : false/,
  'pg-boss useListenNotify default',
);

/** DBOS (executor and client): a pool of DEFAULT_POOL_SIZE unless
 *  systemDatabasePoolSize is set. Its LISTEN client is borrowed from that
 *  pool, so it adds nothing. */
const DBOS_POOL = (() => {
  const sys = join(dbosDir, 'dist/src/system_database.js');
  pinned(sys, /#connect\(\) \{\s*return borrowClient\(this\.pool/, 'DBOS LISTEN client');
  pinned(sys, /sysDbPoolSize = exports\.DEFAULT_POOL_SIZE/, 'DBOS executor pool default');
  pinned(
    join(dbosDir, 'dist/src/client.js'),
    /systemDatabasePoolSize \?\? system_database_1\.DEFAULT_POOL_SIZE/,
    'DBOS client pool default',
  );
  return Number(pinned(sys, /exports\.DEFAULT_POOL_SIZE = (\d+);/, 'DBOS DEFAULT_POOL_SIZE')[1]);
})();

/** postgres.js runs every `sql.listen` of one instance on one extra
 *  connection of its own, outside `max`. */
const LISTEN_CONNECTIONS = Number(
  pinned(
    join(postgresJsDir, 'src/index.js'),
    /listen\.sql = Postgres\(\{\s*\.\.\.options,\s*max: (\d+)/,
    'postgres.js listen connection',
  )[1],
);

// ── The pool calls in runtime code ──────────────────────────────────────

type Kind = 'postgres' | 'pgboss' | 'dbos' | 'pg';

/** What opens a connection pool. `pg` (a bare pg Pool or Client) has no site
 *  today: one that appears must be counted. */
const POOL_CALLS: Record<Kind, RegExp> = {
  // Not inside a regex or a string (`/^postgres(ql)?:/`).
  postgres: /(?<![\w^/.'"`])postgres\(/g,
  pgboss: /\bnew PgBoss\(/g,
  dbos: /\bDBOSClient\.create\(|\bDBOS\.setConfig\(/g,
  pg: /\bnew (?:pg\.)?(?:Pool|Client)\(\s*\{\s*(?:connectionString|host|user|database)\b/g,
};

/** The box processes (compose services) that open a site's pool. `every`:
 *  each DB process. `runs`: the ones that open it only with MANTLE_RUNS on. */
interface Site {
  file: string;
  kind: Kind;
  processes: 'every' | string[];
  runs?: string[];
  /** The instance also LISTENs (postgres.js: one more connection). */
  listen?: boolean;
  /** Why these processes, for the reader. */
  why: string;
}

const CLIENT_TS = 'packages/db/src/client.ts';
const RUNNER_TS = 'server/web/workers/_runner.ts';

const SITES: Site[] = [
  {
    file: CLIENT_TS,
    kind: 'postgres',
    processes: 'every',
    why: 'getAdminDb, the system pool: one per process. getViewerDb, the limited pools: counted per role, capped by its CONNECTION LIMIT',
  },
  {
    file: 'server/api/src/agent/runtime.ts',
    kind: 'postgres',
    processes: ['api'],
    listen: true,
    why: 'the agent runtime boot (server/api main)',
  },
  {
    file: 'server/api/src/turn-cancel.ts',
    kind: 'postgres',
    processes: ['api'],
    listen: true,
    why: 'the turn cancel listener (server/api main)',
  },
  {
    file: 'server/web/lib/realtime.ts',
    kind: 'postgres',
    processes: ['web'],
    listen: true,
    why: 'the SSE fan-out, web only',
  },
  {
    file: 'server/web/workers/push-notify.ts',
    kind: 'postgres',
    processes: ['worker_push'],
    listen: true,
    why: 'the push worker entry',
  },
  {
    file: RUNNER_TS,
    kind: 'pgboss',
    processes: [], // read from the worker entries: queueWorkers() below
    why: 'createBoss: each runQueueWorker worker, and the runs worker with MANTLE_RUNS on',
  },
  {
    file: 'packages/runs/src/boss.ts',
    kind: 'pgboss',
    processes: ['web', 'api'],
    runs: ['worker_runs'],
    why: 'the run-actions send boss: run tools and pending approvals (web MCP, api turns), the runs worker',
  },
  {
    file: 'packages/email/src/backfill-queue.ts',
    kind: 'pgboss',
    processes: ['web', 'api', 'worker_email', 'worker_microsoft'],
    runs: ['worker_runs'],
    why: 'contact backfills: contact routes (web), the contact tools (api turns, web MCP, run tool items), the email and microsoft workers',
  },
  {
    file: 'packages/email/src/accounts.ts',
    kind: 'pgboss',
    processes: ['web'],
    why: 'setIncludedFolders: the email folders route',
  },
  {
    file: 'server/api/src/agent/extract-queue.ts',
    kind: 'pgboss',
    processes: ['api'],
    why: 'the extract queue of the agent runtime',
  },
  {
    file: 'server/api/src/config.ts',
    kind: 'dbos',
    processes: ['api'],
    why: 'the DBOS executor of server/api',
  },
  {
    file: 'server/web/lib/dbos-client.ts',
    kind: 'dbos',
    processes: ['web'],
    why: 'turn enqueue from web routes',
  },
  {
    file: 'server/web/lib/runs/dbos-enqueue.ts',
    kind: 'dbos',
    processes: [],
    runs: ['worker_runs'],
    why: 'worker turns, enqueued by the runs worker (execute-worker)',
  },
];

/** Pool calls that never run in a box's long-running processes. */
const ONE_SHOT: Record<string, string> = {
  'packages/db/src/migrate.ts': 'the migrate gate (restart no)',
  'packages/db/src/init-scratch.ts': 'test databases',
  'packages/db/src/test-support.ts': 'tests',
  'packages/db/src/drop-viewer-logins.ts': 'operator CLI',
  'server/api/src/provision.ts': 'the migrate gate (provision)',
  'packages/email/src/backfill-rfc-message-id.ts': 'operator script (maintain)',
};
/** Whole directories of operator scripts (pgboss:init of the migrate gate
 *  among them) and benchmarks. */
const ONE_SHOT_DIRS = ['server/web/scripts/', 'server/api/src/bench/'];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'out', '.turbo']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The source without comments, so a doc line that names `postgres()` is not
 *  a call. A comment counts only at a line start or after a space, so a URL
 *  or a glob in a string stays code. */
function code(src: string): string {
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The argument text of the call whose `(` ends at `at`. */
function callArgs(src: string, at: number): string {
  let depth = 1;
  let i = at;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
  }
  return src.slice(at, i - 1);
}

interface Call {
  file: string;
  kind: Kind;
  args: string;
  src: string;
}

const runtimeRoots = [
  ...readdirSync(join(repoRoot, 'packages')).map((p) => `packages/${p}/src`),
  ...readdirSync(join(repoRoot, 'server')).map((s) => `server/${s}`),
].filter((r) => existsSync(join(repoRoot, r)) && statSync(join(repoRoot, r)).isDirectory());

const CALLS: Call[] = runtimeRoots.flatMap((root) =>
  sourceFiles(join(repoRoot, root)).flatMap((path) => {
    const file = relative(repoRoot, path);
    const src = code(readFileSync(path, 'utf8'));
    return (Object.keys(POOL_CALLS) as Kind[]).flatMap((kind) =>
      [...src.matchAll(POOL_CALLS[kind])].map((m) => ({
        file,
        kind,
        args: callArgs(src, m.index + m[0].length),
        src,
      })),
    );
  }),
);

const isOneShot = (file: string) =>
  file in ONE_SHOT || ONE_SHOT_DIRS.some((d) => file.startsWith(d));

/** The pool size a call asks for: `max` (postgres.js, pg-boss) or
 *  `systemDatabasePoolSize` (DBOS), a literal or a const of the same file,
 *  else the library default. A postgres.js call must set `max`. */
function sizeOf(call: Call): number {
  const key = call.kind === 'dbos' ? 'systemDatabasePoolSize' : 'max';
  const m = call.args.match(new RegExp(`\\b${key}:\\s*([A-Za-z_$][\\w$]*|\\d+)`));
  if (!m) {
    if (call.kind === 'pgboss') return PG_BOSS_MAX;
    if (call.kind === 'dbos') return DBOS_POOL;
    throw new Error(`${call.file}: a ${call.kind} pool with no explicit max`);
  }
  const value = m[1] ?? '';
  if (/^\d+$/.test(value)) return Number(value);
  const c = call.src.match(new RegExp(`\\bconst ${value}\\s*=\\s*(\\d+)\\s*;`));
  if (!c) throw new Error(`${call.file}: cannot read ${key}: ${value}`);
  return Number(c[1]);
}

/** client.ts: the system pool and the limited pool (VIEWER_POOL_MAX per
 *  process and role). */
const clientCalls = CALLS.filter((c) => c.file === CLIENT_TS && c.kind === 'postgres');
const viewerCall = clientCalls.find((c) => /viewerDatabaseUrl\(/.test(c.args));
const systemCall = clientCalls.find((c) => !/viewerDatabaseUrl\(/.test(c.args));

/**
 * The processes that open the write role's pool (arch A2b2b): the entry
 * files that call openLoginWritePool, by the compose service they run.
 * Only web and api (docs/actors.md): any other caller fails the test below
 * until it is counted here.
 */
const WRITE_POOL_ENTRIES: Record<string, string> = {
  'server/web/server/main.ts': 'web',
  'server/api/src/main.ts': 'api',
};
const WRITE_POOL_OPENERS = runtimeRoots.flatMap((root) =>
  sourceFiles(join(repoRoot, root))
    .map((path) => relative(repoRoot, path))
    .filter((file) => file !== CLIENT_TS && /\bopenLoginWritePool\(/.test(code(read(file)))),
);

/** Each LOGIN role's CONNECTION LIMIT, read from the statement migrate runs. */
const ROLE_LIMITS = POOL_ROLES.map((role) => {
  const stmt = viewerRoleStatements(role, 'ceiling-test-key', false).join(' ');
  const m = stmt.match(/CONNECTION LIMIT (\d+)/);
  if (!m) throw new Error(`role ${role}: no CONNECTION LIMIT`);
  return { role, limit: Number(m[1]) };
});

/** Workers whose entry starts a pg-boss of its own (_runner.ts): always, or
 *  only with MANTLE_RUNS on (the flag check comes before createBoss). */
function queueWorkers(processes: string[]): { always: string[]; runs: string[] } {
  const always: string[] = [];
  const runs: string[] = [];
  for (const p of processes) {
    const entry = workerEntry(p);
    if (!entry) continue;
    const src = code(read(entry));
    if (/\brunQueueWorker\(\s*['"]/.test(src)) always.push(p);
    else if (/\bcreateBoss\(/.test(src)) {
      const gate = src.search(/!\s*isRunsEnabled\(\)/);
      if (gate < 0 || gate > src.search(/\bcreateBoss\(/)) always.push(p);
      else runs.push(p);
    }
  }
  return { always, runs };
}

interface Shape {
  name: string;
  processes: string[];
  runs: boolean;
}

const SHAPES: Shape[] = [
  { name: 'full', processes: DB_PROCESSES, runs: true },
  { name: 'full, MANTLE_RUNS off', processes: DB_PROCESSES, runs: false },
  { name: 'core', processes: DB_PROCESSES.filter((p) => !CORE_OFF.includes(p)), runs: true },
];

/** Every pool's worst case on a shape, line by line. */
function ceiling(shape: Shape): { total: number; lines: Record<string, number> } {
  const on = (list: string[] | undefined) =>
    (list ?? []).filter((p) => shape.processes.includes(p));
  const lines: Record<string, number> = {};
  if (systemCall) lines['system pool'] = sizeOf(systemCall) * shape.processes.length;
  if (viewerCall) {
    const perProcess = sizeOf(viewerCall);
    // The write pool only in the processes that open it (A2b2b).
    const writers = Object.values(WRITE_POOL_ENTRIES).filter((p) => shape.processes.includes(p));
    for (const { role, limit } of ROLE_LIMITS) {
      const procs = role === 'write' ? writers.length : shape.processes.length;
      lines[`role ${role}`] = Math.min(limit, perProcess * procs);
    }
  }
  const workers = queueWorkers(shape.processes);
  for (const site of SITES) {
    if (site.file === CLIENT_TS) continue;
    const call = CALLS.find((c) => c.file === site.file && c.kind === site.kind);
    if (!call) continue; // reported by the site test below
    let procs =
      site.file === RUNNER_TS
        ? [...workers.always, ...(shape.runs ? workers.runs : [])]
        : site.processes === 'every'
          ? shape.processes
          : on(site.processes);
    if (shape.runs) procs = [...procs, ...on(site.runs)];
    const per = sizeOf(call) + (site.listen ? LISTEN_CONNECTIONS : 0);
    if (procs.length) lines[`${site.kind} ${site.file}`] = per * procs.length;
  }
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  return { total, lines };
}

describe('Postgres connection ceiling', () => {
  it('reads max_connections from the postgres command, and only there', () => {
    expect(MAX_CONNECTIONS).not.toBeNull();
    expect(maxConnectionsOf(serviceBlocks(coreOverride).get('postgres'))).toBeNull();
    // The dev stack runs the same processes with the same pools.
    const dev = serviceBlocks(read('docker-compose.dev.yml')).get('postgres');
    expect(maxConnectionsOf(dev), 'docker-compose.dev.yml').toBe(MAX_CONNECTIONS);
    for (const f of readdirSync(repoRoot).filter((n) => /^docker-compose.*\.ya?ml$/.test(n))) {
      if (f === 'docker-compose.yml' || f === 'docker-compose.dev.yml') continue;
      expect(read(f), `${f} sets max_connections`).not.toMatch(/max_connections/);
    }
  });

  it('finds the box processes and the core shape', () => {
    expect(DB_PROCESSES).toEqual(expect.arrayContaining(['web', 'api', 'worker_files']));
    expect(DB_PROCESSES).not.toContain('migrate');
    expect(CORE_OFF).toEqual(expect.arrayContaining(['worker_email', 'worker_runs']));
    expect(compose).toMatch(/x-app-env: &app-env[\s\S]*?\n {2}DATABASE_URL:/);
  });

  it('every pool call in runtime code is counted or one-shot', () => {
    const unknown = CALLS.filter(
      (c) => !isOneShot(c.file) && !SITES.some((s) => s.file === c.file && s.kind === c.kind),
    ).map((c) => `${c.kind} ${c.file}`);
    expect(unknown, 'a new pool: add it to SITES (who opens it) or ONE_SHOT').toEqual([]);
  });

  it('each counted site still opens its pool, once (client.ts: system + limited)', () => {
    for (const s of SITES) {
      const n = CALLS.filter((c) => c.file === s.file && c.kind === s.kind).length;
      expect(n, `${s.kind} ${s.file}`).toBe(s.file === CLIENT_TS ? 2 : 1);
    }
    expect(systemCall).toBeDefined();
    expect(viewerCall).toBeDefined();
  });

  it('only web and api open the write pool (A2b2b)', () => {
    expect([...WRITE_POOL_OPENERS].sort()).toEqual(Object.keys(WRITE_POOL_ENTRIES).sort());
    for (const p of Object.values(WRITE_POOL_ENTRIES)) expect(DB_PROCESSES).toContain(p);
    // Each process opens VIEWER_POOL_MAX of it, under the role's limit.
    const write = ROLE_LIMITS.find((r) => r.role === 'write');
    expect(write).toBeDefined();
    expect(viewerCall && sizeOf(viewerCall) * Object.keys(WRITE_POOL_ENTRIES).length).toBeLessThanOrEqual(
      write!.limit,
    );
  });

  it('the runs worker opens its boss only with MANTLE_RUNS on', () => {
    expect(queueWorkers(['worker_runs'])).toEqual({ always: [], runs: ['worker_runs'] });
  });

  it('no counted pg-boss turns on LISTEN; no DBOS site brings its own pool', () => {
    for (const c of CALLS.filter((x) => x.kind === 'pgboss' && !isOneShot(x.file))) {
      expect(c.args, c.file).not.toMatch(/useListenNotify/);
    }
    for (const c of CALLS.filter((x) => x.kind === 'dbos')) {
      expect(c.args, c.file).not.toMatch(/systemDatabasePool\b/);
    }
  });

  it('a site marked listen really listens; the others do not', () => {
    for (const s of SITES.filter((x) => x.kind === 'postgres' && x.file !== CLIENT_TS)) {
      expect(/\.listen\(/.test(code(read(s.file))), s.file).toBe(Boolean(s.listen));
    }
  });

  const limit = Math.floor((MAX_CONNECTIONS ?? 0) * CEILING_SHARE);
  for (const shape of SHAPES) {
    const { total, lines } = ceiling(shape);
    it(`${shape.name}: ${total} of ${limit} (${shape.processes.length} processes) ${JSON.stringify(lines)}`, () => {
      expect(total).toBeLessThanOrEqual(limit);
    });
  }
});
