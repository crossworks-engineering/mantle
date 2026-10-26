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
 * cell on a fresh item, in the checks' warn and on (plan rule 5). A route
 * open to Admin users only also runs as an Admin user with Write on the
 * item and no Moderator seat of its home (adminWriteGrant), where edit and
 * manage part. A cell passes on the oracle's answer: allowed is the route's
 * success; refused is a 403 or a 404 that changes no row and makes no node,
 * and, for a caller that does not read the item, the answer a random uuid
 * gets (status, body with the id aside, content type and cache control).
 * In warn the edit check only reports: a route whose edit is one statement
 * (the database's check alone, `warnMade`) makes the edit of a login that
 * reads the item and may not edit it, and logs it as an actor miss; every
 * other refusal holds in warn too. A route is covered only with an allowed
 * cell and a refused one; a route whose allowed request the cells cannot
 * stand up runs its refused cells (refusedOnly, with why) and counts in
 * a8Exempt.
 *
 * The declaration states intent only: no gate reads it (route-policy.ts
 * buildRouteRow). Each route's declared need is the one its cells ask
 * (a8NeedOf: the guide action's right), checked here with no database. A
 * write that declares `none` names no item in its path, or one that is no
 * workspace item (each its reason in its route file): it is outside this
 * set. One whose path still names an item says its `param`: it runs cells
 * by the guide action it is (a grant change), or counts in a8Exempt with
 * its reason, as a tool that declares none. The cells run through the full
 * HTTP pipeline (runRoute) in a8-route-cells.matrix.test.ts; the coverage
 * test (a8-coverage.test.ts) counts what no cell covers. This module is
 * pure: no database, no app.
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
import type { ITEM_NEEDS, MethodPolicy } from '../../lib/auth/route-declaration';

type ItemNeed = (typeof ITEM_NEEDS)[number];

/** The roles the route cells run as (plan v3.2 section 5 item 3; the owner
 *  is an Admin user, the admin role stands for every one). */
export const A8_ROUTE_ROLES: readonly GuideRole[] = [
  'outsider',
  'readGrant',
  'writeGrant',
  'homeModerator',
  'admin',
];

/** An Admin user who is a user of W (Write on) and no Moderator of the
 *  item's home: edit and manage part for it (guide-oracle.ts SEATS
 *  adminWriteGrant). It runs the routes open to Admin users only, where the
 *  plan's Admin user (a Moderator of Admin) holds both or neither. */
export const A8_ADMIN_WRITE_GRANT = 'adminWriteGrant' as const;
/** The placements where it reads the item through W's grant. */
const ADMIN_WRITE_GRANT_PLACEMENTS: readonly GuidePlacement[] = ['folder', 'root'];

/** Who a route cell runs as. */
export type A8RouteRole = GuideRole | typeof A8_ADMIN_WRITE_GRANT;

/** The check modes the route cells run in (plan rule 5): warn, where the
 *  edit check reports a write it would refuse (a box below on is an
 *  emergency, migration 0301's floor), and on, as every fleet box. */
export const A8_ROUTE_MODES = ['warn', 'on'] as const;
export type A8RouteMode = (typeof A8_ROUTE_MODES)[number];

/** What a cell's request is built from: the fresh item, what its content
 *  seed handed back, and the fixture's bits a route reads. */
export type A8RouteCtx = {
  id: string;
  tag: string;
  /** The seed's arguments (a8-tool-content.ts), {} when none. */
  input: Readonly<Record<string, unknown>>;
  /** A Recall map's version (its writes name it). */
  version: number;
  /** The fixture's workspaces (a grant names one). */
  ws: Readonly<Record<'admin' | 'H' | 'W' | 'R' | 'T' | 'O', string>>;
  /** The folder the item sits in (its kind's folder F), null at its root. */
  folderId: string | null;
};

/** A route's request that asks a higher right than the route declares (a
 *  code restore on a route whose data restore asks edit): its own cells. */
export type A8RouteHigher = {
  /** Why the route takes it. */
  why: string;
  action: GuideAction;
  seed?: string;
  params?: (c: A8RouteCtx) => Readonly<Record<string, string>>;
  body?: (c: A8RouteCtx) => unknown;
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
  /** A raw body (a form upload) in place of a JSON one. */
  raw?: (c: A8RouteCtx) => { body: string; type: string };
  /** An allowed request answers 2xx and leaves the item as it is (a move
   *  into the folder it is in): no change is asked of it. */
  stays?: string;
  /** An allowed request answers this status, with why: the right passed,
   *  and what follows needs content the cells do not make. */
  allowedStatus?: { status: number; why: string };
  /** The request that asks the higher right of the route, its own cells. */
  higher?: A8RouteHigher;
  /** In warn, the edit of a login that reads the item and may not edit it
   *  is made and logged as an actor miss: the route's edit is one
   *  statement, the database's check alone (docs/edit-check.md, "The
   *  routes the database alone checks"). */
  warnMade?: true;
};

const title = (c: A8RouteCtx) => ({ title: `${c.tag} a8 route ${c.id.slice(0, 8)}` });
const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
const card = (c: A8RouteCtx) => ({ title: 'A8 card', bodyMd: 'a8', version: c.version });
/** A tree kind's name in /api/tree/:kind (the notes tree holds the grid's
 *  folders). */
const treeKind = (ITEM_KINDS as Record<string, { tree: { kind: string } | null }>).note!.tree!.kind;

/** A file's or a folder's copy: open to Admin users only, and its allowed
 *  request also asks a right at its destination. */
const COPY =
  'open to Admin users only; the allowed copy is pinned over HTTP by precheck-removal-http.db.test.ts (files and tree folders, copy), and the destination answers by the file_copy and folder_copy tool cells';
/** The Recall map acts its handler leaves to the owner (an Admin user). */
const RECALL_OWNER =
  'the owner’s act in its handler: an agent or a member writes the cards instead';

/** An app run's broker answers a built app's runtime, which the fresh
 *  fixture app has none of. */
const RUNTIME =
  'its allowed request needs a built app runtime the fixture app lacks; the refused cells run the read ask, and the app tool cells cover the allowed side';

/** A one-sheet CSV upload, as a table's import reads it. */
const csvUpload = (c: A8RouteCtx) => {
  const b = `a8${c.id.slice(0, 8)}`;
  return {
    type: `multipart/form-data; boundary=${b}`,
    body: [
      `--${b}`,
      'Content-Disposition: form-data; name="file"; filename="a8.csv"',
      'Content-Type: text/csv',
      '',
      `A,B\n${c.id.slice(0, 8)},2`,
      `--${b}--`,
      '',
    ].join('\r\n'),
  };
};

/** Every route the cells run, by its row key. */
export const A8_ROUTE_SPECS: Readonly<Record<string, A8RouteSpec>> = {
  'PATCH /api/notes/:id': { kind: 'note', action: 'edit', body: title, warnMade: true },
  'DELETE /api/notes/:id': { kind: 'note', action: 'delete' },
  'PATCH /api/tasks/:id': { kind: 'task', action: 'edit', body: title, warnMade: true },
  'DELETE /api/tasks/:id': { kind: 'task', action: 'delete' },
  'PATCH /api/v1/tasks/:id': {
    kind: 'task',
    action: 'edit',
    key: true,
    body: title,
    warnMade: true,
  },
  'PATCH /api/events/:id': { kind: 'event', action: 'edit', body: title, warnMade: true },
  'DELETE /api/events/:id': { kind: 'event', action: 'delete' },
  'PATCH /api/formulas/:id': { kind: 'formula', action: 'edit', body: title, warnMade: true },
  'DELETE /api/formulas/:id': { kind: 'formula', action: 'delete' },
  'PATCH /api/presents/:id': { kind: 'present', action: 'edit', body: title, warnMade: true },
  'DELETE /api/presents/:id': { kind: 'present', action: 'delete' },
  'PATCH /api/draws/:id': { kind: 'draw', action: 'edit', body: title, warnMade: true },
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
  'PATCH /api/pages/:id': { kind: 'page', action: 'edit', body: title, warnMade: true },
  'DELETE /api/pages/:id': { kind: 'page', action: 'delete' },
  'PATCH /api/v1/pages/:id': {
    kind: 'page',
    action: 'edit',
    key: true,
    body: () => ({ doc }),
    refusedOnly:
      'the guide oracle denies a key’s edit of a page others read (KEY_SHARED_CONTENT), and every fixture page but the snapshot copy has an open link, so there is no allowed cell; the refused cells run (a placement with no link is a follow-up)',
  },
  'PUT /api/pages/:id/draft': { kind: 'page', action: 'editDraft', body: () => ({ doc }) },
  'POST /api/pages/:id/commit': { kind: 'page', action: 'editDraft', body: () => ({ doc }) },
  'POST /api/pages/:id/discard-draft': { kind: 'page', action: 'editDraft', seed: 'page_commit' },
  // A move within its home, into the folder it is in (its root at the
  // root): its home's Moderator, the guide's standing of a delete. A move to
  // another home is the page_move tool cells'.
  'POST /api/pages/:id/move': {
    kind: 'page',
    action: 'delete',
    body: (c) => ({ folderId: c.folderId, confirm: true }),
    stays: 'a move into the folder it is in',
  },
  'PATCH /api/tables/:id': { kind: 'table', action: 'edit', body: title, warnMade: true },
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
  'POST /api/tables/:id/import': { kind: 'table', action: 'edit', raw: csvUpload },
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
    action: 'edit',
    seed: 'app_build',
    body: () => ({ note: 'a8' }),
  },
  'PATCH /api/apps/:id/snapshots/:sid': {
    kind: 'app',
    action: 'edit',
    seed: 'app_snapshot_delete',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
    body: () => ({ note: 'a8' }),
    blind: 'a snapshot’s note is not in the probe',
  },
  'DELETE /api/apps/:id/snapshots/:sid': {
    kind: 'app',
    action: 'edit',
    seed: 'app_snapshot_delete',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
  },
  // A data restore asks edit, a code restore manage (restoreAppSnapshot):
  // the route declares edit, its lowest, and the code restore runs as its
  // higher cells.
  'POST /api/apps/:id/snapshots/:sid/restore': {
    kind: 'app',
    action: 'edit',
    seed: 'app_snapshot_restore',
    params: (c) => ({ sid: String(c.input.snapshot_id) }),
    body: () => ({ mode: 'data' }),
    allowedStatus: {
      status: 409,
      why: 'the snapshot holds no data (the fixture app has no database): the 409 no-data comes after the edit check',
    },
    higher: {
      why: 'a code restore asks manage (an app’s code is its home Moderator’s)',
      action: 'editDraft',
      seed: 'app_snapshot_restore',
      params: (c) => ({ sid: String(c.input.snapshot_id) }),
      body: () => ({ mode: 'code' }),
    },
  },
  'POST /api/apps/:id/opened': { kind: 'app', action: 'read' },
  'POST /api/apps/:id/duplicate': {
    kind: 'app',
    action: 'read',
    seed: 'app_build',
    body: () => ({ title: 'A8 copy' }),
  },
  // A published build (an Admin user runs the draft's or the published
  // one; a member the published one).
  'POST /api/apps/:id/frame-ticket': { kind: 'app', action: 'read', seed: 'app_data_write' },
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
    refusedOnly: COPY,
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
    refusedOnly: COPY,
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
  // The grant changes (each declares none: its rule asks two workspaces,
  // and the guide action it is decides the cell): add T, switch Write on
  // for R, remove R.
  'POST /api/grants/:nodeId': {
    kind: 'note',
    action: 'grantAdd',
    body: (c) => ({ wsId: c.ws.T, confirm: true }),
  },
  'PATCH /api/grants/:nodeId/:wsId': {
    kind: 'note',
    action: 'writeSwitch',
    params: (c) => ({ wsId: c.ws.R }),
    body: () => ({ write: true, confirm: true }),
  },
  'DELETE /api/grants/:nodeId/:wsId': {
    kind: 'note',
    action: 'grantRemove',
    params: (c) => ({ wsId: c.ws.R }),
    query: () => 'confirm=1',
  },
};

/** A write route that names its item: its row key, its param, and its need
 *  (none: a write whose path names an item no one right decides, with its
 *  reason). */
export type A8ItemRoute = {
  key: string;
  method: string;
  pattern: string;
  param: string;
  need?: ItemNeed;
  none?: string;
};

/** The manifest entries as the cells read them (route-manifest.gen.ts). */
export type A8ManifestEntry = Readonly<{
  pattern: string;
  policy?: Readonly<Record<string, MethodPolicy>>;
}>;

/** Every write route whose declaration names its item in its path. */
export function a8ItemRoutes(manifest: readonly A8ManifestEntry[]): A8ItemRoute[] {
  const out: A8ItemRoute[] = [];
  for (const e of manifest) {
    for (const [method, p] of Object.entries(e.policy ?? {})) {
      const it = p.item;
      if (!it || it.param === undefined) continue;
      const key = `${method} ${e.pattern}`;
      out.push(
        it.need !== undefined
          ? { key, method, pattern: e.pattern, param: it.param, need: it.need }
          : { key, method, pattern: e.pattern, param: it.param, none: it.none },
      );
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The right a guide action asks of the item, as a route declares it: an
 *  app's code is its home Moderator's (manage); a grant change asks no one
 *  right (null: its route declares none). */
export function a8NeedOf(kind: string, action: GuideAction): ItemNeed | null {
  switch (action) {
    case 'read':
      return 'read';
    case 'edit':
    case 'appData':
    case 'link':
      return 'edit';
    case 'editDraft':
      return kind === 'app' ? 'manage' : 'edit';
    case 'delete':
    case 'move':
      return 'manage';
    default:
      return null;
  }
}

const NEED_RANK: Readonly<Record<ItemNeed, number>> = { read: 0, edit: 1, manage: 2 };

/** One route cell. `reads`: the caller reads the item (else its refusal is a
 *  random uuid's, byte for byte). */
export type A8RouteCell = {
  /** A deny the oracle cannot see, why: the route is open to Admin users
   *  only, or its handler leaves the act to one. */
  narrowed?: string;
  /** The request that asks the route's higher right (its spec's `higher`). */
  higher?: true;
  key: string;
  method: string;
  pattern: string;
  role: A8RouteRole;
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
  /** Routes that run refused cells only, and routes that declare none and
   *  name an item with no cells, each with why (a8Exempt). */
  exempt: Record<string, string>;
  /** Routes that name an item and have no cells, each with why. */
  uncovered: Record<string, string>;
  /** Routes whose declared need is not the one their cells ask, why. */
  mismatched: Record<string, string>;
  /** Specs of routes that name no item (or are gone). */
  stale: string[];
};

/** The grid roles that are Admin users (the owner is one too). */
const ADMIN_USERS: ReadonlySet<A8RouteRole> = new Set(['owner', 'admin', A8_ADMIN_WRITE_GRANT]);

/** Whether the oracle allows (a not-applicable answer is never a cell). */
export const allows = (w: GuideAnswer): boolean => 'allow' in w && w.allow;

const surfaceOf = (s: Pick<A8RouteSpec, 'key'>): GuideSurface => (s.key ? 'api-v1' : 'web');

/** The oracle's answer of a route cell. adminWriteGrant is a seat role of
 *  the guide (guideStanding reads it); expectedAccess types the grid's
 *  roles only, so it is passed through. */
export function a8RouteWant(
  spec: Pick<A8RouteSpec, 'kind' | 'action' | 'key'>,
  role: A8RouteRole,
  placement: GuidePlacement,
): GuideAnswer {
  return expectedAccess(
    { placement, actor: 'login', surface: surfaceOf(spec) },
    role as GuideRole,
    spec.kind,
    spec.action,
  );
}

/** A cell's spec: the route's, or its higher request's over it. */
export function a8CellSpec(cell: Pick<A8RouteCell, 'key' | 'higher'>): A8RouteSpec {
  const spec = A8_ROUTE_SPECS[cell.key]!;
  if (!cell.higher || !spec.higher) return spec;
  const { why: _why, ...h } = spec.higher;
  const { allowedStatus: _a, higher: _h, ...base } = spec;
  return { ...base, body: undefined, ...h };
}

/** Every route's cells, from its declaration and its spec. */
export function a8RoutePlan(manifest: readonly A8ManifestEntry[]): A8RoutePlan {
  const plan: A8RoutePlan = {
    cells: [],
    covered: [],
    exempt: {},
    uncovered: {},
    mismatched: {},
    stale: [],
  };
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
    const open = base ? policyOf(base)?.open : p?.open;
    return open === 'owner' || open === 'any';
  };
  const named = new Set(routes.map((r) => r.key));
  plan.stale = Object.keys(A8_ROUTE_SPECS).filter((k) => !named.has(k));
  for (const r of routes) {
    const spec = A8_ROUTE_SPECS[r.key];
    if (!spec) {
      // A route that declares none and names an item counts as a tool that
      // declares none: exempt, by its reason.
      if (r.none !== undefined) plan.exempt[r.key] = `none: ${r.none}`;
      else plan.uncovered[r.key] = 'no spec: A8_ROUTE_SPECS names no request for it';
      continue;
    }
    // The need the route declares is the one its cells ask.
    const asked = a8NeedOf(spec.kind, spec.action);
    if (r.need !== undefined && asked !== r.need) {
      plan.mismatched[r.key] = `declares ${r.need}, its cells ask ${spec.action} (${asked})`;
    }
    if (r.none !== undefined && asked !== null) {
      plan.mismatched[r.key] = `declares none, its cells ask ${spec.action}: declare ${asked}`;
    }
    if (spec.higher) {
      const higher = a8NeedOf(spec.kind, spec.higher.action);
      if (r.need === undefined || higher === null || NEED_RANK[higher] <= NEED_RANK[r.need]) {
        plan.mismatched[r.key] =
          `its higher request asks ${spec.higher.action}, no right above ${r.need ?? 'none'}`;
      }
    }
    const open = memberOpen(r.key);
    const roles: A8RouteRole[] = [...A8_ROUTE_ROLES, ...(open ? [] : [A8_ADMIN_WRITE_GRANT])];
    const cells: A8RouteCell[] = [];
    for (const higher of spec.higher ? [false, true] : [false]) {
      const action = higher ? spec.higher!.action : spec.action;
      for (const role of roles) {
        for (const placement of GUIDE_PLACEMENTS) {
          if (role === A8_ADMIN_WRITE_GRANT && !ADMIN_WRITE_GRANT_PLACEMENTS.includes(placement)) {
            continue;
          }
          let want = a8RouteWant({ ...spec, action }, role, placement);
          if ('na' in want) continue;
          let narrowed: string | undefined;
          if (!ADMIN_USERS.has(role) && allows(want)) {
            if (!open) narrowed = 'the route is open to Admin users only';
            else if (spec.adminOnly) narrowed = spec.adminOnly;
            if (narrowed) want = { allow: false, why: narrowed };
          }
          if (spec.refusedOnly && allows(want)) continue;
          const read = a8RouteWant({ ...spec, action: 'read' }, role, placement);
          cells.push({
            ...(narrowed ? { narrowed } : {}),
            ...(higher ? { higher: true as const } : {}),
            key: r.key,
            method: r.method,
            pattern: r.pattern,
            role,
            placement,
            kind: spec.kind,
            action,
            want,
            reads: allows(read),
          });
        }
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
    // Where edit and manage part (an edit route that a Moderator alone may
    // not be told from), a cell allows the one and refuses the other.
    if (spec.higher) {
      const parts = (h: boolean) => cells.filter((c) => !!c.higher === h);
      const tells = parts(false).some(
        (c) =>
          allows(c.want) &&
          parts(true).some(
            (d) => d.role === c.role && d.placement === c.placement && !allows(d.want),
          ),
      );
      if (!tells) plan.uncovered[r.key] = 'no cell where its right and its higher right part';
    }
  }
  return plan;
}

/** A route cell's name: `route:<METHOD pattern>[ (higher)] <role> <placement>`. */
export const a8RouteCellName = (c: A8RouteCell) =>
  `route:${c.key}${c.higher ? ' (higher)' : ''} ${c.role} ${c.placement}`;

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

/** What a route answered: its status, body, and the two headers a hidden
 *  item's answer must share with a random uuid's. */
export type A8RouteOutcome = {
  status: number;
  text: string;
  contentType: string | null;
  cacheControl: string | null;
};

/** A crash, never a refusal (the tool cells' list): a raw database or
 *  runtime text in a reply. */
export type A8RouteJudge = {
  cell: A8RouteCell;
  spec: A8RouteSpec;
  mode: A8RouteMode;
  out: A8RouteOutcome;
  /** The actor misses the request logged. */
  misses: number;
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

/** Whether a refused cell's write is made in warn: the route's edit is the
 *  database's check alone (warnMade), the caller reads the item and may
 *  not edit it, and nothing else refuses it (an Admin-only narrowing, a
 *  snapshot copy's triggers, which hold in every mode). */
export function a8WarnMade(cell: A8RouteCell, spec: A8RouteSpec, mode: A8RouteMode): boolean {
  return (
    mode === 'warn' &&
    !!spec.warnMade &&
    !allows(cell.want) &&
    cell.reads &&
    !cell.narrowed &&
    cell.placement !== 'snapshot' &&
    (cell.action === 'edit' || cell.action === 'editDraft')
  );
}

/** Judge one route cell: null when it passes, else why it fails. */
export function judgeA8RouteCell(a: A8RouteJudge): string | null {
  const { cell, spec, out, before, after, random } = a;
  const allowed = allows(cell.want);
  const changed =
    before.row !== after.row || before.content !== after.content || before.nodes !== after.nodes;
  const ok = out.status >= 200 && out.status < 300;
  const crash = out.status >= 500 || a.generic.test(out.text);
  if (a8WarnMade(cell, spec, a.mode)) {
    // warn: the edit the database refuses in on is made, and reported.
    if (crash) return `a crash, not a warned write: ${out.status} ${out.text.slice(0, 160)}`;
    if (!ok)
      return `warn: refused, the edit check only reports: ${out.status} ${out.text.slice(0, 160)}`;
    if (!changed) return 'warn: answered ok, nothing changed';
    if (!a.misses) return 'warn: the write was made and logged no actor miss';
    return null;
  }
  if (a.misses) return `${a.misses} actor miss(es)`;
  if (!allowed && changed)
    return `changed, the oracle denies (${out.status} ${out.text.slice(0, 100)})`;
  if (crash) return `a crash, not a refusal: ${out.status} ${out.text.slice(0, 160)}`;
  if (allowed) {
    if (spec.allowedStatus) {
      if (out.status !== spec.allowedStatus.status) {
        return `the oracle allows (${spec.allowedStatus.why}): ${out.status} ${out.text.slice(0, 160)}`;
      }
      return null;
    }
    if (!ok) return `refused, the oracle allows: ${out.status} ${out.text.slice(0, 160)}`;
    if (spec.stays) return changed ? `answered ok and changed (${spec.stays})` : null;
    if (cell.action === 'delete' && after.row !== 'gone') return 'answered ok, not deleted';
    const writes = !['read', 'list', 'search'].includes(cell.action);
    if (writes && !changed && !spec.blind) return 'answered ok, nothing changed';
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
    const same =
      r.status === out.status &&
      normal(r.text, random.id) === normal(out.text, a.itemId) &&
      r.contentType === out.contentType &&
      r.cacheControl === out.cacheControl;
    if (!same) {
      return (
        `not a random uuid's answer: ${out.status} ${out.contentType} ${out.cacheControl} ` +
        `${out.text.slice(0, 100)} | ${r.status} ${r.contentType} ${r.cacheControl} ${r.text.slice(0, 100)}`
      );
    }
  }
  return null;
}
