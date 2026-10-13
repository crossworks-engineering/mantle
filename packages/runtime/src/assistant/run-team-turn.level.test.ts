/**
 * A member's team turn runs in the agent's scope (member logins Phase 0b,
 * plan section 2b, workspaces W5b2): with the Team workspace's assistant
 * (W5c: a workspace resource, no agent level read), everything runTeamTurn
 * reads for the turn (the owner's preferences, the member's thread, the
 * retrieval, the assembly, the loop) runs in a turn scope of the Team
 * workspace for the member (withAgentViewer), with no outer wrap from the
 * caller. Client chat went in W5c: a queued client turn refuses. The audit
 * removed this wrap and every test stayed green; this pins it. No
 * database: the agent row, the workspace lookups, the content functions and
 * the inner stages are faked, each recording the scope it runs in, and
 * withTurnScope enters the scope alone. The inner stages wrap themselves
 * too; faking them here is what makes this test about runTeamTurn's own
 * wrap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  /** The login's default assistant (defaultWorkspaceAssistant), or none. */
  team: {
    id: 'agent-1',
    slug: 'team-responder',
    name: 'Team Responder',
    workspaceId: 'ws-team',
  } as {
    id: string;
    slug: string;
    name: string;
    workspaceId?: string;
  } | null,
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
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { runInViewerScope } = await import('@mantle/db/viewer');
  const select = () => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {};
    chain['from'] = (t: unknown) => {
      table = t;
      return chain;
    };
    chain['where'] = () => chain;
    chain['limit'] = async () => {
      // The agent's workspace lookups (agent-viewer.ts, on the system pool):
      // the Team workspace is live and not Admin, and the login a user there.
      if (table === actual.workspaces) {
        return [{ isAdmin: false, ownerId: 'owner-1', archivedAt: null }];
      }
      if (table === actual.workspaceUsers) return [{ moderator: false }];
      // Where the agent row is read (by the id the Team workspace names).
      h.levels.push(`agent:${where()}`);
      return [
        {
          id: 'agent-1',
          slug: 'team-responder',
          // The Team workspace's assistant: the turn runs in its scope.
          workspaceId: 'ws-team',
          enabled: true,
          apiKeyId: 'key-1',
          provider: 'openrouter',
          model: 'fake/model',
          memoryConfig: {},
          params: {},
        },
      ];
    };
    return chain;
  };
  return {
    ...actual,
    db: { select },
    // No "New chat" yet: the thread has no lower bound.
    openChatThread: vi.fn(async () => null),
    // A turn scope without a database: the scope alone.
    withTurnScope: vi.fn((scope: never, fn: () => Promise<unknown>) => runInViewerScope(scope, fn)),
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
    recentThreadMessages: vi.fn(async () => {
      r('thread');
      return [];
    }),
    appendThreadMessage: vi.fn(async (row: Record<string, unknown>) => {
      h.appended++;
      return { ...row, id: `m${++n}`, createdAt: new Date() };
    }),
    defaultWorkspaceAssistant: vi.fn(async () => {
      r('team-assistant');
      return h.team;
    }),
    // A named slug (W7c): the assistants of the login's workspaces. None
    // here is named 'admin-assistant'.
    workspaceAssistantFor: vi.fn(async () => {
      r('workspace-assistants');
      return null;
    }),
    updateThreadMessageOutcome: vi.fn(async () => null),
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
  h.team = {
    id: 'agent-1',
    slug: 'team-responder',
    name: 'Team Responder',
    workspaceId: 'ws-team',
  };
  h.appended = 0;
  h.groupTools = [];
  h.loopTools = [];
});

describe('runTeamTurn runs in the agent scope', () => {
  it('the Team workspace’s assistant: every read of the turn runs in its scope, with no outer wrap', async () => {
    expect(where()).toBe('admin'); // the caller is system work
    const res = await runTeamTurn('owner-1', 'what does the handbook say?', {
      loginId: 'login-1',
    });
    expect(res.reply).toBe('ok, done');
    expect(h.levels).toEqual([
      'team-assistant:admin',
      'agent:admin',
      'prefs:assistant(ws-team)',
      // The thread first: a short follow-up is enriched from it.
      'thread:assistant(ws-team)',
      'context:assistant(ws-team)',
      'assemble:assistant(ws-team)',
      'loop:assistant(ws-team)',
    ]);
  });

  it('control: no assistant on the Team workspace, the turn is refused before anything is read', async () => {
    h.team = null;
    await expect(runTeamTurn('owner-1', 'hello', { loginId: 'login-1' })).rejects.toThrow(
      /no workspace other than Admin with an enabled assistant/,
    );
    expect(h.levels).toEqual(['team-assistant:admin']);
    // No assistant, no thread (0269): nothing is recorded.
    expect(h.appended).toBe(0);
  });

  it('control: an agent that is not the Team workspace’s assistant is refused (W5c: no level is read)', async () => {
    await expect(
      runTeamTurn('owner-1', 'hello', { loginId: 'login-1', agentSlug: 'admin-assistant' }),
    ).rejects.toThrow(/not the assistant of a workspace this login is a user of/);
    expect(h.levels).toEqual(['workspace-assistants:admin']);
  });

  it('control: an assistant that does not answer in the Team workspace is refused (fail closed)', async () => {
    // The resource names it, but its own workspace is another one (or none):
    // the turn would not run in the Team scope, so it never runs.
    h.team = { id: 'agent-1', slug: 'team-responder', name: 'Team', workspaceId: 'ws-other' };
    await expect(runTeamTurn('owner-1', 'hello', { loginId: 'login-1' })).rejects.toThrow(
      /does not answer in its workspace/,
    );
    expect(h.levels).toEqual(['team-assistant:admin', 'agent:admin']);
  });

  it('a member turn keeps what its groups grant', async () => {
    h.groupTools = ['page_get', 'recipe_read_page'];
    await runTeamTurn('owner-1', 'hello', { loginId: 'login-1' });
    expect(h.loopTools).toEqual(['page_get', 'recipe_read_page']);
  });
});

describe('runClientTurn: client chat went in W5c', () => {
  it('a queued client turn refuses before anything is read or written', async () => {
    await expect(
      runClientTurn('owner-1', 'hello', { loginId: 'login-c', sessionEpoch: 3 }),
    ).rejects.toThrow(/client chat was removed/);
    expect(h.levels).toEqual([]);
    expect(h.appended).toBe(0);
  });
});
