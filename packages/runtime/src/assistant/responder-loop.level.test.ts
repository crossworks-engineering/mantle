/**
 * The responder loop runs in the agent's scope (member logins Phase 0b,
 * workspaces W5b2, W8c): for the assistant of a workspace other than Admin,
 * the context load, the backup-route lookup, the message build and the tool
 * loop all start inside a turn scope of that workspace for the login it
 * answers, never as system work. The audit removed this wrap and every test
 * stayed green; this pins it. The tool loop and tracing are faked; each
 * collaborator records the scope it runs in. withTurnScope enters the scope
 * alone (no database).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';
import type { Agent } from '@mantle/db';
import type { ConversationContext } from '../agent';
import type { AssembledResponderTurn } from './assemble-turn';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

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
  // The agent's workspace lookups (agent-viewer.ts, on the system pool)
  // without a database: a live workspace that is not Admin, and the login a
  // user there.
  const select = () => ({
    from: (table: unknown) => {
      const rows =
        table === actual.workspaces
          ? [{ isAdmin: false, ownerId: 'owner-1', archivedAt: null }]
          : [{ moderator: false }];
      const chain: Record<string, unknown> = { where: () => chain, limit: async () => rows };
      return chain;
    },
  });
  return {
    ...actual,
    db: { select },
    // A turn scope without a database: the scope alone.
    withTurnScope: vi.fn((scope: never, fn: () => Promise<unknown>) => runInViewerScope(scope, fn)),
  };
});

vi.mock('../agent', async () => {
  const level = where;
  return {
    runToolLoop: vi.fn(async () => {
      h.levels.push(`loop:${level()}`);
      return {
        reply: 'ok',
        messages: [],
        iterations: 1,
        toolCalls: [],
        pendingIds: [],
        artifacts: [],
        tokensOut: 1,
      };
    }),
    summarizeToolOutcomes: () => ({
      calls: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      queued: 0,
      failures: [],
    }),
    resolveBackupAdapter: vi.fn(async () => {
      h.levels.push(`backup:${level()}`);
      return undefined;
    }),
  };
});

vi.mock('@mantle/content', () => ({
  isStreamThoughtsEnabled: () => false,
  isPersistThoughtsEnabled: () => false,
}));

vi.mock('@mantle/tracing', () => ({
  step: async (_init: unknown, fn: (handle: unknown) => Promise<unknown>) =>
    fn({ setMeta: () => {}, setOutput: () => {} }),
}));

import { runResponderLoop } from './responder-loop';

const CTX = {
  personaNotes: [],
  facts: [],
  digests: [],
  corpusMap: { entries: [] },
  contentHits: [],
  chunkHits: [],
  relations: [],
  history: [],
  snapshot: { items: [] },
} as unknown as ConversationContext;

const ASSEMBLED = {
  allowedTools: [],
  delegateTo: [],
  resultHandling: null,
  thinkingBudget: undefined,
  loopOverrides: {},
} as unknown as AssembledResponderTurn;

const MEMBER_SURFACE = { kind: 'team', loginId: 'login-1', privateReads: false };

/** `workspaceId`: the Team workspace's assistant, or (null) a helper. */
const run = (workspaceId: string | null, surface: unknown = MEMBER_SURFACE) =>
  runResponderLoop({
    ownerId: 'owner-1',
    agent: {
      id: 'agent-1',
      ownerId: 'owner-1',
      slug: 'team-responder',
      workspaceId,
      model: 'm',
      provider: 'openrouter',
      params: {},
    } as unknown as Agent,
    adapter: { providerId: 'openrouter', adapterName: 'fake' } as never,
    apiKey: 'k',
    prefs: { timezone: 'UTC', locale: 'en-GB' },
    logPrefix: '[test]',
    assembled: ASSEMBLED,
    loadContext: async () => {
      h.levels.push(`context:${where()}`);
      return CTX;
    },
    buildMessages: () => {
      h.levels.push(`messages:${where()}`);
      return [{ role: 'user' as const, content: 'hi' }];
    },
    surface: surface as never,
  });

beforeEach(() => {
  h.levels = [];
});

describe('runResponderLoop runs in the agent scope', () => {
  it('the Team workspace’s assistant: context, backup lookup, messages and the loop run in its workspace scope', async () => {
    const res = await run('ws-team');
    expect(res.reply).toBe('ok');
    expect(h.levels).toEqual([
      'context:assistant(ws-team)',
      'backup:assistant(ws-team)',
      'messages:assistant(ws-team)',
      'loop:assistant(ws-team)',
    ]);
  });

  // Answering no login (system work, a run's turn), a helper on no
  // workspace is system work. Answering a login it runs in that login's turn
  // scope of Admin (W7c fix round 2), which needs the database: the W7c
  // chat db test pins it.
  it('control: a helper answering no login is system work', async () => {
    await run(null, { kind: 'web' });
    expect(h.levels).toEqual(['context:admin', 'backup:admin', 'messages:admin', 'loop:admin']);
  });
});
