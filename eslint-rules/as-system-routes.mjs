/**
 * Which pool each asSystem exit runs on: the full system role (every table)
 * or the narrow one (plan v3.2 section 2.1). The route of a reason is read
 * from `AS_SYSTEM_ROUTE` in packages/db/src/viewer.ts once that map exists
 * (a typed Record<AsSystemReason, 'narrow' | 'full'>, so a new reason must
 * pick); until then from AS_SYSTEM_ROUTE_SEED below, where every reason is
 * 'full', as every exit runs today. Read by rights-counts.mjs, pinned in
 * scripts/arch-scoreboard.pins.json (asSystemFull, asSystemNarrow, and
 * asSystemFull_<reason>), tested in admin-counts.test.ts.
 *
 * An exit is a use of a function holding an asSystem call
 * (as-system-exits.mjs). A holder with several reasons (a conditional
 * wrapper) runs narrow only when every one of its reasons does; one whose
 * reason the count cannot read runs full.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { balanced, readRepoFile, stripComments } from './arch-counts.mjs';

/** Every reason's route while the map is not in viewer.ts: all full. */
export const AS_SYSTEM_ROUTE_SEED = Object.freeze({
  'agent-workspace': 'full',
  'connector-binding': 'full',
  'connector-call': 'full',
  'heartbeat-own-row': 'full',
  'app-data': 'full',
  'rule-in-query': 'full',
  'admin-area': 'full',
  'keyword-candidates': 'full',
  'app-trash': 'full',
  'login-telegram': 'full',
  'audit-log': 'full',
  'pending-approval': 'full',
  'page-refold': 'full',
  'brain-bookkeeping': 'full',
  'login-notice': 'full',
  'space-taken-authors': 'full',
  test: 'full',
});

const VIEWER = 'packages/db/src/viewer.ts';

/** The string literals of the `as const` list `name` in `code`. */
function constList(code, name) {
  const at = code.search(new RegExp(String.raw`\bconst\s+${name}\b`));
  if (at < 0) return [];
  const list = balanced(code, code.indexOf('[', at));
  return [...list.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]);
}

/** The reasons AsSystemReason admits (viewer.ts: the turn reasons and the
 *  other reasons). */
export function asSystemReasons(root) {
  const code = stripComments(readRepoFile(root, VIEWER) ?? '');
  return [
    ...constList(code, 'AS_SYSTEM_TURN_REASONS'),
    ...constList(code, 'AS_SYSTEM_OTHER_REASONS'),
  ];
}

/** The route map: viewer.ts's AS_SYSTEM_ROUTE when it is there, else the
 *  seed. `{ source, routes }`. */
export function asSystemRouteMap(root) {
  const code = stripComments(readRepoFile(root, VIEWER) ?? '');
  const at = code.search(/\bconst\s+AS_SYSTEM_ROUTE\b/);
  if (at < 0) return { source: 'seed', routes: { ...AS_SYSTEM_ROUTE_SEED } };
  const block = balanced(code, code.indexOf('{', code.indexOf('=', at)));
  const routes = {};
  for (const m of block.matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*'(\w+)'/g)) {
    routes[m[1] ?? m[2] ?? m[3]] = m[4];
  }
  return { source: VIEWER, routes };
}

/**
 * The asSystem exits split by route: `{ full, narrow, byReason, problems }`.
 * `holders`: the asSystem holders with their exits (asSystemExits(...)
 * .holders, `exits` and `reasons` each). `byReason` keys a holder by its
 * reasons joined with '+', 'unnamed' when it has none the count can read:
 * `{ [key]: { route, exits } }`. A reason AsSystemReason admits with no
 * route, a route that is not 'full' or 'narrow', and a map entry for no
 * reason are problems. While the seed is the source (`source: 'seed'`), a
 * route other than 'full' is one too: every exit runs full until the map in
 * viewer.ts says otherwise, so an edit of the seed cannot lower asSystemFull.
 */
