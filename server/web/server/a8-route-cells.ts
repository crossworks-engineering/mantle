/**
 * The A8 route cells (workspaces arch plan v3.2, section 5 item 3): a set of
 * cells for every write route whose declaration names its item
 * (`item: { param, need }`, server/web/lib/auth/route-declaration.ts),
 * generated from that declaration and the request each route takes
 * (A8_ROUTE_SPECS), and judged against the guide oracle
 * (@mantle/db/matrix/guide-oracle) by the guide action the route is.
 *
 * For each route: the five roles of the plan (outsider, readGrant,
 * writeGrant, homeModerator, an Admin user) x every placement of its kind
 * the fixture holds (the A8 grid's: folder, root, snapshot, admin), each
 * cell on a fresh item. A cell passes on the oracle's answer: allowed is
 * the route's success; refused is a 403 or a 404 that changes no row and
 * makes no node, and, for a caller that does not read the item, the answer
 * a random uuid gets (byte for byte, the id aside). A route is covered only
 * with an allowed cell and a refused one; a route whose allowed request the
 * cells cannot stand up runs its refused cells (refusedOnly, with why) and
 * counts in a8Exempt.
 *
 * The declaration states intent only: no gate reads it (route-policy.ts
 * buildRouteRow). A write that declares `none` names no item in its path,
 * or one that is no workspace item (each its reason in its route file):
 * it is outside this set by that reason, and the route cells do not count
 * it. The cells run through the full HTTP pipeline (runRoute) in
 * a8-route-cells.matrix.test.ts; the coverage test (a8-coverage.test.ts)
 * counts what no cell covers. This module is pure: no database, no app.
 */
import { ITEM_KINDS } from '@mantle/client-types/kinds';
import {
  expectedAccess,
  type GuideAction,
  type GuideAnswer,
  type GuidePlacement,
  type GuideRole,
  type GuideSurface,
  GUIDE_PLACEMENTS,
} from '@mantle/db/matrix/guide-oracle';
import type { MethodPolicy } from '../lib/auth/route-declaration';

/** The roles the route cells run as (plan v3.2 section 5 item 3; the owner
 *  is an Admin user, the admin role stands for every one). */
export const A8_ROUTE_ROLES: readonly GuideRole[] = [
  'outsider',
  'readGrant',
  'writeGrant',
  'homeModerator',
  'admin',
];

/** The check mode the route cells run in: on, as every fleet box. In warn
 *  the edit check only warns, so a route whose write is one statement (the
 *  database's check alone) makes a write the database would refuse
 *  (docs/edit-check.md); its refused cells answer only in on. */
export const A8_ROUTE_MODES = ['on'] as const;

/** What a cell's request is built from: the fresh item, what its content
 *  seed handed back, and the fixture's bits a route reads. */
export type A8RouteCtx = {
  id: string;
  tag: string;
  /** The seed's arguments (a8-tool-content.ts), {} when none. */
  input: Readonly<Record<string, unknown>>;
  /** A Recall map's version (its writes name it). */
  version: number;
};

/** The request a route takes in a cell, and the guide action it is. */
export type A8RouteSpec = {
  /** The kind of the item the route names (a kind of the grid). */
  kind: string;
  /** The guide's action the route is (the oracle's answer is read by it). */
  action: GuideAction;
  /** A tool's content seed (a8-tool-content.ts A8_TOOL_CONTENT): the item
   *  gets that content, and its arguments are the ctx's input. */
  seed?: string;
  /** An /api/v1 route: called with the login's read-write API key. */
  key?: true;
  /** The path's other params, from the ctx. */
  params?: (c: A8RouteCtx) => Readonly<Record<string, string>>;
  body?: (c: A8RouteCtx) => unknown;
  /** The allowed request cannot be stood up here, why: the route runs its
   *  refused cells only, and counts in a8Exempt. */
  refusedOnly?: string;
  /** An allowed write whose change the probe cannot see, why: it passes on
   *  its success alone. */
  blind?: string;
  /** The route's handler leaves it to an Admin user, why: a member the
   *  guide would allow is refused (a narrowed deny the oracle cannot see). */
  adminOnly?: string;
  /** A query the request carries, from the ctx. */
  query?: (c: A8RouteCtx) => string;
  /** SQL run on the fresh item before the request ($1: its id), as the
   *  fixture: the content the route needs that no seed makes. */
  prepSql?: string;
};

