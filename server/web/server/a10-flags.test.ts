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
import {
  ENV_ALIASES,
  FEATURES,
  envDynamic,
  envNum,
  feature,
  parseFlag,
  parseNumber,
  type EnvNumberName,
} from '@mantle/config';
import {
  isTurnStreamingEnabled,
  isTurnStreamingEnabledClient,
} from '@mantle/client-types/turn-streaming';
import { PROFILE_FLAGS, profileFlag, type ProfileFlag } from '@mantle/client-types/profile-flags';
import { PROVIDER_TIMEOUTS } from '@mantle/std';

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

// ── the readers, as each site reads now ────────────────────────────────────
// The expressions each site used on main are in the commit that recorded
// a10-flags.main.json; every site now reads through the registries.

type Reader = { env: string; kind: 'flag' | 'number'; read: () => Value };
const flag = (name: string, read: () => boolean): Reader => ({ env: name, kind: 'flag', read });
const num = (name: string, read: () => number): Reader => ({ env: name, kind: 'number', read });
const feat = (name: string, f: Parameters<typeof feature>[0]) =>
  flag(name, () => (feature as (n: string) => boolean)(f));
const reg = (name: EnvNumberName, plus = 0) =>
  num(name, () => (envNum as (n: string) => number)(name) + plus);