export function asSystemRouteCounts(holders, { routes, reasons, source = VIEWER }) {
  const problems = [];
  if (source === 'seed') {
    for (const [r, v] of Object.entries(routes)) {
      if (v !== 'full')
        problems.push(
          `the route seed (eslint-rules/as-system-routes.mjs) routes ${r} '${v}': the seed is all 'full'; a reason moves off the full role in ${VIEWER}'s AS_SYSTEM_ROUTE (S7a)`,
        );
    }
  }
  for (const r of reasons) {
    if (!Object.hasOwn(routes, r))
      problems.push(`asSystem reason ${r} has no route: pick 'narrow' or 'full'`);
  }
  for (const [r, v] of Object.entries(routes)) {
    if (v !== 'full' && v !== 'narrow')
      problems.push(`asSystem reason ${r} routes '${v}': 'narrow' or 'full'`);
    if (!reasons.includes(r))
      problems.push(`the route map names ${r}, which is no asSystem reason`);
  }
  let full = 0;
  let narrow = 0;
  const byReason = {};
  for (const h of holders) {
    if (!h.exits) continue;
    const rs = h.reasons ?? [];
    const route = rs.length > 0 && rs.every((r) => routes[r] === 'narrow') ? 'narrow' : 'full';
    if (route === 'narrow') narrow += h.exits;
    else full += h.exits;
    const key = rs.length ? rs.join('+') : 'unnamed';
    const cur = byReason[key] ?? { route, exits: 0 };
    cur.exits += h.exits;
    byReason[key] = cur;
  }
  return { full, narrow, byReason, problems };
}

/** The route of each request system exit: viewer.ts's REQUEST_SYSTEM_ROUTE
 *  (plan v3.2 S7a), `{ [why]: 'narrow' | 'full' }`; empty when absent. */
export function requestSystemRouteMap(root) {
  const code = stripComments(readRepoFile(root, VIEWER) ?? '');
  const at = code.search(/\bconst\s+REQUEST_SYSTEM_ROUTE\b/);
  if (at < 0) return {};
  const block = balanced(code, code.indexOf('{', code.indexOf('=', at)));
  const routes = {};
  for (const m of block.matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*'(\w+)'/g)) {
    routes[m[1] ?? m[2] ?? m[3]] = m[4];
  }
  return routes;
}

/**
 * Where onFullSystemRoute may be named outside packages/db and tests, and
 * the spots each file may run (reviewed: each a place where a narrow exit's
 * own work writes a content table; viewer.ts FULL_ROUTE_SPOTS has the why).
 * Alias-proof: a file not listed that names the function, an aliased import
 * or any other binding of it, a call whose spot is not a literal, and a
 * listed spot the file does not hold are problems that fail arch:check.
 * The list only shrinks (S7b moves each spot to the write role or a
 * definer).
 */
