/**
 * The worker shell binds its own actor (workspaces arch A2a, M4): a worker
 * process starts with none, so the test runs the shell's start inside
 * runWithoutActor (a test otherwise runs as system(test)). What setup starts
 * later, a timer here, carries the same actor.
 */
import { describe, expect, it } from 'vitest';
import { currentActor, runWithoutActor, systemActor, type Actor } from '@mantle/db';
import { startWorkerAs } from './_runner';

describe('the worker shell (arch A2a)', () => {
  it('runs setup, and what it starts, as system(worker:<name>)', async () => {
    const seen: (Actor | null)[] = [];
    await runWithoutActor(() => {
      seen.push(currentActor());
      return startWorkerAs('calendar-sync', async () => {
        seen.push(currentActor());
        await new Promise<void>((done) =>
          setTimeout(() => {
            seen.push(currentActor());
            done();
          }, 1),
        );
      });
    });
    const worker = systemActor('worker:calendar-sync');
    expect(seen).toEqual([null, worker, worker]);
  });
});
