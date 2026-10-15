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

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CrashSignal,
  makeFakeDb,
  makeJournal,
  type FakeDb,
  type Journal,
} from './workflow-test-kit';

const h = vi.hoisted(() => ({
  pairedChat: null as Record<string, unknown> | null,
  pairedChatCalls: [] as unknown[],
  journal: null as unknown as {
    runStep: (fn: () => Promise<unknown>, o: { name: string }) => unknown;
  },
  db: null as unknown as Record<string, unknown>,
  runsEnabled: true,
  claimResult: true,
  compiled: null as unknown,
  /** runStateUntrusted's answer (A5 step 6a, carried L4). */
  untrustedState: false,
  apiKey: 'sk-test' as string | null,
  adapter: { providerId: 'openrouter' } as unknown,
  loopReply: 'The run finished. Here is what happened.',
  sendOk: true,
  /** Call order across collaborators — the ordering assertions read this. */
  seq: [] as string[],
  // Explicit call signatures rather than `ReturnType<typeof vi.fn>`: under
  // vitest 4 the bare form widens to `Mock<Procedure | Constructable>`, a union
  // that isn't callable (TS2348 at every call site below).
  recordTurn: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  sendMessage: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  claimResume: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  runResponderLoop: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  logs: [] as Array<{ level: string; message: string }>,
  contextArgs: [] as unknown[],
  assembleArgs: [] as unknown[],
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
  workspaces: { __table: 'workspaces' },
  bumpAgentUsage: vi.fn(async () => {}),
  // Arch A2a: the actor binding passes straight through here.
  loginActor: (loginId: string, mode = 'rw') => ({ kind: 'login', mode, loginId }),
  loginActorNow: async (loginId: string, _entry: string, mode = 'rw') => ({
    kind: 'login',
    mode,
    loginId,
  }),
  systemActor: (reason: string) => ({ kind: 'system', reason }),
  runAsActor: (_actor: unknown, fn: () => unknown) => fn(),
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
}));

// The runs switch, feature('runs') (@mantle/config FEATURES), follows h.
vi.mock('@mantle/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/config')>();
  const feature = (name: string, ctx?: unknown) =>
    name === 'runs'
      ? h.runsEnabled
      : (actual.feature as (n: string, c?: unknown) => boolean)(name, ctx);
  return { ...actual, feature };
});

vi.mock('@mantle/runs', () => ({
  claimResume: (...a: unknown[]) => h.claimResume(...a),
  compileRunState: async () => h.compiled,
  renderRunStateText: () => 'RUN STATE TEXT',
  // A state with third-party content is fenced (A5 step 6a, carried L4).
  runStateUntrusted: () => h.untrustedState,
  // Prompt construction moved into @mantle/runs (audit-prompt.ts) and has its
  // own pure tests; here it only needs to produce a string.
  buildAuditSection: async () => 'AUDIT SECTION',
  buildPanelAuditSection: async () => 'PANEL SECTION',
  isPanelAudit: () => false,
  RUNS_RESUME_TURN_WORKFLOW: 'runsResumeTurnWorkflow',
}));

vi.mock('@mantle/telegram', () => ({
  sendMessage: (...a: unknown[]) => h.sendMessage(...a),
  // The chat paired to the run's login (W7d), else none.
  pairedChatOf: async (args: unknown) => (h.pairedChatCalls.push(args), h.pairedChat),
}));

vi.mock('@mantle/runtime/agent', () => ({
  fenceRetrieved: (body: string) => `[FENCED]${body}[/FENCED]`,
  buildChatMessages: () => [],
  loadConversationContext: async (a: unknown) => {
    h.contextArgs.push(a);
    return { history: [] };
  },
  recordTurn: (...a: unknown[]) => h.recordTurn(...a),
}));

vi.mock('@mantle/runtime/assistant', () => ({
  assembleResponderTurn: async (a: unknown) => {
    h.assembleArgs.push(a);
    h.seq.push('assemble');
    return { effectiveSystemPrompt: 'sys', volatileContext: '' };
  },
  resolveAssistantAgent: async () => null,
  runResponderLoop: (...a: unknown[]) => h.runResponderLoop(...a),
}));

