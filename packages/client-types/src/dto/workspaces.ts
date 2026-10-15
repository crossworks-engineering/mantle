/**
 * Workspace management on the wire (workspaces plan page 4887b8e7, phase
 * W5a): /api/workspaces and the two fields /api/shell adds. Users are flat;
 * every permission is set on a workspace screen (users, Moderator ticks,
 * resources) or, from W5b, on an item's Grant Access panel.
 *
 * Every refusal is `{ error, code }` with 400, 403, 404 or 409. A workspace
 * or login the caller may not see answers 404, never 403.
 */
import type { AppTint } from '../app-nav';
import type { LoginRole } from '../role-names';

/** The Admin areas (plan 1.4), the one list of them (A10 #13: the brain's
 *  SCOPE_AREAS, adminUserSql and the route classes read it). An Admin
 *  workspace user has all of them unless a per-user switch turns one off
 *  (none can be switched off yet). In this order on the wire (the shell's
 *  `areas`). */
export const WORKSPACE_AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'] as const;
export type WorkspaceArea = (typeof WORKSPACE_AREAS)[number];

/** Whether `v` names an Admin area. */
export function isWorkspaceArea(v: unknown): v is WorkspaceArea {
  return typeof v === 'string' && (WORKSPACE_AREAS as readonly string[]).includes(v);
}

/** What a workspace is, for its default icon: the Admin workspace, a
 *  login's private workspace, or any other. 'team' (the built-in Team
 *  workspace) comes only from a brain before migration 0286: Team is a
 *  normal workspace since (its icon was set to the one 'team' drew). */
export type WorkspaceKind = 'admin' | 'team' | 'private' | 'other';

/**
 * A workspace's look (task 5edc9149): on every workspace the brain lists
 * (this list and screen, /api/shell's switcher list, and the chips of the
 * lists and the tree). `color` is a tint key of the folder palette, `icon`
 * an emoji or `lucide:<name>`, the folder vocabulary; null = the default:
 * the neutral colour, and the client's default icon for `kind`. Absent from
 * an older brain (read it as null and 'other').
 */
export type WorkspaceLook = {
  color?: AppTint | null;
  icon?: string | null;
  kind?: WorkspaceKind;
};

/** One workspace as a list row and as the head of its screen. */
export type Workspace = WorkspaceLook & {
  id: string;
  name: string;
  description: string;
  /** A contact node: who this workspace represents. Information only. */
  contactNodeId: string | null;
  /** The workspace's one assistant, if any. */
  assistant: { id: string; name: string } | null;
  /** The Admin workspace: its users manage the brain (requireArea). */
  isAdmin: boolean;
  /** The built-in workspace: Admin only since migration 0286 (Team too
   *  before). It cannot be renamed or archived (hide Rename and Archive
   *  there). Its connectors are attached here like any workspace's since
   *  W5b2. */
  builtIn: boolean;
  /** Always false since migration 0286 (it marked the built-in Team
   *  workspace, where every Admin workspace user was a Moderator). */
  adminModerated: boolean;
  archived: boolean;
  userCount: number;
  resourceCount: number;
  /** The caller's own place in it. */
  me: { member: boolean; moderator: boolean };
};

/** GET /api/workspaces: an Admin user gets every workspace (archived ones
 *  too); any other login the live ones it is a user of. */
export type WorkspaceListResponse = { workspaces: Workspace[] };

/** POST /api/workspaces. Any login may make one; the maker is its only user
 *  and a Moderator. */
export type WorkspaceCreateBody = { name: string; description?: string };

/** A user of a workspace, on its screen. */
export type WorkspaceUser = {
  loginId: string;
  name: string | null;
  email: string;
  moderator: boolean;
  /** Always false since migration 0286 (a Moderator of the Admin-moderated
   *  Team workspace by being an Admin user). Only an Admin user ticks or
   *  clears Moderator now (403 admin_only for anyone else). */
  adminViaArea: boolean;
  /** Who added them ("Added by NAME on DATE", plan S1): `name` is the
   *  display name or else the email. null when unknown (the adder's login
   *  is gone, or a migration or bridge added them). */
  addedBy: { loginId: string; name: string } | null;
  /** When they were added (ISO 8601). */
  addedAt: string;
};

/** A resource kind on the workspace screen (plan 1.4). */
export type WorkspaceResourceKind = 'assistant' | 'connector';

/** One resource: the assistant (an agent id) or a connector (its tool group
 *  slug). `write` is the connector's Write tick: a connector tool that can
 *  change data runs only when it is on AND the person asking is a Moderator. */
export type WorkspaceResource = {
  kind: WorkspaceResourceKind;
  id: string;
  name: string;
  write: boolean;
};

/** GET /api/workspaces/:id. */
export type WorkspaceDetailResponse = {
  workspace: Workspace;
  users: WorkspaceUser[];
  resources: WorkspaceResource[];
  /** The assistant has history (threads or messages): it cannot be swapped
   *  or removed, only cloned to use elsewhere. */
  hasHistory: boolean;
  /** The workspace's landing page (task d78e7bde): its home app, or null
   *  for the Built-in home. Absent from an older brain. */
  landingApp?: WorkspaceLandingApp | null;
};

