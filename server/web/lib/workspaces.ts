/**
 * Workspace management (workspaces plan page 4887b8e7, phase W5a; sections
 * 1.1, 1.4, 2.4, 15, R7, S1, 18.8, 18.13 Q3, 21.8, 21.9; Q1 reversed by the
 * owner decision of 2026-10-13, migration 0286).
 *
 * Users are flat. Every permission is set on a workspace: its users, each
 * user's Moderator tick, and its resources (one assistant, connectors with a
 * Write tick). From W5b an item's Grant Access panel is the second and last
 * place. Nothing here changes who reads what: no read path reads a row this
 * module writes in a way it did not before (memberships and resources were
 * already the truth for workspace turns and connectors since W4).
 *
 * Who may do what:
 *  - An Admin user (a user of the Admin workspace) holds the Admin areas
 *    (requireArea; every area today, per-user switches later). With 'users'
 *    they see every workspace and manage its users, name, look and contact; with
 *    'assistants' its assistant; with 'connectors' its connectors. They may
 *    add anyone anywhere, themselves included, private workspaces too (S1,
 *    which replaces 17 R7): logged (subject.self) and shown on the screen as
 *    "Added by NAME on DATE".
 *  - A Moderator of a workspace manages its users (add by search, remove a
 *    plain user) and its name, description and look (colour and icon, task
 *    5edc9149: the same rule as the name).
 *  - Only an Admin user ticks or clears Moderator (mayPromote: setModerator,
 *    an add with the tick, and removing a Moderator, owner answer Q2), on
 *    every workspace (owner decision
 *    2026-10-13). Nobody becomes a Moderator by themselves, with one
 *    exception: any login may make a workspace, and becomes its only user
 *    and a Moderator. Any login may leave one, except as its last Moderator.
 *  - The only built-in workspace is Admin: it keeps its name, cannot be
 *    archived and keeps a Moderator. Team is a workspace like any other
 *    since 0286 (renamed, archived and moderated by the same rules).
 *
 * A user of the Admin workspace IS an admin login until W5c (adding one or
 * removing one is the same role change the Users screen makes, through
 * applyLoginChange, which keeps the Admin row in step with the role).
 * Connectors are attached here only: since W5b2 (0261) no level attaches
 * one.
 *
 * Every refusal is a WsError: `{ error, code }` with its status. A workspace
 * or login the caller may not see is 404, never 403. Every change writes a
 * workspace_events row; an admin login's write also the generic api.write
 * audit row, and a change of who is an Admin user the user.update row the
 * Users screen writes.
 */
import { NextResponse } from '@/server/http-compat';
import {
  db,
  sql,
  isUniqueViolation,
  isCheckViolation,
  pgConstraint,
  withDeadlockRetry,
  withHeads,
  lockMoreHeads,
} from '@mantle/db';
import type { AppTint } from '@mantle/client-types/app-nav';
import type {
  ShellWorkspaces,
  Workspace,
  WorkspaceArchivePreview,
  WorkspaceArea,
  WorkspaceDetailResponse,
  WorkspaceErrorCode,
  WorkspaceResource,
  WorkspaceResourceKind,
  WorkspaceUser,
  WorkspaceUserSearchHit,
  WorkspaceLandingApp,
} from '@mantle/client-types';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';
import { workspaceHeldApp } from '@mantle/content';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';
import type { AnyLogin, SessionUser } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { applyLoginChange, loadLoginTarget } from '@/lib/login-update';
import { rateLimit } from '@/lib/rate-limit';
import { lookOfRow, WS_LOOK_COLUMNS, type LookRow } from '@/lib/workspace-look';
import { readJson } from '@/lib/read-body';
import { defineDomainError } from '@mantle/std';

// ── Errors and the caller ────────────────────────────────────────────────────

export class WsError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WsError';
  }
}

// What the workspace routes answered by hand (wsRoute, A10 part 2 fix round
// 1, L7): its status and `{ error, code }`.
defineDomainError(WsError, {
  reason: 'a workspace request the caller can fix or may not make; the code says which',
  status: (e) => e.status,
  body: (e) => ({ error: e.message, code: e.code }),
});

const NOT_FOUND = () => new WsError(404, 'not_found', 'Workspace not found.');

/** Who calls: any login. `user` is the admin session (anchor id + actor),
 *  needed for a role change; null for a member. */
export type WsCaller = {
  kind: 'admin' | 'member';
  loginId: string;
  anchorId: string;
  user: SessionUser | null;
};

/**
 * The caller lib/workspaces.ts and lib/grants.ts take, projected from the
 * login the pipeline answered (A4 hand batch A): the route handler reads
 * it first (loginCaller()) and passes it in. No guard and no effect: the
 * gate's any-login answer step resolved the login, entered its scope (an
 * Admin user's write: the system pool) and wrote the api.write row.
 */
export function workspaceCaller(login: AnyLogin): WsCaller {
  return login.kind === 'admin'
    ? { kind: 'admin', loginId: login.loginId, anchorId: login.user.id, user: login.user }
    : { kind: 'member', loginId: login.loginId, anchorId: login.member.anchorId, user: null };
}

/** Run a workspace route for the login the handler read (loginCaller()):
 *  answer the result as JSON. A WsError answers `{ error, code }` by its
 *  row in the one table (A10 part 2 fix round 1, L7); anything else is the
 *  opaque 500. */
export async function wsRoute(
  login: AnyLogin,
  fn: (caller: WsCaller) => Promise<unknown>,
  okStatus = 200,
): Promise<Response> {
  const caller = workspaceCaller(login);
  // The rule is in this library's own SQL on the system pool: it leaves
  // the request scope the gate entered by name (W6a), at the one exit
  // site (lib/auth/rule-in-query.ts).
  const out = await inRuleInQuery(() => fn(caller));
  return NextResponse.json(out, { status: okStatus });
}

/** A body parsed by a zod schema, or a 400. */
export async function wsBody<T>(
  req: Request,
  schema: {
    safeParse(v: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: ReadonlyArray<{ message?: string; path?: ReadonlyArray<PropertyKey> }> };
        };
  },
): Promise<T> {
  const parsed = schema.safeParse(await readJson(req, { empty: undefined }));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.filter((p) => typeof p !== 'symbol').join('.');
    const msg = issue?.message ?? 'invalid input';
    throw new WsError(400, 'invalid', where ? `${where}: ${msg}` : msg);
  }
  return parsed.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a uuid names nothing: 404 (the database would
 *  refuse the cast). */
