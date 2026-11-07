/**
 * The Grant Access panel on the wire: /api/grants. An item is shared by a
 * grant to a workspace; each grant has its own Write switch. Every item has
 * ONE home workspace: only Moderators of the home manage the item's grants.
 * Folders pass their grants to what is inside them (rows "via folder"); a
 * row taken away from a folder-derived grant stays as "Removed here" until
 * restored.
 *
 * Permissions are set in exactly two places: the workspace screen and this
 * panel. Every refusal is `{ error, code }` with 400, 403, 404 or 409; an
 * item or workspace the caller may not see answers 404, never 403.
 *
 * Pure: types only (a workspace chip's look comes from ./workspaces).
 */
import type { WorkspaceLook } from './workspaces';

/** A workspace as the panel names it. */
export type GrantWorkspaceRef = { wsId: string; name: string };

/** One grant row of an item. */
export type GrantRow = {
  wsId: string;
  name: string;
  /** Users of this workspace who are not its Moderators may edit the item. */
  write: boolean;
  /** The item's home: its Moderators manage the item. */
  isHome: boolean;
  /** The folder this row comes from ("via folder X", with "Change here");
   *  null for a grant set on the item. `title` is null when the caller
   *  cannot open that folder. */
  viaFolder: { id: string; title: string | null } | null;
  /** "Removed here": the folder grants this workspace, the item does not
   *  take it (with "Restore"). */
  excluded: boolean;
};

/** An embed of a page, drawing or note that is not granted to every
 *  workspace the item is ("Grant these too"). */
export type GrantEmbed = { nodeId: string; title: string; kind: string };

/** One item on a link's served list. `nodeId` lower-case; `title` null
 *  when the caller cannot read that item (or it is gone). */
export type GrantServedRef = { nodeId: string; title: string | null };

/** A contact the item is shared with (the same shape as the Access
 *  control's AccessContactShare). */
export type GrantContactShare = {
  shareId: string;
  contactId: string;
  name: string;
  canWrite: boolean;
  sharingOn: boolean;
  lastOpenedAt: string | null;
  /** Server-relative: `/s/<token>`. */
  path: string;
};

/** GET /api/grants/:nodeId (an item or a folder). */
export type GrantsResponse = {
  item: { id: string; title: string; type: string };
  /** Both null when the caller is not a user of the home workspace (and
   *  not an Admin user): a home the caller may not name is not identified. */
  home: { wsId: string | null; name: string | null };
  /** The home first, then by name. Only rows of workspaces the caller is a
   *  user of, unless it is an Admin user or manages the item. */
  rows: GrantRow[];
  /** "Add workspace": live workspaces where the caller is a Moderator that
   *  the item is not granted to yet. Empty unless `mayManage`. */
  addable: GrantWorkspaceRef[];
  /** The caller moderates the item's home. */
  mayManage: boolean;
  /** The caller may open or close the item's public link: the item can
   *  carry one, and the caller may edit it (an app: home Moderator). */
  mayLink: boolean;
  /** A live open link exists (the "Public" pill). */
  hasLink: boolean;
  /** The open link, only when `mayLink`, with its served list (plan 8.1:
   *  the items the link shows besides its own, in the list's order). Changed
   *  by PATCH /api/shares/:id { serve }, which takes the ids. A new embed of
   *  an item that already has a link is NOT served until it is ticked
   *  (decision 12): it shows in `serveCandidates`, not here. */
  link: { id: string; path: string; served: GrantServedRef[] } | null;
  /** What the caller may put on the link's served list: the items this item
   *  names or embeds (a folder: the first 500 items under it that the
   *  caller may edit) that the caller may edit, by title; the ones already
   *  served among them. Empty unless `mayLink`. The same rule POST
   *  /api/shares and PATCH /api/shares/:id { serve } check. */
  serveCandidates: GrantEmbed[];
  /** The contacts it is shared with: only for an Admin user who `mayLink`,
   *  on a kind that takes contact shares; else null. */
  contactShares: GrantContactShare[] | null;
  /** Pages, drawings and notes: what they embed that is not granted to
   *  every workspace the item is (only embeds the caller may open). */
  embedsNotGranted: GrantEmbed[];
  /** Apps only. MCP access is written by PATCH /api/apps/:id. */
  app?: { mcpAccess: boolean };
  /** Folders, when the caller may add items there: every workspace a new
   *  item placed in it takes (its rows not removed there, the home's
   *  included), named even where the caller is not a user. */
  placesInto?: GrantWorkspaceRef[];
};

