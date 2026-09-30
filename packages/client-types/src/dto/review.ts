/**
 * Member review, the admin side (`/api/team-admin/submissions/*` and the
 * admin's own Accept, `/api/admin/space/:id/accept`): the fields client
 * logins added (C1, audit A28). Additive only: every field is optional on
 * the wire, so an older brain or an older client keeps working.
 */
import type { AccessItemView, AccessLevel } from './access';
import type { TreeCrumb, TreeKind, TreeShareLevel, TreeVisibilityChange } from '../tree';

/** Who wrote a reviewable item: a member or a client login. */
export type ReviewAuthorRole = 'member' | 'client';

/** GET /api/team-admin/submissions: a queue row's `author`. */
export type ReviewAuthorView = {
  loginId: string | null;
  name: string;
  email: string | null;
  /** Deactivated, or the login is gone. */
  inactive: boolean;
  /** Member or client; null when the login is gone. Absent on brains
   *  before client logins C1. */
  role?: ReviewAuthorRole | null;
};

/** GET /api/team-admin/submissions/:id/bundle: what Accept would move. */
export type AcceptPreview = {
  items: { id: string; type: string; title: string }[];
  linksStayingBehind: number;
  /** Brain items in the embed closure of what Accept moves in, with their
   *  CURRENT level. The client shows the ones above the chosen level: they
   *  go DOWN with it and need a tick. */
  closure?: AccessItemView[];
  /** Where it lands by default (folder plan phase 5): the brain folder the
   *  author filed it in (`folderId` null = the kind's top level), and the
   *  author's own folders that become brain folders below it. Absent for a
   *  page (no tree yet) and from brains before the tree. */
  place?: AcceptPlace;
};

export type AcceptPlace = {
  kind: TreeKind;
  folderId: string | null;
  /** The folder's crumbs, top-down, itself included. */
  crumbs: TreeCrumb[];
  creates: string[];
  /** The share it is read at there through a shared folder (null: none):
   *  the item is read at the more open of this and the chosen level. Absent
   *  from brains before the Accept visibility check. */
  share?: TreeShareLevel | null;
};

/** POST /api/team-admin/submissions/:id/accept and
 *  POST /api/admin/space/:id/accept. */
export type AcceptRequest = {
  audience?: AccessLevel;
  parentPageId?: string | null;
  folderPath?: string | null;
  /** Where the item lands (folder plan phase 5): left out, in place; null,
   *  the kind's top level; an id, a brain folder of its kind (the author's
   *  own folders still go below it). The rest of the bundle lands in place. */
  folderId?: string | null;
  /** A client's item at client or public: the admin confirmed the level. */
  lowerConfirmed?: boolean;
  /** Ids of closure items the admin ticked (with `lowerConfirmed: true`).
   *  For a client's item at client or public every closure item that goes
   *  down must be here. */
  confirmedIds?: string[];
  /** The admin saw the `visibility` refusal's list and accepts that those
   *  items are read above the chosen level where they land. */
  visibilityConfirmed?: boolean;
};

/** 409 from either Accept (brains with the Accept visibility check): the item, or something of its
 *  bundle, lands in a shared folder and would be read above the chosen
 *  level there. Nothing moved; repeat with `visibilityConfirmed: true`. */
export type AcceptVisibilityRefusal = {
  error: string;
  reason: 'visibility';
  /** The first changes (at most TREE_VISIBILITY_LIST_MAX): `from` the
   *  chosen level, `to` the level it would be read at. */
  changes: TreeVisibilityChange[];
  total: number;
  /** Brain items the bundle embeds that would be read through it at the
   *  folder's share (migration 0208), `from` now, `to` then. Absent when
   *  there are none, and from brains before it was listed. */
  alsoEmbeds?: TreeVisibilityChange[];
};

/** 409 from either Accept: a client's item at client or public without the
 *  confirmation, or with a closure item that goes down not ticked. */
export type AcceptConfirmLevelRefusal = {
  error: string;
  reason: 'confirm-level';
  /** The brain items that would go down with it (tick each one). */
  goingDown?: AccessItemView[];
};
