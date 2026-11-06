/**
 * The agent UI tools on a member's workspace turn (docs/agent-ui.md,
 * "Members"): offered on the same terms as an owner turn, only when the turn
 * named its window, streams, and the login's setting is on (read by the
 * brain at turn start, never from the client); then the loop's team surface
 * carries the window. No database: the harness of run-team-turn.level.test.ts
 * (the agent row, the content functions and the inner stages faked), with
 * the assembly's options and the loop's surface recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  team: {
    id: 'agent-1',
    slug: 'team-responder',
    name: 'Team Responder',
    workspaceId: 'ws-team',
  } as { id: string; slug: string; name: string; workspaceId?: string } | null,
  appended: 0,
  groupTools: [] as string[],
  loopTools: [] as string[],
  /** The login's agent UI setting, or a read that fails. */
  agentUi: true as boolean | 'fails',
  settingReads: [] as string[],
  assembled: null as Record<string, unknown> | null,
  loopSurface: null as unknown,
}));

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
    // The login's agent UI setting (docs/agent-ui.md), read at turn start.
    loadPreferencesFor: vi.fn(async (loginId: string) => {
      h.settingReads.push(loginId);
      if (h.agentUi === 'fails') throw new Error('profile row unreadable');
      return { agentUi: h.agentUi };
    }),
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
    assembleResponderTurn: vi.fn(async (opts: Record<string, unknown>) => {
      h.levels.push(`assemble:${level()}`);
      h.assembled = opts;
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
    runResponderLoop: vi.fn(
      async (args: { assembled: { allowedTools: { slug: string }[] }; surface: unknown }) => {
        h.levels.push(`loop:${level()}`);
        h.loopSurface = args.surface;
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
      },
    ),
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

import { runTeamTurn } from './run-team-turn';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const WINDOW = 'win_abcdefgh';
const STREAM = `ws-${LOGIN}.k1`;

beforeEach(() => {
  h.levels = [];
  h.appended = 0;
  h.groupTools = ['page_get'];
  h.loopTools = [];
  h.agentUi = true;
  h.settingReads = [];
  h.assembled = null;
  h.loopSurface = null;
});

const turn = (o: { windowId?: string; streamId?: string }) =>
  runTeamTurn('owner-1', 'show me where the handbook is', { loginId: LOGIN, ...o });

describe('a workspace turn offers the ui tools on the owner turn terms', () => {
  it('with its window, a stream and the setting on: offered, and the team surface carries the window', async () => {
    await turn({ windowId: WINDOW, streamId: STREAM });
    expect(h.settingReads).toEqual([LOGIN]);
    expect(h.assembled?.agentUiTools).toBe(true);
    expect(h.assembled?.surface).toEqual({ kind: 'team', loginId: LOGIN, uiWindowId: WINDOW });
    expect(h.loopSurface).toMatchObject({ kind: 'team', loginId: LOGIN, uiWindowId: WINDOW });
  });

  it('the setting off: not offered, no window on the surface', async () => {
    h.agentUi = false;
    await turn({ windowId: WINDOW, streamId: STREAM });
    expect(h.assembled?.agentUiTools).toBe(false);
    expect(h.assembled?.surface).toEqual({ kind: 'team', loginId: LOGIN });
    expect(h.loopSurface).not.toHaveProperty('uiWindowId');
  });

  it('no window named: not offered, and the setting is not even read', async () => {
    await turn({ streamId: STREAM });
    expect(h.settingReads).toEqual([]);
    expect(h.assembled?.agentUiTools).toBe(false);
    expect(h.loopSurface).not.toHaveProperty('uiWindowId');
  });

  it('a turn that does not stream: not offered (no ui-call could reach the window)', async () => {
    await turn({ windowId: WINDOW });
    expect(h.assembled?.agentUiTools).toBe(false);
    expect(h.loopSurface).not.toHaveProperty('uiWindowId');
  });

  it('a bad window id, or a setting that cannot be read: not offered (fail closed)', async () => {
    await turn({ windowId: 'short', streamId: STREAM });
    expect(h.assembled?.agentUiTools).toBe(false);
    h.agentUi = 'fails';
    await turn({ windowId: WINDOW, streamId: STREAM });
    expect(h.assembled?.agentUiTools).toBe(false);
    expect(h.loopSurface).not.toHaveProperty('uiWindowId');
  });
});
