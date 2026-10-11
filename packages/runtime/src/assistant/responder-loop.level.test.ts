/**
 * The responder loop runs in the agent's scope (member logins Phase 0b,
 * workspaces W5b2): for a team-level agent, the context load, the
 * backup-route lookup, the message build and the tool loop all start inside
 * the scope the R6 shim (withViewer) enters for it, never as system work.
 * The audit removed this wrap and every test stayed green; this pins it. The
 * tool loop and tracing are faked; each collaborator records the scope it
 * runs in. withViewer enters the scope viewerScopeFor gives an agent on no
 * workspace.
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
  if (s.kind === 'level') return `level:${s.level}`;
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const { runInViewerScope } = await import('@mantle/db/viewer');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    // The R6 shim without a database: 'admin' is system work; any lower
    // level enters the workspace scope of an agent on no workspace.
    withViewer: vi.fn((level: string, _for: unknown, fn: () => Promise<unknown>) =>
      level === 'admin'
        ? fn()
        : runInViewerScope({ kind: 'assistant', loginId: null, ws: [], modWs: [] }, fn),
    ),
  };
});

vi.mock('../agent', async () => {
  const level = where;
  return {
    runToolLoop: vi.fn(async (args: { agentLevel?: string }) => {
      h.levels.push(`loop:${level()}`, `loop-arg:${args.agentLevel}`);
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

const run = (audience: string, surface: unknown = MEMBER_SURFACE) =>
  runResponderLoop({
    ownerId: 'owner-1',
    agent: {
      id: 'agent-1',
      slug: 'team-responder',
      audience,
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
  it('a team agent: context, backup lookup, messages and the loop run in its workspace scope', async () => {
    const res = await run('team');
    expect(res.reply).toBe('ok');
    expect(h.levels).toEqual([
      'context:assistant()',
      'backup:assistant()',
      'messages:assistant()',
      'loop:assistant()',
      'loop-arg:team',
    ]);
  });

  // Answering no login (system work, a run's turn), an admin agent on no
  // workspace runs at admin. Answering a login it runs in that login's turn
  // scope of Admin (W7c fix round 2), which needs the database: the W7c
  // chat db test pins it.
  it('control: an admin agent answering no login runs at admin', async () => {
    await run('admin', { kind: 'web' });
    expect(h.levels).toEqual([
      'context:admin',
      'backup:admin',
      'messages:admin',
      'loop:admin',
      'loop-arg:admin',
    ]);
  });
});
