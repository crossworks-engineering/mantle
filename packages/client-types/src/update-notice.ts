/**
 * Whether the update notice is on (dto/update-notice.ts), worked out at read
 * time from what is stored and what the updater says. Nothing clears the
 * stored value: a forgotten "off" stops counting by itself, so no reaper or
 * boot step can fail to run and leave a box's logins locked out.
 */
import type { StoredUpdateNotice } from './dto/update-notice';

/** The longest a notice counts: a manual "on", or an updater run. */
export const UPDATE_NOTICE_MAX_MS = 60 * 60 * 1000;

/** The updater phases that count as an update in progress (its status.json). */
const UPDATER_BUSY = new Set(['pulling', 'rolling']);

/** The stored value, or undefined for anything else (pure). */
export function projectUpdateNotice(v: unknown): StoredUpdateNotice | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { setAt, version } = v as Record<string, unknown>;
  if (typeof setAt !== 'string' || typeof version !== 'string' || !version) return undefined;
  if (!Number.isFinite(Date.parse(setAt))) return undefined;
  return { setAt, version };
}

/** When a manual "on" stops counting (ms), or null when it counts not at
 *  all: set on another version, or already past its hour (pure). */
export function manualNoticeUntil(
  notice: StoredUpdateNotice | undefined,
  version: string,
  now: number,
): number | null {
  if (!notice || notice.version !== version) return null;
  const until = Date.parse(notice.setAt) + UPDATE_NOTICE_MAX_MS;
  return until > now ? until : null;
}

/** The updater is pulling or rolling, and started within the hour (an
 *  updater that died mid-run leaves its status behind) (pure). */
export function updaterBusy(
  updater: { phase: string; startedAt: string | null } | null | undefined,
  now: number,
): boolean {
  if (!updater || !UPDATER_BUSY.has(updater.phase) || !updater.startedAt) return false;
  const started = Date.parse(updater.startedAt);
  return Number.isFinite(started) && now - started < UPDATE_NOTICE_MAX_MS;
}

/** Whether every login sees the notice (pure). */
export function updateNoticeOn(input: {
  notice: StoredUpdateNotice | undefined;
  version: string;
  updater: { phase: string; startedAt: string | null } | null | undefined;
  now: number;
}): boolean {
  return (
    manualNoticeUntil(input.notice, input.version, input.now) !== null ||
    updaterBusy(input.updater, input.now)
  );
}
