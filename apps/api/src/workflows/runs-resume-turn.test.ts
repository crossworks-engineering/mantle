/**
 * Unit tests for the runs RESUME turn workflow (slice 3 WP2 + the v0.157.14
 * replay hardening). Pins the ORCHESTRATION contract — the collaborators (the
 * responder loop, the engine, telegram, key decryption) are mocked, because
 * their internals have their own tests and none of them are what this file is
 * about.
 *
 * What it is about, in order of importance:
 *   1. REPLAY DETERMINISM (final-audit F1). A crash after the journaled claim
 *      must not lose the wake-up. The pre-fix build re-read `resumed_at` in
 *      unjournaled glue, saw its own claim, and exited 'duplicate' — dropping
 *      the report forever. `makeJournal({crashAfter})` reproduces exactly that
 *      sequence in-process, so the bug can never come back unnoticed.
 *   2. Claim ordering (the v0.157.5 rule): every fallible precondition runs
 *      BEFORE the at-most-once token is burned, so a transient failure leaves
 *      the resume re-sendable by the sweep.
 *   3. The pre-claim refusals (duplicate / paused / missing / no agent) and
 *      the channel-routed delivery with its web-only fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrashSignal,
  makeFakeDb,
  makeJournal,
  type FakeDb,
  type Journal,
} from './workflow-test-kit';

const h = vi.hoisted(() => ({
  journal: null as unknown as {
    runStep: (fn: () => Promise<unknown>, o: { name: string }) => unknown;
  },
  db: null as unknown as Record<string, unknown>,
  runsEnabled: true,
  claimResult: true,
  compiled: null as unknown,
  apiKey: 'sk-test' as string | null,
  adapter: { providerId: 'openrouter' } as unknown,
  loopReply: 'The run finished. Here is what happened.',
  sendOk: true,
  /** Call order across collaborators — the ordering assertions read this. */
  seq: [] as string[],
  recordTurn: null as unknown as ReturnType<typeof vi.fn>,
  sendMessage: null as unknown as ReturnType<typeof vi.fn>,
  claimResume: null as unknown as ReturnType<typeof vi.fn>,
  runResponderLoop: null as unknown as ReturnType<typeof vi.fn>,
  logs: [] as Array<{ level: string; message: string }>,
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: <T>(fn: T) => fn,
    runStep: (fn: () => Promise<unknown>, o: { name: string }) => h.journal.runStep(fn, o),
    span: undefined,
    logger: {
      info: (m: string) => h.logs.push({ level: 'info', message: m }),
      warn: (m: string) => h.logs.push({ level: 'warn', message: m }),
      error: (m: string) => h.logs.push({ level: 'error', message: m }),
    },
  },
}));

vi.mock('drizzle-orm', () => {
  const tag = () => ({ __expr: true });
  return { and: tag, eq: tag, inArray: tag, isNull: tag, lt: tag, asc: tag, desc: tag, sql: tag };
});

vi.mock('@mantle/db', () => ({
  // Defers to the per-test fake assigned in beforeEach.
  db: new Proxy(
    {},
    { get: (_t, prop: string) => (h.db as Record<string, unknown>)[prop] },
  ) as unknown,
  runItems: { __table: 'run_items' },
  runs: { __table: 'runs' },
  agents: { __table: 'agents' },
  telegramAccounts: { __table: 'telegram_accounts' },
  telegramChats: { __table: 'telegram_chats' },
  bumpAgentUsage: vi.fn(async () => {}),
}));

vi.mock('@mantle/runs', () => ({
  isRunsEnabled: () => h.runsEnabled,
  claimResume: (...a: unknown[]) => h.claimResume(...a),
  compileRunState: async () => h.compiled,
  renderRunStateText: () => 'RUN STATE TEXT',
  // Prompt construction moved into @mantle/runs (audit-prompt.ts) and has its
  // own pure tests; here it only needs to produce a string.
  buildAuditSection: async () => 'AUDIT SECTION',
  buildPanelAuditSection: async () => 'PANEL SECTION',
  isPanelAudit: () => false,
  RUNS_RESUME_TURN_WORKFLOW: 'runsResumeTurnWorkflow',
}));

