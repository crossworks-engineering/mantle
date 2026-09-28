/**
 * The Access control's wire shapes (`/api/access/nodes/:id`). One level
 * system: admin > team > client > public. A caller sees what is at or below
 * its level. The level is the truth and the item's share link follows it:
 * none at admin or team (members read team items with their own logins), an
 * open link at client and public. See docs/access-levels.md.
 */
import type { ShareMode } from './rows';

/** Highest first: the order the control shows them in. */
export const ACCESS_LEVELS = ['admin', 'team', 'client', 'public'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** One item as the Access control lists it (the item itself or its closure). */
export type AccessItemView = {
  id: string;
  type: string;
  title: string;
  audience: AccessLevel;
};

/** The item's link. `path` is server-relative (`/s/<token>`). */
export type AccessLinkView = {
  id: string;
  token: string;
  path: string;
  mode: ShareMode;
  /** Page links only: sub-pages are shared with it. */
  cascade: boolean;
};

/** GET /api/access/nodes/:id */
/** Who wrote a brain item, when a member wrote it and an admin accepted it
 *  (member logins Phase 4): the member-authored badge. `name` is the login's
 *  display name ("A member" without one, "Removed member" once deleted). */
export type MemberItemAuthor = { name: string; acceptedAt: string | null };

export type AccessNodeView = {
  item: AccessItemView;
  /** What the item's link or embeds need, each at its own level. For a page,
   *  drawing or note: what it embeds (images, files, drawings, child pages,
   *  transitively), which goes down with it when it is lowered (0.232.311
   *  on; before that it only did on "Lower them too"). For a folder: its
   *  contents, which keep their own levels. */
  closure: AccessItemView[];
  share: AccessLinkView | null;
  /** Descendant pages (pages only; 0 otherwise). */
  childCount: number;
  /** Only workspace kinds go below admin (tasks, events, … are admin only). */
  canLower: boolean;
  /** Whether the item can carry a link (a folder only under `files`). */
  canLink: boolean;
  /** True for a page, drawing or note: lowering it lowers its embeds with it
   *  (embedding means sharing), so the control says what will be shared
   *  instead of offering "Lower them too". False for a folder, whose
   *  contents keep their levels. Absent from brains before 0.232.311, which
   *  lower embeds only on request. */
  embedsFollow?: boolean;
  /** Set when a member wrote it and an admin accepted it into the brain (the
   *  member-authored badge). Absent from brains before 0.232.285. */
  author?: MemberItemAuthor | null;
};

/** One item that went down with the item that embeds it. */
export type AccessLoweredView = {
  id: string;
  type: string;
  title: string;
  from: AccessLevel;
  to: AccessLevel;
};

/** PATCH /api/access/nodes/:id { audience, withClosure?, raiseClosure? }.
 *  `withClosure` only matters for a folder (its contents); a page's,
 *  drawing's or note's embeds always follow it down. */
export type AccessNodeUpdate = {
  item: AccessItemView;
  /** Everything lowered with it, at its new level: the embeds that followed
   *  it and, with `withClosure`, a folder's contents. */
  lowered: AccessItemView[];
  /** The embeds that followed it down, with the level each left and took.
   *  Absent from brains before 0.232.311. */
  alsoLowered?: AccessLoweredView[];
  /** Closure items still above the new level: an embed that can never go
   *  below admin, or a folder's contents when not `withClosure`. */
  stillAbove: AccessItemView[];
  /** Closure items raised with it (only when `raiseClosure`). Absent from
   *  brains before 0.232.264. */
  raised?: AccessItemView[];
  /** Closure items still below the new level (when not `raiseClosure`).
   *  Absent from brains before 0.232.264. */
  stillBelow?: AccessItemView[];
  share: AccessLinkView | null;
};