export function wsId(id: string): string {
  if (!UUID_RE.test(id)) throw NOT_FOUND();
  return id.toLowerCase();
}

type Exec = { execute: (typeof db)['execute'] };
/** A transaction that also builds queries (the landing check reads with it). */
type QueryTx = Exec & Pick<typeof db, 'select'>;

async function rows<T>(q: Exec, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await q.execute(query)) as unknown as T[];
}

// ── Areas (plan 1.4) ─────────────────────────────────────────────────────────

type AdminInfo = {
  /** The brain has an Admin workspace (the workspaces migration ran). */
  migrated: boolean;
  adminWsId: string | null;
  /** The caller is a user of the Admin workspace. */
  member: boolean;
  limits: Record<string, unknown>;
};

async function adminInfo(caller: WsCaller, q: Exec = db): Promise<AdminInfo> {
  const [r] = await rows<{ id: string; member: boolean; limits: Record<string, unknown> | null }>(
    q,
    sql`select w.id, u.login_id is not null as member, u.limits
          from workspaces w
          left join workspace_users u on u.workspace_id = w.id and u.login_id = ${caller.loginId}
         where w.owner_id = ${caller.anchorId} and w.is_admin
         limit 1`,
  );
  if (!r) return { migrated: false, adminWsId: null, member: false, limits: {} };
  return { migrated: true, adminWsId: r.id, member: r.member, limits: r.limits ?? {} };
}

function areasOf(info: AdminInfo, caller: WsCaller): WorkspaceArea[] {
  // A brain the migration skipped keeps today's rule: an admin login.
  if (!info.migrated) return caller.kind === 'admin' ? [...WORKSPACE_AREAS] : [];
  if (!info.member) return [];
  return areasFromLimits(info.limits);
}

/** The areas an Admin workspace user holds by its limits: every area unless
 *  limits.areas switches it off with false or "false", the same rule as SQL
 *  (mantle_scope_has_area reads ->> 'false' for both; W5b1 audit L5). */
export function areasFromLimits(limits: Record<string, unknown>): WorkspaceArea[] {
  const off = (limits.areas ?? {}) as Record<string, unknown>;
  return WORKSPACE_AREAS.filter((a) => off[a] !== false && off[a] !== 'false');
}

/** The Admin areas the caller holds (plan 1.4): every area for a user of
 *  the Admin workspace unless its limits switch one off, none for anyone
 *  else. The ONE reader of workspace_users.limits in TypeScript; code that
 *  runs in a user scope asks scopeHasArea, whose SQL (mantle_scope_has_area,
 *  0256) is the same rule. */
export async function areasFor(caller: WsCaller): Promise<WorkspaceArea[]> {
  return areasOf(await adminInfo(caller), caller);
}

/** requireArea (plan 1.4): whether the caller holds `area`. */
export async function requireArea(caller: WsCaller, area: WorkspaceArea): Promise<boolean> {
  return (await areasFor(caller)).includes(area);
}

// ── Reading ──────────────────────────────────────────────────────────────────

type WsRow = LookRow & {
  id: string;
  name: string;
  description: string;
  contact_id: string | null;
  is_admin: boolean;
  landing_app_id: string | null;
  archived_at: string | Date | null;
  user_count: number;
  resource_count: number;
  me_member: boolean;
  me_moderator: boolean;
  agent_id: string | null;
  agent_name: string | null;
};

function wsSelect(caller: WsCaller, where: ReturnType<typeof sql>, lock = false) {
  return sql`
    select w.id, w.name, w.description, w.contact_id, w.is_admin,
           w.landing_app_id, w.archived_at, ${WS_LOOK_COLUMNS},
           (select count(*)::int from workspace_users u where u.workspace_id = w.id) as user_count,
           (select count(*)::int from workspace_resources r where r.workspace_id = w.id) as resource_count,
           me.login_id is not null as me_member,
           coalesce(me.moderator, false) as me_moderator,
           a.id as agent_id, a.name as agent_name
      from workspaces w
      left join workspace_users me on me.workspace_id = w.id and me.login_id = ${caller.loginId}
      left join workspace_resources ar on ar.workspace_id = w.id and ar.type = 'assistant'
      left join agents a on a.id::text = ar.ref_id
     where w.owner_id = ${caller.anchorId} and ${where}
     order by w.is_admin desc, lower(w.name)
     ${lock ? sql`for update of w` : sql``}`;
}

function toWorkspace(r: WsRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    contactNodeId: r.contact_id,
    assistant: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? '' } : null,
    isAdmin: r.is_admin,
    // Admin is the one built-in workspace; no workspace is Admin-moderated
    // since 0286 (both fields stay for older clients).
    builtIn: r.is_admin,
    adminModerated: false,
    archived: r.archived_at !== null,
    userCount: r.user_count,
    resourceCount: r.resource_count,
    me: { member: r.me_member, moderator: r.me_moderator },
    ...lookOfRow(r),
  };
}

/** What the caller may do on one workspace it can see. */
type Seen = {
  row: WsRow;
  areas: WorkspaceArea[];
  /** Admin user with 'users': sees and manages every workspace. */
  admin: boolean;
  /** Moderator of this workspace. */
  mod: boolean;
};

/** The workspace if the caller may see it (a user of it, or an Admin user
 *  with 'users'; an archived one only the latter), else 404. `lock` takes
 *  the workspace row FOR UPDATE: every change does, so two changes of one
 *  workspace (the last Moderator, the assistant) are serialized. */
async function seeWorkspace(
  caller: WsCaller,
  id: string,
  q: Exec = db,
  lock = false,
): Promise<Seen> {
  const [row] = await rows<WsRow>(q, wsSelect(caller, sql`w.id = ${wsId(id)}`, lock));
  if (!row) throw NOT_FOUND();
  const areas = areasOf(await adminInfo(caller, q), caller);
  const admin = areas.includes('users');
  if (!admin && (!row.me_member || row.archived_at !== null)) throw NOT_FOUND();
  return { row, areas, admin, mod: row.me_member && row.me_moderator };
}

/** GET /api/workspaces. */
export async function listWorkspaces(caller: WsCaller): Promise<{ workspaces: Workspace[] }> {
  const areas = await areasFor(caller);
  const where = areas.includes('users')
    ? sql`true`
    : sql`me.login_id is not null and w.archived_at is null`;
  const list = await rows<WsRow>(db, wsSelect(caller, where));
  return { workspaces: list.map(toWorkspace) };
}

