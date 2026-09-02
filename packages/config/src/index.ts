/**
 * @mantle/config — the ONE place the server tree reads its environment.
 *
 * Why (2026-09-02 audit, sloppiness A5): 135 distinct variables were read raw
 * in 134 files, 106 of them documented nowhere; three names in .env.example
 * did not match the name the code read; seven `NEXT_PUBLIC_*` names survived
 * from the Next.js era in a server that no longer has Next. Nothing listed
 * what the system actually consumes.
 *
 * What this module gives you:
 *   - `env(name)`: the raw read, but `name` must be a {@link KnownEnvName}.
 *     A typo is a type error, and this union IS the inventory of what the
 *     server tree reads. Semantics are identical to `process.env[name]`: read
 *     at call time (tests that set env in a `beforeAll` keep working), no
 *     caching, `undefined` when unset.
 *   - Canonical names with silent legacy fallbacks ({@link ENV_ALIASES}): a
 *     box that still sets `NEXT_PUBLIC_APP_URL` keeps working, logs one
 *     warning, and the code never mentions the old name again.
 *   - `envInt` / `envFlag` for the two shapes that were re-parsed by hand in
 *     dozens of places; `envDynamic` for the handful of sites that look up a
 *     variable by a name held in data (a manifest's `envModelVar`).
 *   - `assertEnvShape()` at boot: values that are PRESENT must be well-formed
 *     (a UUID that is not a UUID, a DATABASE_URL that is not a postgres URL)
 *     fail at start-up with the variable named, instead of somewhere deep in
 *     the first request. It requires nothing new — DB-less dev stays legal.
 *
 * Rules: an ESLint restriction bans `process.env.X` outside this package
 * (tests, scripts and the two boot bridges excepted). Add a new variable by
 * adding its name to the union below and documenting it in .env.example.
 *
 * NOT covered on purpose: packages/client-types (published to the frontend,
 * where `NEXT_PUBLIC_*` is a build-time inlining contract) and
 * server/sandboxd (a standalone image with no workspace dependencies; it has
 * its own config block).
 */