vi.mock('@mantle/telegram', () => ({ sendMessage: (...a: unknown[]) => h.sendMessage(...a) }));

vi.mock('@mantle/agent-runtime', () => ({
  buildChatMessages: () => [],
  loadConversationContext: async () => ({ history: [] }),
  recordTurn: (...a: unknown[]) => h.recordTurn(...a),
}));

vi.mock('@mantle/assistant-runtime', () => ({
  assembleResponderTurn: async () => {
    h.seq.push('assemble');
    return { effectiveSystemPrompt: 'sys', volatileContext: '' };
  },
  resolveAssistantAgent: async () => null,
  runResponderLoop: (...a: unknown[]) => h.runResponderLoop(...a),
}));

vi.mock('@mantle/api-keys', () => ({ getApiKeyById: async () => h.apiKey }));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: async () => ({ timezone: 'UTC' }) }));
vi.mock('@mantle/voice', () => ({
  getChatAdapter: () => h.adapter,
  stripAudioTags: (t: string) => ({ text: t }),
}));

// The durable seam itself stays REAL — it is the thing under test. Only the
// trace wrapper is made inert.
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    startTrace: async (_init: unknown, fn: () => Promise<unknown>) => fn(),
    currentTrace: () => ({ id: 'trace-1', costMicroUsd: 0, tokens: { in: 0, out: 0 } }),
  };
});

const { runsResumeTurnImpl } = await import('./runs-resume-turn');

const RUN_ID = 'run-1';
const GROUP_ID = 'item-1';
const AGENT = {
  id: 'agent-1',
  slug: 'assistant',
  ownerId: 'owner-1',
  enabled: true,
  apiKeyId: 'key-1',
  provider: 'openrouter',
  model: 'x/y',
};

let fake: FakeDb;
let journal: Journal;

/** Queue the rows a happy path reads, in table order. `overrides` tweak the
 *  interesting bits per test. */
function seedHappyPath(
  opts: {
    item?: Record<string, unknown>;
    run?: Record<string, unknown>;
    originChannel?: { kind: 'telegram'; chat_id: string } | null;
    telegramChat?: Record<string, unknown>[];
    telegramAccount?: Record<string, unknown>[];
  } = {},
) {
  const item = { id: GROUP_ID, kind: 'group_seq', resumedAt: null, ...(opts.item ?? {}) };
  const run = { status: 'running', ownerId: 'owner-1', agentId: AGENT.id, ...(opts.run ?? {}) };
  // preflight: run_items → runs → agents ; glue: run_items → agents
  fake.queue('run_items', [item], [item]);
  fake.queue('runs', [run]);
  fake.queue('agents', [AGENT], [AGENT]);
  if (opts.telegramChat) fake.queue('telegram_chats', opts.telegramChat);
  if (opts.telegramAccount) fake.queue('telegram_accounts', opts.telegramAccount);
  h.compiled = {
    run: {
      id: RUN_ID,
      ownerId: 'owner-1',
      title: 'Q3 notes',
      status: 'done',
      agentId: AGENT.id,
      originChannel: opts.originChannel ?? null,
    },
    items: [],
  };
}

beforeEach(() => {
  fake = makeFakeDb();
  journal = makeJournal();
  h.db = fake.db as Record<string, unknown>;
  h.journal = journal;
  journal.beginPass();
  h.runsEnabled = true;
  h.claimResult = true;
  h.apiKey = 'sk-test';
  h.adapter = { providerId: 'openrouter' };
  h.loopReply = 'The run finished. Here is what happened.';
  h.sendOk = true;
  h.seq = [];
  h.logs = [];
  h.recordTurn = vi.fn(async () => ({ id: 'msg-1' }));
  h.sendMessage = vi.fn(async () => {
    if (!h.sendOk) throw new Error('telegram 403');
    return { message_id: 7 };
  });
  h.claimResume = vi.fn(async () => {
    h.seq.push('claim');
    return h.claimResult;
  });
  h.runResponderLoop = vi.fn(async () => {
    h.seq.push('loop');
    return { reply: h.loopReply, toolCalls: [] };
  });
});

