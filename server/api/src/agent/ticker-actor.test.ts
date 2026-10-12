/**
 * Each tick binds its own actor (workspaces arch A2a, M4): the ticker is
 * started inside runWithoutActor, as a process boot with no actor, so the
 * tick's timer carries none unless the ticker binds system(tick:<name>).
 */
import { describe, expect, it } from 'vitest';
import { currentActor, runWithoutActor, systemActor, type Actor } from '@mantle/db';
import { startTicker, type Ticker } from './ticker';

describe('the ticker (arch A2a)', () => {
  it('runs each tick as system(tick:<name>)', async () => {
    const logger = { log: () => {}, error: () => {} };
    const outside: (Actor | null)[] = [];
    const seen = await new Promise<Actor | null>((resolve) => {
      runWithoutActor(() => {
        outside.push(currentActor());
        const ticker: Ticker = startTicker({
          name: 'Heartbeat tick',
          everyMs: 5,
          logger,
          run: async () => {
            ticker.stop();
            resolve(currentActor());
          },
        });
      });
    });
    expect(outside).toEqual([null]);
    expect(seen).toEqual(systemActor('tick:heartbeat-tick'));
  });
});