const title = (c: A8RouteCtx) => ({ title: `${c.tag} a8 route ${c.id.slice(0, 8)}` });
const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
const card = (c: A8RouteCtx) => ({ title: 'A8 card', bodyMd: 'a8', version: c.version });
/** A tree kind's name in /api/tree/:kind (the notes tree holds the grid's
 *  folders). */
const treeKind = (ITEM_KINDS as Record<string, { tree: { kind: string } | null }>).note!.tree!.kind;

/** A copy or a move also asks a right at its destination, which the cell's
 *  roles do not each hold; the tool cells of the same function cover the
 *  destination's answers (file_copy, folder_copy, page_move). */
const DEST = 'its allowed request also asks a destination right the cells do not set per role';
/** The Recall map acts its handler leaves to the owner (an Admin user). */
const RECALL_OWNER =
  'the owner’s act in its handler: an agent or a member writes the cards instead';

/** An app run's broker answers a built app's runtime, which the fresh
 *  fixture app has none of. */
const RUNTIME = 'its allowed request needs a built app runtime the fixture app has none of';

/** Every route the cells run, by its row key. */
export const A8_ROUTE_SPECS: Readonly<Record<string, A8RouteSpec>> = {
  'PATCH /api/notes/:id': { kind: 'note', action: 'edit', body: title },
  'DELETE /api/notes/:id': { kind: 'note', action: 'delete' },
  'PATCH /api/tasks/:id': { kind: 'task', action: 'edit', body: title },
  'DELETE /api/tasks/:id': { kind: 'task', action: 'delete' },
  'PATCH /api/v1/tasks/:id': { kind: 'task', action: 'edit', key: true, body: title },
  'PATCH /api/events/:id': { kind: 'event', action: 'edit', body: title },
  'DELETE /api/events/:id': { kind: 'event', action: 'delete' },
  'PATCH /api/formulas/:id': { kind: 'formula', action: 'edit', body: title },
  'DELETE /api/formulas/:id': { kind: 'formula', action: 'delete' },
  'PATCH /api/presents/:id': { kind: 'present', action: 'edit', body: title },
  'DELETE /api/presents/:id': { kind: 'present', action: 'delete' },
  'PATCH /api/draws/:id': { kind: 'draw', action: 'edit', body: title },
  'DELETE /api/draws/:id': { kind: 'draw', action: 'delete' },
  'PUT /api/draws/:id/draft': {
    kind: 'draw',
    action: 'editDraft',
    body: () => ({ scene: { elements: [] } }),
  },
  'POST /api/draws/:id/commit': {
    kind: 'draw',
    action: 'editDraft',
    body: () => ({ scene: { elements: [] } }),
  },
  'POST /api/draws/:id/discard-draft': {
    kind: 'draw',
    action: 'editDraft',
    prepSql: `update draws set draft_scene = '{"v":1}' where node_id = $1`,
  },
  'PATCH /api/pages/:id': { kind: 'page', action: 'edit', body: title },
  'DELETE /api/pages/:id': { kind: 'page', action: 'delete' },
  'PATCH /api/v1/pages/:id': {
    kind: 'page',
    action: 'edit',
    key: true,
    body: () => ({ doc }),
    refusedOnly:
      'every page of the fixture is read by others (an open link), and a key may not change one: the oracle allows no cell',
  },
  'PUT /api/pages/:id/draft': { kind: 'page', action: 'editDraft', body: () => ({ doc }) },
  'POST /api/pages/:id/commit': { kind: 'page', action: 'editDraft', body: () => ({ doc }) },
  'POST /api/pages/:id/discard-draft': { kind: 'page', action: 'editDraft', seed: 'page_commit' },
  // A move within its home (no folder named): its home's Moderator, the
  // guide's standing of a delete.
  'POST /api/pages/:id/move': {
    kind: 'page',
    action: 'delete',
    body: () => ({ folderId: null, confirm: true }),
    refusedOnly: DEST,
  },
  'PATCH /api/tables/:id': { kind: 'table', action: 'edit', body: title },
  'DELETE /api/tables/:id': { kind: 'table', action: 'delete' },
  'PUT /api/tables/:id/draft': {
    kind: 'table',
    action: 'editDraft',
    body: () => ({ data: { sheets: [] } }),
  },
  'POST /api/tables/:id/commit': { kind: 'table', action: 'editDraft', seed: 'table_commit' },
  'POST /api/v1/tables/:id/commit': {
    kind: 'table',
    action: 'editDraft',
    seed: 'table_commit',
    key: true,
  },
  'POST /api/tables/:id/discard-draft': {
    kind: 'table',
    action: 'editDraft',
    seed: 'table_commit',
  },
  'POST /api/tables/:id/draft-ops': {
    kind: 'table',
    action: 'editDraft',
    seed: 'table_cell_set',
    body: () => ({ ops: [{ op: 'row_add' }] }),
  },
  'POST /api/tables/:id/import': {
    kind: 'table',
    action: 'edit',
    refusedOnly: 'its allowed request is a workbook upload (a form) the cells do not build',
  },
  'POST /api/tables/:id/history': {
    kind: 'table',
    action: 'edit',
    seed: 'table_snapshot_create',
    body: () => ({ note: 'a8' }),
  },
  'DELETE /api/tables/:id/history/:sid': {
    kind: 'table',
    action: 'edit',
    seed: 'table_snapshot_delete',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
  },
  'POST /api/tables/:id/history/:sid/restore': {
    kind: 'table',
    action: 'edit',
    seed: 'table_snapshot_restore',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
    body: () => ({ discardDraft: true }),
  },
  'POST /api/v1/tables/:id/rows': {
    kind: 'table',
    action: 'edit',
    seed: 'table_row_update',
    key: true,
    body: () => ({ rows: [{ Note: 'a8' }] }),
  },
  'PATCH /api/v1/tables/:id/rows/:rowId': {
    kind: 'table',
    action: 'edit',
    seed: 'table_row_update',
    key: true,
    params: (c) => ({ rowId: String(c.input.row_id) }),
    body: () => ({ cells: { Note: 'a8' } }),
  },
  'PATCH /api/recall/maps/:id': {
    kind: 'recall',
    action: 'edit',
    body: (c) => ({ title: 'A8 map', version: c.version }),
  },
  'DELETE /api/recall/maps/:id': { kind: 'recall', action: 'delete', adminOnly: RECALL_OWNER },
  'POST /api/recall/maps/:id/cards': { kind: 'recall', action: 'edit', body: card },
  'PUT /api/recall/maps/:id/cards/:card': {
    kind: 'recall',
    action: 'edit',
    params: () => ({ card: 'card' }),
    body: card,
  },
  'DELETE /api/recall/maps/:id/cards/:card': {
    kind: 'recall',
    action: 'edit',
    seed: 'recall_cards_reorder',
    params: () => ({ card: 'card' }),
    query: (c) => `version=${c.version}`,
  },
  'POST /api/recall/maps/:id/cards/:card/prompt': {
    kind: 'recall',
    action: 'edit',
    params: () => ({ card: 'card' }),
    prepSql: `update recall_nodes set use_when = 'a8' where map_id = $1 and slug = 'card'`,
    body: (c) => ({ confirm: true, version: c.version }),
    adminOnly: RECALL_OWNER,
  },
  'POST /api/recall/maps/:id/cards/reorder': {
    kind: 'recall',
    action: 'edit',
    seed: 'recall_cards_reorder',
    body: (c) => ({ slugs: c.input.slugs, version: c.version }),
    adminOnly: RECALL_OWNER,
  },
  'PATCH /api/apps/:id': { kind: 'app', action: 'edit', body: () => ({ name: 'A8 app' }) },
  'DELETE /api/apps/:id': { kind: 'app', action: 'delete' },
  'PUT /api/apps/:id/draft': {
    kind: 'app',
    action: 'editDraft',
    seed: 'app_build',
    body: () => ({ entry: 'App.tsx', files: { 'App.tsx': 'export default () => null;\n' } }),
  },
  'DELETE /api/apps/:id/draft': { kind: 'app', action: 'editDraft', seed: 'app_publish' },
  'POST /api/apps/:id/build': { kind: 'app', action: 'editDraft', seed: 'app_build' },
  'POST /api/apps/:id/format': {
    kind: 'app',
    action: 'edit',
    blind: 'it formats the text it is sent and saves nothing',
    body: () => ({ path: 'App.tsx', content: 'export default () => null;\n' }),
  },
  'POST /api/apps/:id/publish': { kind: 'app', action: 'editDraft', seed: 'app_publish' },
  'POST /api/apps/:id/snapshots': {
    kind: 'app',
    action: 'editDraft',
    seed: 'app_build',
    body: () => ({ note: 'a8' }),
  },
  'PATCH /api/apps/:id/snapshots/:sid': {
    kind: 'app',
    action: 'editDraft',
    seed: 'app_snapshot_delete',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
    body: () => ({ note: 'a8' }),
    blind: 'a snapshot’s note is not in the probe',
  },
  'DELETE /api/apps/:id/snapshots/:sid': {
    kind: 'app',
    action: 'editDraft',
    seed: 'app_snapshot_delete',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
  },
  'POST /api/apps/:id/snapshots/:sid/restore': {
    kind: 'app',
    action: 'editDraft',
    seed: 'app_snapshot_restore',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
    body: () => ({ mode: 'code' }),
  },
  'POST /api/apps/:id/opened': { kind: 'app', action: 'read' },
  'POST /api/apps/:id/duplicate': {
    kind: 'app',
    action: 'read',
    seed: 'app_build',
    body: () => ({ title: 'A8 copy' }),
  },
  'POST /api/apps/:id/frame-ticket': { kind: 'app', action: 'read', refusedOnly: RUNTIME },
  'POST /api/apps/:id/db-broker': {
    kind: 'app',
    action: 'read',
    body: () => ({ op: 'query', sql: 'select 1' }),
    refusedOnly: RUNTIME,
  },
  'POST /api/apps/:id/tool-broker': {
    kind: 'app',
    action: 'read',
    body: () => ({ slug: 'calculate', input: { expression: '1+1' } }),
    refusedOnly: RUNTIME,
  },
  'PATCH /api/files/files/:id': {
    kind: 'file',
    action: 'edit',
    seed: 'file_rename',
    body: (c) => ({ rename: `${String(c.input.new_stem)}.csv` }),
  },
  'DELETE /api/files/files/:id': { kind: 'file', action: 'delete', seed: 'file_rename' },
  'POST /api/files/files/:id': {
    kind: 'file',
    action: 'edit',
    seed: 'file_rename',
    body: () => ({ copy_to: '/' }),
    refusedOnly: DEST,
  },
  'PATCH /api/files/folders/:id': {
    kind: 'branch',
    action: 'edit',
    seed: 'folder_rename',
    body: (c) => ({ rename: String(c.input.new_name) }),
  },
  'DELETE /api/files/folders/:id': { kind: 'branch', action: 'delete', seed: 'folder_rename' },
  'POST /api/files/folders/:id': {
    kind: 'branch',
    action: 'edit',
    seed: 'folder_rename',
    body: () => ({ copy_to: '/' }),
    refusedOnly: DEST,
  },
  'PATCH /api/tree/:kind/folders/:id': {
    kind: 'branch',
    action: 'edit',
    params: () => ({ kind: treeKind }),
    body: (c) => ({ name: `a8 ${c.id.slice(0, 8)}` }),
  },
  'DELETE /api/tree/:kind/folders/:id': {
    kind: 'branch',
    action: 'delete',
    params: () => ({ kind: treeKind }),
  },
  'POST /api/tree/items/:id/opened': { kind: 'note', action: 'read' },
  'PUT /api/tree/items/:id/pin': { kind: 'note', action: 'read', body: () => ({ pinned: true }) },
};