/** Every environment variable the server tree reads (130 names). Keep sorted. */
export type KnownEnvName =
  | 'AGENT_SLUG'
  | 'ALLOWED_USER_ID'
  | 'APP_DB_DIR'
  | 'APP_RUNTIME_OUT'
  | 'ATTACH_AGENT'
  | 'BROWSER_WS_ENDPOINT'
  | 'CRASH_MARKER'
  | 'CRASH_POINT'
  | 'CRASH_TEST_SHAPE'
  | 'DATABASE_URL'
  | 'DBOS_LOG_LEVEL'
  | 'DBOS_SYSTEM_DATABASE_URL'
  | 'DOCKER_SOCK'
  | 'DOCS_MODEL'
  | 'DWF_RENDER_DPI'
  | 'DWG_RENDER_DPI'
  | 'EXTRACT_CONCURRENCY'
  | 'HOST'
  | 'MANTLE_API_CORS_ORIGINS'
  | 'MANTLE_API_TOKEN'
  | 'MANTLE_APP_RUNTIME_MANIFEST'
  | 'MANTLE_BACKUP_DIR'
  | 'MANTLE_BUILD_TIME'
  | 'MANTLE_CLIENT_ORIGIN'
  | 'MANTLE_CORRECTED_SALIENCE'
  | 'MANTLE_CRASH_TEST'
  | 'MANTLE_DETACHED_DEV'
  | 'MANTLE_DEV_EMAIL'
  | 'MANTLE_DISABLE_BOOT_RECONCILE'
  | 'MANTLE_DOCS_ROOT'
  | 'MANTLE_EMBEDDING_MODEL'
  | 'MANTLE_EXTRACT_DRAIN_LIMIT'
  | 'MANTLE_EXTRACT_DRAIN_WINDOW_HOURS'
  | 'MANTLE_EXTRACT_EXPIRE_MIN'
  | 'MANTLE_EXTRACT_SWEEP_LIMIT'
  | 'MANTLE_EXTRACT_SWEEP_MS'
  | 'MANTLE_FILES_ROOT'
  | 'MANTLE_MAX_UPLOAD_MB'
  | 'MANTLE_GIT_SHA'
  | 'MANTLE_HEARTBEAT_FILE'
  | 'MANTLE_LOCAL_CHAT_URL'
  | 'MANTLE_LOCAL_EMBEDDING_URL'
  | 'MANTLE_LOCAL_EMBED_BATCH'
  | 'MANTLE_LOCAL_EMBED_TIMEOUT_MS'
  | 'MANTLE_MASTER_KEY'
  | 'MANTLE_MASTER_KEY_NEXT'
  | 'MANTLE_MAX_AUTO_TABLE_TABLES'
  | 'MANTLE_MCP_DIR'
  | 'MANTLE_MCP_TERMINAL'
  | 'MANTLE_MCP_TOOLSMITH_WRITE'
  | 'MANTLE_NEAT_LICENSE_KEY'
  | 'MANTLE_PG_DUMP'
  | 'MANTLE_PRINT_ORIGIN'
  | 'MANTLE_PUBLIC_URL'
  | 'MANTLE_PUSH_RELAY_URL'
  | 'MANTLE_QUERY_ENRICH'
  | 'MANTLE_RATE_LIMIT_SCALE'
  | 'MANTLE_RECENCY_CONTENT'
  | 'MANTLE_RECENCY_EPISODIC'
  | 'MANTLE_RECENCY_TAU_DAYS'
  | 'MANTLE_RELEASE_CLIENT_COMPOSE_PATH'
  | 'MANTLE_RELEASE_CLIENT_TAG_PATH'
  | 'MANTLE_RELEASE_COMPOSE_PATH'
  | 'MANTLE_RELEASE_UPDATER_PATH'
  | 'MANTLE_RELEASE_CADDYFILE_PATH'
  | 'MANTLE_RELEASE_SCRIPTS_DIR'
  | 'MANTLE_RUNNER_ADMIN_PORT'
  | 'MANTLE_RUNNER_CONCURRENCY'
  | 'MANTLE_RUNNER_VERSION'
  | 'MANTLE_RUNS'
  | 'MANTLE_RUNS_TURN_CONCURRENCY'
  | 'MANTLE_RUNS_WORKER_CONCURRENCY'
  | 'MANTLE_SALIENCE_LAMBDA'
  | 'MANTLE_SHEET_PROFILE_ROWS'
  | 'MANTLE_SUPERSEDED_FILE_SALIENCE'
  | 'MANTLE_SUPERSEDED_SALIENCE'
  | 'MANTLE_TABLE_MIGRATE_SWEEP_MS'
  | 'MANTLE_TAILNET_PROXY_URL'
  | 'MANTLE_TAILSCALE_SOCK'
  | 'MANTLE_TERMINAL_CWD'
  | 'MANTLE_TOOL_VALIDATION'
  | 'MANTLE_TRUSTED_PROXIES'
  | 'MANTLE_TURN_NARRATION'
  | 'MANTLE_TURN_STREAMING'
  | 'MANTLE_TURN_SUGGESTIONS'
  | 'MANTLE_TURN_TOKENS'
  | 'MANTLE_UPDATE_SIGNAL_DIR'
  | 'MANTLE_WEB_SEARCH_MODEL'
  | 'MEDIA_SIDECAR_TOKEN'
  | 'MEDIA_SIDECAR_URL'
  | 'MS_CLIENT_ID'
  | 'MS_CLIENT_SECRET'
  | 'MS_REDIRECT_URI'
  | 'MS_TENANT'
  | 'NODE_ENV'
  | 'OTLP_LOGS_ENDPOINT'
  | 'OTLP_TRACES_ENDPOINT'
  | 'PORT'
  | 'S3_ACCESS_KEY'
  | 'S3_BUCKET'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_SECRET_KEY'
  | 'SANDBOXD_PORT'
  | 'SANDBOXD_TOKEN'
  | 'SANDBOXD_URL'
  | 'SANDBOXES_DIR'
  | 'SANDBOX_DEFAULT_IMAGE'
  | 'SANDBOX_DISK_BUDGET_BYTES'
  | 'SANDBOX_EGRESS_ALLOW'
  | 'SANDBOX_EGRESS_PROXY_HOST'
  | 'SANDBOX_EGRESS_PROXY_PORT'
  | 'SANDBOX_EXPORT_MAX_BYTES'
  | 'SANDBOX_IDLE_STOP_MINUTES'
  | 'SANDBOX_IMPORT_MAX_BYTES'
  | 'SANDBOX_INBOX_ROOT'
  | 'SANDBOX_MAX_COUNT'
  | 'SANDBOX_MEM_BYTES'
  | 'SANDBOX_NANO_CPUS'
  | 'SANDBOX_NETWORK'
  | 'SANDBOX_NETWORK_RESTRICTED'
  | 'SANDBOX_PIDS_LIMIT'
  | 'SESSION_SECRET'
  | 'TABLE_DB_DIR'
  | 'TABLE_IMPORT_MAX_ROWS'
  | 'TABLE_SQL_TIMEOUT_MS'
  | 'TEAM_CHAT_DAILY_TURNS'
  | 'TEAM_CHAT_POST_ENABLED'
  | 'TEAM_UPLOAD_DAILY_BYTES'
  | 'TG_CHAT_ID'
  | 'TIKA_URL'
  | 'VERIFY_AGENT_SLUG'
  | 'VERIFY_OWNER_ID';