/** The live workspaces of the signed-in login, and its areas (/api/shell). */
export async function shellWorkspaces(caller: WsCaller): Promise<ShellWorkspaces> {
  const [areas, list] = await Promise.all([
    areasFor(caller),
    rows<
      LookRow & {
        id: string;
        name: string;
        is_admin: boolean;
        moderator: boolean;
        private: boolean;
      }
    >(
      db,
      sql`select w.id, w.name, w.is_admin, u.moderator, ${WS_LOOK_COLUMNS},
                 exists (select 1 from private_workspaces p
                          where p.workspace_id = w.id and p.login_id = ${caller.loginId}) as private
            from workspaces w
            join workspace_users u on u.workspace_id = w.id and u.login_id = ${caller.loginId}
           where w.owner_id = ${caller.anchorId} and w.archived_at is null
           order by w.is_admin desc, lower(w.name)`,
    ),
  ]);
  return {
    workspaces: list.map((w) => ({
      id: w.id,
      name: w.name,
      isAdmin: w.is_admin,
      moderator: w.moderator,
      ...(w.private ? { private: true as const } : {}),
      ...lookOfRow(w),
    })),
    areas,
  };
}

async function agentHasHistory(q: Exec, agentId: string): Promise<boolean> {
  const [r] = await rows<{ h: boolean }>(
    q,
    sql`select mantle_agent_has_history(${agentId}::uuid) as h`,
  );
  return r?.h === true;
}

async function detail(
  caller: WsCaller,
  seen: Seen,
  q: Exec = db,
): Promise<WorkspaceDetailResponse> {
  const id = seen.row.id;
  const [users, resources] = await Promise.all([
    rows<{
      login_id: string;
      name: string | null;
      email: string;
      moderator: boolean;
      added_by: string | null;
      added_by_name: string | null;
      added_at: string | Date;
    }>(
      q,
      sql`select u.login_id, x.display_name as name, x.email, u.moderator,
                 u.added_by, coalesce(nullif(btrim(b.display_name), ''), b.email) as added_by_name,
                 u.added_at
            from workspace_users u
            join auth.users x on x.id = u.login_id
            left join auth.users b on b.id = u.added_by
           where u.workspace_id = ${id}
           order by lower(coalesce(x.display_name, x.email))`,
    ),
    rows<{ type: WorkspaceResourceKind; ref_id: string; write: boolean; name: string }>(
      q,
      sql`select r.type, r.ref_id, r.write, coalesce(a.name, g.name, r.ref_id) as name
            from workspace_resources r
            left join agents a on r.type = 'assistant' and a.id::text = r.ref_id
            left join tool_groups g on r.type = 'connector' and g.slug = r.ref_id
                                    and g.owner_id = ${caller.anchorId}
           where r.workspace_id = ${id}
           order by r.type, lower(coalesce(a.name, g.name, r.ref_id))`,
    ),
  ]);
  const outUsers: WorkspaceUser[] = users.map((u) => ({
    loginId: u.login_id,
    name: u.name,
    email: u.email,
    moderator: u.moderator,
    // Nobody is a Moderator by the Admin area since 0286 (kept for older
    // clients).
    adminViaArea: false,
    addedBy: u.added_by && u.added_by_name ? { loginId: u.added_by, name: u.added_by_name } : null,
    addedAt: new Date(u.added_at).toISOString(),
  }));
  const outResources: WorkspaceResource[] = resources.map((r) => ({
    kind: r.type,
    id: r.ref_id,
    name: r.name,
    write: r.write,
  }));
  const hasHistory = seen.row.agent_id ? await agentHasHistory(q, seen.row.agent_id) : false;
  const landingApp = await landingAppOf(caller, seen);
  return {
    workspace: toWorkspace(seen.row),
    users: outUsers,
    resources: outResources,
    hasHistory,
    landingApp,
  };
}

/**
 * The screen's landing page (task d78e7bde). The home app is named (id and
 * title) only to a user of the workspace and only while the workspace holds
 * it: an Admin user outside the workspace learns only that one is set
 * (audit L1), and a pointer to an app the workspace lost names nothing, so
 * the screen can offer the clear (audit M2; the item_grants trigger of 0276
 * clears such a pointer at commit, this covers one left from before).
 */
async function landingAppOf(caller: WsCaller, seen: Seen): Promise<WorkspaceLandingApp | null> {
  const appId = seen.row.landing_app_id;
  if (!appId) return null;
  const held = await workspaceHeldApp(caller.anchorId, seen.row.id, appId);
  if (!held) return { held: false, appId: null, title: null, ready: false };
  return seen.row.me_member
    ? { held: true, appId: held.appId, title: held.title, ready: held.ready }
    : { held: true, appId: null, title: null, ready: held.ready };
}

/** GET /api/workspaces/:id. */
export async function getWorkspace(caller: WsCaller, id: string): Promise<WorkspaceDetailResponse> {
  return detail(caller, await seeWorkspace(caller, id));
}

/** The screen again after a change, read fresh. */
async function reread(caller: WsCaller, id: string): Promise<WorkspaceDetailResponse> {
  return getWorkspace(caller, id);
}

// ── Events ───────────────────────────────────────────────────────────────────

async function event(
  q: Exec,
  wsIdValue: string,
  actor: string,
  action: string,
  subject: Record<string, unknown> = {},
): Promise<void> {
  await q.execute(
    sql`insert into workspace_events (workspace_id, actor_id, action, subject)
        values (${wsIdValue}, ${actor}, ${action}, ${JSON.stringify(subject)}::jsonb)`,
  );
}

// ── Create and change ────────────────────────────────────────────────────────

/** Names are not unique (0255, audit M3): a clash with a workspace the
 *  caller cannot see would tell them it exists. Only the name of the Admin
 *  workspace is reserved, and everybody knows it ("Team" too until 0286:
 *  it is a name like any other now). */
const RESERVED = () =>
  new WsError(
    409,
    'reserved_name',
    'Admin is the name of the built-in Admin workspace. Pick another name.',
  );

function nameError(err: unknown): WsError | null {
  if (isUniqueViolation(err) && pgConstraint(err) === 'workspaces_reserved_name_uq') {
    return RESERVED();
  }
  return null;
}

/** The reserved name, in code (fix round 2, L-3): for any workspace but
 *  Admin. The index (0255, 0286) is the backstop. */
function refuseReservedName(name: string): void {
  if (name.trim().toLowerCase() === 'admin') throw RESERVED();
}

/** POST /api/workspaces: the maker is its only user and a Moderator (plan
 *  15; kept by the owner decision of 2026-10-13: the one way to become a
 *  Moderator without an Admin user). */
