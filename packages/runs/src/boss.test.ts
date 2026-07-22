/**
 * Action routing (WP0). `enqueueRunActions` now handles TWO kinds of thing:
 * pg-boss jobs, and the advisory approval fan-out. These pin the split, which
 * nothing else covers — the engine suite that exercises the emission is
 * DB-gated and skips in CI, and a `pending_created` leaking into the job loop
 * would call `boss.send(undefined, …)`, throw, and be swallowed by
 * `enqueueRunActionsSafe` — silently dropping every REAL dispatch batched
 * alongside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Static: `queues` needs no mocking, and importing it dynamically widened the
// queue-name literals to `string`, which no longer satisfy PostCommitAction.
import { RUN_RESUME_QUEUE, RUN_TOOL_QUEUE, RUN_WORKER_QUEUE } from './queues';
import type { PostCommitAction } from './engine';

const sent: Array<{ queue: string; data: unknown; opts: unknown }> = [];
const notified: Array<Record<string, unknown>> = [];
let sendImpl: (queue: string, data: unknown, opts: unknown) => Promise<void>;

// pg-boss 12 is ESM-only and exports PgBoss as a NAMED export — there is no
// default. The stand-in has to match that shape or the source's
// `import { PgBoss }` resolves to undefined.
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on() {}
    async start() {}
    async createQueue() {}
    async send(queue: string, data: unknown, opts: unknown) {
      sent.push({ queue, data, opts });
      await sendImpl(queue, data, opts);
    }
  },
}));

vi.mock('./notify', () => ({
  notifyPendingCreated: vi.fn(async (n: Record<string, unknown>) => {
    notified.push(n);
  }),
}));

const { enqueueRunActions, enqueueRunActionsSafe } = await import('./boss');

const NOTICE: PostCommitAction = {
  type: 'pending_created',
  ownerId: 'owner-1',
  pendingId: 'row-1',
  toolSlug: 'ask_human',
  args: { question: 'Ship it?' },
};
const DISPATCH: PostCommitAction = {
  type: 'dispatch',
  queue: RUN_TOOL_QUEUE,
  itemId: 'item-1',
  sideEffecting: false,
};

beforeEach(() => {
  sent.length = 0;
  notified.length = 0;
  sendImpl = async () => {};
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
});

describe('enqueueRunActions routing', () => {
  it('sends a notice to the notifier and NEVER to pg-boss', async () => {
    await enqueueRunActions([NOTICE]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ pendingId: 'row-1', toolSlug: 'ask_human' });
    // The load-bearing half: no job was created for it.
    expect(sent).toHaveLength(0);
  });

  it('routes a mixed batch both ways without losing either', async () => {
    const batch: PostCommitAction[] = [
      NOTICE,
      DISPATCH,
      { type: 'resume', runId: 'run-1', groupId: 'group-1' },
      { type: 'dispatch', queue: RUN_WORKER_QUEUE, itemId: 'item-2', sideEffecting: true },
    ];
    await enqueueRunActions(batch);
    expect(notified).toHaveLength(1);
    expect(sent.map((s) => s.queue)).toEqual([RUN_TOOL_QUEUE, RUN_RESUME_QUEUE, RUN_WORKER_QUEUE]);
    // Side-effecting items stay exempt from transport retries (§5b).
    expect(sent[2]!.opts).toMatchObject({ retryLimit: 0 });
    expect(sent[1]!.opts).toMatchObject({ singletonKey: 'group-1' });
  });

  it('a notice alone never opens a pg-boss connection', async () => {
    // A brain whose boss is sick must still announce its questions, so the
    // notice path must not depend on getSendBoss() succeeding.
    sendImpl = async () => {
      throw new Error('boss should not be reached for a notice-only batch');
    };
    await expect(enqueueRunActions([NOTICE])).resolves.toBeUndefined();
    expect(notified).toHaveLength(1);
  });

  it('does not await the fan-out (a hung notifier cannot stall the caller)', async () => {
    // The regression this guards: awaited, one unreachable Telegram call
    // holds an answered question in the decided-but-unsettled window until
    // the sweep reverts a decision that already applied.
    const notify = await import('./notify');
    let release: (() => void) | undefined;
    vi.mocked(notify.notifyPendingCreated).mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    let returned = false;
    await enqueueRunActions([NOTICE]).then(() => (returned = true));
    expect(returned).toBe(true); // resolved while the notifier is still pending
    release?.();
  });

  it('enqueueRunActionsSafe swallows a pg-boss failure', async () => {
    sendImpl = async () => {
      throw new Error('boss down');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(enqueueRunActionsSafe([DISPATCH])).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('is a no-op on an empty batch', async () => {
    await enqueueRunActions([]);
    expect(sent).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});