export const FULL_ROUTE_SPOT_FILES = Object.freeze({
  'packages/content/src/profile-preferences.ts': ['profile-row'],
  'packages/db/src/gateway/structure-item.ts': ['structure-no-login'],
  // The five acting-login definers' callers enter the spot through one
  // helper (atActingLogin, FULL_ROUTE_SPOT_CALLBACKS).
  'packages/db/src/gateway/acting-login.ts': ['acting-login'],
  'packages/embeddings/src/reembed.ts': ['reembed'],
  // A disable or session end of the owner or an Admin user (0327's hold:
  // onLoginHoldSpot, asked by session.ts and login-update.ts).
  'packages/db/src/login-hold.ts': ['login-credential'],
  'server/web/lib/auth/session.ts': ['login-credential'],
  'server/web/lib/login-create.ts': ['login-credential'],
  'server/web/lib/login-update.ts': ['login-credential'],
  'packages/tools/src/pending.ts': ['pending-call', 'run-control'],
  'server/web/app/api/dev-tools/execute-tool/route.ts': ['console-tool'],
  'server/web/lib/integrity/landed.ts': ['integrity-delete'],
  'server/web/lib/pair-code.ts': ['pair-code'],
  'server/web/lib/mcp-oauth.ts': ['oauth-code'],
  'packages/content/src/member-invites.ts': ['member-invite'],
  'packages/content/src/peers/registry.ts': ['peer-access'],
  'packages/content/src/peers/grants.ts': ['peer-share'],
  'packages/telegram/src/pairing.ts': ['telegram-pair'],
  'server/web/app/api/telegram/chats/[id]/route.ts': ['telegram-responder'],
  'server/web/app/api/runs/[id]/route.ts': ['run-control'],
  'packages/tools/src/builtins-runs.ts': ['run-control'],
  'server/web/lib/ai-workers.ts': ['model-route', 'skill-text'],
  'server/web/lib/embedding-config.ts': ['model-route'],
  'packages/tools/src/crud.ts': ['tool-config'],
  'packages/tools/src/external-access.ts': ['tool-config'],
  'packages/tools/src/integration.ts': ['tool-config'],
  'packages/tools/src/mcp-oauth.ts': ['tool-config'],
  'packages/microsoft/src/config-store.ts': ['tool-config'],
  'server/web/lib/heartbeats.ts': ['heartbeat-maker'],
  'packages/runtime/src/heartbeats/tools.ts': ['heartbeat-maker'],
  'packages/tools/src/heartbeat-maker.ts': ['heartbeat-maker'],
  'server/web/lib/skills.ts': ['skill-text'],
  'packages/tools/src/toolsmith/docs.ts': ['skill-text'],
  // The approval queue's one park (the turn's confirm gate, an agent's
  // queued call, the toolsmith, the dev console all call parkPendingCall).
  'packages/db/src/pending-calls.ts': ['pending-park'],
  // A cancelled turn pair stamped superseded (the cancel route).
  'packages/db/src/conversation-writes.ts': ['turn-supersede'],
  'packages/files/src/docs.ts': ['docs-root'],
  // A content feed switched on (0324: enabled only off on the narrow login).
  'packages/calendar/src/manage.ts': ['feed-enable'],
  'packages/microsoft/src/drives/manage.ts': ['feed-enable'],
  'server/web/lib/worker-groups.ts': ['agent-group-grant'],
  'packages/tools/src/builtins-pending.ts': ['agent-group-grant'],
  'server/web/lib/agents.ts': ['assistant-grant', 'model-route', 'skill-text'],
  'server/web/lib/system-manifest/seed.ts': [
    'assistant-grant',
    'tool-group-grant',
    'heartbeat-maker',
  ],
  'packages/runs/src/worker.ts': ['assistant-grant'],
  'packages/tools/src/toolsmith/groups.ts': ['assistant-grant', 'tool-group-grant', 'model-route'],
  'server/web/lib/tool-groups.ts': ['tool-group-grant', 'tool-config'],
  'server/web/app/api/tools/route.ts': ['tool-group-grant'],
  'packages/tools/src/toolsmith/common.ts': ['tool-group-grant'],
  'packages/tools/src/mcp-sync.ts': ['tool-group-grant', 'tool-config'],
  'packages/tools/src/openapi-sync.ts': ['tool-group-grant', 'tool-config'],
  'packages/tools/src/sandbox/files.ts': ['tool-group-grant', 'tool-config'],
  'server/web/lib/push/store.ts': ['push-device'],
  'server/web/app/api/users/[id]/route.ts': ['login-credential'],
  'packages/api-keys/src/index.ts': ['model-route'],
  'packages/tools/src/builtins-persona.ts': ['skill-text'],
  'packages/email/src/accounts.ts': ['mail-account'],
  'packages/microsoft/src/outlook/manage.ts': ['mail-account'],
  'packages/content/src/sandboxes.ts': ['sandbox-make'],
  'server/web/lib/agent-telegram.ts': ['telegram-connect'],
  'packages/microsoft/src/token-store.ts': ['ms-account'],
  'packages/microsoft/src/drives/discover.ts': ['ms-account'],
  'server/web/app/api/model-pools/[id]/route.ts': ['model-route'],
  // (the destination and cost class): a pool entry added or
  // removed, a turn's thinking effort, the extraction concurrency.
  'server/web/app/api/model-pools/route.ts': ['model-route'],
  'packages/tools/src/builtins-curation.ts': ['model-route'],
  'server/web/app/api/embedding/extraction/route.ts': ['model-route'],
  'server/web/lib/maintenance/curate-pools-run.ts': ['model-route'],
  'server/web/lib/model-pools-seed.ts': ['model-route'],
  'server/web/lib/studio/prompt-versions.ts': ['skill-text'],
  'server/web/lib/mcp-connectors.ts': ['tool-config'],
  'server/web/lib/openapi-connectors.ts': ['tool-config'],
  'server/api/src/agent/reflector.ts': ['skill-text'],
});

