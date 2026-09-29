/**
 * Member review, the admin side (`/api/team-admin/submissions/*` and the
 * admin's own Accept, `/api/admin/space/:id/accept`): the fields client
 * logins added (C1, audit A28). Additive only: every field is optional on
 * the wire, so an older brain or an older client keeps working.
 */
import type { AccessItemView, AccessLevel } from './access';

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
};

/** POST /api/team-admin/submissions/:id/accept and
 *  POST /api/admin/space/:id/accept. */
export type AcceptRequest = {
  audience?: AccessLevel;
  parentPageId?: string | null;
  folderPath?: string | null;
  /** A client's item at client or public: the admin confirmed the level. */
  lowerConfirmed?: boolean;
  /** Ids of closure items the admin ticked (with `lowerConfirmed: true`).
   *  For a client's item at client or public every closure item that goes
   *  down must be here. */
  confirmedIds?: string[];
};

/** 409 from either Accept: a client's item at client or public without the
 *  confirmation, or with a closure item that goes down not ticked. */
export type AcceptConfirmLevelRefusal = {
  error: string;
  reason: 'confirm-level';
  /** The brain items that would go down with it (tick each one). */
  goingDown?: AccessItemView[];
};
