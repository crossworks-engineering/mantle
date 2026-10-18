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
  'workspace-write': 'full',
  'page-refold': 'full',
  'brain-bookkeeping': 'full',
  'login-notice': 'full',
  'space-taken-authors': 'full',
  'snapshot-copies': 'full',
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
