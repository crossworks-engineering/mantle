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

  it('warns ONCE and drops when nothing is registered', async () => {
    // Module state means this can only be observed on a FRESH module — once
    // any test registers a notifier the slot never empties again. A process
    // that creates questions but cannot announce them is a wiring bug worth
    // seeing, but not worth a log line per question.
    vi.resetModules();
    const fresh = await import('./notify');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      fresh.notifyPendingCreated({ ...NOTICE, args: { ...NOTICE.args } }),
    ).resolves.toBeUndefined();
    await fresh.notifyPendingCreated({ ...NOTICE, args: { ...NOTICE.args } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no pending-created notifier registered/);
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