describe('runs resume turn — pre-claim refusals', () => {
  it('refuses with the flag off, without claiming', async () => {
    h.runsEnabled = false;
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'disabled' });
    expect(h.claimResume).not.toHaveBeenCalled();
    expect(journal.recordedSteps()).toEqual([]);
  });

  it('exits duplicate when the item was already resumed', async () => {
    seedHappyPath({ item: { resumedAt: new Date() } });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'duplicate' });
    expect(h.claimResume).not.toHaveBeenCalled();
    expect(h.runResponderLoop).not.toHaveBeenCalled();
  });

  it('refuses a budget-paused run before claiming (WP4 amendment 4)', async () => {
    seedHappyPath({ run: { status: 'paused' } });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'precondition' });
    expect(h.claimResume).not.toHaveBeenCalled();
  });

  it('refuses when the item is missing', async () => {
    fake.queue('run_items', []);
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'precondition' });
    expect(h.claimResume).not.toHaveBeenCalled();
  });

  it('refuses when no chat-capable agent resolves', async () => {
    seedHappyPath();
    // Agent without an api key → preflight's no_agent branch.
    fake.queue('agents', [{ ...AGENT, apiKeyId: null }]);
    const fresh = makeFakeDb();
    fresh.queue('run_items', [{ id: GROUP_ID, kind: 'group_seq', resumedAt: null }]);
    fresh.queue('runs', [{ status: 'running', ownerId: 'owner-1', agentId: AGENT.id }]);
    fresh.queue('agents', [{ ...AGENT, apiKeyId: null }]);
    h.db = fresh.db as Record<string, unknown>;
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'precondition' });
    expect(h.claimResume).not.toHaveBeenCalled();
  });
});

describe('runs resume turn — claim ordering and the happy path', () => {
  it('claims AFTER the fallible preconditions, then runs the loop', async () => {
    seedHappyPath();
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: true, outcome: 'reported' });
    // The v0.157.5 ordering: assembly (fallible) → claim → loop.
    expect(h.seq).toEqual(['assemble', 'claim', 'loop']);
    expect(journal.recordedSteps()).toEqual([
      'resume_preflight',
      'claim_resume',
      'record_outbound',
    ]);
  });

  it('records the outbound turn once, on the web channel by default', async () => {
    seedHappyPath();
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(h.recordTurn).toHaveBeenCalledTimes(1);
    expect(h.recordTurn.mock.calls[0]![0]).toMatchObject({
      direction: 'outbound',
      channel: 'web',
      data: { run_id: RUN_ID, run_resume: true },
    });
  });

  it('loses the claim race and stops without running the loop', async () => {
    seedHappyPath();
    h.claimResult = false;
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: false, outcome: 'duplicate' });
    expect(h.runResponderLoop).not.toHaveBeenCalled();
    expect(h.recordTurn).not.toHaveBeenCalled();
  });

  it('audit mode judges without posting to the conversation', async () => {
    seedHappyPath({ item: { kind: 'audit' } });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: true, outcome: 'audited' });
    expect(h.recordTurn).not.toHaveBeenCalled();
  });
});