export async function createWorkspace(
  caller: WsCaller,
  body: { name: string; description?: string },
): Promise<Workspace> {
  const info = await adminInfo(caller);
  if (!info.migrated) {
    throw new WsError(409, 'not_migrated', 'Workspaces are not set up on this brain yet.');
  }
  refuseReservedName(body.name);
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [w] = await rows<{ id: string }>(
        tx,
        sql`insert into workspaces (owner_id, name, description, created_by)
            values (${caller.anchorId}, ${body.name}, ${body.description ?? ''}, ${caller.loginId})
            returning id`,
      );
      await tx.execute(
        sql`insert into workspace_users (workspace_id, login_id, moderator, added_by)
            values (${w!.id}, ${caller.loginId}, true, ${caller.loginId})`,
      );
      await event(tx, w!.id, caller.loginId, 'workspace.create', { name: body.name });
      return w!.id;
    });
  } catch (err) {
    throw nameError(err) ?? err;
  }
  return (await getWorkspace(caller, id)).workspace;
}

/**
 * Who may change what a workspace is called and how it looks (task
 * 5edc9149): ONE check for the name, the description and the look, the
 * same for every workspace. An Admin user (the users area) or a Moderator
 * of it: on Admin, its Moderators are Admin users.
 */
function mayChangeAbout(seen: Seen): boolean {
  return seen.admin || seen.mod;
}

/** PATCH /api/workspaces/:id. */
export async function patchWorkspace(
  caller: WsCaller,
  id: string,
  body: {
    name?: string;
    description?: string;
    color?: AppTint | null;
    icon?: string | null;
    contactNodeId?: string | null;
    assistantId?: string | null;
    landingAppId?: string | null;
  },
): Promise<Workspace> {
  try {
    await db.transaction(async (tx) => {
      const seen = await seeWorkspace(caller, id, tx, true);
      const w = seen.row;
      if (w.archived_at !== null) throw archivedError();
      const look = body.color !== undefined || body.icon !== undefined;
      const own = body.name !== undefined || body.description !== undefined || look;
      if (own && !mayChangeAbout(seen)) {
        throw new WsError(403, 'forbidden', 'Only a Moderator of this workspace can change it.');
      }
      if (body.name !== undefined && body.name !== w.name) {
        // Admin keeps its name (fix round 2, L-3): a renamed Admin would
        // free "Admin" for anyone, and a later clash would tell them it
        // exists. Every other workspace, Team too (0286), is renamed.
        if (w.is_admin) {
          throw new WsError(409, 'reserved_name', 'The Admin workspace keeps its name.');
        }
        refuseReservedName(body.name);
      }
      if (body.contactNodeId !== undefined && !seen.admin) {
        throw new WsError(403, 'admin_only', 'Only an Admin user can set the contact.');
      }
      if (body.assistantId !== undefined && !seen.areas.includes('assistants')) {
        throw new WsError(403, 'admin_only', 'Only an Admin user can change the assistant.');
      }
      if (body.contactNodeId) {
        const [c] = await rows<{ id: string }>(
          tx,
          sql`select id from nodes
               where id = ${wsIdOrInvalid(body.contactNodeId)} and owner_id = ${caller.anchorId}
                 and type = 'contact'`,
        );
        if (!c) throw new WsError(400, 'invalid', 'contactNodeId: no such contact.');
      }
      const changed: Record<string, unknown> = {};
      if (body.name !== undefined && body.name !== w.name) changed.name = body.name;
      if (body.description !== undefined && body.description !== w.description) {
        changed.description = body.description;
      }
      if (body.color !== undefined && body.color !== w.look_color) changed.color = body.color;
      if (body.icon !== undefined && body.icon !== w.look_icon) changed.icon = body.icon;
      if (body.contactNodeId !== undefined && body.contactNodeId !== w.contact_id) {
        changed.contactNodeId = body.contactNodeId;
      }
      if (Object.keys(changed).length > 0) {
        await tx.execute(
          sql`update workspaces set
                name = ${body.name ?? w.name},
                description = ${body.description ?? w.description},
                color = ${body.color === undefined ? w.look_color : body.color},
                icon = ${body.icon === undefined ? w.look_icon : body.icon},
                contact_id = ${body.contactNodeId === undefined ? w.contact_id : body.contactNodeId},
                updated_at = now()
              where id = ${w.id}`,
        );
        await event(tx, w.id, caller.loginId, 'workspace.update', changed);
      }
      if (body.assistantId !== undefined) {
        await setAssistant(caller, tx, w, body.assistantId);
      }
      if (body.landingAppId !== undefined) {
        await setLandingApp(caller, tx, seen, body.landingAppId);
      }
    });
  } catch (err) {
    throw nameError(err) ?? assistantError(err) ?? err;
  }
  return (await getWorkspace(caller, id)).workspace;
}

// ── The landing page (task d78e7bde) ─────────────────────────────────────────

/**
 * Set or clear the workspace's home app: what its landing page shows in
 * place of the Built-in home. A Moderator of this workspace only (the right
 * mantle_may_manage gives on the workspace's items: the Moderator tick, read
 * here with the workspace row), never an Admin area: the landing page is
 * the workspace's own setting. Only an app the workspace holds (its grant;
 * share the app with the workspace first, nothing is granted here) with a
 * green published build. `null` clears it: the Built-in home.
 */
async function setLandingApp(
  caller: WsCaller,
  tx: QueryTx,
  seen: Seen,
  appId: string | null,
): Promise<void> {
  const w = seen.row;
  if (!seen.mod) {
    throw new WsError(
      403,
      'forbidden',
      'Only a Moderator of this workspace can set its landing page.',
    );
  }
  if (appId !== null) {
    // In the transaction that holds the workspace row (audit L4).
    const held = await workspaceHeldApp(caller.anchorId, w.id, wsIdOrInvalid(appId), tx);
    if (!held) {
      throw new WsError(
        409,
        'landing_app_not_held',
        'This workspace does not hold that app. Share the app with the workspace first.',
      );
    }
    if (!held.ready) {
      throw new WsError(
        409,
        'landing_app_not_ready',
        'That app has no working published build. Publish it first.',
      );
    }
    appId = held.appId;
  }
  if (appId === w.landing_app_id) return;
  await tx.execute(
    sql`update workspaces set landing_app_id = ${appId}, updated_at = now() where id = ${w.id}`,
  );
  await event(tx, w.id, caller.loginId, 'workspace.landing', { appId });
}

