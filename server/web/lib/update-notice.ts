/**
 * The update notice every client polls (@mantle/client-types
 * dto/update-notice.ts): the stored "on" and the updater's status, put
 * through the one rule (updateNoticeOn) at read time. Switched only by
 * update_notice_on / update_notice_off (agents and MCP): a switch on a screen
 * would sit behind the notice it turns on.
 */
import type { UpdateNoticeView } from '@mantle/client-types';
import { updateNoticeOn } from '@mantle/client-types/update-notice';
import { APP_VERSION } from '@mantle/client-types/version';
import { readUpdateNotice } from '@mantle/content';
import { TtlCache } from '@mantle/std';
import { readUpdaterStatus } from '@/lib/updates';

/** Every signed-in tab polls it: one read per process per 5 s. */
const TTL_MS = 5_000;

const cache = new TtlCache<'view', Promise<UpdateNoticeView>>({ ttlMs: TTL_MS });

async function read(): Promise<UpdateNoticeView> {
  const [notice, updater] = await Promise.all([readUpdateNotice(), readUpdaterStatus()]);
  return {
    on: updateNoticeOn({ notice, version: APP_VERSION, updater, now: Date.now() }),
    version: APP_VERSION,
  };
}

/** The view, fail-soft (off) when the brain cannot read its own state, so a
 *  broken read never blocks a box's logins. */
export function updateNoticeView(): Promise<UpdateNoticeView> {
  const hit = cache.get('view');
  if (hit) return hit;
  const view = read().catch(() => ({ on: false, version: APP_VERSION }));
  cache.set('view', view);
  return view;
}
