/**
 * Workspace management on the wire (workspaces plan page 4887b8e7, phase
 * W5a): /api/workspaces and the two fields /api/shell adds. Users are flat;
 * every permission is set on a workspace screen (users, Moderator ticks,
 * resources) or, from W5b, on an item's Grant Access panel.
 *
 * Every refusal is `{ error, code }` with 400, 403, 404 or 409. A workspace
 * or login the caller may not see answers 404, never 403.
 */

/** The Admin areas (plan 1.4). An Admin workspace user has all of them
 *  unless a per-user switch turns one off (none can be switched off yet). */
export type WorkspaceArea = 'settings' | 'users' | 'assistants' | 'connectors' | 'keys';

export const WORKSPACE_AREAS: readonly WorkspaceArea[] = [
  'settings',
  'users',
  'assistants',
  'connectors',
  'keys',
];

/** One workspace as a list row and as the head of its screen. */
export type Workspace = {
  id: string;
  name: string;
  description: string;
  /** A contact node: who this workspace represents. Information only. */
  contactNodeId: string | null;
  /** The workspace's one assistant, if any. */
  assistant: { id: string; name: string } | null;
  /** The Admin workspace: its users manage the brain (requireArea). */
  isAdmin: boolean;
  /** Admin or Team, the built-in workspaces: they cannot be renamed or
   *  archived (hide Rename and Archive there). Their connectors are
   *  attached here like any workspace's since W5b2. */
  builtIn: boolean;
  /** Every Admin workspace user is a Moderator here (the Team workspace);
   *  only an Admin user may remove or demote one of them. */
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
  /** A Moderator here because they are an Admin user and the workspace is
   *  Admin-moderated: nobody may remove or demote them here (409
   *  admin_kept); they stop being one by leaving the Admin workspace. */
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
};

/** PATCH /api/workspaces/:id. Name and description: a Moderator or an Admin
 *  user. Contact and assistant: an Admin user (assistant: area
 *  'assistants'). `null` clears. Answers the updated Workspace. */
export type WorkspacePatchBody = {
  name?: string;
  description?: string;
  contactNodeId?: string | null;
  assistantId?: string | null;
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
export type ShellWorkspace = { id: string; name: string; isAdmin: boolean; moderator: boolean };
export type ShellWorkspaces = { workspaces: ShellWorkspace[]; areas: WorkspaceArea[] };

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
  | 'rate_limited';

export type WorkspaceError = { error: string; code: WorkspaceErrorCode };