/**
 * The helpers that wrap one spot for many writes, each with its spot, the
 * file that defines it and the files that may call it. Each call is counted
 * (`wrapperCalls`, pinned down only): a call from a file not listed, the
 * helper imported under another name, or named any other way than by its
 * definition, its import and a call (an alias, a reference passed on), is
 * a problem. TODO(S7b): each write
 * moves to the write role or a definer and the helper goes.
 */
export const FULL_ROUTE_SPOT_WRAPPERS = Object.freeze({
  profileWrite: {
    spot: 'profile-row',
    from: 'packages/content/src/profile-preferences.ts',
    callers: ['packages/content/src/profile-preferences.ts', 'packages/content/src/backup.ts'],
  },
});

/**
 * The spot holders that run a caller's function inside their spot: what
 * the function writes runs on the full route too, though its file holds no
 * onFullSystemRoute call. Each with its spot, its file and the files that
 * may pass it a function. A function in FULL_ROUTE_SPOT_FILES that calls
 * onFullSystemRoute and takes a function-typed parameter (`=>` in its
 * type) is a holder: one not listed here (nor a FULL_ROUTE_SPOT_WRAPPERS
 * helper) is a problem; so is a call that passes something other than
 * `undefined` at a function parameter from a file not listed, and the
 * holder named other than by its definition, its import and a call.
 * applyManifest takes data only (slugs and modes), so it is no holder.
 */
export const FULL_ROUTE_SPOT_CALLBACKS = Object.freeze({
  applyLoginChange: {
    spot: 'login-credential',
    from: 'server/web/lib/login-update.ts',
    // The workspace screen's role change: its firstInTx locks the
    // workspace and checks its rules (reads; a refusal throws). The Users
    // screen's role change (PATCH /api/users/:id): its firstInTx is the
    // Admin membership definer's one call (adminMembershipChange: the add
    // or removal that writes the role; a refusal throws).
    callers: ['server/web/lib/workspaces.ts', 'server/web/app/api/users/[id]/route.ts'],
  },
  atActingLogin: {
    spot: 'acting-login',
    from: 'packages/db/src/gateway/acting-login.ts',
    // The five definers that need the exit's acting login (0322): each
    // caller opens its own transaction and calls its one definer.
    callers: [
      'packages/db/src/gateway/structure-item.ts',
      'packages/db/src/gateway/spot-definers.ts',
      'packages/telegram/src/pairing.ts',
      'server/web/lib/workspaces-migrate.ts',
      'server/web/lib/workspaces.ts',
    ],
  },
  // 0327's hold: a disable or session end of the owner or an Admin user.
  // Each caller passes its own transaction (the login's sessions ended, the
  // users area's change of that login).
  onLoginHoldSpot: {
    spot: 'login-credential',
    from: 'packages/db/src/login-hold.ts',
    // And the same hold on their grants: a device revoked (the users area's
    // devices, the phone's own sign-out, a device token's rotation), a
    // login's grants on one MCP client ended, an OAuth code burned, an MCP
    // client removed that a live grant of theirs rides on; and since 0328
    // a push device removed (push/store.ts devicesDelete and the login's
    // own device deletes outside a caller's transaction).
    callers: [
      'server/web/app/api/auth/mobile-logout/route.ts',
      'server/web/app/api/auth/token/refresh/route.ts',
      'server/web/app/api/users/[id]/devices/[jti]/route.ts',
      'server/web/lib/auth/session.ts',
      'server/web/lib/login-update.ts',
      'server/web/lib/mcp-clients.ts',
      'server/web/lib/mcp-oauth.ts',
      'server/web/lib/push/store.ts',
    ],
  },

  // Two local arrows the check found once it read arrow functions: each
  // runs its own file's functions only.
  asCallActorOrSpot: {
    spot: 'pending-call',
    from: 'packages/tools/src/pending.ts',
    // An approved call with no login and no origin runs its tool at the
    // spot; with a login, as that login (runAsActor).
    callers: ['packages/tools/src/pending.ts'],
  },
  atCredentialSpot: {
    spot: 'login-credential',
    from: 'server/web/lib/login-update.ts',
    // applyLoginChange's own transaction, at the spot only when the change
    // names a credential or a right.
    callers: ['server/web/lib/login-update.ts'],
  },
  onSpot: {
    spot: 'structure-no-login',
    from: 'packages/db/src/gateway/structure-item.ts',
    // Its own file's three writes of a structure item (not exported).
    callers: ['packages/db/src/gateway/structure-item.ts'],
  },
});