vi.mock('@mantle/api-keys', () => ({ getApiKeyById: async () => h.apiKey }));
vi.mock('@mantle/content', () => ({
  loadProfilePreferences: async () => ({ timezone: 'UTC' }),
  teamHiddenNodeTypes: (privateReads: boolean) =>
    privateReads ? ['secret_type'] : ['secret_type', 'email'],
}));
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
  h.pairedChat = opts.telegramChat?.[0] ?? null;
  h.pairedChatCalls = [];
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
  h.untrustedState = false;
  h.logs = [];
  h.contextArgs = [];
  h.assembleArgs = [];
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

  it('fences a run state that holds third-party content (A5 step 6a, carried L4)', async () => {
    // The loop reads the prompt through its context loader (inboundText).
    h.runResponderLoop = vi.fn(async (o: unknown) => {
      await (o as { loadContext: () => Promise<unknown> }).loadContext();
      return { reply: h.loopReply, toolCalls: [] };
    });
    const promptOf = () =>
      String((h.contextArgs[h.contextArgs.length - 1] as { inboundText?: string }).inboundText);
    seedHappyPath();
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(promptOf()).toContain('RUN STATE TEXT');
    expect(promptOf()).not.toContain('[FENCED]');
    seedHappyPath();
    h.untrustedState = true;
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(promptOf()).toContain('[FENCED]RUN STATE TEXT[/FENCED]');
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
    // Only a chat paired to the run's own login (none: the anchor's), W7d.
    expect(h.pairedChatCalls[0]).toMatchObject({
      ownerId: 'owner-1',
      loginId: 'owner-1',
      telegramChatId: '555',
    });
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

describe('runs resume turn: the run login (W7c fix round 1, L7)', () => {
  it('reads and writes the thread of the login the run was planned for', async () => {
    seedHappyPath({ run: { loginId: 'login-b' } });
    h.runResponderLoop = vi.fn(async (...a: unknown[]) => {
      const opts = a[0] as { loadContext: () => Promise<unknown>; surface: unknown };
      await opts.loadContext();
      h.seq.push(`surface:${JSON.stringify(opts.surface)}`);
      return { reply: h.loopReply, toolCalls: [] };
    });
    const res = await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(res).toMatchObject({ resumed: true });
    expect(h.contextArgs).toEqual([expect.objectContaining({ loginId: 'login-b' })]);
    // The prompt is assembled for that login too (W7 integration fix).
    expect(h.assembleArgs).toEqual([expect.objectContaining({ loginId: 'login-b' })]);
    expect(h.seq).toContain('surface:{"kind":"web","loginId":"login-b"}');
    expect(h.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ loginId: 'login-b' }));
  });

  // W7c fix round 2: a member's run (a workspace other than Admin) resumes
  // on a team surface, which owner-only tools refuse; an Admin run (its
  // workspace Admin, or NULL = Admin) on the web as its login.
  const surfaceFor = async (
    run: Record<string, unknown>,
    wsRows?: Record<string, unknown>[],
    tg?: { originChannel: { kind: 'telegram'; chat_id: string }; chat?: Record<string, unknown> },
  ) => {
    seedHappyPath({
      run,
      ...(tg
        ? {
            originChannel: tg.originChannel,
            ...(tg.chat
              ? { telegramChat: [tg.chat], telegramAccount: [{ id: 'acct-9', enabled: true }] }
              : {}),
          }
        : {}),
    });
    if (wsRows) fake.queue('workspaces', wsRows);
    let seen = '';
    h.runResponderLoop = vi.fn(async (...a: unknown[]) => {
      seen = JSON.stringify((a[0] as { surface: unknown }).surface);
      return { reply: h.loopReply, toolCalls: [] };
    });
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    return seen;
  };

  it("resumes a member's run (another workspace) on a team surface", async () => {
    expect(
      await surfaceFor({ loginId: 'login-m', workspaceId: 'ws-team' }, [{ isAdmin: false }]),
    ).toBe('{"kind":"team","loginId":"login-m","privateReads":false}');
  });

  it('resumes an Admin run as its login on the web', async () => {
    expect(
      await surfaceFor({ loginId: 'login-b', workspaceId: 'ws-admin' }, [{ isAdmin: true }]),
    ).toBe('{"kind":"web","loginId":"login-b"}');
  });

  it('resumes a run with no workspace (NULL = Admin) as its login on the web', async () => {
    expect(await surfaceFor({ loginId: 'login-b', workspaceId: null })).toBe(
      '{"kind":"web","loginId":"login-b"}',
    );
  });

  // W7d fix round 1, M1: a Telegram-origin run of a workspace other than
  // Admin is that user's, not the owner's: a team surface and the team
  // assembly; its report still goes back to the chat (keyed off the origin).
  it("resumes a member's Telegram-origin run on a team surface, report still to the chat", async () => {
    const seen = await surfaceFor(
      { loginId: 'login-m', workspaceId: 'ws-team' },
      [{ isAdmin: false }],
      {
        originChannel: { kind: 'telegram', chat_id: '555' },
        chat: { id: 'chat-1', accountId: 'acct-9', telegramChatId: '555' },
      },
    );
    // The surface carries the chat (W7d+e), so a run planned in the resumed
    // turn reports back to it too.
    expect(seen).toBe(
      '{"kind":"team","loginId":"login-m","privateReads":false,"originTelegramChatId":"555"}',
    );
    expect(h.assembleArgs[0]).toMatchObject({
      includeIdentity: false,
      withThinking: false,
      allowDelegation: false,
      excludePrivateCorpus: true,
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("an Admin Telegram-origin run keeps the telegram surface with the chat's own bot (L7)", async () => {
    const seen = await surfaceFor({ loginId: null, workspaceId: null }, undefined, {
      originChannel: { kind: 'telegram', chat_id: '555' },
      chat: { id: 'chat-1', accountId: 'acct-9', telegramChatId: '555' },
    });
    expect(seen).toBe('{"kind":"telegram","telegramChatId":"555","accountId":"acct-9"}');
    expect(h.assembleArgs[0]).toMatchObject({ withThinking: true, allowDelegation: true });
  });

  // W7d+e: the workspace is checked first, whatever the login.
  it('a non-Admin run with no login is a team surface without a login, never the owner one', async () => {
    expect(await surfaceFor({ loginId: null, workspaceId: 'ws-team' }, [{ isAdmin: false }])).toBe(
      '{"kind":"team","privateReads":false}',
    );
    expect(
      await surfaceFor({ loginId: null, workspaceId: 'ws-team' }, [{ isAdmin: false }], {
        originChannel: { kind: 'telegram', chat_id: '555' },
      }),
    ).toBe('{"kind":"team","privateReads":false,"originTelegramChatId":"555"}');
  });

  it('a workspace run reads its context as its web chat: no Journal, private types hidden (W7d+e)', async () => {
    h.contextArgs = [];
    seedHappyPath({ run: { loginId: 'login-m', workspaceId: 'ws-team' } });
    fake.queue('workspaces', [{ isAdmin: false }]);
    h.runResponderLoop = vi.fn(async (...a: unknown[]) => {
      await (a[0] as { loadContext: () => Promise<unknown> }).loadContext();
      return { reply: h.loopReply, toolCalls: [] };
    });
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(h.contextArgs).toEqual([
      expect.objectContaining({
        loginId: 'login-m',
        includeJournal: false,
        excludeNodeTypes: ['secret_type', 'email'],
      }),
    ]);
  });

  it('an Admin run reads its full context (no workspace exclusions)', async () => {
    h.contextArgs = [];
    seedHappyPath({ run: { loginId: 'login-b', workspaceId: 'ws-admin' } });
    fake.queue('workspaces', [{ isAdmin: true }]);
    h.runResponderLoop = vi.fn(async (...a: unknown[]) => {
      await (a[0] as { loadContext: () => Promise<unknown> }).loadContext();
      return { reply: h.loopReply, toolCalls: [] };
    });
    await runsResumeTurnImpl({ runId: RUN_ID, groupId: GROUP_ID });
    expect(h.contextArgs).toHaveLength(1);
    expect(h.contextArgs[0]).not.toHaveProperty('includeJournal');
    expect(h.contextArgs[0]).not.toHaveProperty('excludeNodeTypes');
  });

  it('a gone workspace is not Admin: team surface, never the owner one', async () => {
    expect(await surfaceFor({ loginId: 'login-m', workspaceId: 'ws-gone' }, [])).toBe(
      '{"kind":"team","loginId":"login-m","privateReads":false}',
    );
  });
});
