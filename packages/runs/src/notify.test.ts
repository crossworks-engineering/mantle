/**
 * The approval fan-out seam (WP0). No database, no pg-boss — these pin the
 * two properties the engine depends on: the notice reaches whatever
 * @mantle/tools registered, and NOTHING about it can break a run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyPendingCreated, registerPendingCreatedNotifier } from './notify';

const NOTICE = {
  ownerId: 'owner-1',
  pendingId: 'pending-1',
  toolSlug: 'ask_human',
  args: { question: 'Ship it?', item_id: 'item-1' },
} as const;

describe('pending-created notifier seam', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the notice to the registered implementation', async () => {
    const seen: unknown[] = [];
    registerPendingCreatedNotifier(async (notice) => {
      seen.push(notice);
    });
    await notifyPendingCreated({ ...NOTICE, args: { ...NOTICE.args } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ownerId: 'owner-1',
      pendingId: 'pending-1',
      toolSlug: 'ask_human',
      args: { question: 'Ship it?', item_id: 'item-1' },
    });
  });

  it('swallows a throwing notifier — a failed ping never fails a run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPendingCreatedNotifier(async () => {
      throw new Error('telegram exploded');
    });
    await expect(
      notifyPendingCreated({ ...NOTICE, args: { ...NOTICE.args } }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('last registration wins (module-load idempotence)', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    registerPendingCreatedNotifier(first);
    registerPendingCreatedNotifier(second);
    await notifyPendingCreated({ ...NOTICE, args: { ...NOTICE.args } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