/** id -> the reading now. The id names the variable and the site. */
const READERS: Record<string, Reader> = {
  'MANTLE_TURN_STREAMING client-types/turn-streaming isTurnStreamingEnabled': flag(
    'MANTLE_TURN_STREAMING',
    isTurnStreamingEnabled,
  ),
  'MANTLE_TURN_STREAMING turn-stream/publish isBufferingEnabled': feat(
    'MANTLE_TURN_STREAMING',
    'turnStreaming',
  ),
  'NEXT_PUBLIC_MANTLE_TURN_STREAMING client-types/turn-streaming isTurnStreamingEnabledClient':
    flag('NEXT_PUBLIC_MANTLE_TURN_STREAMING', isTurnStreamingEnabledClient),
  'MANTLE_TURN_NARRATION api/turn-narration isTurnNarrationEnabled': feat(
    'MANTLE_TURN_NARRATION',
    'turnNarration',
  ),
  'MANTLE_TURN_TOKENS api/turn-stream-observer isTurnTokenStreamingEnabled': feat(
    'MANTLE_TURN_TOKENS',
    'turnTokens',
  ),
  'MANTLE_TURN_SUGGESTIONS api/turn-suggestion isTurnSuggestionsEnabled': feat(
    'MANTLE_TURN_SUGGESTIONS',
    'turnSuggestions',
  ),
  'MANTLE_MCP_TOOLSMITH_WRITE mcp-core/build-server': feat(
    'MANTLE_MCP_TOOLSMITH_WRITE',
    'mcpToolsmithWrite',
  ),
  'MANTLE_QUERY_ENRICH runtime/conversation': feat('MANTLE_QUERY_ENRICH', 'queryEnrich'),
  'S3_FORCE_PATH_STYLE storage/index': feat('S3_FORCE_PATH_STYLE', 's3ForcePathStyle'),
  'MANTLE_RUNS runs/flag isRunsEnabled': feat('MANTLE_RUNS', 'runs'),
  'MANTLE_VIEWER_ROLES_PER_DATABASE db/client+migrate envFlag': feat(
    'MANTLE_VIEWER_ROLES_PER_DATABASE',
    'viewerRolesPerDatabase',
  ),
  'MANTLE_DISABLE_BOOT_RECONCILE web/system-manifest/reconcile': feat(
    'MANTLE_DISABLE_BOOT_RECONCILE',
    'bootReconcileOff',
  ),
  'MANTLE_CRASH_TEST api/crash-test': feat('MANTLE_CRASH_TEST', 'crashTest'),
  'MANTLE_DETACHED_DEV web/auth-constants isDetachedDev (NODE_ENV development)': feat(
    'MANTLE_DETACHED_DEV',
    'detachedDev',
  ),
  'MANTLE_MCP_TERMINAL mcp-core/register/context (stdio)': flag('MANTLE_MCP_TERMINAL', () =>
    feature('mcpTerminal', { default: true }),
  ),
  'MANTLE_MCP_TERMINAL mcp-core/register/context (http)': flag('MANTLE_MCP_TERMINAL', () =>
    feature('mcpTerminal', { default: false }),
  ),

  'MANTLE_SHEET_PROFILE_ROWS content/chunk-spreadsheet': reg('MANTLE_SHEET_PROFILE_ROWS'),
  'TEAM_CHAT_DAILY_TURNS content/member-turn-ledger': reg('TEAM_CHAT_DAILY_TURNS'),
  'TEAM_CHAT_DAILY_TURNS web/member-daily-cap': reg('TEAM_CHAT_DAILY_TURNS'),
  'MANTLE_MEMBER_DAILY_TOKENS content/member-turn-ledger': reg('MANTLE_MEMBER_DAILY_TOKENS'),
  'MANTLE_MEMBER_DAILY_TOKENS web/member-daily-cap': reg('MANTLE_MEMBER_DAILY_TOKENS'),
  'MANTLE_SUPERSEDED_SALIENCE content/supersede': reg('MANTLE_SUPERSEDED_SALIENCE'),
  'MANTLE_CORRECTED_SALIENCE content/supersede': reg('MANTLE_CORRECTED_SALIENCE'),
  'MANTLE_SUPERSEDED_FILE_SALIENCE api/extract/supersede': reg('MANTLE_SUPERSEDED_FILE_SALIENCE'),
  'EXTRACT_CONCURRENCY embeddings/extraction-concurrency (no saved value)':
    reg('EXTRACT_CONCURRENCY'),
  'DWF_RENDER_DPI files/dwf': reg('DWF_RENDER_DPI'),
  'DWG_RENDER_DPI files/dwg': reg('DWG_RENDER_DPI'),
  'MANTLE_RUNS_WORKER_CONCURRENCY runs/engine': reg('MANTLE_RUNS_WORKER_CONCURRENCY'),
  'MANTLE_SALIENCE_LAMBDA runtime/conversation': reg('MANTLE_SALIENCE_LAMBDA'),
  'MANTLE_SALIENCE_LAMBDA search/chunks': reg('MANTLE_SALIENCE_LAMBDA'),
  'MANTLE_SALIENCE_LAMBDA search/index': reg('MANTLE_SALIENCE_LAMBDA'),
  'MANTLE_RECENCY_TAU_DAYS runtime/conversation (days)': reg('MANTLE_RECENCY_TAU_DAYS'),
  'MANTLE_RECENCY_EPISODIC runtime/conversation': reg('MANTLE_RECENCY_EPISODIC'),
  'MANTLE_RECENCY_CONTENT runtime/conversation': reg('MANTLE_RECENCY_CONTENT'),
  'MANTLE_SCOPE_EXACT_MAX_ROWS search/scope': reg('MANTLE_SCOPE_EXACT_MAX_ROWS'),
  'MANTLE_SCOPE_EXACT_MAX_ITEMS search/scope': reg('MANTLE_SCOPE_EXACT_MAX_ITEMS'),
  'TABLE_IMPORT_MAX_ROWS tabledb/engine': reg('TABLE_IMPORT_MAX_ROWS'),
  'TABLE_SQL_TIMEOUT_MS tabledb/sql-runner': reg('TABLE_SQL_TIMEOUT_MS'),
  'MANTLE_LOCAL_EMBED_BATCH voice/local-embedding': reg('MANTLE_LOCAL_EMBED_BATCH'),
  'MANTLE_LOCAL_EMBED_TIMEOUT_MS voice/local-embedding': num('MANTLE_LOCAL_EMBED_TIMEOUT_MS', () =>
    envNum('MANTLE_LOCAL_EMBED_TIMEOUT_MS', PROVIDER_TIMEOUTS.localEmbed),
  ),
  'MANTLE_EXTRACT_EXPIRE_MIN api/extract-queue': reg('MANTLE_EXTRACT_EXPIRE_MIN'),
  'MANTLE_EXTRACT_EXPIRE_MIN web/journey (+15)': reg('MANTLE_EXTRACT_EXPIRE_MIN', 15),
  'MANTLE_EXTRACT_EXPIRE_MIN web/scripts/traces-reap (+15)': reg('MANTLE_EXTRACT_EXPIRE_MIN', 15),
  'MANTLE_MAX_AUTO_TABLE_TABLES api/extract/auto-table': reg('MANTLE_MAX_AUTO_TABLE_TABLES'),
  'MANTLE_EXTRACT_DRAIN_WINDOW_HOURS api/runtime': reg('MANTLE_EXTRACT_DRAIN_WINDOW_HOURS'),
  'MANTLE_EXTRACT_DRAIN_LIMIT api/runtime': reg('MANTLE_EXTRACT_DRAIN_LIMIT'),
  'MANTLE_EXTRACT_SWEEP_LIMIT api/runtime': reg('MANTLE_EXTRACT_SWEEP_LIMIT'),
  'MANTLE_EXTRACT_SWEEP_MS api/runtime': reg('MANTLE_EXTRACT_SWEEP_MS'),
  'MANTLE_TABLE_MIGRATE_SWEEP_MS api/runtime': reg('MANTLE_TABLE_MIGRATE_SWEEP_MS'),
  'MANTLE_RUNNER_CONCURRENCY api/config': reg('MANTLE_RUNNER_CONCURRENCY'),
  'MANTLE_RUNS_TURN_CONCURRENCY api/config': reg('MANTLE_RUNS_TURN_CONCURRENCY'),
  'MANTLE_MEMBER_TURN_CONCURRENCY api/config': reg('MANTLE_MEMBER_TURN_CONCURRENCY'),
  'MANTLE_TURN_STALE_MIN web/maintenance/turns-reap': reg('MANTLE_TURN_STALE_MIN'),
  'MANTLE_RATE_LIMIT_SCALE web/rate-limit': reg('MANTLE_RATE_LIMIT_SCALE'),
  'MANTLE_TRUSTED_PROXIES web/rate-limit (hops)': reg('MANTLE_TRUSTED_PROXIES'),
  'APP_SQL_MAX_DB_MB content/app-sql-runner (MB)': reg('APP_SQL_MAX_DB_MB'),
  'APP_SNAPSHOT_MAX_MB content/app-snapshots (MB)': reg('APP_SNAPSHOT_MAX_MB'),
  'APP_SNAPSHOT_MAX_MB content/table-snapshots (MB)': reg('APP_SNAPSHOT_MAX_MB'),
  'APP_SNAPSHOT_AUTO_MAX_MB content/app-snapshots (MB)': reg('APP_SNAPSHOT_AUTO_MAX_MB'),
  'APP_SNAPSHOT_MCP_MAX_MB content/app-snapshots (MB)': reg('APP_SNAPSHOT_MCP_MAX_MB'),
  'TABLE_HISTORY_MAX_MB content/table-snapshots (MB)': reg('TABLE_HISTORY_MAX_MB'),
  'MANTLE_MAX_UPLOAD_MB files/limits (MB)': reg('MANTLE_MAX_UPLOAD_MB'),
  'TOOL_RESULT_INLINE_MAX tools/tool-results': reg('TOOL_RESULT_INLINE_MAX'),
  'TOOL_RESULT_EMBED_MIN tools/tool-results': reg('TOOL_RESULT_EMBED_MIN'),
  'TOOL_RESULT_PAGE_BYTES tools/tool-results': reg('TOOL_RESULT_PAGE_BYTES'),
  'TOOL_RESULT_SPILL_MAX tools/tool-results': reg('TOOL_RESULT_SPILL_MAX'),
  'TOOL_RESULT_MAX_CHUNKS tools/tool-results': reg('TOOL_RESULT_MAX_CHUNKS'),
  'TOOL_RESULT_TTL_DAYS tools/tool-results (days)': reg('TOOL_RESULT_TTL_DAYS'),
  'MEDIA_MAX_STT_DURATION_S tools/builtins-video': reg('MEDIA_MAX_STT_DURATION_S'),
  'MEDIA_MAX_AUDIO_BYTES tools/builtins-video': reg('MEDIA_MAX_AUDIO_BYTES'),
  'MEDIA_MAX_VIDEO_BYTES tools/builtins-video': reg('MEDIA_MAX_VIDEO_BYTES'),
  'BENCH_MAX_USD api/bench/run': num('BENCH_MAX_USD', () =>
    parseNumber(envDynamic('BENCH_MAX_USD'), 0),
  ),
  'BENCH_EXTRACT_CONCURRENCY api/bench/run': num('BENCH_EXTRACT_CONCURRENCY', () =>
    parseNumber(envDynamic('BENCH_EXTRACT_CONCURRENCY'), 4),
  ),
  'BENCH_INGEST_ONLY api/bench/run': flag('BENCH_INGEST_ONLY', () =>
    parseFlag(envDynamic('BENCH_INGEST_ONLY'), false),
  ),
  'BENCH_REUSE_INGEST api/bench/run': flag('BENCH_REUSE_INGEST', () =>
    parseFlag(envDynamic('BENCH_REUSE_INGEST'), false),
  ),
  'BENCH_RETRIEVE_ONLY api/bench/run': flag('BENCH_RETRIEVE_ONLY', () =>
    parseFlag(envDynamic('BENCH_RETRIEVE_ONLY'), false),
  ),
};

/** Profile booleans: key -> the reading now, through the one table. The
 *  feature registry's reading of the same key must agree (checked below). */
const PROFILE_READERS: Record<string, (v: unknown) => boolean> = Object.fromEntries(
  (Object.keys(PROFILE_FLAGS) as ProfileFlag[]).map((k) => [
    k,
    (v: unknown) => profileFlag({ [k]: v }, k),
  ]),
);

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
  const now = { ...measure(READERS), ...measureProfile(PROFILE_READERS) };

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

  it('reads every profile feature as its profile flag', () => {
    for (const [name, spec] of Object.entries(FEATURES)) {
      if (!('profile' in spec)) continue;
      for (const v of PROFILE_INPUTS) {
        const prefs = { [spec.profile]: v };
        expect(
          (feature as (n: string, c: unknown) => boolean)(name, { prefs }),
          `${name} ${String(v)}`,
        ).toBe(profileFlag(prefs, spec.profile));
      }
    }
  });

  it('gives every named change a reason', () => {
    for (const [cell, c] of Object.entries(changes.cells)) {
      expect(c.why.length, cell).toBeGreaterThan(20);
    }
  });
});
