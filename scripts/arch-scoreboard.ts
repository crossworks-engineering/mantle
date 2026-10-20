/**
 * The architecture scoreboard (workspaces arch plan v2, section 3; A0): the
 * numbers that come from the repo, measured by eslint-rules/arch-counts.mjs.
 *
 *   node scripts/arch-scoreboard.ts            print the numbers
 *   node scripts/arch-scoreboard.ts --check    fail when one went UP from
 *                                              scripts/arch-scoreboard.pins.json
 *   node scripts/arch-scoreboard.ts --pin      write today's numbers as pins
 *
 * `pnpm verify` runs --check, so no number can grow. A number that went
 * down is reported: lower its pin in the same change (--pin). The numbers
 * of a box (410 hits, the check settings) are not here: they live in
 * scripts/arch-scoreboard-box.sh, which verify never runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: plain-JS module, no types shipped.
import { keptNotes, measure } from '../eslint-rules/arch-counts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINS = join(ROOT, 'scripts/arch-scoreboard.pins.json');

/** What each number means, in the order printed. */
const LABELS: Record<string, string> = {
  asSystemExits:
    'system-pool exits: every use of a function holding an asSystem call (arch A6 fix round 1)',
  systemDbUses: 'direct systemDb uses (the admin pool, whatever the scope)',
  systemDbFiles: 'files using systemDb directly',
  asSystemFiles: 'files with asSystem',
  asSystemReasons: 'asSystem reasons',
  rawAclFiles: 'files outside packages/db reading read_ws, write_ws or home_ws',
  rawAclLines: 'lines reading them',
  toolPolicyLists: 'tool policy lists keyed by name',
  toolPolicyListFiles: 'files with tool policy lists',
  toolPolicyEntries: 'tool policy list entries',
  routePolicyLists: 'route policy lists',
  routeFiles: 'route files',
  apiRouteFiles: 'route files under /api',
  goneStubs: 'route files answering 410',
  guardCalls: 'guard calls in route files',
  guardCallFiles: 'route files with a guard call',
  liveRoutesWithoutGuard: 'live /api routes calling no guard',
  callerReads: 'reads of the caller the pipeline answers (A4 step 3b)',
  callerReadFiles: 'route files reading the caller the pipeline answers',
  handKindLists: 'hand kind lists outside the kind registry and the named list (A10 #12)',
  handKindListsAllowed: 'hand kind lists in the named files (A10 #12)',
  handRoleLists: 'hand role, area and actor name lists outside their source (A10 #13)',
  handRoleListsAllowed: 'role, area and actor name lists in their source files (A10 #13)',
  brainOnWorkspacesCalls: 'brainOnWorkspacesNow calls',
  brainOnWorkspacesFiles: 'files calling brainOnWorkspacesNow',
  adminReadsFiles: 'files naming MANTLE_ADMIN_READS',
  readPathWrites: 'named writes inside read paths',
  itemPrecheckTools:
    'tool item pre-checks: policy `items` entries (A5 step 6b; exit 0, see docs/actors.md "Pre-check deletion")',
  itemPrecheckRoutes:
    'HTTP item pre-check list entries in route-scope.ts (A4 step 4; exit 0, see docs/actors.md "Pre-check deletion")',
  requestSystemExits: 'request paths that leave the login scope for the system pool (all reasons)',
  requestSystemExits_area: "request system exits, reason 'area' (an Admin area row)",
  requestSystemExits_loginSelf: "request system exits, reason 'login-self' (the login's own row)",
  requestSystemExits_adminWrite:
    "request system exits, reason 'admin-write' (an Admin user's write)",
  requestSystemExits_other:
    'request system exits with any other reason, or one the count cannot read',
  scopeHoldsAdminCalls: 'scopeHoldsAdmin calls (an Admin ask in code; done: the gates only)',
  sqlAreaRules:
    "SQL that decides an Admin area or user itself: functions reading the 'areas' limits, and SQL text in code",
  workspaceTableRawWrites:
    'raw writes to the four workspace tables in code (done: 0, definers only)',
  workspaceTableRowLocks:
    'row locks (FOR UPDATE / SHARE, drizzle .for) on the four workspace tables in code (0: the runtime role only reads them)',
  workspaceTableWriterFns:
    'SQL functions the migrations leave that write the four workspace tables (= the live catalog)',
  setAssistantCopies: 'copies of "set the assistant of a workspace" (code and SQL)',
  legacyPrecheckUndated: 'legacy tool item pre-checks with no owner or no end date',
  rawWriteAllowlist:
    'raw write SQL allowlist entries (eslint-rules/raw-write-allowlist.mjs; capped at the pin)',
  sqlMembershipAsks:
    "SQL text in code asking whether a given login is a user of a workspace (an assistant's; Admin only as a fallback): not an area rule",
  sqlRoleReaders:
    'SQL functions the migrations leave that read auth.users.role (= the live catalog)',
  asSystemFull: 'asSystem exits on the full system role (every table)',
  asSystemNarrow: 'asSystem exits on the narrow system role (may grow: a reason moved off full)',
  systemWholeOnFull:
    'systemWhole tools (run whole on the system pool) while admin-area routes full',
  systemDbUses_narrow:
    'systemDb uses in files reached in a scope: the narrow system role (may grow: a file moved off full)',
  systemDbUses_full: 'systemDb uses in files reached outside every scope: the full system role',
  requestSystemExits_narrow:
    'request system exits on the narrow system role (REQUEST_SYSTEM_ROUTE; may grow)',
  fullRouteSpots:
    "spots where a narrow exit's own work writes a content table, on the full route (down only; S7b)",
  fullRouteSpotCalls: 'onFullSystemRoute calls outside packages/db (down only; S7b)',
  systemWholeTools:
    'tool policies whose area scope is systemWhole (equal to the registry: tool-policy-snapshot.test.ts)',
  adminActRoutes: "Admin acts: an Admin user's write on the system pool with no scope (ADMIN_ACT)",
  loginKindBranches: "branches on a login's kind ('admin' or 'member'; progress counter only)",
  loginRoleDecisionReads:
    "decisions on a login's role ('admin' or 'member') in code (progress counter only)",
  adminDecisionFlags: 'identifiers named isAdmin (progress counter only)',
  tsAreaRules: 'TypeScript functions deciding an Admin area themselves (done: 0, SQL decides)',
  inHandlerAreaChecks:
    'area or Admin asks after the gate (scopeHasArea, loginHasArea, requireArea, loginHoldsAdmin, and thin wrappers of them; progress counter only)',
  inHandlerAreaCheckFiles: 'files with an area or Admin ask after the gate (may grow: a split)',
  loginTypeKindOrRole:
    'of kind and role, how many the login type has (the type test login-shape.test.ts; done: 0)',
  rawWriteSqlScoped:
    'literal raw write SQL in packages/*/src and server/ outside the allowlist (done: 0)',
  rawSqlNonLiteral:
    'raw SQL text that is no literal (.unsafe(x), sql.raw(x)) outside the allowlist (done: 0)',
  rawWriteSqlFiles: 'files with raw write SQL outside the allowlist (may grow: a split)',
  historyCodeComments: 'comment lines carrying a history code (fix rounds, audit and step codes)',
  routeBodyReadFiles: 'route files reading the request body directly (A10 part 2)',
  routeBodyReadAllowed: 'route files named to read the body another way (A10 part 2)',
  routeErrorTextFiles: "route files putting a caught error's text in a reply (A10 part 2)",
  rateLimitCalls: 'rate limit calls in any file outside the named list (A10 #8)',
  rateLimitAllowed: 'files named to take a limit: the gate and the budgets of their own (A10 #8)',
  handExportSyncCalls: 'hand export sync calls outside the app DB write path (A10 #9)',
  handExportSyncAllowed: 'files named to schedule the export sync by hand (A10 #9)',
  appToolBrokerLogicFiles: 'files holding app tool broker logic outside the one broker (A10 #9)',
  routeErrorTextAllowed:
    'route files named to, each with its reason: public by design, or waiting on the client (A10 part 2)',
  store_tabledb_files: 'files reaching the tables write API (A3b)',
  store_objectstore_files: 'files reaching the object store write API (A3b)',
  store_appdb_files: 'files reaching the app database write API or APP_DB_DIR (A3b)',
  bareFetchSites: 'bare fetch( sites in tools, calendar, content (A10 part 1)',
  http_inlineTimeout: 'inline AbortSignal.timeout( sites outside the named list (A10 #10)',
  http_inlineTimeout_allowed: 'inline AbortSignal.timeout( sites named in the list (A10 #10)',
  http_handAbortTimer: 'hand abort timers outside the named list (A10 #10)',
  http_handAbortTimer_allowed: 'hand abort timers named (headers-only deadlines) (A10 #10)',
  http_withTimeoutCopy: 'private withTimeout copies (A10 #10)',
  http_withTimeoutCopy_allowed: 'withTimeout definitions named (std) (A10 #10)',
  http_retryAfterRead: 'Retry-After header reads outside std (A10 #10)',
  http_retryAfterRead_allowed: 'Retry-After header reads named (std) (A10 #10)',
  http_backoffLoop: 'sleeping retry loops outside the named list (A10 #10)',
  http_backoffLoop_allowed: 'sleeping retry loops named (std, database retries) (A10 #10)',
  env_rawRead: 'raw process.env reads outside the named list (A10 #11)',
  env_rawRead_allowed:
    'raw process.env reads named (config, boot, published, standalone) (A10 #11)',
  env_handParse: 'hand parses of an env value outside the named list (A10 #11)',
  env_handParse_allowed: 'hand parses of an env value named (sandboxd, repo CLIs) (A10 #11)',
  env_isEnabledDef: 'isXEnabled definitions outside the named list (A10 #11)',
  env_isEnabledDef_allowed:
    'isXEnabled definitions named (published contracts, owner lookup) (A10 #11)',
  env_prefDefault: 'profile booleans compared with their default by hand (A10 #11)',
  env_prefDefault_allowed: 'profile boolean default checks named (A10 #11)',
  reindexNotifyCalls: 'hand node_ingested notifies outside markContentChanged (A10 #7)',
  reindexEmbeddingResets: 'hand embedding: null resets outside markContentChanged (A10 #7)',
  reindexSummaryClears: 'hand summary clears outside markContentChanged (A10 #7)',
  reindexAllowedFiles: 'files named to hold a hand re-index line, each with its reason (A10 #7)',
  spend_handSpend: 'hand spend recording outside the one recorder and the named list (A10 #5)',
  spend_handSpend_allowed: 'spend recording sites in the named files (A10 #5)',
  spend_providerBypass: 'provider calls bypassing the recording point (A10 #5)',
  spend_providerBypass_allowed: 'provider call sites named outside the registry wrapper (A10 #5)',
  std_uuidCopy: 'UUID regex copies outside @mantle/std and the named list (A10 #15)',
  std_uuidCopy_allowed: 'UUID regex copies named (std, the published packages, sandboxd) (A10 #15)',
  std_errorIdiom: 'hand error-to-message ternaries outside the named list (A10 #15)',
  std_errorIdiom_allowed:
    'hand error-to-message ternaries named (a fallback of their own, no std) (A10 #15)',
  std_dedupeTagsCopy: 'dedupeTags copies outside @mantle/content tags.ts (A10 #15)',
  std_dedupeTagsCopy_allowed: 'dedupeTags definitions named (the one) (A10 #15)',
  std_signalHandler: 'signal handlers outside onShutdown (A10 #15)',
  std_signalHandler_allowed: 'signal handlers named (onShutdown itself) (A10 #15)',
  std_advisoryLock: 'advisory locks in SQL outside the lock helper and the named list (A10 #15)',
  std_advisoryLock_allowed: 'advisory locks in SQL named (the helper, share, tests) (A10 #15)',
  std_ttlAgeCheck: 'hand TTL cache age checks outside TtlCache and the named list (A10 #15)',
  std_ttlAgeCheck_allowed: 'hand TTL cache age checks named (A10 #15)',
  std_cacheControlLiteral: 'Cache-Control values not from CACHE_CONTROL (A10 #15)',
  std_cacheControlLiteral_allowed: 'Cache-Control values not from CACHE_CONTROL, named (A10 #15)',
  consoleCalls:
    'console calls outside scripts (down only; log(scope) as files are touched) (A10 #15)',
  archivedAtIsNull:
    "hand live workspace ('archived_at is null', isNull(workspaces.archivedAt)) outside workspace-live.ts (down only) (A10 #15)",
  cacheControlFiles:
    'files that set Cache-Control (down only; /api is no-store by default) (A10 #15)',
  actorsMdLines:
    'lines of the spec docs/actors.md (down only, at most 350; handovers go to docs/_archive)',
  actorsHistoryRefs:
    'heading quotes of the history: docs/actors.md ones only the history file holds, and every docs/_archive quote (down only; D2 retargets them)',
  actorsStepRefs:
    'unquoted pointers to the history by a step code: the spec path, a comma, A4 (down only; D2 takes them to 0)',
  docQuotesDangling: 'doc heading quotes naming no heading, listed (down only; docs-quotes.mjs)',
  gapTables:
    'write-role gap reruns (a role switch to any role but the write role; 0 since plan v3 S3)',
  dbClientLines: 'lines of packages/db/src/client.ts (down only; plan v3 S5 splits it)',
  dbGatewayMaxLines:
    'most lines of a packages/db/src/gateway module: the max-lines limit, or the longest module over it (down only)',
  dbGatewayImportCycles: 'packages/db/src/gateway modules on an import cycle (0)',
  dbGlobalKeyWrites:
    'globalThis.__mantle* writes in packages/db/src outside gateway/pools.ts (0: pools.ts owns the keys)',
  dbGlobalKeyReads:
    "globalThis.__mantle* reads in packages/db/src outside gateway/pools.ts (1: actorClient's closing check)",
  failOpenSites:
    'fail-open branches counted as miss rows, not refused (plan v3.2 S4a: 6; S4b takes them to 0)',
};

