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
  std_cacheControlLiteral: 'literal Cache-Control values outside CACHE_CONTROL (A10 #15)',
  std_cacheControlLiteral_allowed: 'literal Cache-Control values named (A10 #15)',
  consoleCalls:
    'console calls outside scripts (down only; log(scope) as files are touched) (A10 #15)',
  archivedAtIsNull:
    "hand live workspace ('archived_at is null', isNull(workspaces.archivedAt)) outside workspace-live.ts (down only) (A10 #15)",
  cacheControlFiles:
    'files that set Cache-Control (down only; /api is no-store by default) (A10 #15)',
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
]);

const mode = process.argv[2] ?? '';
const numbers = (measure(ROOT) as { numbers: Record<string, number> }).numbers;
const width = Math.max(...Object.values(LABELS).map((l) => l.length));
for (const [key, label] of Object.entries(LABELS)) {
  console.log(`${label.padEnd(width)}  ${numbers[key]}`);
}

if (mode === '--pin') {
  // `_notes` says why a pin went up (a reviewed raise); a re-pin keeps it
  // while the pin holds, and drops it once the pin comes back down.
  let old: { _notes?: Record<string, string> } & Record<string, unknown> = {};
  try {
    old = JSON.parse(readFileSync(PINS, 'utf8')) as typeof old;
  } catch {
    old = {};
  }
  const notes = keptNotes(old._notes, old, numbers) as Record<string, string>;
  const out = Object.keys(notes).length === 0 ? numbers : { ...numbers, _notes: notes };
  writeFileSync(PINS, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\npinned in ${PINS}`);
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
  if (up.length) {
    console.error(`\nThe architecture scoreboard went UP (plan v2, section 3):`);
    for (const u of up) console.error(`  ${u}`);
    console.error('Remove the new site, or raise the pin with a reason in review.');
    process.exit(1);
  }
} else if (mode !== '') {
  console.error(`unknown option ${mode}: use --check or --pin`);
  process.exit(2);
}
