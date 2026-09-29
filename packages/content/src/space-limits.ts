/**
 * What one personal space may hold and do, by the login's role (client
 * logins C5, plan section 9 and N12). A member's space keeps the limits of
 * member logins Phase 2; a client's is smaller, every client space counts
 * against one brain-wide total, and a client may submit only so much.
 *
 * The role is never taken from the caller: withSpace sets the scope's level
 * from the login's row (team for an admin or a member, client for a client),
 * and these limits read that level.
 */
import { currentSpaceScope, currentViewerLevel } from '@mantle/db';

export type SpaceLimits = {
  /** One upload's ceiling. */
  fileMaxBytes: number;
  /** Everything the space holds on disk: file bytes plus table workbooks. */
  storageBytes: number;
  /** New file bytes the space may take in 24 hours. */
  dailyUploadBytes: number;
  /** Items the space may hold (its own per-kind folders do not count). */
  itemLimit: number;
  /** Submissions in 24 hours (the ledger, so Recall cannot reset it);
   *  null = no cap. */
  submitsPerDay: number | null;
  /** Items submitted and not yet accepted or returned; null = no cap. */
  openSubmissions: number | null;
};

const MB = 1024 * 1024;

/** A member's (and an admin's own) space: the Phase 2 limits. */
export const MEMBER_SPACE_LIMITS: SpaceLimits = {
  fileMaxBytes: 100 * MB,
  storageBytes: 2 * 1024 * MB,
  dailyUploadBytes: 500 * MB,
  itemLimit: 2000,
  submitsPerDay: null,
  openSubmissions: null,
};

/** A client's space (plan section 9): lower on every axis, and capped
 *  submissions (10 a day, 50 open per client login). */
export const CLIENT_SPACE_LIMITS: SpaceLimits = {
  fileMaxBytes: 20 * MB,
  storageBytes: 200 * MB,
  dailyUploadBytes: 50 * MB,
  itemLimit: 500,
  submitsPerDay: 10,
  openSubmissions: 50,
};

/** What ALL client spaces of the brain may hold together (N12). */
export const CLIENT_SPACES_TOTAL_BYTES = 5 * 1024 * MB;

/** Whether the current personal-space scope is a client's. Outside a space
 *  scope this is false (the callers all run inside one). */
export function inClientSpace(): boolean {
  return currentSpaceScope() !== null && currentViewerLevel() === 'client';
}

/** The limits of the current personal-space scope, by its login's role. */
export function spaceLimits(): SpaceLimits {
  return inClientSpace() ? CLIENT_SPACE_LIMITS : MEMBER_SPACE_LIMITS;
}