/** Numbers that may go up without failing: the route counts grow with
 *  every new feature; retiring a route to a 410 stub is fine (A0 fix round
 *  2, M-2); the reads of the caller the pipeline answers grow with every
 *  batch of the A4 step 3b codemod. The guard calls and the files holding
 *  them may not grow since step 3b: the codemod takes them down batch by
 *  batch, and a new owner route reads the pipeline's caller (ownerCaller()). */
const MAY_GROW = new Set([
  'routeFiles',
  'apiRouteFiles',
  'goneStubs',
  'callerReads',
  'callerReadFiles',
  'asSystemNarrow',
  'systemDbUses_narrow',
  'requestSystemExits_narrow',
  // File counts of a counter pinned by itself: a file split (S5's of
  // client.ts) moves sites to more files, not more sites.
  'rawWriteSqlFiles',
  'inHandlerAreaCheckFiles',
]);

/** Pins a test measures and checks (not this script): --pin keeps them. */
const TESTED_PINS = ['a8Uncovered', 'a8Exempt'];

const mode = process.argv[2] ?? '';
const measured = measure(ROOT) as {
  numbers: Record<string, number>;
  perFile: {
    asSystemExitProblems?: string[];
    systemDbRouteProblems?: string[];
    rights?: {
      requestSystemExitProblems?: string[];
      asSystemRouteProblems?: string[];
      adminCountProblems?: string[];
    };
    cleanup?: { problems?: string[] };
    gateway?: { overLimit?: string[]; cycles?: string[] };
  };
};
const numbers = measured.numbers;
// The full-route exits by reason (asSystemFull_<reasons>): one pin each, so
// a reason that moves to the narrow role, or a new one, shows by name.
const pinnedKeys = (() => {
  try {
    return Object.keys(JSON.parse(readFileSync(PINS, 'utf8')) as object);
  } catch {
    return [];
  }
})();
for (const key of [...new Set([...Object.keys(numbers), ...pinnedKeys])].sort()) {
  if (key.startsWith('asSystemFull_')) {
    LABELS[key] = `asSystem exits on the full role, reason ${key.slice('asSystemFull_'.length)}`;
  }
}
const width = Math.max(...Object.values(LABELS).map((l) => l.length));
for (const [key, label] of Object.entries(LABELS)) {
  console.log(`${label.padEnd(width)}  ${numbers[key] ?? 0}`);
}

