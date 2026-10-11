/**
 * A member's team turn runs in the agent's scope (member logins Phase 0b,
 * plan section 2b, workspaces W5b2): with team-responder at `team`,
 * everything runTeamTurn reads for the turn (the owner's preferences, the
 * member's thread, the retrieval, the assembly, the loop) runs in the scope
 * the R6 shim (withViewer) enters for the agent, with no outer wrap from the
 * caller; a client turn runs all of it in the client login's own scope. The
 * audit removed this wrap and every test stayed green; this pins it. No
 * database: the agent row, the content functions and the inner stages are
 * faked, each recording the scope it runs in, and withViewer enters a fake
 * scope that names whom it acts for. The inner stages wrap themselves too;
 * faking them here is what makes this test about runTeamTurn's own wrap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  audience: 'team',
  mayRun: true,
  appended: 0,
  /** What the agent's groups resolve to (the assembly's allowedTools). */
  groupTools: [] as string[],
  /** The tools the loop was given. */
  loopTools: [] as string[],
}));

/** The scope the code runs in: 'admin' for system work, else the workspace
 *  scope's kind and workspaces. */
function where(): string {
  const s = currentScope();
  if (s.kind === 'system') return 'admin';
  if (s.kind === 'level') return `level:${s.level}`;
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { runInViewerScope } = await import('@mantle/db/viewer');
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = () => chain;
  chain['limit'] = async () => {
    // Where the agent row is read: a client turn reads it inside its own
    // client wrap (client logins C4, N7).
    h.levels.push(`agent:${where()}`);
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
  return {
    ...actual,
    db: { select: () => chain },
    // The R6 shim without a database: 'admin' is system work; a login reads
    // its workspaces (here one named for it); an agent on no workspace reads
    // none.
    withViewer: vi.fn((level: string, actsFor: { login?: string }, fn: () => Promise<unknown>) =>
      level === 'admin'
        ? fn()
        : runInViewerScope(
            actsFor.login
              ? { kind: 'user', loginId: actsFor.login, ws: [`ws-of-${actsFor.login}`], modWs: [] }
              : { kind: 'assistant', loginId: null, ws: [], modWs: [] },
            fn,
          ),
    ),
  };
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
  const r = (what: string) => h.levels.push(`${what}:${where()}`);
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
  const level = where;
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
  const level = where;
  return {
    assembleResponderTurn: vi.fn(async () => {
      h.levels.push(`assemble:${level()}`);
      return {
        effectiveSystemPrompt: 'SYSTEM',
        volatileContext: '',
        allowedTools: h.groupTools.map((slug) => ({ slug })),
        delegateTo: [],
        loopOverrides: {},
      };
    }),
  };
});

vi.mock('./responder-loop', async (importOriginal) => {
  const level = where;
  const actual = await importOriginal<typeof import('./responder-loop')>();
  return {
    ...actual,
    runResponderLoop: vi.fn(async (args: { assembled: { allowedTools: { slug: string }[] } }) => {
      h.levels.push(`loop:${level()}`);
      h.loopTools = args.assembled.allowedTools.map((t) => t.slug);
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
  h.groupTools = [];
  h.loopTools = [];
});

describe('runTeamTurn runs in the agent scope', () => {
  it('team-responder at team: every read of the turn runs in its scope, with no outer wrap', async () => {
    expect(where()).toBe('admin'); // the caller is system work
    const res = await runTeamTurn('owner-1', 'what does the handbook say?', {
      loginId: 'login-1',
    });
    expect(res.reply).toBe('ok, done');
    expect(h.levels).toEqual([
      'agent:admin',
      'prefs:assistant()',
      // The thread first: a short follow-up is enriched from it.
      'thread:assistant()',
      'context:assistant()',
      'assemble:assistant()',
      'loop:assistant()',
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

describe('runClientTurn runs in the client login scope (client logins C4)', () => {
  const opts = { loginId: 'login-c', sessionEpoch: 3 };
  const CLIENT = 'user(ws-of-login-c)';

  it('the whole turn, the agent lookup included, runs in the login scope; no retrieval context', async () => {
    h.audience = 'client';
    const res = await runClientTurn('owner-1', 'what is shared with me?', opts);
    expect(res.reply).toBe('ok, done');
    expect(h.levels).toEqual([
      'may-run:admin',
      // The client's own wrap: the agent row is read in the login scope too,
      // and the agent's own wrap stays inside it, never wider.
      `agent:${CLIENT}`,
      `prefs:${CLIENT}`,
      `thread:${CLIENT}`,
      `assemble:${CLIENT}`,
      `loop:${CLIENT}`,
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
    expect(h.levels).toEqual(['may-run:admin', `agent:${CLIENT}`]);
  });
});

describe('a client turn gets no tools, whatever its groups say (W5c)', () => {
  const opts = { loginId: 'login-c', sessionEpoch: 3 };
  // What the old client-read group held, plus a brain-wide read and a recipe.
  const widened = ['my_items_list', 'my_item_open', 'page_get', 'recipe_read_page', 'read_result'];

  it('the client tools went with the client portal: nothing reaches a client turn', async () => {
    h.audience = 'client';
    h.groupTools = widened;
    await runClientTurn('owner-1', 'what is shared with me?', opts);
    expect(h.loopTools).toEqual([]);
  });

  it('control: a member turn keeps what its groups grant', async () => {
    h.groupTools = ['page_get', 'recipe_read_page'];
    await runTeamTurn('owner-1', 'hello', { loginId: 'login-1' });
    expect(h.loopTools).toEqual(['page_get', 'recipe_read_page']);
  });
});
