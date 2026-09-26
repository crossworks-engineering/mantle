/**
 * The Access control's wire shapes (`/api/access/nodes/:id`). One level
 * system: admin > team > client > public. A caller sees what is at or below
 * its level. The level is the truth and the item's share link follows it:
 * none at admin, a team-only link at team (the team workspace opens items
 * through it), an open link at client and public. See docs/access-levels.md.
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
export type AccessNodeView = {
  item: AccessItemView;
  /** What the item's link or embeds need: a page's files and drawings, a
   *  folder's contents, a drawing's images. Each carries its own level. */
  closure: AccessItemView[];
  share: AccessLinkView | null;
  /** Descendant pages (pages only; 0 otherwise). */
  childCount: number;
  /** Only workspace kinds go below admin (tasks, events, … are admin only). */
  canLower: boolean;
  /** Whether the item can carry a link (a folder only under `files`). */
  canLink: boolean;
};

/** PATCH /api/access/nodes/:id { audience, withClosure?, raiseClosure? } */
export type AccessNodeUpdate = {
  item: AccessItemView;
  /** Closure items lowered with it (only when `withClosure`). */
  lowered: AccessItemView[];
  /** Closure items still above the new level (when not `withClosure`). */
  stillAbove: AccessItemView[];
  /** Closure items raised with it (only when `raiseClosure`). Absent from
   *  brains before 0.232.264. */
  raised?: AccessItemView[];
  /** Closure items still below the new level (when not `raiseClosure`).
   *  Absent from brains before 0.232.264. */
  stillBelow?: AccessItemView[];
  share: AccessLinkView | null;
};