/** A write answers the panel again, or `{ visible: false }` when the caller
 *  no longer reads the item after its own change. */
export type GrantsWriteResponse = GrantsResponse | { visible: false };

/** POST /api/grants/:nodeId: add a grant ("Add workspace"). A folder, or an
 *  app gaining a holder, needs `confirm: true` (409 confirm_required). */
export type GrantAddBody = { wsId: string; write?: boolean; confirm?: boolean };

/** PATCH /api/grants/:nodeId/:wsId: the Write switch. A folder needs
 *  `confirm: true`. */
export type GrantPatchBody = { write: boolean; confirm?: boolean };

/** DELETE /api/grants/:nodeId/:wsId (a folder-derived row becomes "Removed
 *  here"), POST .../restore and POST .../hand ("Change here") take
 *  `?confirm=1` for a folder. */

/** POST /api/grants/:nodeId/embeds: grant the listed embeds to these
 *  workspaces (each must hold the item). */
export type GrantEmbedsBody = { wsIds: string[]; confirm?: boolean };

/** Pairs an embeds grant left out, and why. */
export type GrantEmbedSkip = { nodeId: string; wsId: string; code: GrantErrorCode };

export type GrantEmbedsResponse = GrantsWriteResponse & { skipped: GrantEmbedSkip[] };

/** GET /api/grants/:nodeId/preview?add=<ws>&remove=<ws>: how many items
 *  (the item, and for a folder everything inside it) would gain or lose
 *  that workspace. The caller must be allowed the change itself (add: home
 *  Moderator and Moderator of the target; remove: either), else 403.
 *  `tooBig` when a folder holds more than the limit (the change then
 *  answers 409 too_big). `app` for an app with `add`: what the new holder
 *  would see (rows null when the app has no database yet or it cannot be
 *  read). */
export type GrantPreviewResponse = {
  gain: number;
  /** Apps among `gain`: each also narrows what it reads (21.8 row 13). */
  gainApps: number;
  lose: number;
  total: number;
  /** Items in the folder the caller cannot open, counted in `total`,
   *  `gain` and `lose` all the same ("N items, some you cannot open"). */
  hidden: number;
  tooBig: boolean;
  app?: { rows: number | null; exportedTables: number };
};

/** POST /api/grants/move/preview and POST /api/grants/move: change the home
 *  (`toWorkspaceId`: Moderator of the old home and of the new one) or the
 *  folder (`toFolderId`, null = the kind's root: items only, of one tree
 *  kind). `keepReadableIn` (the old home only) keeps a read grant there.
 *
 *  `withContents` (a home move of one folder, with `confirm` and
 *  `fromWorkspaceId`, the home the caller saw on it: 409 `changed` once the
 *  folder has another): the items below the folder that share its old home
 *  move too, each on its own by the same rules and the same
 *  `keepReadableIn`. An item stays when it is homed elsewhere, of a kind the
 *  new home may not hold, "Removed here" for the new home (on it or on a
 *  folder it is in), or in a folder the caller cannot open. At most 200 of
 *  them move per call, deepest first; while `contents.remaining` is above
 *  0, call again with the same body. The folder itself moves in the call
 *  that moves the last of them. */
export type GrantMoveBody = {
  nodeIds: string[];
  toWorkspaceId?: string;
  toFolderId?: string | null;
  keepReadableIn?: string;
  confirm?: boolean;
  withContents?: boolean;
  fromWorkspaceId?: string;
};

/** What a home move of a folder with its contents takes along (the
 *  preview with `withContents`). */
export type GrantMoveContentsPreview = {
  /** The items below the folder with its home: they move with it. */
  move: number;
  /** Apps among `move`: each new holder sees its data (21.8 row 13). */
  apps: number;
  /** The items below it homed in another workspace (not the target): they
   *  stay where they are. `hidden` included. */
  otherHome: number;
  /** The items with its home of a kind the target may not hold: they stay. */
  notAllowed: number;
  /** The items with its home that the target was removed from by hand
   *  ("Removed here", on them or on a folder they are in), or that sit in
   *  a folder the caller cannot open: they stay. */
  removedHere: number;
  /** Of `otherHome`, the items the caller cannot open. */
  hidden: number;
  /** How many calls the move takes (200 items per call). */
  calls: number;
};

