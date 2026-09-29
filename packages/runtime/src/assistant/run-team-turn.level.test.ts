/**
 * A member's team turn runs at the agent's level (member logins Phase 0b,
 * plan section 2b): with team-responder at `team`, everything runTeamTurn
 * reads for the turn (the owner's preferences, the member's thread, the
 * retrieval, the assembly, the loop) runs in the team viewer scope, with no
 * outer wrap from the caller. The audit removed this wrap and every test
 * stayed green; this pins it. No database: the agent row, the content
 * functions and the inner stages are faked, each recording
 * `currentViewerLevel()`. The inner stages wrap themselves too; faking them
 * here is what makes this test about runTeamTurn's own wrap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentViewerLevel } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  audience: 'team',
  mayRun: true,
  appended: 0,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = () => chain;
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  chain['limit'] = async () => {
    // Where the agent row is read: a client turn reads it inside its own
    // client wrap (client logins C4, N7).
    h.levels.push(`agent:${level()}`);
    return [
      {
        id: 'agent-1',
        slug: 'team-responder',
        audience: h.audience,
        enabled: true,
        apiKeyId: 'key-1',
        provider: 'openrouter',
        model: 'fake/model',
        memoryConfig: {},
        params: {},
      },
    ];
  };
  return { ...actual, db: { select: () => chain } };
});

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async (id: string) => ({ id, provider: 'openrouter', key: 'sk-fake' })),
}));

vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake' })),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  const r = (what: string) => h.levels.push(`${what}:${level()}`);
  let n = 0;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    loadProfilePreferences: vi.fn(async () => {
      r('prefs');
      return { timezone: 'UTC', locale: 'en-GB' };
    }),
    recentTeamMessages: vi.fn(async () => {
      r('thread');
      return [];
    }),
    appendTeamMessage: vi.fn(async (row: Record<string, unknown>) => {
      h.appended++;
      return { ...row, id: `m${++n}`, createdAt: new Date() };
    }),
    clientTurnMayRun: vi.fn(async () => {
      r('may-run');
      return h.mayRun;
    }),
    updateTeamMessageOutcome: vi.fn(async () => null),
  };
});

vi.mock('../agent', async (importOriginal) => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    loadConversationContext: vi.fn(async () => {
      h.levels.push(`context:${level()}`);
      return {
        personaNotes: [],
        facts: [],
        digests: [],
        corpusMap: { entries: [] },
        contentHits: [],
        chunkHits: [],
        relations: [],
        history: [],
        snapshot: { items: [] },
      };
    }),
    buildChatMessages: vi.fn(() => []),
  };
});

vi.mock('./assemble-turn', async () => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  return {
    assembleResponderTurn: vi.fn(async () => {
      h.levels.push(`assemble:${level()}`);
      return {
        effectiveSystemPrompt: 'SYSTEM',
        volatileContext: '',
        allowedTools: [],
        delegateTo: [],
        loopOverrides: {},
      };
    }),
  };
});

vi.mock('./responder-loop', async (importOriginal) => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  const actual = await importOriginal<typeof import('./responder-loop')>();
  return {
    ...actual,
    runResponderLoop: vi.fn(async () => {
      h.levels.push(`loop:${level()}`);
      return {
        loop: { ...actual.emptyLoopResult(), reply: 'ok, done' },
        reply: 'ok, done',
        emptyReplySubstituted: false,
        blockedByProvider: false,
        truncated: false,
        persistedThoughts: [],
        toolStats: null,
      };
    }),
  };
});

vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startTrace: (_init: unknown, fn: () => Promise<unknown>) => fn(),
  runDurableStep: (_name: string, fn: () => Promise<unknown>) => fn(),
  withTracePrelude: (_p: unknown, fn: () => Promise<unknown>) => fn(),
  currentTrace: () => null,
  emitTurnLifecycle: vi.fn(),
}));

import { runClientTurn, runTeamTurn } from './run-team-turn';

beforeEach(() => {
  h.levels = [];
  h.audience = 'team';
  h.mayRun = true;
  h.appended = 0;
});

describe('runTeamTurn runs at the agent level', () => {
  it('team-responder at team: every read of the turn runs at team, with no outer wrap', async () => {
    expect(currentViewerLevel()).toBe('admin'); // the caller is at admin
    const res = await runTeamTurn('owner-1', 'what does the handbook say?', {
      loginId: 'login-1',
    });
    expect(res.reply).toBe('ok, done');
    expect(h.levels).toEqual([
      'agent:admin',
      'prefs:team',
      'context:team',
      'thread:team',
      'assemble:team',
      'loop:team',
    ]);
  });

  it('control: an admin-level agent is refused for a member before anything is read', async () => {
    h.audience = 'admin';
    await expect(runTeamTurn('owner-1', 'hello', { loginId: 'login-1' })).rejects.toThrow(
      /admin level/,
    );
    expect(h.levels).toEqual(['agent:admin']);
  });
});

describe('runClientTurn runs at client level twice over (client logins C4)', () => {
  const opts = { loginId: 'login-c', sessionEpoch: 3 };

  it('the whole turn, the agent lookup included, runs at client; no retrieval context', async () => {
    h.audience = 'client';
    const res = await runClientTurn('owner-1', 'what is shared with me?', opts);
    expect(res.reply).toBe('ok, done');
    expect(h.levels).toEqual([
      'may-run:admin',
      // The client's own wrap: the agent row is read on the client role too.
      'agent:client',
      'prefs:client',
      'thread:client',
      'assemble:client',
      'loop:client',
    ]);
  });

  it('a signed-out, disabled or ended login: the turn never runs and writes nothing', async () => {
    h.audience = 'client';
    h.mayRun = false;
    await expect(runClientTurn('owner-1', 'hello', opts)).rejects.toThrow(/no longer signed in/);
    expect(h.levels).toEqual(['may-run:admin']);
    expect(h.appended).toBe(0);
  });

  it('a queued input with no epoch never runs', async () => {
    h.audience = 'client';
    await expect(
      runClientTurn('owner-1', 'hello', { loginId: 'login-c' } as never),
    ).rejects.toThrow(/no longer signed in/);
    expect(h.levels).toEqual([]);
  });

  it('a team-level agent is refused for a client before anything is read', async () => {
    h.audience = 'team';
    await expect(runClientTurn('owner-1', 'hello', opts)).rejects.toThrow(
      /only chat with a client-level agent/,
    );
    expect(h.levels).toEqual(['may-run:admin', 'agent:client']);
  });
});