/**
 * Canonical name → legacy name still honoured on old boxes. Reading the
 * canonical name falls back to the legacy one and warns once per process.
 * Remove an entry once `pnpm status` shows no box sets the legacy name.
 */
export const ENV_ALIASES: Partial<Record<KnownEnvName, string>> = {
  MANTLE_PUBLIC_URL: 'NEXT_PUBLIC_APP_URL',
  MANTLE_API_TOKEN: 'NEXT_PUBLIC_MANTLE_API_TOKEN',
  MANTLE_NEAT_LICENSE_KEY: 'NEXT_PUBLIC_NEAT_LICENSE_KEY',
  MANTLE_TURN_STREAMING: 'NEXT_PUBLIC_MANTLE_TURN_STREAMING',
};

const warnedAliases = new Set<string>();

/** Tests only: forget which legacy aliases already warned. */
export function resetEnvAliasWarningsForTests(): void {
  warnedAliases.clear();
}

/** Read one known variable. Identical to `process.env[name]` (call-time, no
 *  cache) plus the legacy-alias fallback. */
export function env(name: KnownEnvName): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const legacy = ENV_ALIASES[name];
  if (!legacy) return undefined;
  const value = process.env[legacy];
  if (value !== undefined && !warnedAliases.has(name)) {
    warnedAliases.add(name);
    console.warn(`[config] ${legacy} is deprecated — set ${name} instead (same value).`);
  }
  return value;
}

/** Read a variable whose NAME is data (a manifest's `envModelVar`, a task's
 *  `requiresEnv`). Prefer {@link env} whenever the name is a literal. */
export function envDynamic(name: string): string | undefined {
  return process.env[name];
}

/** Integer with a default; a missing or non-numeric value yields the default,
 *  and `min` (default 0) floors it. */
export function envInt(name: KnownEnvName, fallback: number, min = 0): number {
  const raw = Number(env(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}

/** Boolean flag: `1`, `true`, `yes`, `on` (any case) are on; anything else,
 *  including unset, is `fallback`. */
export function envFlag(name: KnownEnvName, fallback = false): boolean {
  const raw = env(name)?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isProduction(): boolean {
  return env('NODE_ENV') === 'production';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate the SHAPE of the core variables that are set. Call once at process
 * start (server/web and server/api do). Throws with every problem listed so
 * an operator fixes them in one go. Requires nothing: an unset value is fine
 * here — presence rules stay where they always were (the auth gate insists on
 * SESSION_SECRET, the db client on DATABASE_URL, …).
 */
export function assertEnvShape(): void {
  const problems: string[] = [];
  const dbUrl = env('DATABASE_URL');
  if (dbUrl !== undefined && dbUrl !== '' && !/^postgres(ql)?:\/\//.test(dbUrl)) {
    problems.push('DATABASE_URL must be a postgres:// URL');
  }
  const owner = env('ALLOWED_USER_ID');
  if (owner !== undefined && owner !== '' && !UUID_RE.test(owner.trim())) {
    problems.push('ALLOWED_USER_ID must be a UUID (or empty on a fresh install)');
  }
  const secret = env('SESSION_SECRET');
  if (secret !== undefined && secret !== '' && secret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters');
  }
  const publicUrl = env('MANTLE_PUBLIC_URL');
  if (publicUrl !== undefined && publicUrl !== '' && !/^https?:\/\//.test(publicUrl)) {
    problems.push('MANTLE_PUBLIC_URL must start with http:// or https://');
  }
  if (problems.length > 0) {
    throw new Error(`[config] environment is malformed:\n  - ${problems.join('\n  - ')}`);
  }
}