// An exit the counts cannot follow (a renamed call or wrapper, a use of the
// call that is not a call, a default-exported holder, a wrapper of a
// wrapper, two reason parameters), a reason with no route, or a login type
// pin the scoreboard cannot read would hide behind a pin that holds.
const problems = [
  ...(measured.perFile.asSystemExitProblems ?? []),
  ...(measured.perFile.systemDbRouteProblems ?? []),
  ...(measured.perFile.rights?.requestSystemExitProblems ?? []),
  ...(measured.perFile.rights?.asSystemRouteProblems ?? []),
  ...(measured.perFile.rights?.adminCountProblems ?? []),
  ...(measured.perFile.cleanup?.problems ?? []),
  ...(measured.perFile.gateway?.overLimit ?? []).map((p) => `${p} lines, over the gateway's limit`),
  ...(measured.perFile.gateway?.cycles ?? []).map((p) => `${p}: on an import cycle`),
  ...(numbers.loginTypeKindOrRole === -1
    ? ['server/web/lib/auth/login-shape.test.ts: LOGIN_SHAPE_PIN is not readable']
    : []),
];
const showProblems = () => {
  if (!problems.length) return;
  console.error(
    `\nWhat the scoreboard cannot count (eslint-rules/as-system-exits.mjs, as-system-routes.mjs):`,
  );
  for (const p of problems) console.error(`  ${p}`);
};

