/**
 * The client chat queue (client logins C4, plan section 8): its own queue,
 * partitioned by client login with ONE turn in flight per login, under a
 * global cap. The web route enqueues with `queuePartitionKey` = the login
 * (client-chat-route.test.ts); this pins the queue side.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('client turn queue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('one turn in flight per client login, two across all clients by default', async () => {
    vi.stubEnv('MANTLE_CLIENT_TURN_CONCURRENCY', '');
    const { clientTurnQueueParams } = await import('./config');
    expect(clientTurnQueueParams()).toEqual({ globalConcurrency: 2, partitionConcurrency: 1 });
  }, 60_000); // imports ./config (the DBOS SDK): slow while the whole suite runs in parallel

  it('the global cap follows MANTLE_CLIENT_TURN_CONCURRENCY; the per-login cap does not', async () => {
    vi.stubEnv('MANTLE_CLIENT_TURN_CONCURRENCY', '5');
    const { clientTurnQueueParams } = await import('./config');
    expect(clientTurnQueueParams()).toEqual({ globalConcurrency: 5, partitionConcurrency: 1 });
  }, 60_000); // imports ./config (the DBOS SDK): slow while the whole suite runs in parallel

  it('the api registers the client queue with those parameters and the client workflow', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/registerQueue\(CLIENT_TURN_QUEUE, clientTurnQueueParams\(\)\)/);
    expect(main).toContain("import './workflows/client-turn';");
  });
});