export type GrantMovePreviewResponse = {
  alsoVisibleTo: GrantWorkspaceRef[];
  removedFrom: GrantWorkspaceRef[];
  /** A home move of one folder with `withContents`. */
  contents?: GrantMoveContentsPreview;
};

/** One item a folder's move left where it was: another home, or a kind
 *  the new home may not hold. */
export type GrantMoveLeftAlone = {
  id: string;
  title: string;
  reason: 'other_home' | 'kind_not_allowed' | 'removed_here' | 'hidden_folder';
};

export type GrantMoveResponse = {
  /** Every item moved by this call (a folder's contents and the folder). */
  moved: number;
  failed: Array<{ id: string; error: string }>;
  /** A home move of a folder with `withContents`. */
  contents?: {
    /** Items below the folder moved by this call. */
    moved: number;
    /** Items this call did not get to (200 per call, or a failure that
     *  ended the call): call again with the same body. The folder itself
     *  has not moved while this is above 0. */
    remaining: number;
    /** The items left where they are, the first 200 (`hidden` ones never
     *  named). */
    leftAlone: GrantMoveLeftAlone[];
    /** All of them, `hidden` included. */
    leftAloneCount: number;
    /** Items below the folder the caller cannot open: they stay. */
    hidden: number;
  };
};

/** Every `code` a /api/grants refusal carries. */
export type GrantErrorCode =
  | 'invalid'
  | 'not_migrated'
  | 'not_found'
  | 'forbidden'
  | 'already_granted'
  | 'not_granted'
  | 'not_excluded'
  | 'not_derived'
  | 'derived_row'
  | 'home_row'
  | 'kind_not_allowed'
  | 'confirm_required'
  | 'too_big'
  | 'same_home'
  | 'mixed_kinds'
  /** A folder's contents item whose home or folder changed while the
   *  folder moved: it stays. */
  | 'changed';

export type GrantError = { error: string; code: GrantErrorCode };

// ── Lists ────────────────────────────────────────────────────────────────────

/** A workspace chip on a list row, with the workspace's look (its colour
 *  and icon, WorkspaceLook) from a brain that has one. */
export type ListWorkspace = WorkspaceLook & { id: string; name: string };

/**
 * What the caller may do with an item, and what the item is: on every list row and item response of pages, notes, drawings,
 * tables, files and apps, on the tree's items and folders, and on GET
 * /api/nodes/:id. Set by the server on each of those; optional in the type
 * only so older shapes still parse.
 */
export type ItemCaps = {
  /** The caller may change it (a Moderator of its home, or a grant with
   *  Write on, in the caller's own workspaces); never for a read-only copy. */
  mayEdit?: boolean;
  /** The caller may delete or move it (a Moderator of its home). */
  mayManage?: boolean;
  /** A read-only snapshot copy of an accepted item (data.snapshot_of):
   *  nobody edits it, moves it out of its private workspace or shares it;
   *  its author may delete it. Absent on every other item. */
  readOnly?: true;
  /** The brain item a read-only copy copies (the accepted item). */
  snapshotOf?: string;
  /** A member app that was in its author's trash when the personal spaces
   *  were folded into workspaces: show it as "was in your trash" with
   *  Delete. */
  trashedBeforeFold?: true;
};

/** What every row of GET /api/pages and /api/notes, and every item and
 *  folder of GET /api/tree/:kind (its search and marks too), carries. */
export type ListChips = ItemCaps & {
  /** The workspaces that read the item (its read_ws) and that the caller is
   *  a user of; all of them for an Admin user. Live workspaces only, by
   *  name. */
  workspaces: ListWorkspace[];
  /** A live open public link exists (the "Public" pill). */
  hasLink: boolean;
};

/** A list asked with `?ws=<id>` keeps only the items that workspace reads
 *  and echoes the id as a top-level `ws` (absent when not asked). A
 *  workspace the caller is not a user of, unless an Admin user, answers 404
 *  `{ error, code: 'not_found' }`. */
export type ListWsEcho = { ws?: string };
