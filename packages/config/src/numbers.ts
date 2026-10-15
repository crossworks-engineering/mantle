/**
 * Every number the tree reads from the environment, with its default and its
 * range, in one table (A10 #11; docs/configuration.md, "Flags and env").
 * A site reads `envNum('NAME')`; the default never appears at the site, so
 * two sites reading one variable cannot disagree (MANTLE_SALIENCE_LAMBDA is
 * read in three places, MANTLE_EXTRACT_EXPIRE_MIN in three, the member
 * limits in two).
 *
 * The options are the one number dialect's (parse.ts): blank or not a number
 * is the default, then `int`, then `positive` / `atLeast` (fall back), then
 * `min` / `max` (clamp). `default: null` means the caller passes it (a default that
 * belongs to another table, such as PROVIDER_TIMEOUTS in @mantle/std).
 */
import { env, type KnownEnvName } from './index';
import { parseNumber, type NumberOptions } from './parse';

export type NumberSpec = NumberOptions & { default: number | null; doc: string };

const MB = 'MB; 0 or less is 1';

export const ENV_NUMBERS = {
  // Retrieval ranking
  MANTLE_SALIENCE_LAMBDA: {
    default: 0.15,
    doc: 'weight of (1 - salience) added to a hit distance',
  },
  MANTLE_RECENCY_TAU_DAYS: { default: 180, doc: 'recency decay time constant, days' },
  MANTLE_RECENCY_EPISODIC: { default: 0.15, doc: 'recency weight for episodic hits' },
  MANTLE_RECENCY_CONTENT: { default: 0.06, doc: 'recency weight for content hits' },
  MANTLE_SUPERSEDED_SALIENCE: {
    default: 0.5,
    min: 0,
    max: 1,
    doc: 'salience a superseded node drops to',
  },
  MANTLE_CORRECTED_SALIENCE: {
    default: 0.3,
    min: 0,
    max: 1,
    doc: 'salience a corrected node drops to',
  },
  MANTLE_SUPERSEDED_FILE_SALIENCE: {
    default: 0.5,
    min: 0,
    max: 1,
    doc: 'salience of an older version of an exported file',
  },
  MANTLE_SCOPE_EXACT_MAX_ROWS: {
    default: 15000,
    int: 'floor',
    min: 0,
    doc: 'most rows the exact scope path searches; 0 turns it off',
  },
  MANTLE_SCOPE_EXACT_MAX_ITEMS: {
    default: 500,
    int: 'floor',
    min: 0,
    doc: 'most items a scope holds for the exact path; 0 turns it off',
  },
  MANTLE_SHEET_PROFILE_ROWS: { default: 8, doc: "data rows sampled into a sheet's profile chunk" },

  // Extraction
  EXTRACT_CONCURRENCY: {
    default: 2,
    atLeast: 1,
    int: 'floor',
    max: 16,
    doc: 'extractions at once (a saved setting wins)',
  },
  MANTLE_EXTRACT_EXPIRE_MIN: { default: 60, positive: true, doc: 'extract job expiry, minutes' },
  MANTLE_EXTRACT_DRAIN_WINDOW_HOURS: {
    default: 168,
    positive: true,
    doc: 'how far back the boot drain and the sweep look, hours',
  },
  MANTLE_EXTRACT_DRAIN_LIMIT: { default: 1000, positive: true, doc: 'boot drain batch' },
  MANTLE_EXTRACT_SWEEP_LIMIT: { default: 200, positive: true, doc: 'periodic sweep batch' },
  MANTLE_EXTRACT_SWEEP_MS: { default: 120_000, positive: true, doc: 'periodic sweep period, ms' },
  MANTLE_TABLE_MIGRATE_SWEEP_MS: {
    default: 300_000,
    positive: true,
    doc: 'table migration sweep period, ms',
  },
  MANTLE_MAX_AUTO_TABLE_TABLES: {
    default: 20,
    positive: true,
    doc: 'most tables one auto-table pass makes',
  },
  DWF_RENDER_DPI: {
    default: 300,
    positive: true,
    int: 'round',
    min: 50,
    max: 600,
    doc: 'DWF sheet render resolution',
  },
  DWG_RENDER_DPI: {
    default: 300,
    positive: true,
    int: 'round',
    min: 50,
    max: 600,
    doc: 'DWG render resolution',
  },

  // Queues and concurrency
  MANTLE_RUNNER_CONCURRENCY: {
    default: 8,
    positive: true,
    int: 'floor',
    doc: 'in-flight runs on RUNNER_QUEUE',
  },
  MANTLE_RUNS_TURN_CONCURRENCY: {
    default: 2,
    positive: true,
    int: 'floor',
    doc: 'in-flight runs turns on RUNS_TURN_QUEUE',
  },
  MANTLE_MEMBER_TURN_CONCURRENCY: {
    default: 2,
    positive: true,
    int: 'floor',
    doc: 'in-flight member chat turns on MEMBER_TURN_QUEUE',
  },
  MANTLE_RUNS_WORKER_CONCURRENCY: {
    default: 3,
    atLeast: 1,
    int: 'floor',
    doc: 'running worker items per run',
  },
  MANTLE_TURN_STALE_MIN: {
    default: 30,
    positive: true,
    doc: 'a pending turn older than this is failed by the reaper, minutes',
  },

  // Member limits
  TEAM_CHAT_DAILY_TURNS: {
    default: 100,
    positive: true,
    int: 'floor',
    doc: 'member chat turns per member login per UTC day',
  },
  MANTLE_MEMBER_DAILY_TOKENS: {
    default: 2_000_000,
    atLeast: 0,
    int: 'floor',
    doc: 'member chat tokens per member login per UTC day; 0 turns the budget off',
  },

  // HTTP
  PORT: { default: 3000, doc: 'the port server/web listens on (compose sets it)' },
  MANTLE_RATE_LIMIT_SCALE: { default: 1, atLeast: 1, doc: 'multiplies every rate limit' },
  MANTLE_TRUSTED_PROXIES: {
    default: 1,
    positive: true,
    min: 1,
    doc: 'proxy hops in front of the server (X-Forwarded-For)',
  },
  MANTLE_MAX_UPLOAD_MB: {
    default: 512,
    int: 'floor',
    min: 1,
    doc: `streamed upload cap, ${MB}`,
  },

  // Stores
  APP_SQL_MAX_DB_MB: { default: 256, int: 'floor', min: 1, doc: `one app database, ${MB}` },
  APP_SNAPSHOT_MAX_MB: {
    default: 2048,
    int: 'floor',
    min: 1,
    doc: `snapshot history of one app or table, ${MB}`,
  },
  APP_SNAPSHOT_AUTO_MAX_MB: {
    default: 1024,
    int: 'floor',
    min: 1,
    doc: `automatic app snapshots, ${MB}`,
  },
  APP_SNAPSHOT_MCP_MAX_MB: {
    default: 512,
    int: 'floor',
    min: 1,
    doc: `app snapshots before an MCP write, ${MB}`,
  },
  TABLE_HISTORY_MAX_MB: {
    default: 512,
    int: 'floor',
    min: 1,
    doc: `table edit history, ${MB}`,
  },
  TABLE_IMPORT_MAX_ROWS: {
    default: 2_000_000,
    positive: true,
    int: 'floor',
    doc: 'largest table import, rows',
  },
  TABLE_SQL_TIMEOUT_MS: { default: 5_000, positive: true, doc: 'table SQL statement timeout, ms' },

  // Tool results
  TOOL_RESULT_INLINE_MAX: {
    default: 32 * 1024,
    positive: true,
    int: 'floor',
    doc: 'a tool result up to this many bytes goes to the model inline (per agent overridable)',
  },
  TOOL_RESULT_EMBED_MIN: {
    default: 100 * 1024,
    positive: true,
    int: 'floor',
    doc: 'from this many bytes a stored result is read back by semantic query',
  },
  TOOL_RESULT_PAGE_BYTES: {
    default: 16 * 1024,
    positive: true,
    int: 'floor',
    doc: 'read_result page size, bytes',
  },
  TOOL_RESULT_SPILL_MAX: {
    default: 1024 * 1024,
    positive: true,
    int: 'floor',
    doc: 'a stored result is cut at this many bytes',
  },
  TOOL_RESULT_MAX_CHUNKS: {
    default: 200,
    positive: true,
    int: 'floor',
    doc: 'chunks embedded per stored result',
  },
  TOOL_RESULT_TTL_DAYS: {
    default: 7,
    positive: true,
    int: 'floor',
    doc: 'days a stored result is kept',
  },

  // Media
  MEDIA_MAX_STT_DURATION_S: {
    default: 3600,
    positive: true,
    int: 'floor',
    doc: 'longest video transcribed by video_ingest, seconds',
  },
  MEDIA_MAX_AUDIO_BYTES: {
    default: 20_000_000,
    positive: true,
    int: 'floor',
    doc: 'largest audio track video_ingest sends to speech to text',
  },
  MEDIA_MAX_VIDEO_BYTES: {
    default: 1024 ** 3,
    positive: true,
    int: 'floor',
    doc: 'largest video video_ingest downloads',
  },

  // Local models
  MANTLE_LOCAL_EMBED_BATCH: {
    default: 16,
    atLeast: 1,
    int: 'floor',
    doc: 'texts per request to the local embedder',
  },
  MANTLE_LOCAL_EMBED_TIMEOUT_MS: {
    default: null,
    atLeast: 1_000,
    int: 'floor',
    doc: 'local embedder request timeout, ms (default PROVIDER_TIMEOUTS.localEmbed, @mantle/std)',
  },
} as const satisfies Partial<Record<KnownEnvName, NumberSpec>>;

export type EnvNumberName = keyof typeof ENV_NUMBERS;

/** Registered numbers whose default the caller passes. */
type CallerDefault = {
  [K in EnvNumberName]: (typeof ENV_NUMBERS)[K]['default'] extends null ? K : never;
}[EnvNumberName];

/** A registered number: its default and range come from {@link ENV_NUMBERS}. */
export function envNum(name: Exclude<EnvNumberName, CallerDefault>): number;
export function envNum(name: CallerDefault, fallback: number): number;
export function envNum(name: EnvNumberName, fallback?: number): number {
  const spec: NumberSpec = ENV_NUMBERS[name];
  const def = fallback ?? spec.default;
  if (def === null) throw new Error(`[config] ${name} needs a default from its caller`);
  return parseNumber(env(name), def, spec);
}

/** A registered number's default, for a caller that shows it (a settings
 *  screen, an exported constant). */
export function envNumDefault(name: Exclude<EnvNumberName, CallerDefault>): number {
  return ENV_NUMBERS[name].default;
}