function wsIdOrInvalid(id: string): string {
  if (!UUID_RE.test(id)) throw new WsError(400, 'invalid', 'Not a valid id.');
  return id.toLowerCase();
}

const archivedError = () =>
  new WsError(409, 'archived', 'This workspace is archived and cannot be changed.');

// ── The assistant (plan 5.1, 18.8: frozen once it has history) ──────────────

const HISTORY = () =>
  new WsError(
    409,
    'assistant_has_history',
    'This assistant has history in its workspace. Clone it to use it elsewhere.',
  );

/** A database refusal of an assistant change, said plainly, or null. */
function assistantError(err: unknown): WsError | null {
  if (isUniqueViolation(err) && pgConstraint(err) === 'workspace_resources_assistant_home_uq') {
    return new WsError(
      409,
      'assistant_in_use',
      'This assistant already belongs to another workspace.',
    );
  }
  if (isUniqueViolation(err) && pgConstraint(err) === 'workspace_resources_one_assistant_uq') {
    return new WsError(409, 'resource_exists', 'This workspace already has an assistant.');
  }
  if (isCheckViolation(err)) {
    for (let e: unknown = err, d = 0; e && d < 4; d++) {
      const m = (e as { message?: unknown }).message;
      if (typeof m === 'string' && m.includes('has history')) return HISTORY();
      e = (e as { cause?: unknown }).cause;
    }
  }
  return null;
}

/** Make `agentId` (or none) the workspace's assistant. The current one with
 *  history stays: 409. A new one must be a chat assistant of this brain,
 *  not another workspace's. A detached one with no history is unbound
 *  (agents.workspace_id back to NULL, as before it was attached). */