/**
 * A workspace's home app, as its screen shows it. `held`: the workspace
 * still holds the app; false is a pointer left from before (the landing
 * page shows the Built-in home), with no id or title: only a clear
 * (`landingAppId: null`) makes sense then. `appId` and `title` are named
 * only to a user of the workspace (an Admin user outside it gets null for
 * both). `ready`: a green published build, so the landing page shows it.
 */
export type WorkspaceLandingApp = {
  held: boolean;
  appId: string | null;
  title: string | null;
  ready: boolean;
};

/** PATCH /api/workspaces/:id. Name, description, colour and icon: a
 *  Moderator or an Admin user (one rule: whoever may rename it sets its
 *  look; the built-in workspaces keep their names but take a look). `color`
 *  is a tint key (APP_TINTS), `icon` an emoji or `lucide:<name>` (400
 *  `invalid` otherwise). null clears either; '' clears the icon too (the
 *  folder field's rule), never the colour. Contact and assistant: an Admin
 *  user (assistant: area 'assistants'). The landing page (`landingAppId`): a Moderator of this
 *  workspace only, to an app the workspace holds with a green published
 *  build (409 `landing_app_not_held` or `landing_app_not_ready`). `null`
 *  clears (the Built-in home). Answers the updated Workspace. */
export type WorkspacePatchBody = {
  name?: string;
  description?: string;
  color?: AppTint | null;
  icon?: string | null;
  contactNodeId?: string | null;
  assistantId?: string | null;
  landingAppId?: string | null;
};

/** GET /api/workspaces/:id/archive-preview: what archiving would do.
 *  `itemCount` items have their home here: while it is above 0 the archive
 *  is refused (move them first). `grantCount` items are only shared here and
 *  lose that share. */
export type WorkspaceArchivePreview = { grantCount: number; itemCount: number };

/** POST /api/workspaces/:id/archive answers the archived Workspace plus the
 *  counts it applied. */
export type WorkspaceArchiveResponse = {
  workspace: Workspace;
  grantCount: number;
  itemCount: number;
};

/** POST /api/workspaces/:id/users. */
export type WorkspaceUserAddBody = { loginId: string; moderator?: boolean };

/** PATCH /api/workspaces/:id/users/:loginId. */
export type WorkspaceUserPatchBody = { moderator: boolean };

/** POST, PATCH and DELETE on users answer the workspace screen again. */
export type WorkspaceUsersResponse = WorkspaceDetailResponse;

/** GET /api/workspaces/user-search?q=&offset=: logins by email or name. A
 *  non-Admin Moderator needs at least 3 characters and gets at most 10 (no
 *  paging: offset > 0 answers 400 invalid). An Admin user may send an empty
 *  q (everyone) and gets pages of 50: a full page may have more, so ask
 *  again with offset + 50. Disabled and client logins are left out. */
export type WorkspaceUserSearchHit = { loginId: string; name: string | null; email: string };
export type WorkspaceUserSearchResponse = WorkspaceUserSearchHit[];

/** POST /api/workspaces/:id/resources. */
export type WorkspaceResourceAddBody = {
  kind: WorkspaceResourceKind;
  id: string;
  write?: boolean;
};

/** PATCH /api/workspaces/:id/resources/:kind/:id. */
export type WorkspaceResourcePatchBody = { write: boolean };

/** What /api/shell adds for the signed-in login: its live workspaces (for
 *  the switcher) and its Admin areas ([] when it is not an Admin user). */
export type ShellWorkspace = WorkspaceLook & {
  id: string;
  name: string;
  isAdmin: boolean;
  moderator: boolean;
  /** The login's own private workspace ("<name> (only you)", W6b): match
   *  on this, never on the name (W6b fix round 1). Absent on any other. */
  private?: true;
};
export type ShellWorkspaces = { workspaces: ShellWorkspace[]; areas: WorkspaceArea[] };

/**
 * GET /api/auth/whoami (the phone app's first call with a bearer, workspaces
 * W7e): who the credential is, and the same workspaces, areas and owner
 * flag GET /api/shell gives (its builder). `areas` is empty for a login
 * outside the Admin workspace; `isOwner` is the brain's anchor login.
 * `brainId` is left out only while the database is behind the code.
 */
export type AuthWhoami = {
  role: LoginRole;
  loginId: string;
  email: string;
  displayName: string | null;
  /** Every role's shell route: '/api/shell'. */
  shell: string;
  /** The push routes' base path for this role. */
  pushBase: string;
  brainId?: string;
  workspaces: ShellWorkspace[];
  areas: WorkspaceArea[];
  isOwner: boolean;
};

/** Every `code` a /api/workspaces refusal carries. */
export type WorkspaceErrorCode =
  | 'invalid'
  | 'not_migrated'
  | 'query_too_short'
  | 'not_found'
  | 'forbidden'
  | 'admin_only'
  | 'reserved_name'
  | 'archived'
  | 'admin_workspace'
  | 'built_in'
  | 'workspace_holds_items'
  | 'already_user'
  | 'not_user'
  | 'last_moderator'
  | 'admin_kept'
  | 'owner_stays_admin'
  | 'self_demote'
  | 'client_login'
  | 'assistant_has_history'
  | 'assistant_in_use'
  | 'resource_exists'
  | 'landing_app_not_held'
  | 'landing_app_not_ready'
  | 'rate_limited';

export type WorkspaceError = { error: string; code: WorkspaceErrorCode };
