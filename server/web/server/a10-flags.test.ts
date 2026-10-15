/**
 * Every flag and number the tree reads from the environment or the profile,
 * under a matrix of inputs (workspaces arch A10 #11; docs/configuration.md,
 * "Flags and env"). Record, move, compare: every cell below was recorded on
 * main (a10-flags.main.json) while each site still parsed its value by hand;
 * each cell the step changed is named in a10-flags.changes.json with its new
 * answer and the reason. A cell that differs from main and is not named there
 * fails, and so does a named change that no longer happens.
 *
 * A reader is one site's reading of one variable (`MANTLE_TURN_STREAMING` is
 * read twice, so it has two readers). An input is the raw value: `unset`,
 * `=<value>`, or `alias=<value>` (only the legacy name set) for a variable
 * with a legacy alias. NaN is recorded as the string "NaN".
 *
 *   pnpm vitest run server/web/server/a10-flags.test.ts
 *   A10_FLAGS_RECORD=main …   writes a10-flags.main.json (on main only)
 *   A10_FLAGS_RECORD=now …    writes a10-flags.now.json (to name changes)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_ALIASES, env, envDynamic, type KnownEnvName } from '@mantle/config';

const RECORD = process.env.A10_FLAGS_RECORD;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_FILE = path.join(HERE, 'a10-flags.main.json');
const CHANGES_FILE = path.join(HERE, 'a10-flags.changes.json');

type Value = boolean | number | string | null;
type Changes = { cells: Record<string, { now: Value; why: string }> };

const FLAG_INPUTS = [
  undefined,
  '',
  '0',
  '1',
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'TRUE',
  ' Off ',
  'garbage',
];
const NUMBER_INPUTS = [
  undefined,
  '',
  '0',
  '1',
  '5',
  '-1',
  '0.5',
  '2.5',
  '1e3',
  '16abc',
  'garbage',
  '700',
  '1500',
  '99999999',
  ' 7 ',
];
const PROFILE_INPUTS: unknown[] = [undefined, null, true, false, 'true', 'false', 0, 1];

// ── the legacy readers, copied from each site on main ──────────────────────

/** client-types turn-streaming.ts flagOn */
function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}
/** config index.ts envInt on main */
function mainEnvInt(name: KnownEnvName, fallback: number, min = 0): number {
  const raw = Number(env(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}
/** config index.ts envFlag on main */
function mainEnvFlag(name: KnownEnvName, fallback = false): boolean {
  const raw = env(name)?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
/** content node-snapshot-rows.ts envMbBytes, in MB */
function mainEnvMb(name: KnownEnvName, defaultMb: number): number {
  return env(name)?.trim() ? mainEnvInt(name, defaultMb, 1) : defaultMb;
}
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
/** tools tool-results.ts envInt */
function toolResultInt(name: string, def: number): number {
  const v = envDynamic(name);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}
/** tools builtins-video.ts intEnv */
function videoInt(name: string, dflt: number): number {
  const v = Number(envDynamic(name));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}
function memberTurns(): number {
  const turns = Number(env('TEAM_CHAT_DAILY_TURNS'));
  return Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 100;
}
function memberTokensLedger(): number {
  const rawTokens = env('MANTLE_MEMBER_DAILY_TOKENS');
  const tokens = rawTokens === undefined || rawTokens === '' ? NaN : Number(rawTokens);
  return Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : 2_000_000;
}
function memberTokensWeb(): number {
  const raw = env('MANTLE_MEMBER_DAILY_TOKENS');
  if (raw === undefined || raw === '') return 2_000_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2_000_000;
}
function mcpTerminal(transport: 'stdio' | 'http'): boolean {
  const terminalEnv = env('MANTLE_MCP_TERMINAL') ?? '';
  return /^(1|true|on|yes)$/i.test(terminalEnv)
    ? true
    : /^(0|false|off|no)$/i.test(terminalEnv)
      ? false
      : transport === 'stdio';
}
function extractConcurrency(): number {
  const envN = Number.parseInt(env('EXTRACT_CONCURRENCY') ?? '', 10);
  const candidate = envN;
  if (!Number.isFinite(candidate) || candidate < 1) return 2;
  return Math.min(Math.floor(candidate), 16);
}
function dpi(name: 'DWF_RENDER_DPI' | 'DWG_RENDER_DPI'): number {
  const raw = Number(env(name));
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.min(600, Math.max(50, Math.round(raw)));
}
function positiveFloor(name: KnownEnvName, def: number): number {
  const raw = Number(env(name));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : def;
}

type Reader = { env: string; kind: 'flag' | 'number'; read: () => Value };
const flag = (name: string, read: () => boolean): Reader => ({ env: name, kind: 'flag', read });
const num = (name: string, read: () => number): Reader => ({ env: name, kind: 'number', read });

/** id -> the reading on main. The id names the variable and the site. */
const LEGACY: Record<string, Reader> = {
  // flags: the on-unless-off dialect
  'MANTLE_TURN_STREAMING client-types/turn-streaming isTurnStreamingEnabled': flag(
    'MANTLE_TURN_STREAMING',
    () => flagOn(process.env.MANTLE_TURN_STREAMING),
  ),
  'MANTLE_TURN_STREAMING turn-stream/publish isBufferingEnabled': flag(
    'MANTLE_TURN_STREAMING',
    () => {
      const v = env('MANTLE_TURN_STREAMING')?.trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
    },
  ),
  'NEXT_PUBLIC_MANTLE_TURN_STREAMING client-types/turn-streaming isTurnStreamingEnabledClient':
    flag('NEXT_PUBLIC_MANTLE_TURN_STREAMING', () =>
      flagOn(process.env.NEXT_PUBLIC_MANTLE_TURN_STREAMING),
    ),
  'MANTLE_TURN_NARRATION api/turn-narration isTurnNarrationEnabled': flag(
    'MANTLE_TURN_NARRATION',
    () => {
      const v = env('MANTLE_TURN_NARRATION')?.trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
    },
  ),
  'MANTLE_TURN_TOKENS api/turn-stream-observer isTurnTokenStreamingEnabled': flag(
    'MANTLE_TURN_TOKENS',
    () => {
      const v = env('MANTLE_TURN_TOKENS')?.trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
    },
  ),
  'MANTLE_TURN_SUGGESTIONS api/turn-suggestion isTurnSuggestionsEnabled': flag(
    'MANTLE_TURN_SUGGESTIONS',
    () => {
      const v = env('MANTLE_TURN_SUGGESTIONS')?.trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
    },
  ),
  'MANTLE_MCP_TOOLSMITH_WRITE mcp-core/build-server': flag(
    'MANTLE_MCP_TOOLSMITH_WRITE',
    () => !/^(0|false|off|no)$/i.test(env('MANTLE_MCP_TOOLSMITH_WRITE') ?? ''),
  ),
  'MANTLE_QUERY_ENRICH runtime/conversation': flag(
    'MANTLE_QUERY_ENRICH',
    () => env('MANTLE_QUERY_ENRICH') !== '0',
  ),
  'S3_FORCE_PATH_STYLE storage/index': flag(
    'S3_FORCE_PATH_STYLE',
    () => !/^(false|0|no)$/i.test(env('S3_FORCE_PATH_STYLE') ?? ''),
  ),
  // flags: the off-unless-on dialect
  'MANTLE_RUNS runs/flag isRunsEnabled': flag('MANTLE_RUNS', () => {
    const v = env('MANTLE_RUNS')?.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }),
  'MANTLE_VIEWER_ROLES_PER_DATABASE db/client+migrate envFlag': flag(
    'MANTLE_VIEWER_ROLES_PER_DATABASE',
    () => mainEnvFlag('MANTLE_VIEWER_ROLES_PER_DATABASE'),
  ),
  'MANTLE_DISABLE_BOOT_RECONCILE web/system-manifest/reconcile': flag(
    'MANTLE_DISABLE_BOOT_RECONCILE',
    () => env('MANTLE_DISABLE_BOOT_RECONCILE') === '1',
  ),
  'MANTLE_CRASH_TEST api/crash-test': flag(
    'MANTLE_CRASH_TEST',
    () => env('MANTLE_CRASH_TEST') === '1',
  ),
  'MANTLE_DETACHED_DEV web/auth-constants isDetachedDev (NODE_ENV development)': flag(
    'MANTLE_DETACHED_DEV',
    () => !!env('MANTLE_DETACHED_DEV')?.trim(),
  ),
  // flags: explicit either way, else the transport decides
  'MANTLE_MCP_TERMINAL mcp-core/register/context (stdio)': flag('MANTLE_MCP_TERMINAL', () =>
    mcpTerminal('stdio'),
  ),
  'MANTLE_MCP_TERMINAL mcp-core/register/context (http)': flag('MANTLE_MCP_TERMINAL', () =>
    mcpTerminal('http'),
  ),

  // numbers
  'MANTLE_SHEET_PROFILE_ROWS content/chunk-spreadsheet': num('MANTLE_SHEET_PROFILE_ROWS', () =>
    Number(env('MANTLE_SHEET_PROFILE_ROWS') ?? 8),
  ),
  'TEAM_CHAT_DAILY_TURNS content/member-turn-ledger': num('TEAM_CHAT_DAILY_TURNS', memberTurns),
  'TEAM_CHAT_DAILY_TURNS web/member-daily-cap': num('TEAM_CHAT_DAILY_TURNS', memberTurns),
  'MANTLE_MEMBER_DAILY_TOKENS content/member-turn-ledger': num(
    'MANTLE_MEMBER_DAILY_TOKENS',
    memberTokensLedger,
  ),
  'MANTLE_MEMBER_DAILY_TOKENS web/member-daily-cap': num(
    'MANTLE_MEMBER_DAILY_TOKENS',
    memberTokensWeb,
  ),
  'MANTLE_SUPERSEDED_SALIENCE content/supersede': num('MANTLE_SUPERSEDED_SALIENCE', () =>
    clamp01(Number(env('MANTLE_SUPERSEDED_SALIENCE') ?? 0.5)),
  ),
  'MANTLE_CORRECTED_SALIENCE content/supersede': num('MANTLE_CORRECTED_SALIENCE', () =>
    clamp01(Number(env('MANTLE_CORRECTED_SALIENCE') ?? 0.3)),
  ),
  'MANTLE_SUPERSEDED_FILE_SALIENCE api/extract/supersede': num(
    'MANTLE_SUPERSEDED_FILE_SALIENCE',
    () => Math.min(1, Math.max(0, Number(env('MANTLE_SUPERSEDED_FILE_SALIENCE') ?? 0.5))),
  ),
  'EXTRACT_CONCURRENCY embeddings/extraction-concurrency (no saved value)': num(
    'EXTRACT_CONCURRENCY',
    extractConcurrency,
  ),
  'DWF_RENDER_DPI files/dwf': num('DWF_RENDER_DPI', () => dpi('DWF_RENDER_DPI')),
  'DWG_RENDER_DPI files/dwg': num('DWG_RENDER_DPI', () => dpi('DWG_RENDER_DPI')),
  'MANTLE_RUNS_WORKER_CONCURRENCY runs/engine': num('MANTLE_RUNS_WORKER_CONCURRENCY', () => {
    const raw = Number(env('MANTLE_RUNS_WORKER_CONCURRENCY') ?? '');
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
  }),
  'MANTLE_SALIENCE_LAMBDA runtime/conversation': num('MANTLE_SALIENCE_LAMBDA', () =>
    Number(env('MANTLE_SALIENCE_LAMBDA') ?? 0.15),
  ),
  'MANTLE_SALIENCE_LAMBDA search/chunks': num('MANTLE_SALIENCE_LAMBDA', () =>
    Number(env('MANTLE_SALIENCE_LAMBDA') ?? 0.15),
  ),
  'MANTLE_SALIENCE_LAMBDA search/index': num('MANTLE_SALIENCE_LAMBDA', () =>
    Number(env('MANTLE_SALIENCE_LAMBDA') ?? 0.15),
  ),
  'MANTLE_RECENCY_TAU_DAYS runtime/conversation (days)': num('MANTLE_RECENCY_TAU_DAYS', () =>
    Number(env('MANTLE_RECENCY_TAU_DAYS') ?? 180),
  ),
  'MANTLE_RECENCY_EPISODIC runtime/conversation': num('MANTLE_RECENCY_EPISODIC', () =>
    Number(env('MANTLE_RECENCY_EPISODIC') ?? 0.15),
  ),
  'MANTLE_RECENCY_CONTENT runtime/conversation': num('MANTLE_RECENCY_CONTENT', () =>
    Number(env('MANTLE_RECENCY_CONTENT') ?? 0.06),
  ),
  'MANTLE_SCOPE_EXACT_MAX_ROWS search/scope': num('MANTLE_SCOPE_EXACT_MAX_ROWS', () => {
    const n = Math.floor(Number(env('MANTLE_SCOPE_EXACT_MAX_ROWS') ?? 15000));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }),
  'MANTLE_SCOPE_EXACT_MAX_ITEMS search/scope': num('MANTLE_SCOPE_EXACT_MAX_ITEMS', () => {
    const n = Math.floor(Number(env('MANTLE_SCOPE_EXACT_MAX_ITEMS') ?? 500));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }),
  'TABLE_IMPORT_MAX_ROWS tabledb/engine': num('TABLE_IMPORT_MAX_ROWS', () => {
    const raw = Number(env('TABLE_IMPORT_MAX_ROWS') ?? '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000_000;
  }),
  'TABLE_SQL_TIMEOUT_MS tabledb/sql-runner': num('TABLE_SQL_TIMEOUT_MS', () => {
    const raw = Number(env('TABLE_SQL_TIMEOUT_MS') ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
  }),
  'MANTLE_LOCAL_EMBED_BATCH voice/local-embedding': num('MANTLE_LOCAL_EMBED_BATCH', () => {
    const n = Number.parseInt(env('MANTLE_LOCAL_EMBED_BATCH') ?? '', 10);
    return Number.isFinite(n) && n >= 1 ? n : 16;
  }),
  'MANTLE_LOCAL_EMBED_TIMEOUT_MS voice/local-embedding': num(
    'MANTLE_LOCAL_EMBED_TIMEOUT_MS',
    () => {
      const n = Number.parseInt(env('MANTLE_LOCAL_EMBED_TIMEOUT_MS') ?? '', 10);
      return Number.isFinite(n) && n >= 1_000 ? n : 120_000;
    },
  ),
  'MANTLE_EXTRACT_EXPIRE_MIN api/extract-queue': num(
    'MANTLE_EXTRACT_EXPIRE_MIN',
    () => Number(env('MANTLE_EXTRACT_EXPIRE_MIN')) || 60,
  ),
  'MANTLE_EXTRACT_EXPIRE_MIN web/journey (+15)': num(
    'MANTLE_EXTRACT_EXPIRE_MIN',
    () => (Number(env('MANTLE_EXTRACT_EXPIRE_MIN')) || 60) + 15,
  ),
  'MANTLE_EXTRACT_EXPIRE_MIN web/scripts/traces-reap (+15)': num(
    'MANTLE_EXTRACT_EXPIRE_MIN',
    () => (Number(env('MANTLE_EXTRACT_EXPIRE_MIN')) || 60) + 15,
  ),
  'MANTLE_MAX_AUTO_TABLE_TABLES api/extract/auto-table': num(
    'MANTLE_MAX_AUTO_TABLE_TABLES',
    () => Number(env('MANTLE_MAX_AUTO_TABLE_TABLES')) || 20,
  ),
  'MANTLE_EXTRACT_DRAIN_WINDOW_HOURS api/runtime': num(
    'MANTLE_EXTRACT_DRAIN_WINDOW_HOURS',
    () => Number(env('MANTLE_EXTRACT_DRAIN_WINDOW_HOURS')) || 168,
  ),
  'MANTLE_EXTRACT_DRAIN_LIMIT api/runtime': num(
    'MANTLE_EXTRACT_DRAIN_LIMIT',
    () => Number(env('MANTLE_EXTRACT_DRAIN_LIMIT')) || 1000,
  ),
  'MANTLE_EXTRACT_SWEEP_LIMIT api/runtime': num(
    'MANTLE_EXTRACT_SWEEP_LIMIT',
    () => Number(env('MANTLE_EXTRACT_SWEEP_LIMIT')) || 200,
  ),
  'MANTLE_EXTRACT_SWEEP_MS api/runtime': num(
    'MANTLE_EXTRACT_SWEEP_MS',
    () => Number(env('MANTLE_EXTRACT_SWEEP_MS')) || 120 * 1000,
  ),
  'MANTLE_TABLE_MIGRATE_SWEEP_MS api/runtime': num(
    'MANTLE_TABLE_MIGRATE_SWEEP_MS',
    () => Number(env('MANTLE_TABLE_MIGRATE_SWEEP_MS')) || 5 * 60 * 1000,
  ),
  'MANTLE_RUNNER_CONCURRENCY api/config': num('MANTLE_RUNNER_CONCURRENCY', () =>
    positiveFloor('MANTLE_RUNNER_CONCURRENCY', 8),
  ),
  'MANTLE_RUNS_TURN_CONCURRENCY api/config': num('MANTLE_RUNS_TURN_CONCURRENCY', () =>
    positiveFloor('MANTLE_RUNS_TURN_CONCURRENCY', 2),
  ),
  'MANTLE_MEMBER_TURN_CONCURRENCY api/config': num('MANTLE_MEMBER_TURN_CONCURRENCY', () =>
    positiveFloor('MANTLE_MEMBER_TURN_CONCURRENCY', 2),
  ),
  'MANTLE_TURN_STALE_MIN web/maintenance/turns-reap': num(
    'MANTLE_TURN_STALE_MIN',
    () => Number(env('MANTLE_TURN_STALE_MIN')) || 30,
  ),
  'MANTLE_RATE_LIMIT_SCALE web/rate-limit': num('MANTLE_RATE_LIMIT_SCALE', () => {
    const raw = Number(env('MANTLE_RATE_LIMIT_SCALE') ?? '1');
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  }),
  'MANTLE_TRUSTED_PROXIES web/rate-limit (hops)': num('MANTLE_TRUSTED_PROXIES', () =>
    Math.max(1, Number(env('MANTLE_TRUSTED_PROXIES')) || 1),
  ),
  'APP_SQL_MAX_DB_MB content/app-sql-runner (MB)': num('APP_SQL_MAX_DB_MB', () =>
    mainEnvMb('APP_SQL_MAX_DB_MB', 256),
  ),
  'APP_SNAPSHOT_MAX_MB content/app-snapshots (MB)': num('APP_SNAPSHOT_MAX_MB', () =>
    mainEnvMb('APP_SNAPSHOT_MAX_MB', 2048),
  ),
  'APP_SNAPSHOT_MAX_MB content/table-snapshots (MB)': num('APP_SNAPSHOT_MAX_MB', () =>
    mainEnvMb('APP_SNAPSHOT_MAX_MB', 2048),
  ),
  'APP_SNAPSHOT_AUTO_MAX_MB content/app-snapshots (MB)': num('APP_SNAPSHOT_AUTO_MAX_MB', () =>
    mainEnvMb('APP_SNAPSHOT_AUTO_MAX_MB', 1024),
  ),
  'APP_SNAPSHOT_MCP_MAX_MB content/app-snapshots (MB)': num('APP_SNAPSHOT_MCP_MAX_MB', () =>
    mainEnvMb('APP_SNAPSHOT_MCP_MAX_MB', 512),
  ),
  'TABLE_HISTORY_MAX_MB content/table-snapshots (MB)': num('TABLE_HISTORY_MAX_MB', () =>
    mainEnvMb('TABLE_HISTORY_MAX_MB', 512),
  ),
  'MANTLE_MAX_UPLOAD_MB files/limits (MB)': num('MANTLE_MAX_UPLOAD_MB', () =>
    mainEnvInt('MANTLE_MAX_UPLOAD_MB', 512, 1),
  ),
  'TOOL_RESULT_INLINE_MAX tools/tool-results': num('TOOL_RESULT_INLINE_MAX', () =>
    toolResultInt('TOOL_RESULT_INLINE_MAX', 32 * 1024),
  ),
  'TOOL_RESULT_EMBED_MIN tools/tool-results': num('TOOL_RESULT_EMBED_MIN', () =>
    toolResultInt('TOOL_RESULT_EMBED_MIN', 100 * 1024),
  ),
  'TOOL_RESULT_PAGE_BYTES tools/tool-results': num('TOOL_RESULT_PAGE_BYTES', () =>
    toolResultInt('TOOL_RESULT_PAGE_BYTES', 16 * 1024),
  ),
  'TOOL_RESULT_SPILL_MAX tools/tool-results': num('TOOL_RESULT_SPILL_MAX', () =>
    toolResultInt('TOOL_RESULT_SPILL_MAX', 1024 * 1024),
  ),
  'TOOL_RESULT_MAX_CHUNKS tools/tool-results': num('TOOL_RESULT_MAX_CHUNKS', () =>
    toolResultInt('TOOL_RESULT_MAX_CHUNKS', 200),
  ),
  'TOOL_RESULT_TTL_DAYS tools/tool-results (days)': num('TOOL_RESULT_TTL_DAYS', () =>
    toolResultInt('TOOL_RESULT_TTL_DAYS', 7),
  ),
  'MEDIA_MAX_STT_DURATION_S tools/builtins-video': num('MEDIA_MAX_STT_DURATION_S', () =>
    videoInt('MEDIA_MAX_STT_DURATION_S', 3600),
  ),
  'MEDIA_MAX_AUDIO_BYTES tools/builtins-video': num('MEDIA_MAX_AUDIO_BYTES', () =>
    videoInt('MEDIA_MAX_AUDIO_BYTES', 20_000_000),
  ),
  'MEDIA_MAX_VIDEO_BYTES tools/builtins-video': num('MEDIA_MAX_VIDEO_BYTES', () =>
    videoInt('MEDIA_MAX_VIDEO_BYTES', 1024 ** 3),
  ),
  'BENCH_MAX_USD api/bench/run': num('BENCH_MAX_USD', () =>
    Number(envDynamic('BENCH_MAX_USD') ?? 0),
  ),
  'BENCH_EXTRACT_CONCURRENCY api/bench/run': num('BENCH_EXTRACT_CONCURRENCY', () =>
    Number(envDynamic('BENCH_EXTRACT_CONCURRENCY') ?? 4),
  ),
  'BENCH_INGEST_ONLY api/bench/run': flag(
    'BENCH_INGEST_ONLY',
    () => envDynamic('BENCH_INGEST_ONLY') === '1',
  ),
  'BENCH_REUSE_INGEST api/bench/run': flag(
    'BENCH_REUSE_INGEST',
    () => envDynamic('BENCH_REUSE_INGEST') === '1',
  ),
  'BENCH_RETRIEVE_ONLY api/bench/run': flag(
    'BENCH_RETRIEVE_ONLY',
    () => envDynamic('BENCH_RETRIEVE_ONLY') === '1',
  ),
};

/** Profile booleans: key -> the reading on main (every site read the key
 *  the same way: `!== false` for a default-on key, `=== true` otherwise). */
const LEGACY_PROFILE: Record<string, (v: unknown) => boolean> = {
  shareNeat: (v) => v !== false,
  streamThoughts: (v) => v !== false,
  persistThoughts: (v) => v !== false,
  toolsmithRequireApproval: (v) => v === true,
  heartbeatEgressGate: (v) => v === true,
  remoteMcpEnabled: (v) => v === true,
  teamPrivateReads: (v) => v === true,
};

// ── the matrix ─────────────────────────────────────────────────────────────

function show(v: Value): Value {
  return typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v;
}

function withEnv<T>(set: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(set)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function inputKey(v: string | undefined): string {
  return v === undefined ? 'unset' : `=${JSON.stringify(v)}`;
}

/** Every cell: `<reader> | <input>` -> the value. */
function measure(readers: Record<string, Reader>): Record<string, Value> {
  const out: Record<string, Value> = {};
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    for (const [id, r] of Object.entries(readers)) {
      const alias = (ENV_ALIASES as Record<string, string | undefined>)[r.env];
      const inputs = r.kind === 'flag' ? FLAG_INPUTS : NUMBER_INPUTS;
      for (const v of inputs) {
        const set: Record<string, string | undefined> = { [r.env]: v };
        if (alias) set[alias] = undefined;
        out[`${id} | ${inputKey(v)}`] = show(withEnv(set, r.read));
      }
      if (alias) {
        for (const v of inputs) {
          if (v === undefined) continue;
          out[`${id} | alias${inputKey(v)}`] = show(
            withEnv({ [r.env]: undefined, [alias]: v }, r.read),
          );
        }
        out[`${id} | ="1" alias="0"`] = show(withEnv({ [r.env]: '1', [alias]: '0' }, r.read));
      }
    }
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  return out;
}

function measureProfile(readers: Record<string, (v: unknown) => boolean>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, read] of Object.entries(readers)) {
    for (const v of PROFILE_INPUTS) {
      out[`profile ${key} | ${v === undefined ? 'unset' : JSON.stringify(v)}`] = read(v);
    }
  }
  return out;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

describe('flags and env: record, move, compare (A10 #11)', () => {
  const now = { ...measure(LEGACY), ...measureProfile(LEGACY_PROFILE) };

  if (RECORD === 'main' || RECORD === 'now') {
    it(`records ${RECORD}`, () => {
      const file = RECORD === 'main' ? MAIN_FILE : MAIN_FILE.replace('.main.', '.now.');
      writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
    });
    return;
  }

  const main = readJson<Record<string, Value>>(MAIN_FILE, {});
  const changes = readJson<Changes>(CHANGES_FILE, { cells: {} });

  it('reads every recorded cell, and only those', () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(main).sort());
  });

  it('answers as main did, except the named changes', () => {
    const diff: Record<string, { main: Value; now: Value }> = {};
    for (const [cell, was] of Object.entries(main)) {
      const is = now[cell];
      const named = changes.cells[cell];
      if (named) {
        expect(is, `${cell}: named change`).toEqual(named.now);
        expect(is, `${cell}: a named change that no longer happens`).not.toEqual(was);
        continue;
      }
      if (is !== was) diff[cell] = { main: was, now: is ?? null };
    }
    expect(diff).toEqual({});
  });

  it('gives every named change a reason', () => {
    for (const [cell, c] of Object.entries(changes.cells)) {
      expect(c.why.length, cell).toBeGreaterThan(20);
    }
  });
});
