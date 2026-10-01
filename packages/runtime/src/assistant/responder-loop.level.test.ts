/**
 * The responder loop runs at the agent's level (member logins Phase 0b): for
 * a team-level agent, the context load, the backup-route lookup, the message
 * build and the tool loop all start inside the team viewer scope. The audit
 * removed this wrap and every test stayed green; this pins it. The tool loop
 * and tracing are faked; each collaborator records `currentViewerLevel()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentViewerLevel } from '@mantle/db/viewer';
import type { Agent } from '@mantle/db';
import type { ConversationContext } from '../agent';
import type { AssembledResponderTurn } from './assemble-turn';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

vi.mock('../agent', async () => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
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

const run = (audience: string) =>
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
      h.levels.push(`context:${currentViewerLevel()}`);
      return CTX;
    },
    buildMessages: () => {
      h.levels.push(`messages:${currentViewerLevel()}`);
      return [{ role: 'user' as const, content: 'hi' }];
    },
    surface: { kind: 'team', loginId: 'login-1', privateReads: false } as never,
  });

beforeEach(() => {
  h.levels = [];
});

describe('runResponderLoop runs at the agent level', () => {
  it('a team agent: context, backup lookup, messages and the loop run at team', async () => {
    const res = await run('team');
    expect(res.reply).toBe('ok');
    expect(h.levels).toEqual([
      'context:team',
      'backup:team',
      'messages:team',
      'loop:team',
      'loop-arg:team',
    ]);
  });

  it('control: an admin agent runs at admin', async () => {
    await run('admin');
    expect(h.levels).toEqual([
      'context:admin',
      'backup:admin',
      'messages:admin',
      'loop:admin',
      'loop-arg:admin',
    ]);
  });
});