async function setAssistant(
  caller: WsCaller,
  tx: Exec,
  w: WsRow,
  agentId: string | null,
): Promise<void> {
  const next = agentId === null ? null : wsIdOrInvalid(agentId);
  const current = w.agent_id;
  if (current === next) return;
  if (current && (await agentHasHistory(tx, current))) throw HISTORY();
  if (next) {
    const [a] = await rows<{ id: string; workspace_id: string | null }>(
      tx,
      sql`select id, workspace_id from agents
           where id = ${next} and owner_id = ${caller.anchorId}
             and role in ('responder', 'assistant')`,
    );
    if (!a) throw new WsError(400, 'invalid', 'assistantId: no such chat assistant.');
    const [held] = await rows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id from workspace_resources
           where type = 'assistant' and ref_id = ${next} and workspace_id <> ${w.id}`,
    );
    if (held) {
      throw new WsError(
        409,
        'assistant_in_use',
        'This assistant already belongs to another workspace.',
      );
    }
    if (a.workspace_id && a.workspace_id !== w.id && (await agentHasHistory(tx, next))) {
      throw HISTORY();
    }
  }
  if (current) {
    await tx.execute(
      sql`delete from workspace_resources where workspace_id = ${w.id} and type = 'assistant'`,
    );
    await tx.execute(
      sql`update agents set workspace_id = null where id = ${current} and workspace_id = ${w.id}`,
    );
    await event(tx, w.id, caller.loginId, 'resource.remove', { kind: 'assistant', id: current });
  }
  if (next) {
    // The resource trigger (0241) writes agents.workspace_id.
    await tx.execute(
      sql`insert into workspace_resources (workspace_id, type, ref_id, write, added_by)
          values (${w.id}, 'assistant', ${next}, true, ${caller.loginId})`,
    );
    await event(tx, w.id, caller.loginId, 'resource.add', { kind: 'assistant', id: next });
  }
}

// ── Archive (plan 15, 18.8, 21.8 row 11) ─────────────────────────────────────

async function archiveCounts(
  q: Exec,
  id: string,
): Promise<WorkspaceArchivePreview & { exclusionCount: number }> {
  const [r] = await rows<{ items: number; grants: number; exclusions: number }>(
    q,
    sql`select count(*) filter (where is_home)::int as items,
               count(*) filter (where not is_home and not excluded)::int as grants,
               count(*) filter (where excluded)::int as exclusions
          from item_grants where workspace_id = ${id}`,
  );
  return {
    itemCount: r?.items ?? 0,
    grantCount: r?.grants ?? 0,
    exclusionCount: r?.exclusions ?? 0,
  };
}

function mayArchive(seen: Seen): void {
  if (!seen.mod && !seen.admin) {
    throw new WsError(403, 'forbidden', 'Only a Moderator of this workspace can archive it.');
  }
  if (seen.row.is_admin) {
    throw new WsError(409, 'admin_workspace', 'The Admin workspace cannot be archived.');
  }
  if (seen.row.archived_at !== null) throw archivedError();
}

/** GET /api/workspaces/:id/archive-preview. */
export async function archivePreview(
  caller: WsCaller,
  id: string,
): Promise<WorkspaceArchivePreview> {
  const seen = await seeWorkspace(caller, id);
  if (!seen.mod && !seen.admin) {
    throw new WsError(403, 'forbidden', 'Only a Moderator of this workspace can archive it.');
  }
  const { itemCount, grantCount } = await archiveCounts(db, seen.row.id);
  return { itemCount, grantCount };
}

/** POST /api/workspaces/:id/archive: refused while it is any item's home;
 *  the items only shared here lose that share, under their heads (the
 *  heads are the first lock; rows found later are locked NOWAIT and the
 *  whole transaction retried). */
export async function archiveWorkspace(
  caller: WsCaller,
  id: string,
): Promise<{ workspace: Workspace } & WorkspaceArchivePreview> {
  const seen = await seeWorkspace(caller, id);
  mayArchive(seen);
  const wid = seen.row.id;
  const nodeIds = async (q: Exec) =>
    (
      await rows<{ node_id: string }>(
        q,
        sql`select node_id from item_grants where workspace_id = ${wid} and not is_home`,
      )
    ).map((r) => r.node_id);
  const first = await nodeIds(db);
  const counts = await withDeadlockRetry(() =>
    withHeads(first, 'update', async (tx) => {
      const again = await seeWorkspace(caller, wid, tx, true);
      mayArchive(again);
      const now = await archiveCounts(tx, wid);
      if (now.itemCount > 0) {
        throw new WsError(
          409,
          'workspace_holds_items',
          `${now.itemCount} item(s) have their home in this workspace. Move them first.`,
        );
      }
      const known = new Set(first);
      const later = (await nodeIds(tx)).filter((n) => !known.has(n));
      await lockMoreHeads(tx, later);
      await tx.execute(sql`delete from item_grants where workspace_id = ${wid} and not is_home`);
      await tx.execute(
        sql`update workspaces set archived_at = now(), updated_at = now() where id = ${wid}`,
      );
      // Both kinds of row the delete drops (audit L5): grants, and the
      // "removed here" exclusions against a folder's grant.
      await event(tx, wid, caller.loginId, 'workspace.archive', {
        grantsDropped: now.grantCount,
        exclusionsDropped: now.exclusionCount,
      });
      return { itemCount: now.itemCount, grantCount: now.grantCount, row: again.row };
    }),
  );
  // Read inside the change: a login that is not an Admin user no longer
  // sees an archived workspace.
  const { row, ...applied } = counts;
  return { workspace: toWorkspace({ ...row, archived_at: new Date() }), ...applied };
}

// ── Users (plan 18.13 Q3, R7, 18.8; the owner decision of 2026-10-13) ───────

type LoginRow = { id: string; role: string; disabled: boolean };

async function loginOf(q: Exec, loginId: string): Promise<LoginRow | null> {
  if (!UUID_RE.test(loginId)) return null;
  const [r] = await rows<LoginRow>(
    q,
    sql`select id, role, disabled_at is not null as disabled from auth.users where id = ${loginId}`,
  );
  return r ?? null;
}

async function userRow(
  q: Exec,
  wid: string,
  loginId: string,
): Promise<{ moderator: boolean } | null> {
  const [r] = await rows<{ moderator: boolean }>(
    q,
    sql`select moderator from workspace_users where workspace_id = ${wid} and login_id = ${loginId}`,
  );
  return r ?? null;
}

async function otherModerators(q: Exec, wid: string, loginId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    q,
    sql`select count(*)::int as n from workspace_users
         where workspace_id = ${wid} and moderator and login_id <> ${loginId}`,
  );
  return r?.n ?? 0;
}

const LAST_MOD = () =>
  new WsError(
    409,
    'last_moderator',
    'This is the last Moderator of the workspace. An Admin user must make another user a Moderator first.',
  );

function mayManageUsers(seen: Seen): void {
  if (!seen.mod && !seen.admin) {
    throw new WsError(403, 'forbidden', 'Only a Moderator of this workspace can manage its users.');
  }
  if (seen.row.archived_at !== null) throw archivedError();
}

/**
 * Who ticks or clears Moderator (owner decision 2026-10-13): an Admin user
 * only (the users area), on every workspace, Admin included. The ONE check
 * for setModerator, an add with the tick and the removal of a Moderator
 * (owner answer Q2: a removal takes the tick away too); a Moderator of the
 * workspace still adds users without it and removes plain users. Nobody becomes a
 * Moderator by themselves: the maker of a workspace is the one exception
 * (createWorkspace), and an admin login joins Admin as one (the login
 * bridge, mantle_bridge_login). "An Admin user" here is the caller's users
 * area (areasFor); adminUserSql (@mantle/db) is the same rule as SQL, for a
 * login other than the caller (the 0286 roll's tick commands).
 */
function mayPromote(seen: Seen): void {
  mayManageUsers(seen);
  if (!seen.admin) {
    throw new WsError(
      403,
      'admin_only',
      'Only an Admin user can make someone a Moderator or take the tick away.',
    );
  }
}

/** The Admin-workspace role change behind adding or removing a user there.
 *  `checks` runs first inside the change's transaction (it locks the
 *  workspace, audit L2); `inTx` last, after the login bridge. On success the
 *  user.update audit row the Users screen writes (audit M2). */
async function adminRoleChange(
  caller: WsCaller,
  loginId: string,
  role: 'admin' | 'member',
  path: { method: 'POST' | 'DELETE'; path: string },
  checks: (tx: Exec) => Promise<unknown>,
  inTx: (tx: Exec) => Promise<void>,
): Promise<void> {
  const actor = caller.user;
  if (!actor) {
    throw new WsError(403, 'admin_only', 'Only an Admin user can change who is an Admin user.');
  }
  const target = UUID_RE.test(loginId) ? await loadLoginTarget(loginId) : null;
  if (!target) throw new WsError(404, 'not_found', 'User not found.');
  if (target.role === role) {
    // No role change (a row out of step with its role): only the row.
    await db.transaction(async (tx) => {
      await checks(tx);
      await inTx(tx);
    });
    return;
  }
  // The workspace lock comes before the login row here, the other way round
  // on the Users screen: a deadlock between the two is retried whole.
  const done = await withDeadlockRetry(() =>
    applyLoginChange(actor, target, { role }, inTx, async (tx) => {
      await checks(tx);
    }),
  );
  if (done.ok) {
    auditFireAndForget({
      actorId: actor.actor.id,
      actorEmail: actor.actor.email,
      action: 'user.update',
      method: path.method,
      path: path.path,
      detail: {
        targetId: target.id,
        targetEmail: target.email,
        changes: { role },
        ...(done.sessionsEnded ? { sessionsEnded: true } : {}),
        ...(done.lockingOut
          ? { releasedAgentId: done.releasedAgentId, pushDevicesRemoved: done.pushDevicesRemoved }
          : {}),
      },
      ...(await requestMeta()),
    });
    return;
  }
  switch (done.reason) {
    case 'owner':
      throw new WsError(
        403,
        'owner_stays_admin',
        'The original account always stays an Admin user.',
      );
    case 'self':
      throw new WsError(403, 'self_demote', 'You cannot remove yourself from the Admin workspace.');
    case 'last-admin':
      throw LAST_MOD();
    case 'role-fixed':
      throw new WsError(409, 'invalid', 'This login cannot change role.');
    default:
      throw new WsError(409, 'invalid', done.error);
  }
}

/** POST /api/workspaces/:id/users. A Moderator adds anyone (Q3), without
 *  the Moderator tick; an Admin user adds anyone anywhere, itself included,
 *  private workspaces too (S1), with or without it (mayPromote): logged
 *  with subject.self and shown as "Added by NAME on DATE". On the Admin
 *  workspace the add is the role change to admin (W5a), a Moderator there
 *  unless the add says otherwise. */
export async function addUser(
  caller: WsCaller,
  id: string,
  body: { loginId: string; moderator?: boolean },
): Promise<WorkspaceDetailResponse> {
  // Who may add comes first (audit L1): a caller who may not manage this
  // workspace learns nothing about the login it names.
  const pre = await seeWorkspace(caller, id);
  const gate = body.moderator === true ? mayPromote : mayManageUsers;
  gate(pre);
  const wid = pre.row.id;
  const target = await loginOf(db, body.loginId);
  if (!target) throw new WsError(404, 'not_found', 'User not found.');
  const self = target.id === caller.loginId;
  const checks = async (q: Exec): Promise<Seen> => {
    const seen = await seeWorkspace(caller, wid, q, true);
    gate(seen);
    if (await userRow(q, wid, target.id)) {
      throw new WsError(409, 'already_user', 'This person is already a user of this workspace.');
    }
    return seen;
  };
  const subject = (moderator: boolean) => ({
    login: target.id,
    moderator,
    ...(self ? { self: true } : {}),
  });
  if (pre.row.is_admin) {
    await adminRoleChange(
      caller,
      target.id,
      'admin',
      { method: 'POST', path: `/api/workspaces/${wid}/users` },
      checks,
      async (tx) => {
        // The login bridge (0251) made the row (Moderator); the tick asked
        // for here wins. The last-Moderator guard still holds at commit.
        const wanted = body.moderator ?? true;
        await tx.execute(
          sql`insert into workspace_users (workspace_id, login_id, moderator, added_by)
              values (${wid}, ${target.id}, ${wanted}, ${caller.loginId})
              on conflict (workspace_id, login_id)
              do update set moderator = excluded.moderator, added_by = excluded.added_by`,
        );
        await event(tx, wid, caller.loginId, 'user.add', subject(wanted));
      },
    );
    return reread(caller, wid);
  }
  await db.transaction(async (tx) => {
    await checks(tx);
    const moderator = body.moderator ?? false;
    await tx.execute(
      sql`insert into workspace_users (workspace_id, login_id, moderator, added_by)
          values (${wid}, ${target.id}, ${moderator}, ${caller.loginId})`,
    );
    await event(tx, wid, caller.loginId, 'user.add', subject(moderator));
  });
  return reread(caller, wid);
}

/** PATCH /api/workspaces/:id/users/:loginId: an Admin user ticks or
 *  clears Moderator (mayPromote). Never the last Moderator. */
export async function setModerator(
  caller: WsCaller,
  id: string,
  loginId: string,
  moderator: boolean,
): Promise<WorkspaceDetailResponse> {
  const wid = (await seeWorkspace(caller, id)).row.id;
  await db
    .transaction(async (tx) => {
      const seen = await seeWorkspace(caller, wid, tx, true);
      mayPromote(seen);
      const row = UUID_RE.test(loginId) ? await userRow(tx, wid, loginId) : null;
      if (!row) throw new WsError(404, 'not_user', 'This person is not a user of this workspace.');
      if (row.moderator === moderator) return;
      if (!moderator && (await otherModerators(tx, wid, loginId)) === 0) throw LAST_MOD();
      await tx.execute(
        sql`update workspace_users set moderator = ${moderator}
           where workspace_id = ${wid} and login_id = ${loginId}`,
      );
      await event(tx, wid, caller.loginId, 'user.moderator', { login: loginId, moderator });
    })
    .catch((err: unknown) => {
      throw lastAdminError(err) ?? err;
    });
  return reread(caller, wid);
}

function lastAdminError(err: unknown): WsError | null {
  if (!isCheckViolation(err)) return null;
  for (let e: unknown = err, d = 0; e && d < 4; d++) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.includes('at least one Moderator')) return LAST_MOD();
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** DELETE /api/workspaces/:id/users/:loginId: a Moderator or an Admin user
 *  removes a plain user; only an Admin user removes a Moderator (mayPromote,
 *  owner answer Q2); anyone may leave. Never the last Moderator. On the
 *  Admin workspace it is the role change to member (W5a). */
export async function removeUser(
  caller: WsCaller,
  id: string,
  loginId: string,
): Promise<WorkspaceDetailResponse> {
  const pre = await seeWorkspace(caller, id);
  const wid = pre.row.id;
  const self = loginId.toLowerCase() === caller.loginId;
  const checks = async (q: Exec): Promise<void> => {
    const seen = await seeWorkspace(caller, wid, q, true);
    if (!self) mayManageUsers(seen);
    else if (seen.row.archived_at !== null) throw archivedError();
    const row = UUID_RE.test(loginId) ? await userRow(q, wid, loginId) : null;
    if (!row) throw new WsError(404, 'not_user', 'This person is not a user of this workspace.');
    // Removing a Moderator takes their tick away: the same one check as
    // clearing it (owner answer Q2), or a Moderator could remove another and
    // add them back without it. Leaving stays open to anyone.
    if (!self && row.moderator) mayPromote(seen);
    if (row.moderator && (await otherModerators(q, wid, loginId)) === 0) throw LAST_MOD();
  };
  if (pre.row.is_admin) {
    await adminRoleChange(
      caller,
      loginId,
      'member',
      { method: 'DELETE', path: `/api/workspaces/${wid}/users/${loginId}` },
      checks,
      async (tx) => {
        // The login bridge (0251) removed the row; make sure, and log it.
        await tx.execute(
          sql`delete from workspace_users where workspace_id = ${wid} and login_id = ${loginId}`,
        );
        await event(tx, wid, caller.loginId, 'user.remove', { login: loginId });
      },
    );
  } else {
    await db.transaction(async (tx) => {
      await checks(tx);
      await tx.execute(
        sql`delete from workspace_users where workspace_id = ${wid} and login_id = ${loginId}`,
      );
      await event(tx, wid, caller.loginId, self ? 'user.leave' : 'user.remove', {
        login: loginId,
      });
    });
  }
  // A login that left can no longer see the workspace.
  if (self && !pre.admin) return { ...(await detailAfterLeave(pre)) };
  return reread(caller, wid);
}

/** What a login that just left sees: the workspace as it was, without
 *  users or resources (it may no longer read them). */
async function detailAfterLeave(pre: Seen): Promise<WorkspaceDetailResponse> {
  return {
    workspace: {
      ...toWorkspace(pre.row),
      userCount: Math.max(0, pre.row.user_count - 1),
      me: { member: false, moderator: false },
    },
    users: [],
    resources: [],
    hasHistory: false,
  };
}

/** An Admin user's page of user search. */
export const USER_SEARCH_PAGE = 50;

/** GET /api/workspaces/user-search?q=&offset= (Q3): logins by email or
 *  name, for a Moderator of any workspace or an Admin user. A non-Admin
 *  Moderator needs 3 characters and gets 10 at most, no paging; an Admin
 *  user any query, in pages of 50 (`offset`), so they can list everyone.
 *  Disabled logins are left out. */
export async function searchUsers(
  caller: WsCaller,
  q: string,
  offset = 0,
): Promise<WorkspaceUserSearchHit[]> {
  const admin = await requireArea(caller, 'users');
  if (!admin) {
    const [m] = await rows<{ ok: boolean }>(
      db,
      sql`select exists (
            select 1 from workspace_users u join workspaces w on w.id = u.workspace_id
             where w.owner_id = ${caller.anchorId} and w.archived_at is null
               and u.login_id = ${caller.loginId} and u.moderator) as ok`,
    );
    if (!m?.ok) {
      throw new WsError(403, 'forbidden', 'Only a Moderator of a workspace can search for users.');
    }
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new WsError(400, 'invalid', 'offset: a whole number of 0 or more.');
  }
  if (!admin && offset > 0) {
    throw new WsError(400, 'invalid', 'offset: paging is for Admin users.');
  }
  const term = q.trim();
  if (!admin && term.length < 3) {
    throw new WsError(400, 'query_too_short', 'Type at least 3 characters of a name or email.');
  }
  const limit = rateLimit(`ws-user-search:${caller.loginId}`, { max: 60, windowMs: 60_000 });
  if (!limit.ok) {
    throw new WsError(429, 'rate_limited', 'Too many searches. Wait a minute and try again.');
  }
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const hits = await rows<{ id: string; name: string | null; email: string }>(
    db,
    sql`select id, display_name as name, email from auth.users
         where disabled_at is null
           and (${term} = '' or email ilike ${like} or coalesce(display_name, '') ilike ${like})
         order by lower(coalesce(display_name, email)), id
         limit ${admin ? USER_SEARCH_PAGE : 10} offset ${offset}`,
  );
  return hits.map((h) => ({ loginId: h.id, name: h.name, email: h.email }));
}

// ── Resources (plan 1.4, 6) ──────────────────────────────────────────────────

function mayManageResource(seen: Seen, kind: WorkspaceResourceKind): void {
  const area: WorkspaceArea = kind === 'assistant' ? 'assistants' : 'connectors';
  if (!seen.areas.includes(area)) {
    throw new WsError(
      403,
      'admin_only',
      'Only an Admin user can change this workspace’s resources.',
    );
  }
  if (seen.row.archived_at !== null) throw archivedError();
}

/** POST /api/workspaces/:id/resources. */
export async function addResource(
  caller: WsCaller,
  id: string,
  body: { kind: WorkspaceResourceKind; id: string; write?: boolean },
): Promise<WorkspaceDetailResponse> {
  const wid = (await seeWorkspace(caller, id)).row.id;
  try {
    await db.transaction(async (tx) => {
      const seen = await seeWorkspace(caller, wid, tx, true);
      mayManageResource(seen, body.kind);
      if (body.kind === 'assistant') {
        if (seen.row.agent_id) {
          throw new WsError(409, 'resource_exists', 'This workspace already has an assistant.');
        }
        await setAssistant(caller, tx, seen.row, body.id);
        return;
      }
      const [g] = await rows<{ slug: string }>(
        tx,
        sql`select slug from tool_groups
             where owner_id = ${caller.anchorId} and slug = ${body.id} and integration is not null`,
      );
      if (!g) throw new WsError(400, 'invalid', 'id: no such connector.');
      const write = body.write ?? false;
      const added = await rows<{ id: string }>(
        tx,
        sql`insert into workspace_resources (workspace_id, type, ref_id, write, added_by)
            values (${wid}, 'connector', ${g.slug}, ${write}, ${caller.loginId})
            on conflict (workspace_id, type, ref_id) do nothing
            returning id`,
      );
      if (added.length === 0) {
        throw new WsError(409, 'resource_exists', 'This connector is already on this workspace.');
      }
      await event(tx, wid, caller.loginId, 'resource.add', {
        kind: 'connector',
        id: g.slug,
        write,
      });
    });
  } catch (err) {
    throw assistantError(err) ?? err;
  }
  return reread(caller, wid);
}

/** PATCH /api/workspaces/:id/resources/:kind/:id: the Write tick. */
export async function patchResource(
  caller: WsCaller,
  id: string,
  kind: string,
  refId: string,
  write: boolean,
): Promise<WorkspaceDetailResponse> {
  const k = resourceKind(kind);
  const wid = (await seeWorkspace(caller, id)).row.id;
  await db.transaction(async (tx) => {
    const seen = await seeWorkspace(caller, wid, tx, true);
    mayManageResource(seen, k);
    if (k === 'assistant') {
      throw new WsError(400, 'invalid', 'An assistant has no Write tick.');
    }
    const done = await rows<{ id: string }>(
      tx,
      sql`update workspace_resources set write = ${write}
           where workspace_id = ${wid} and type = 'connector' and ref_id = ${refId}
          returning id`,
    );
    if (done.length === 0) {
      throw new WsError(404, 'not_found', 'This connector is not on this workspace.');
    }
    await event(tx, wid, caller.loginId, 'resource.update', { kind: k, id: refId, write });
  });
  return reread(caller, wid);
}

/** DELETE /api/workspaces/:id/resources/:kind/:id. */
export async function removeResource(
  caller: WsCaller,
  id: string,
  kind: string,
  refId: string,
): Promise<WorkspaceDetailResponse> {
  const k = resourceKind(kind);
  const wid = (await seeWorkspace(caller, id)).row.id;
  await db.transaction(async (tx) => {
    const seen = await seeWorkspace(caller, wid, tx, true);
    mayManageResource(seen, k);
    if (k === 'assistant') {
      if (seen.row.agent_id !== refId.toLowerCase()) {
        throw new WsError(404, 'not_found', 'This assistant is not on this workspace.');
      }
      await setAssistant(caller, tx, seen.row, null);
      return;
    }
    const done = await rows<{ id: string }>(
      tx,
      sql`delete from workspace_resources
           where workspace_id = ${wid} and type = 'connector' and ref_id = ${refId}
          returning id`,
    );
    if (done.length === 0) {
      throw new WsError(404, 'not_found', 'This connector is not on this workspace.');
    }
    await event(tx, wid, caller.loginId, 'resource.remove', { kind: k, id: refId });
  });
  return reread(caller, wid);
}

function resourceKind(kind: string): WorkspaceResourceKind {
  if (kind === 'assistant' || kind === 'connector') return kind;
  throw new WsError(404, 'not_found', 'No such resource kind.');
}