/** A write route that names its item: its row key, its param and need. */
export type A8ItemRoute = {
  key: string;
  method: string;
  pattern: string;
  param: string;
  need: string;
};

/** The manifest entries as the cells read them (route-manifest.gen.ts). */
export type A8ManifestEntry = Readonly<{
  pattern: string;
  policy?: Readonly<Record<string, MethodPolicy>>;
}>;

/** Every write route whose declaration names its item. */
export function a8ItemRoutes(manifest: readonly A8ManifestEntry[]): A8ItemRoute[] {
  const out: A8ItemRoute[] = [];
  for (const e of manifest) {
    for (const [method, p] of Object.entries(e.policy ?? {})) {
      const it = p.item;
      if (!it || it.param === undefined || it.need === undefined) continue;
      out.push({ key: `${method} ${e.pattern}`, method, pattern: e.pattern, ...it });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One route cell. `reads`: the caller reads the item (else its refusal is a
 *  random uuid's, byte for byte). */
export type A8RouteCell = {
  /** A deny the oracle cannot see, why: the route is open to Admin users
   *  only, or its handler leaves the act to one. */
  narrowed?: string;
  key: string;
  method: string;
  pattern: string;
  role: GuideRole;
  placement: GuidePlacement;
  kind: string;
  action: GuideAction;
  want: GuideAnswer;
  reads: boolean;
};

export type A8RoutePlan = {
  cells: A8RouteCell[];
  /** The routes with an allowed cell and a refused one. */
  covered: string[];
  /** Routes that run refused cells only, each with why (a8Exempt). */
  exempt: Record<string, string>;
  /** Routes that name an item and have no cells, each with why. */
  uncovered: Record<string, string>;
  /** Specs of routes that name no item (or are gone). */
  stale: string[];
};

/** Whether the oracle allows (a not-applicable answer is never a cell). */
export const allows = (w: GuideAnswer): boolean => 'allow' in w && w.allow;

const surfaceOf = (s: A8RouteSpec): GuideSurface => (s.key ? 'api-v1' : 'web');

/** The oracle's answer of a route cell. */
export function a8RouteWant(
  spec: A8RouteSpec,
  role: GuideRole,
  placement: GuidePlacement,
): GuideAnswer {
  return expectedAccess(
    { placement, actor: 'login', surface: surfaceOf(spec) },
    role,
    spec.kind,
    spec.action,
  );
}

/** Every route's cells, from its declaration and its spec. */
export function a8RoutePlan(manifest: readonly A8ManifestEntry[]): A8RoutePlan {
  const plan: A8RoutePlan = { cells: [], covered: [], exempt: {}, uncovered: {}, stale: [] };
  const routes = a8ItemRoutes(manifest);
  const policyOf = (key: string): MethodPolicy | undefined => {
    const at = key.indexOf(' ');
    const e = manifest.find((x) => x.pattern === key.slice(at + 1));
    return e?.policy?.[key.slice(0, at)];
  };
  // Whom the route opens to beyond Admin: its own `open`, or its /api/v1
  // base's (an alias or a base runs as its base admits).
  const memberOpen = (key: string): boolean => {
    const p = policyOf(key);
    const base = p?.aliasOf ?? p?.base;
    return (base ? policyOf(base)?.open : p?.open) === 'owner';
  };
  const named = new Set(routes.map((r) => r.key));
  plan.stale = Object.keys(A8_ROUTE_SPECS).filter((k) => !named.has(k));
  for (const r of routes) {
    const spec = A8_ROUTE_SPECS[r.key];
    if (!spec) {
      plan.uncovered[r.key] = 'no spec: A8_ROUTE_SPECS names no request for it';
      continue;
    }
    const cells: A8RouteCell[] = [];
    for (const role of A8_ROUTE_ROLES) {
      for (const placement of GUIDE_PLACEMENTS) {
        let want = a8RouteWant(spec, role, placement);
        if ('na' in want) continue;
        let narrowed: string | undefined;
        if (role !== 'admin' && allows(want)) {
          if (!memberOpen(r.key)) narrowed = 'the route is open to Admin users only';
          else if (spec.adminOnly) narrowed = spec.adminOnly;
          if (narrowed) want = { allow: false, why: narrowed };
        }
        if (spec.refusedOnly && allows(want)) continue;
        const read = a8RouteWant({ ...spec, action: 'read' }, role, placement);
        cells.push({
          ...(narrowed ? { narrowed } : {}),
          key: r.key,
          method: r.method,
          pattern: r.pattern,
          role,
          placement,
          kind: spec.kind,
          action: spec.action,
          want,
          reads: allows(read),
        });
      }
    }
    plan.cells.push(...cells);
    const allowed = cells.some((c) => allows(c.want));
    const refused = cells.some((c) => !allows(c.want));
    if (spec.refusedOnly) {
      if (refused) plan.exempt[r.key] = spec.refusedOnly;
      else plan.uncovered[r.key] = `refused only (${spec.refusedOnly}), and no refused cell`;
    } else if (allowed && refused) {
      plan.covered.push(r.key);
    } else {
      plan.uncovered[r.key] = allowed ? 'no refused cell' : 'no allowed cell';
    }
  }
  return plan;
}

/** A route cell's name: `route:<METHOD pattern> <role> <placement>`. */
export const a8RouteCellName = (c: A8RouteCell) => `route:${c.key} ${c.role} ${c.placement}`;

/** The path of a cell's request: the item's id in its param, the spec's
 *  other params, an id in place of the item's for the random uuid's. */
export function a8RoutePath(
  route: Pick<A8ItemRoute, 'pattern' | 'param'>,
  spec: A8RouteSpec,
  c: A8RouteCtx,
  id = c.id,
): string {
  const params: Record<string, string> = { ...(spec.params?.(c) ?? {}), [route.param]: id };
  const p = route.pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`a8RoutePath: ${route.pattern} needs :${name}`);
    return encodeURIComponent(v);
  });
  const q = spec.query?.(c);
  return q ? `${p}?${q}` : p;
}

/** What a route answered, and what the probes saw around it. */
export type A8RouteOutcome = { status: number; text: string };

/** A crash, never a refusal (the tool cells' list): a raw database or
 *  runtime text in a reply. */
export type A8RouteJudge = {
  cell: A8RouteCell;
  spec: A8RouteSpec;
  out: A8RouteOutcome;
  /** The item's row (a8_probe: 'gone' once deleted) and its content, and
   *  the count of the brain's nodes, before and after. */
  before: { row: string; content: string; nodes: number };
  after: { row: string; content: string; nodes: number };
  /** The same request on a random uuid, for a caller that does not read
   *  the item. */
  random: { out: A8RouteOutcome; id: string } | null;
  itemId: string;
  generic: RegExp;
};

const normal = (text: string, id: string) => text.split(id).join('<id>');

/** Judge one route cell: null when it passes, else why it fails. */
export function judgeA8RouteCell(a: A8RouteJudge): string | null {
  const { cell, spec, out, before, after, random } = a;
  const allowed = allows(cell.want);
  const changed =
    before.row !== after.row || before.content !== after.content || before.nodes !== after.nodes;
  const ok = out.status >= 200 && out.status < 300;
  const crash = out.status >= 500 || a.generic.test(out.text);
  if (!allowed && changed)
    return `changed, the oracle denies (${out.status} ${out.text.slice(0, 100)})`;
  if (crash) return `a crash, not a refusal: ${out.status} ${out.text.slice(0, 160)}`;
  if (allowed) {
    if (!ok) return `refused, the oracle allows: ${out.status} ${out.text.slice(0, 160)}`;
    if (cell.action === 'delete' && after.row !== 'gone') return 'answered ok, not deleted';
    if ((cell.action === 'edit' || cell.action === 'editDraft') && !changed && !spec.blind) {
      return 'answered ok, nothing changed';
    }
    return null;
  }
  if (ok)
    return `answered ${out.status}, the oracle denies (${'why' in cell.want ? cell.want.why : ''})`;
  if (out.status !== 403 && out.status !== 404) {
    return `refused with ${out.status}, not 403 or 404: ${out.text.slice(0, 100)}`;
  }
  // A caller that does not read the item gets a random uuid's answer.
  if (random) {
    const r = random.out;
    if (r.status !== out.status || normal(r.text, random.id) !== normal(out.text, a.itemId)) {
      return `not a random uuid's answer: ${out.status} ${out.text.slice(0, 100)} | ${r.status} ${r.text.slice(0, 100)}`;
    }
  }
  return null;
}
