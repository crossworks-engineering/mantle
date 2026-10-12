/**
 * The agent runtime's LISTEN handlers bind their own actor (workspaces arch
 * A2a, M4): a notification arrives on the listen connection's socket with
 * no actor, so the handler is called inside runWithoutActor and must run as
 * system(listen:<channel>), what it starts too.
 */
import { describe, expect, it, vi } from 'vitest';

// runtime.ts reads it at import (it opens nothing until the boot).
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
});
import { currentActor, runWithoutActor, systemActor, type Actor } from '@mantle/db';
import { listenAs } from './runtime';

describe('the runtime LISTEN handlers (arch A2a)', () => {
  it('run each notification as system(listen:<channel>)', async () => {
    const seen: { payload: string; actor: Actor | null }[] = [];
    let later!: Promise<void>;
    const handler = listenAs('listen:node-ingested', (payload) => {
      seen.push({ payload, actor: currentActor() });
      later = new Promise<void>((done) =>
        setTimeout(() => {
          seen.push({ payload: `${payload} later`, actor: currentActor() });
          done();
        }, 1),
      );
    });
    runWithoutActor(() => {
      expect(currentActor()).toBeNull();
      handler('n1');
    });
    await later;
    const actor = systemActor('listen:node-ingested');
    expect(seen).toEqual([
      { payload: 'n1', actor },
      { payload: 'n1 later', actor },
    ]);
  });
});