describe('runs resume turn — channel-routed delivery', () => {
  it('delivers a telegram-origin report to the originating chat', async () => {
    seedHappyPath({
      originChannel: { kind: 'telegram', chat_id: '555' },
      telegramChat: [{ accountId: 'acct-1' }],
      telegramAccount: [{ id: 'acct-1', enabled: true }],
    });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res.outcome).toBe('reported');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.recordTurn.mock.calls[0]![0]).toMatchObject({ channel: 'telegram' });
    expect(journal.recordedSteps()).toContain('deliver_telegram');
  });

  it('falls back to web-only when the chat is unpaired — the report is never lost', async () => {
    seedHappyPath({
      originChannel: { kind: 'telegram', chat_id: '555' },
      telegramChat: [], // no allowlisted chat row
    });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res.outcome).toBe('reported');
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.recordTurn).toHaveBeenCalledTimes(1);
    expect(h.recordTurn.mock.calls[0]![0]).toMatchObject({ channel: 'web' });
    expect(
      h.logs.some((l) => l.level === 'warn' && /telegram delivery unavailable/.test(l.message)),
    ).toBe(true);
  });

  it('falls back to web-only when the account is disabled', async () => {
    seedHappyPath({
      originChannel: { kind: 'telegram', chat_id: '555' },
      telegramChat: [{ accountId: 'acct-1' }],
      telegramAccount: [{ id: 'acct-1', enabled: false }],
    });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res.outcome).toBe('reported');
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.recordTurn.mock.calls[0]![0]).toMatchObject({ channel: 'web' });
  });
});

describe('runs resume turn — crash replay (final-audit F1 regression)', () => {
  it('a crash AFTER the claim still delivers the report, exactly once, on recovery', async () => {
    // ── Pass 1: crash the instant the claim commits (the loss window).
    journal = makeJournal({ crashAfter: 'claim_resume' });
    h.journal = journal;
    journal.beginPass();
    seedHappyPath();
    await expect(runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID })).rejects.toBeInstanceOf(
      CrashSignal,
    );
    expect(h.recordTurn).not.toHaveBeenCalled(); // report not yet written

    // ── Pass 2: DBOS recovery re-runs the function from the top. The world has
    // moved: the claim committed, so the row now reads `resumed_at` SET. THIS
    // is what broke the pre-fix build — unjournaled glue re-read that marker,
    // concluded another worker owned the resume, and returned 'duplicate'
    // while the user's report was never written.
    const recovery = makeFakeDb();
    const claimedItem = { id: GROUP_ID, kind: 'group_seq', resumedAt: new Date() };
    recovery.queue('run_items', [claimedItem], [claimedItem]);
    recovery.queue('runs', [{ status: 'running', ownerId: 'owner-1', agentId: AGENT.id }]);
    recovery.queue('agents', [AGENT], [AGENT]);
    h.db = recovery.db as Record<string, unknown>;
    journal.beginPass();

    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });

    expect(res).toEqual({ resumed: true, outcome: 'reported' });
    // The preflight decision came from the journal, NOT from re-reading the row.
    expect(journal.replayed).toContain('resume_preflight');
    expect(journal.replayed).toContain('claim_resume');
    // And the side effect that had not yet happened did happen — once.
    expect(journal.executed).toContain('record_outbound');
    expect(h.recordTurn).toHaveBeenCalledTimes(1);
  });

  it('a crash AFTER record_outbound does not double-post on recovery', async () => {
    journal = makeJournal({ crashAfter: 'record_outbound' });
    h.journal = journal;
    journal.beginPass();
    seedHappyPath();
    await expect(runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID })).rejects.toBeInstanceOf(
      CrashSignal,
    );
    expect(h.recordTurn).toHaveBeenCalledTimes(1);

    const recovery = makeFakeDb();
    const claimedItem = { id: GROUP_ID, kind: 'group_seq', resumedAt: new Date() };
    recovery.queue('run_items', [claimedItem], [claimedItem]);
    recovery.queue('runs', [{ status: 'running', ownerId: 'owner-1', agentId: AGENT.id }]);
    recovery.queue('agents', [AGENT], [AGENT]);
    h.db = recovery.db as Record<string, unknown>;
    journal.beginPass();

    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toEqual({ resumed: true, outcome: 'reported' });
    expect(journal.replayed).toContain('record_outbound');
    expect(h.recordTurn).toHaveBeenCalledTimes(1); // still exactly one post
  });
});