if (mode === '--pin') {
  // `_notes` says why a pin went up (a reviewed raise); a re-pin keeps it
  // while the pin holds, and drops it once the pin comes back down.
  let old: { _notes?: Record<string, string> } & Record<string, unknown> = {};
  try {
    old = JSON.parse(readFileSync(PINS, 'utf8')) as typeof old;
  } catch {
    old = {};
  }
  // The pins a test measures, not arch-counts (the A8 coverage, S11a:
  // server/web/server/a8-coverage.test.ts reads them): kept as they are.
  const tested = Object.fromEntries(TESTED_PINS.map((k) => [k, old[k]]));
  const notes = keptNotes(old._notes, old, numbers) as Record<string, string>;
  const all = { ...numbers, ...tested };
  const out = Object.keys(notes).length === 0 ? all : { ...all, _notes: notes };
  writeFileSync(PINS, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\npinned in ${PINS}`);
  // The pins are written; what they cannot count still fails --check.
  showProblems();
} else if (mode === '--check') {
  const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, number | undefined>;
  const up: string[] = [];
  const down: string[] = [];
  for (const key of Object.keys(LABELS)) {
    const now = numbers[key] ?? 0;
    const pin = pins[key];
    if (pin === undefined) up.push(`${key}: no pin (run --pin)`);
    else if (now > pin && !MAY_GROW.has(key)) up.push(`${LABELS[key]}: ${pin} -> ${now}`);
    else if (now < pin) down.push(`${LABELS[key]}: ${pin} -> ${now}`);
  }
  if (down.length) {
    console.log(`\nWent down (lower the pins: node scripts/arch-scoreboard.ts --pin):`);
    for (const d of down) console.log(`  ${d}`);
  }
  showProblems();
  if (up.length) {
    console.error(`\nThe architecture scoreboard went UP (plan v2, section 3):`);
    for (const u of up) console.error(`  ${u}`);
    console.error('Remove the new site, or raise the pin with a reason in review.');
  }
  if (up.length || problems.length) process.exit(1);
} else if (mode !== '') {
  console.error(`unknown option ${mode}: use --check or --pin`);
  process.exit(2);
}