/** `text` (the inside of a bracket pair) split at its top-level commas. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{<'.includes(c)) depth += 1;
    else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '=')) depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The functions declared in `body` (`function name(...)`) whose own body
 *  calls onFullSystemRoute, each with the indexes of its function-typed
 *  parameters: `[{ name, fnParams }]`. */
function spotHolders(body) {
  const out = [];
  for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const params = balanced(body, open);
    // The body: the first `{` after the parameters outside a type's `<>`.
    let i = open + params.length;
    let angle = 0;
    for (; i < body.length; i += 1) {
      const c = body[i];
      if (c === '<') angle += 1;
      else if (c === '>' && body[i - 1] !== '=') angle -= 1;
      else if (c === '{' && angle === 0) break;
    }
    if (i >= body.length) continue;
    const own = balanced(body, i);
    if (!/\bonFullSystemRoute\s*\(/.test(own)) continue;
    const fnParams = topLevelParts(params.slice(1, -1))
      .map((p, idx) => (/=>/.test(p) ? idx : -1))
      .filter((idx) => idx >= 0);
    out.push({ name: m[1], fnParams });
  }
  // The same as an arrow or a function expression bound to a name
  // (`const name = async (a, b) => { ... }`, `const name = function (...)`):
  // a holder written so must not slip past the check.
  for (const m of body.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b\s*[A-Za-z_$]*\s*)?(?:<[^>()]*>)?\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const params = balanced(body, open);
    let i = open + params.length;
    // An arrow: `=>` next (after a return type); a function expression: its `{`.
    const rest = body.slice(i);
    const arrow = rest.match(/^\s*(?::[^=]*?)?=>\s*/);
    let own;
    if (arrow) {
      i += arrow[0].length;
      own =
        body[i] === '{' || body[i] === '('
          ? balanced(body, i)
          : body.slice(i, body.indexOf(';', i) >>> 0);
    } else if (/function\b/.test(m[0])) {
      const brace = body.indexOf('{', i);
      if (brace < 0) continue;
      own = balanced(body, brace);
    } else continue;
    if (!/\bonFullSystemRoute\s*\(/.test(own)) continue;
    const fnParams = topLevelParts(params.slice(1, -1))
      .map((p, idx) => (/=>/.test(p) ? idx : -1))
      .filter((idx) => idx >= 0);
    out.push({ name: m[1], fnParams });
  }
  return out;
}

/**
 * The callbacks into spot holders (FULL_ROUTE_SPOT_CALLBACKS): `{ calls,
 * problems }`, `calls` the calls that pass a function. `texts` as
 * fullRouteSpots takes them.
 */
