/**
 * The update notice every client polls (@mantle/client-types
 * dto/update-notice.ts): the stored "on" and the updater's status, put
 * through the one rule (updateNoticeOn) at read time. Switched only by
 * update_notice_on / update_notice_off (agents and MCP): a switch on a screen
 * would sit behind the notice it turns on.
 */
import type { StoredUpdateNotice, UpdateNoticeView } from '@mantle/client-types';
import { updateNoticeOn } from '@mantle/client-types/update-notice';
import { APP_VERSION } from '@mantle/client-types/version';
import { readUpdateNotice } from '@mantle/content';
import { TtlCache, withTimeout } from '@mantle/std';
import { readUpdaterStatus } from '@/lib/updates';

/** Every signed-in tab polls it: one read per process per 5 s. */
const TTL_MS = 5_000;
/** A read that has not answered by then counts as failed. */
const READ_TIMEOUT_MS = 3_000;

const cache = new TtlCache<'view', Promise<UpdateNoticeView>>({ ttlMs: TTL_MS });

/** The last stored notice this process read: a failed read (the database
 *  restarting under a manual notice) answers it, still under the rule's
 *  version and hour, so it can never hold a box longer than a good read. */
let lastStored: StoredUpdateNotice | undefined;

async function readStored(): Promise<StoredUpdateNotice | undefined> {
  try {
    lastStored = await withTimeout(readUpdateNotice(), READ_TIMEOUT_MS, 'update notice');
  } catch {
    // keep the last good read
  }
  return lastStored;
}

async function read(): Promise<UpdateNoticeView> {
  // Each source on its own: a database that is down mid-roll must not hide
  // the updater's run or a manual "on", and a hung read must not hold every
  // poll.
  const [notice, updater] = await Promise.all([
    readStored(),
    withTimeout(readUpdaterStatus(), READ_TIMEOUT_MS, 'updater status').catch(() => null),
  ]);
  return {
    on: updateNoticeOn({ notice, version: APP_VERSION, updater, now: Date.now() }),
    version: APP_VERSION,
  };
}

/** The view. Fail-soft: anything that throws past the reads answers off, so
 *  a broken read never blocks a box's logins. */
export function updateNoticeView(): Promise<UpdateNoticeView> {
  const hit = cache.get('view');
  if (hit) return hit;
  const view = read().catch(() => ({ on: false, version: APP_VERSION }));
  cache.set('view', view);
  return view;
}
