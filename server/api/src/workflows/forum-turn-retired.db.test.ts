/**
 * A forum turn left on a box's DBOS queue when it upgrades (member logins
 * Phase 6) ends cleanly on a real DBOS: the runner registers only the retired
 * stub under the old name and no longer registers the forum queue, the
 * queue's row (as an older release left it) still dispatches, and the turn
 * finishes in SUCCESS instead of failing to find its function and staying
 * PENDING for every later boot.
 *
 * Its own DBOS system database on the test server, dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/workflows/forum-turn-retired.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;

// The brain side of the stub (failing a pending reply, the archive export) is
// covered on Postgres by packages/content/src/forum/export.db.test.ts; here it
// is stubbed so the test is only about DBOS.
vi.mock('@mantle/content', () => ({ failPendingForumReplies: vi.fn(async () => 1) }));
vi.mock('../forum-archive-boot', () => ({ runForumArchiveBootTask: vi.fn(async () => {}) }));
vi.mock('@mantle/runtime/assistant', async () => ({
  RETIRED_FORUM_TURN_WORKFLOW: (await import('../../../../packages/runtime/src/assistant/contract'))
    .RETIRED_FORUM_TURN_WORKFLOW,
}));

describe.skipIf(!URL_)('a leftover forum turn on a real DBOS', () => {
  const sysDbName = `dbos_forumstub_${randomUUID().slice(0, 8)}`;
  const sysUrl = (() => {
    const u = new URL(URL_ ?? 'postgres://x@localhost/x');
    u.pathname = `/${sysDbName}`;
    return u.toString();
  })();
  let DBOS: typeof import('@dbos-inc/dbos-sdk').DBOS;
  let client: import('@dbos-inc/dbos-sdk').DBOSClient;

  beforeAll(async () => {
    const sdk = await import('@dbos-inc/dbos-sdk');
    DBOS = sdk.DBOS;
    DBOS.setConfig({
      name: 'mantle-api',
      systemDatabaseUrl: sysUrl,
      applicationVersion: 'mantle-runner-1',
      logLevel: 'error',
      runAdminServer: false,
    });
    // What server/api/src/main.ts does: import the stub for its registration.
    await import('./forum-turn-retired');
    await DBOS.launch();
    // The queue row an older release left behind (it registered the forum
    // queue at every boot; this release does not).
    await DBOS.registerQueue('mantle_forum', { concurrency: 1, partitionQueue: true });
    client = await sdk.DBOSClient.create({ systemDatabaseUrl: sysUrl });
  }, 60_000);

  afterAll(async () => {
    await client?.destroy();
    await DBOS?.shutdown();
    const postgres = (await import('postgres')).default;
    const admin = postgres(URL_!, { max: 1 });
    await admin.unsafe(`drop database if exists "${sysDbName}" with (force)`);
    await admin.end();
  });

  it('runs the retired stub under the old name and ends in SUCCESS', async () => {
    const workflowID = `team-${randomUUID()}.${randomUUID()}`;
    const topicId = randomUUID();
    await client.enqueue(
      {
        workflowName: 'forumTurnWorkflow',
        queueName: 'mantle_forum',
        workflowID,
        queuePartitionKey: topicId,
      },
      // The input shape the forum routes enqueued before Phase 6.
      {
        ownerId: randomUUID(),
        options: { contactId: randomUUID(), topicId, inboundPostId: randomUUID(), streamId: 'x' },
      },
    );
    const result = await Promise.race([
      client.retrieveWorkflow(workflowID).getResult(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the forum turn never finished')), 30_000),
      ),
    ]);
    expect(result).toEqual({ retired: true, failedReplies: 1 });
    expect((await client.getWorkflow(workflowID))?.status).toBe('SUCCESS');
  }, 45_000);
});