export function fullRouteSpotCallbacks(
  texts,
  allowed = FULL_ROUTE_SPOT_FILES,
  holders = FULL_ROUTE_SPOT_CALLBACKS,
  wrappers = FULL_ROUTE_SPOT_WRAPPERS,
) {
  const problems = [];
  const found = {};
  let calls = 0;
  const live = texts.filter(({ path }) => !/\.test\.tsx?$/.test(path));
  for (const { path, text } of live) {
    if (!allowed[path]) continue;
    for (const h of spotHolders(stripComments(text))) {
      if (h.fnParams.length === 0 || Object.hasOwn(wrappers, h.name)) continue;
      found[h.name] = { path, fnParams: h.fnParams };
      const listed = holders[h.name];
      if (!listed)
        problems.push(
          `${path}: ${h.name} runs a caller's function at a full-route spot and is not in FULL_ROUTE_SPOT_CALLBACKS`,
        );
      else if (listed.from !== path)
        problems.push(`${path}: ${h.name} is listed from ${listed.from}`);
    }
  }
  for (const [name, h] of Object.entries(holders)) {
    if (!found[name]) {
      problems.push(
        `${h.from}: ${name} is listed in FULL_ROUTE_SPOT_CALLBACKS but takes no function at a spot`,
      );
      continue;
    }
    if (!(allowed[h.from] ?? []).includes(h.spot))
      problems.push(`${h.from}: ${name} runs at '${h.spot}', not listed for it`);
    const { fnParams } = found[name];
    for (const { path, text } of live) {
      const body = stripComments(text);
      const named = new RegExp(`\\b${name}\\b`, 'g');
      const mentions = body.match(named)?.length ?? 0;
      if (mentions === 0) continue;
      if (new RegExp(`\\b${name}\\s+as\\b`).test(body))
        problems.push(`${path}: imports ${name} under another name`);
      const defined =
        path === h.from
          ? (body.match(
              new RegExp(
                `\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=(?!=)`,
                'g',
              ),
            )?.length ?? 0)
          : 0;
      let imported = 0;
      for (const m of body.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']+'/g)) {
        for (const part of m[1].split(',')) {
          if (new RegExp(`^\\s*(?:type\\s+)?${name}\\s*$`).test(part)) imported += 1;
        }
      }
      // The db barrel's bare re-export (`export { name } from './...'`) is
      // an import for this count.
      if (path === 'packages/db/src/index.ts')
        for (const m of body.matchAll(/export\s*\{([^}]*)\}\s*from\s*'[^']+'/g))
          for (const part of m[1].split(','))
            if (new RegExp(`^\\s*${name}\\s*$`).test(part)) imported += 1;
      let called = 0;
      for (const m of body.matchAll(
        new RegExp(`(?<!function\\s+)\\b${name}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g'),
      )) {
        called += 1;
        const args = topLevelParts(balanced(body, m.index + m[0].length - 1).slice(1, -1));
        const passes = fnParams.some((i) => args[i] !== undefined && args[i] !== 'undefined');
        if (!passes) continue;
        calls += 1;
        if (!h.callers.includes(path))
          problems.push(
            `${path}: passes a function to ${name} (runs at '${h.spot}') but is not its caller`,
          );
      }
      if (mentions !== defined + imported + called)
        problems.push(
          `${path}: names ${name} other than by its definition, its import and a call (an alias or a passed reference the check misses)`,
        );
    }
  }
  return { calls, problems };
}

/** The one file that may call onFullSystemRoute with a spot that is no
 *  literal: onNarrowSpots, which enters the spots its table names
 *  (NARROW_TABLE_SPOTS). Its callers name the table; the spots are read
 *  from that list, and each must be listed for the calling file. */
export const NARROW_SPOTS_FILE = 'packages/db/src/narrow-spots.ts';
const TABLE_SPOT_CALL = 'onNarrowSpots';

/** NARROW_TABLE_SPOTS read from its source: `{ 'schema.table': [spots] }`. */
export function narrowTableSpots(text) {
  const code = stripComments(text ?? '');
  const out = {};
  for (const m of code.matchAll(/'([a-z_]+\.[a-z_]+)'\s*:\s*\{\s*spots\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^'\n]+)'/g)].map((x) => x[1]);
  }
  return out;
}

/** The schema's table exports by name: `{ exportName: 'schema.table' }`
 *  (pgTable and a pgSchema's `.table`). */
export function schemaTableNames(root) {
  const out = {};
  const dir = 'packages/db/src/schema';
  let files;
  try {
    files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'));
  } catch {
    return out;
  }
  for (const f of files) {
    const code = stripComments(readRepoFile(root, `${dir}/${f}`) ?? '');
    const schemas = {};
    for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*pgSchema\(\s*'([^']+)'/g))
      schemas[m[1]] = m[2];
    for (const m of code.matchAll(
      /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(pgTable|[A-Za-z_$][\w$]*\.table)\s*\(\s*'([^']+)'/g,
    )) {
      const schema = m[2] === 'pgTable' ? 'public' : schemas[m[2].split('.')[0]];
      if (schema) out[m[1]] = `${schema}.${m[3]}`;
    }
  }
  return out;
}

/**
 * The onNarrowSpots calls of one file (its code, comments stripped): each
 * call's table (its first argument, a schema export) and the spots
 * NARROW_TABLE_SPOTS names for it. `problems` for a table not listed there,
 * the helper imported under another name, or named other than by its
 * import and a call.
 */
export function tableSpotCalls(path, body, tables, tableSpots) {
  const problems = [];
  const calls = [];
  const named = new RegExp(`\\b${TABLE_SPOT_CALL}\\b`, 'g');
  const mentions = body.match(named)?.length ?? 0;
  if (mentions === 0) return { calls, problems };
  let imported = 0;
  for (const m of body.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    for (const part of m[1].split(',')) {
      if (!new RegExp(`\\b${TABLE_SPOT_CALL}\\b`).test(part)) continue;
      if (new RegExp(`^\\s*${TABLE_SPOT_CALL}\\s*$`).test(part)) imported += 1;
      else problems.push(`${path}: imports ${TABLE_SPOT_CALL} under another name`);
    }
  }
  const found = [
    ...body.matchAll(
      new RegExp(`(?<!function\\s+)\\b${TABLE_SPOT_CALL}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g'),
    ),
  ];
  for (const m of found) {
    const args = topLevelParts(balanced(body, m.index + m[0].length - 1).slice(1, -1));
    const table = tables[args[0]];
    const spots = table ? tableSpots[table] : undefined;
    if (!spots)
      problems.push(
        `${path}: an ${TABLE_SPOT_CALL} call whose table (${args[0]}) has no NARROW_TABLE_SPOTS entry`,
      );
    else calls.push({ table, spots });
  }
  if (imported + found.length !== mentions)
    problems.push(`${path}: ${TABLE_SPOT_CALL} named other than by its import and a call`);
  return { calls, problems };
}

/**
 * The full-route spots (plan v3.2 S7a): the entries of viewer.ts's
 * FULL_ROUTE_SPOTS (where a narrow exit's own work writes a content table),
 * the onFullSystemRoute calls outside tests (packages/db included, where
 * the definition is not a call), and the calls of the wrappers
 * (FULL_ROUTE_SPOT_WRAPPERS). All only go down (S7b moves each to the
 * write role or a definer). `problems`: what FULL_ROUTE_SPOT_FILES and
 * FULL_ROUTE_SPOT_WRAPPERS refuse.
 */
export function fullRouteSpots(
  root,
  texts,
  allowed = FULL_ROUTE_SPOT_FILES,
  wrappers = FULL_ROUTE_SPOT_WRAPPERS,
) {
  const code = stripComments(readRepoFile(root, VIEWER) ?? '');
  const at = code.search(/\bconst\s+FULL_ROUTE_SPOTS\b/);
  const names =
    at < 0
      ? []
      : [
          ...balanced(code, code.indexOf('{', code.indexOf('=', at))).matchAll(
            /^\s*(?:'([^'\n]+)'|([A-Za-z_$][\w$]*))\s*:/gm,
          ),
        ].map((m) => m[1] ?? m[2]);
  const problems = [];
  let calls = 0;
  const seen = new Set();
  let wrapperCalls = 0;
  const tableSpots = narrowTableSpots(readRepoFile(root, NARROW_SPOTS_FILE));
  const tables = schemaTableNames(root);
  let tableCalls = 0;
  for (const { path, text } of texts) {
    if (/\.test\.tsx?$/.test(path)) continue;
    const body = stripComments(text);
    if (path === NARROW_SPOTS_FILE) {
      // The helper's own call: one, its spot the loop's variable.
      const own = [...body.matchAll(/(?<!function\s+)\bonFullSystemRoute\s*\(\s*([^,]*),/g)];
      if (own.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(own[0][1].trim()))
        problems.push(`${path}: holds one onFullSystemRoute call, its spot a variable`);
      continue;
    }
    // The barrel's re-export and the test helpers' own name of it are no
    // calls.
    if (path !== 'packages/db/src/index.ts' && !/(^|\/)test-support\//.test(path)) {
      const t = tableSpotCalls(path, body, tables, tableSpots);
      problems.push(...t.problems);
      for (const c of t.calls) {
        tableCalls += 1;
        for (const spot of c.spots) {
          if (!(allowed[path] ?? []).includes(spot))
            problems.push(`${path}: spot '${spot}' (by its table ${c.table}) is not listed for it`);
          else seen.add(`${path}|${spot}`);
        }
      }
    }
    for (const [name, w] of Object.entries(wrappers)) {
      const named = new RegExp(`\\b${name}\\b`, 'g');
      if (!named.test(body)) continue;
      const called = [
        ...body.matchAll(new RegExp(`(?<!function\\s+)\\b${name}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g')),
      ];
      wrapperCalls += called.length;
      if (!w.callers.includes(path)) problems.push(`${path}: calls ${name} but is not its caller`);
      if (new RegExp(`\\b${name}\\s+as\\b`).test(body)) {
        problems.push(`${path}: imports ${name} under another name`);
      }
      // Every mention is its definition (in its own file), its bare import
      // or a call: an alias (const v = w), a reference passed on
      // (.map(w)) or a re-export would be calls the count never sees.
      const mentions = body.match(named)?.length ?? 0;
      const defined =
        path === w.from
          ? (body.match(new RegExp(`\\bfunction\\s+${name}\\b`, 'g'))?.length ?? 0)
          : 0;
      let imported = 0;
      for (const m of body.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']+'/g)) {
        for (const part of m[1].split(',')) {
          if (new RegExp(`^\\s*(?:type\\s+)?${name}\\s*$`).test(part)) imported += 1;
        }
      }
      if (mentions !== defined + imported + called.length) {
        problems.push(
          `${path}: names ${name} other than by its definition, its import and a call (an alias or a passed reference the count misses)`,
        );
      }
    }
    if (path.startsWith('packages/db/src/')) {
      // The definition and the export list are no call; a call here is
      // counted and must be listed as anywhere else.
      const dbCalls = [
        ...body.matchAll(/(?<!function\s+)\bonFullSystemRoute\s*(?:<[^>()]*>)?\s*\(/g),
      ];
      if (dbCalls.length > 0 && !allowed[path]) {
        problems.push(`${path}: calls onFullSystemRoute but is not in FULL_ROUTE_SPOT_FILES`);
      }
      if (!allowed[path]) continue;
    }
    const mentions = [...body.matchAll(/\bonFullSystemRoute\b/g)].length;
    if (mentions === 0) continue;
    const spots = allowed[path];
    if (!spots) {
      problems.push(`${path}: names onFullSystemRoute but is not in FULL_ROUTE_SPOT_FILES`);
      continue;
    }
    // The bare name in an import from @mantle/db (never `as`), and calls
    // with a literal spot; any other mention is a binding the count misses.
    let imported = 0;
    // (inside packages/db, from its own viewer module).
    for (const m of body.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*'(?:@mantle\/db|(?:\.\.?\/)+viewer)'/g,
    )) {
      for (const part of m[1].split(',')) {
        if (!/\bonFullSystemRoute\b/.test(part)) continue;
        if (/^\s*(?:type\s+)?onFullSystemRoute\s*$/.test(part)) imported += 1;
        else problems.push(`${path}: imports onFullSystemRoute under another name`);
      }
    }
    const fileCalls = [
      ...body.matchAll(/\bonFullSystemRoute\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)")?/g),
    ];
    calls += fileCalls.length;
    for (const m of fileCalls) {
      const spot = m[1] ?? m[2];
      if (spot === undefined)
        problems.push(`${path}: an onFullSystemRoute call whose spot is no literal`);
      else if (!spots.includes(spot)) problems.push(`${path}: spot '${spot}' is not listed for it`);
      else seen.add(`${path}|${spot}`);
    }
    if (imported + fileCalls.length !== mentions) {
      problems.push(`${path}: onFullSystemRoute named other than by its import and a call`);
    }
  }
  for (const [path, spots] of Object.entries(allowed)) {
    for (const spot of spots) {
      if (!names.includes(spot)) problems.push(`${path}: '${spot}' is no FULL_ROUTE_SPOTS entry`);
      else if (!seen.has(`${path}|${spot}`))
        problems.push(`${path}: listed for '${spot}' but holds no such call`);
    }
  }
  for (const [name, w] of Object.entries(wrappers)) {
    if (!(allowed[w.from] ?? []).includes(w.spot)) {
      problems.push(`${w.from}: ${name} wraps '${w.spot}', not listed for it`);
    }
  }
  return { entries: names.length, calls: calls + tableCalls, tableCalls, wrapperCalls, problems };
}
