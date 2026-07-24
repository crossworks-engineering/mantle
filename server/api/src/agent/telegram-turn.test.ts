/**
 * Characterization tests for the Telegram turn pipeline
 * (`handleTelegramMessage` in ./runtime.ts) — written BEFORE the audit-#5c
 * refactor that routes the drift-prone middle of this pipeline through
 * @mantle/assistant-runtime. These pin the CURRENT externally-observable
 * behavior at the pipeline's real seams (Telegram HTTP, the LLM tool loop,
 * the DB, the unified conversation stream) so the refactor can prove itself
 * behavior-preserving:
 *
 *   - text turn: send + persist (outbound node + telegram_messages transport
 *     row + assistant_messages mirror via recordTurn)
 *   - chunked send → one transport row per sent chunk
 *   - voice in → voice out (transcribe, replace text, TTS reply)
 *   - `[VOICE]` marker strip (forced TTS; marker never persisted)
 *   - send failure → reply persisted undelivered + the trace fails
 *   - empty model reply → nothing sent, nothing persisted
 *   - attachment ingest → file node + inline extraction folded into the turn
 *   - parity-drift pins (audit #5c): b1 (per-turn loop overrides NOT
 *     forwarded) and b2 (no text-only retry after an image-call failure)
 *
 * Mock style follows extractor-chat.test.ts (module-boundary vi.mock) — there
 * is no DB-backed test convention in this repo, so the drizzle `db` is a
 * chainable stub programmed per test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted state the mocks + tests share ─────────────────────────────────
const h = vi.hoisted(() => {
  // The module under test reads these at import time.
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.ALLOWED_USER_ID = 'owner-1';

  /** One recorded drizzle mutation (update/insert) with its captured payload. */
  type DbWrite = { op: 'update' | 'insert'; table: string; payload: any };

  const state = {
    /** Results handed to successive `db.select()` calls, in order. */
    selectQueue: [] as unknown[][],
    /** Every update/insert the pipeline issued, in order. */
    writes: [] as DbWrite[],
    /** Result for the atomic processed-claim update (`.returning()`). */
    claimResult: [{ id: 'msg-1' }] as unknown[],
    /** Auto-id counter for inserted rows. */
    insertSeq: 0,
    /** Traces opened via startTrace: init + terminal error (null = success). */
    traces: [] as Array<{ init: any; error: string | null }>,
    /** Step names recorded via step(). */
    steps: [] as string[],
    /** Tool-loop behavior programmed per test. */
    loopResult: null as any,
    loopError: null as Error | null,
    loopCalls: [] as any[],
    /** buildChatMessages captured args. */
    buildArgs: [] as any[],
    buildAttachmentArgs: [] as any[],
    recordTurnCalls: [] as any[],
    recordTurnSeq: 0,
    /** Owner thought-trail persistence prefs (both gates share the flag). */
    thoughtsOn: false,
    /** Per-test worker/adapter fixtures. */
    sttWorker: null as any,
    ttsWorker: null as any,
    sttTranscribe: vi.fn(),
    ttsSynthesize: vi.fn(),
    extractResult: { kind: 'image', text: 'a cat', note: null } as any,
    account: { id: 'acct-1', branchPath: '/telegram/saskia' } as any,
    sendMessage: vi.fn(),
    sendVoice: vi.fn(),
    sendChatAction: vi.fn(),
    downloadTelegramFile: vi.fn(),
    recordIngest: vi.fn(),
    upsertFile: vi.fn(),
    noteInboundChannel: vi.fn(),
  };
  return state;
});

// ── drizzle: the pipeline only needs inert condition builders ─────────────
vi.mock('drizzle-orm', () => {
  const cond = () => ({});
  return {
    and: cond,
    asc: cond,
    eq: cond,
    gte: cond,
    inArray: cond,
    isNull: cond,
    ne: cond,
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

// ── @mantle/db: chainable stub + table sentinels ──────────────────────────
vi.mock('@mantle/db', () => {
  const table = (name: string) =>
    new Proxy({ __table: name }, { get: (t: any, p) => (p in t ? t[p] : `${name}.${String(p)}`) });

  const chainMethods = ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy'];
  const db = {
    select: () => {
      const result = h.selectQueue.length > 0 ? h.selectQueue.shift()! : [];
      const c: any = {};
      for (const m of chainMethods) c[m] = () => c;
      c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      return c;
    },
    update: (t: any) => {
      const entry = {
        op: 'update' as const,
        table: t.__table as string,
        payload: undefined as any,
      };
      h.writes.push(entry);
      let returning = false;
      const c: any = {
        set: (v: any) => ((entry.payload = v), c),
        where: () => c,
        returning: () => ((returning = true), c),
        then: (res: any, rej: any) => {
          // Only the atomic claim reads its result; everything else ignores it.
          const isClaim = returning && entry.payload && 'processed' in entry.payload;
          return Promise.resolve(isClaim ? h.claimResult : []).then(res, rej);
        },
        catch: (rej: any) => c.then(undefined, rej),
      };
      return c;
    },
    insert: (t: any) => {
      const entry = {
        op: 'insert' as const,
        table: t.__table as string,
        payload: undefined as any,
      };
      h.writes.push(entry);
      const c: any = {
        values: (v: any) => ((entry.payload = v), c),
        returning: () => c,
        then: (res: any, rej: any) =>
          Promise.resolve([{ id: `gen-${++h.insertSeq}` }]).then(res, rej),
      };
      return c;
    },
    execute: async () => [],
  };

  return {
    db,
    agents: table('agents'),
    toolGroups: table('toolGroups'),
    channels: table('channels'),
    nodes: table('nodes'),
    telegramMessages: table('telegramMessages'),
    telegramChats: table('telegramChats'),
    telegramAccounts: table('telegramAccounts'),
    waitForOwner: async () => 'owner-1',
    getDefaultWorker: vi.fn(async () => h.sttWorker),
    getAgentTtsWorker: vi.fn(async () => h.ttsWorker),
    bumpWorkerUsage: vi.fn(async () => {}),
  };
});

// ── Telegram HTTP boundary ────────────────────────────────────────────────
vi.mock('@mantle/telegram', () => ({
  accountById: vi.fn(async () => h.account),
  downloadTelegramFile: (...a: unknown[]) => h.downloadTelegramFile(...a),
  sendChatAction: (...a: unknown[]) => h.sendChatAction(...a),
  sendMessage: (...a: unknown[]) => h.sendMessage(...a),
  sendVoice: (...a: unknown[]) => h.sendVoice(...a),
}));

// ── LLM/tool-loop + conversation-stream seams (@mantle/agent-runtime) ─────
vi.mock('@mantle/agent-runtime', () => ({
  buildChatMessages: (args: any) => {
    h.buildArgs.push(args);
    return [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.newUserText },
    ];
  },
  buildAttachmentContextText: (text: string, info: any) => {
    h.buildAttachmentArgs.push({ text, info });
    return `${text}\n[attachment kind=${info.kind} transcript=${info.transcript ?? ''} node=${info.nodeId ?? ''}]`;
  },
  composeSystemPromptWithSkills: (prompt: string) => prompt,
  effectiveToolSlugs: () => [] as string[],
  extractAttachmentForTurn: vi.fn(async () => h.extractResult),
  invokeAgent: vi.fn(),
  loadConversationContext: vi.fn(async () => ({
    personaNotes: [],
    facts: [],
    digests: [],
    corpusMap: { entries: [] },
    contentHits: [],
    chunkHits: [],
    relations: [],
    history: [],
    snapshot: {},
  })),
  recordTurn: vi.fn(async (args: any) => {
    h.recordTurnCalls.push(args);
    return { id: `am-${++h.recordTurnSeq}`, createdAt: new Date().toISOString(), ...args };
  }),
  resolveAgentSkills: vi.fn(async () => []),
  resolveAgentToolGroups: vi.fn(async () => []),
  resolveAgentTools: vi.fn(async () => []),
  resolveBackupAdapter: vi.fn(async () => undefined),
  // Used by run-turn via the real @mantle/assistant-runtime barrel.
  summarizeToolOutcomes: vi.fn(() => ({
    calls: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
    failures: [],
  })),
  updateAssistantMessageOutcome: vi.fn(async () => null),
  resolveChatKey: vi.fn(async () => ({ ok: true, apiKey: 'sk-live' })),
  runToolLoop: vi.fn(async (args: any) => {
    h.loopCalls.push(args);
    if (h.loopError) {
      // One-shot: the next loop call (the shared image-fallback's text-only
      // retry) succeeds, mirroring a Bedrock-style image-only failure.
      const err = h.loopError;
      h.loopError = null;
      throw err;
    }
    return h.loopResult;
  }),
}));

// ── Tracing: passthrough that records trace init + terminal error ─────────
vi.mock('@mantle/tracing', () => ({
  startTrace: async (init: any, fn: () => Promise<unknown>) => {
    const rec = { init, error: null as string | null };
    h.traces.push(rec);
    try {
      return await fn();
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  },
  step: async (init: any, fn: (handle: any) => Promise<unknown>) => {
    h.steps.push(init.name);
    return fn({ setMeta: () => {}, setOutput: () => {} });
  },
  runDurableStep: async (_name: string, fn: () => Promise<unknown>) => fn(),
  recordIngest: (...a: unknown[]) => h.recordIngest(...a),
  refreshModelCatalog: vi.fn(async () => {}),
  modelSupportsVision: vi.fn(() => true),
  maxImageBytesFor: vi.fn(() => 5 * 1024 * 1024),
  // Used by run-turn/run-team-turn, which ride into the module graph via the
  // real @mantle/assistant-runtime barrel (the assembly under test is REAL).
  emitTurnLifecycle: vi.fn(),
  registerTurnAbort: vi.fn(() => null),
  unregisterTurnAbort: vi.fn(),
  currentTrace: vi.fn(() => null),
}));

// ── Remaining collaborators ───────────────────────────────────────────────
vi.mock('@mantle/content', () => ({
  buildIdentityContext: vi.fn(async () => ''),
  buildTimeContextLine: () => 'Current time: 2026-07-17T10:00:00+02:00 (Africa/Johannesburg)',
  loadProfilePreferences: vi.fn(async () => ({})),
  resolveThinkingBudget: () => 0,
  noteInboundChannel: (...a: unknown[]) => (h.noteInboundChannel(...a), Promise.resolve()),
  isStreamThoughtsEnabled: () => h.thoughtsOn,
  isPersistThoughtsEnabled: () => h.thoughtsOn,
  // Used by run-turn/run-team-turn via the real @mantle/assistant-runtime
  // barrel — never exercised by these tests.
  applyAutoTimezone: vi.fn(async (_o: string, _l: unknown, prefs: unknown) => ({ prefs })),
  buildLocationContextLine: () => '',
  appendTeamMessage: vi.fn(),
  updateTeamMessageOutcome: vi.fn(),
  recentTeamMessages: vi.fn(async () => []),
  isTeamPrivateReadsEnabled: () => false,
  TEAM_PRIVATE_READ_SLUGS: [] as string[],
}));
vi.mock('@mantle/content/table-storage', () => ({ sweepLegacyTables: vi.fn(async () => {}) }));
vi.mock('@mantle/files', () => ({
  ensureDatedUploadFolder: vi.fn(async () => '/telegram-uploads/2026-07-17'),
  upsertFile: (...a: unknown[]) => h.upsertFile(...a),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKey: vi.fn(async () => 'sk-bare'),
  getApiKeyById: vi.fn(async () => 'sk-by-id'),
}));
vi.mock('@mantle/voice', () => ({
  composeAudioTagInstructions: () => '',
  getChatAdapter: () => ({
    providerId: 'openrouter',
    adapterName: 'openrouter-chat',
    chat: vi.fn(),
  }),
  getSttAdapter: () => ({ adapterName: 'openai-stt', transcribe: h.sttTranscribe }),
  getTtsAdapter: () => ({ adapterName: 'openai-tts', synthesize: h.ttsSynthesize }),
  stripAudioTags: (text: string) => ({ text, stripped: 0 }),
}));
vi.mock('@mantle/tools', () => ({
  registerAgentInvoker: vi.fn(),
  seedBuiltinTools: vi.fn(async () => ({ inserted: 0, updated: 0 })),
}));
vi.mock('@mantle/heartbeats', () => ({
  buildOpenHeartbeatContext: () => '',
  HEARTBEAT_DUE_CHANNEL: 'heartbeat_due',
  HEARTBEAT_RESPONDER_TOOLS: [] as string[],
  hasActiveHeartbeatsOnSurface: vi.fn(async () => false),
  openHeartbeatsForSurface: vi.fn(async () => []),
  registerHeartbeatTools: vi.fn(),
  tickHeartbeats: vi.fn(async () => ({ considered: 0, fired: 0, skipped: 0, errored: 0 })),
}));
vi.mock('@mantle/embeddings', () => ({
  resolveEmbeddingConfig: vi.fn(async () => ({
    model: 'test-embed',
    dimensions: 4,
    primary: { provider: 'openai' },
    backup: null,
  })),
}));
vi.mock('postgres', () => ({ default: () => ({ listen: async () => {} }) }));
// Local siblings the runtime module pulls in at import time — not under test.
vi.mock('./summarizer.js', () => ({ summarizeAgentConversation: vi.fn(async () => {}) }));
vi.mock('./extract-queue.js', () => ({
  enqueueExtract: vi.fn(async () => {}),
  startExtractQueue: vi.fn(async () => {}),
  stopExtractQueue: vi.fn(async () => {}),
}));
vi.mock('./reflector.js', () => ({ reflect: vi.fn(async () => {}) }));

import { handleTelegramMessage } from './runtime';

// ── Fixtures ──────────────────────────────────────────────────────────────
function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'saskia',
    role: 'responder',
    enabled: true,
    priority: 100,
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    systemPrompt: 'You are Saskia.',
    apiKeyId: 'key-1',
    baseUrl: null,
    viaTailnet: false,
    params: {},
    memoryConfig: {},
    skillSlugs: [],
    toolGroupSlugs: [],
    ttsWorkerId: null,
    usageCount: 0,
    ...overrides,
  };
}

function makeMsgRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    processed: false,
    direction: 'inbound',
    chatPk: 'chat-pk-1',
    text: 'hello saskia',
    sentAt: new Date(),
    telegramChatId: '777',
    telegramMessageId: '555',
    fromName: 'Jason',
    accountId: 'acct-1',
    responderAgentId: null,
    channelAgentId: 'agent-1',
    attachments: [] as unknown[],
    ...overrides,
  };
}

/** Program the standard two selects (message row, responder agent) + run. */
async function runTurn(row: Record<string, unknown>, agent = makeAgent()) {
  h.selectQueue = [[row], [agent]];
  await handleTelegramMessage(row.id as string);
}

const insertsInto = (table: string) =>
  h.writes.filter((w) => w.op === 'insert' && w.table === table);
const updatesOf = (table: string) => h.writes.filter((w) => w.op === 'update' && w.table === table);
const outboundTurns = () => h.recordTurnCalls.filter((c) => c.direction === 'outbound');
const inboundTurns = () => h.recordTurnCalls.filter((c) => c.direction === 'inbound');

beforeEach(() => {
  h.selectQueue = [];
  h.writes = [];
  h.claimResult = [{ id: 'msg-1' }];
  h.insertSeq = 0;
  h.traces = [];
  h.steps = [];
  h.loopResult = {
    reply: 'hi there!',
    messages: [],
    iterations: 1,
    toolCalls: [],
    pendingIds: [],
    artifacts: [],
    tokensOut: 5,
  };
  h.loopError = null;
  h.loopCalls = [];
  h.buildArgs = [];
  h.buildAttachmentArgs = [];
  h.recordTurnCalls = [];
  h.recordTurnSeq = 0;
  h.thoughtsOn = false;
  h.sttWorker = null;
  h.ttsWorker = null;
  h.extractResult = { kind: 'image', text: 'a cat', note: null };
  h.sttTranscribe.mockReset();
  h.ttsSynthesize.mockReset();
  h.sendMessage.mockReset().mockResolvedValue([111]);
  h.sendVoice.mockReset().mockResolvedValue(333);
  h.sendChatAction.mockReset().mockResolvedValue(undefined);
  h.downloadTelegramFile
    .mockReset()
    .mockResolvedValue({ bytes: Buffer.from('IMGBYTES'), mimeType: 'image/jpeg' });
  h.recordIngest.mockReset().mockResolvedValue(undefined);
  h.upsertFile.mockReset().mockResolvedValue({ id: 'file-node-1', sizeBytes: 8 });
  h.noteInboundChannel.mockReset();
});

describe('handleTelegramMessage — text turn', () => {
  it('claims the row, sends the reply, and persists transport + mirror rows', async () => {
    await runTurn(makeMsgRow());

    // Atomic processed-claim BEFORE any work.
    const claim = updatesOf('telegramMessages').find((u) => u.payload?.processed === true);
    expect(claim).toBeDefined();

    // Native typing indicator poked at least once.
    expect(h.sendChatAction).toHaveBeenCalledWith(h.account, '777', 'typing');

    // Reply sent once, threaded under the inbound message.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(h.account, '777', 'hi there!', { replyTo: '555' });

    // Transport persistence: one outbound node + one telegram_messages row.
    const nodeRows = insertsInto('nodes');
    expect(nodeRows).toHaveLength(1);
    expect(nodeRows[0]!.payload.type).toBe('telegram_message');
    expect(nodeRows[0]!.payload.data).toMatchObject({
      direction: 'outbound',
      delivered: true,
      agent: 'saskia',
    });
    const tmRows = insertsInto('telegramMessages');
    expect(tmRows).toHaveLength(1);
    expect(tmRows[0]!.payload).toMatchObject({
      direction: 'outbound',
      text: 'hi there!',
      telegramMessageId: '111',
      replyToId: 'msg-1',
      delivered: true,
      processed: true,
    });

    // Unified-stream mirror: inbound + outbound assistant_messages rows.
    expect(inboundTurns()).toHaveLength(1);
    expect(inboundTurns()[0]).toMatchObject({
      channel: 'telegram',
      text: 'hello saskia',
      externalRef: { accountId: 'acct-1', chatId: '777', messageId: '555' },
    });
    expect(outboundTurns()).toHaveLength(1);
    expect(outboundTurns()[0]).toMatchObject({
      channel: 'telegram',
      text: 'hi there!',
      externalRef: { chatId: '777', messageId: '111' },
    });

    // Telegram is reminder-capable: the inbound flips the delivery channel.
    expect(h.noteInboundChannel).toHaveBeenCalledWith('owner-1', 'telegram');

    // One responder_turn trace, ended clean; agent usage bumped.
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]!.init.kind).toBe('responder_turn');
    expect(h.traces[0]!.error).toBeNull();
    expect(updatesOf('agents')).toHaveLength(1);
  });

  it('a chunked send persists one transport row per sent chunk, one mirror row total', async () => {
    h.sendMessage.mockResolvedValue([111, 222]);
    await runTurn(makeMsgRow());

    const tmRows = insertsInto('telegramMessages');
    expect(tmRows).toHaveLength(2);
    expect(tmRows.map((r) => r.payload.telegramMessageId)).toEqual(['111', '222']);
    expect(insertsInto('nodes')).toHaveLength(2);
    // The unified stream gets the FULL reply once; external_ref points at the
    // first chunk for reply threading.
    expect(outboundTurns()).toHaveLength(1);
    expect(outboundTurns()[0].externalRef.messageId).toBe('111');
  });

  it('b3 RESOLVED: an empty model reply sends + persists the shared fallback', async () => {
    // Stage-0 pinned the OLD behavior (the turn went silent — no send, no
    // outbound rows). Stage 2 routes the loop through the shared core, which
    // substitutes the same honest fallback the web /assistant sends, so the
    // user gets a reply they can react to instead of dead air.
    h.loopResult.reply = '';
    await runTurn(makeMsgRow());

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![2]).toMatch(/couldn't compose a final answer/);
    expect(insertsInto('telegramMessages')).toHaveLength(1);
    expect(outboundTurns()).toHaveLength(1);
    expect(outboundTurns()[0].text).toMatch(/couldn't compose a final answer/);
    expect(h.traces[0]!.error).toBeNull();
  });

  it('b4/b5 RESOLVED: thought trail + tool-outcome ledger land on the outbound mirror', async () => {
    // Stage 2: the shared core computes the persistable thought trail
    // (prefs-gated) and the deterministic toolStats ledger; the Telegram
    // adapter persists them on the assistant_messages mirror under the same
    // data keys the web path writes — /assistant renders both identically.
    h.thoughtsOn = true;
    h.loopResult.toolCalls = [
      { slug: 'note_create', argsJson: '{"title":"Q3 plan"}', durationMs: 42, error: null },
    ];
    await runTurn(makeMsgRow());

    const outbound = outboundTurns()[0];
    expect(outbound.data.thoughts).toEqual([
      { kind: 'write', label: 'Saving “Q3 plan” to your notes…', elapsedMs: 42 },
    ]);
    // The ledger comes from summarizeToolOutcomes (mocked here — the real
    // tally is unit-tested with the shared core).
    expect(outbound.data.toolStats).toBeDefined();
  });

  it('a Telegram send failure persists the reply undelivered and fails the trace', async () => {
    h.sendMessage.mockRejectedValue(new Error('tg 502'));
    await expect(runTurn(makeMsgRow())).resolves.toBeUndefined(); // handler never throws

    // Reply persisted, flagged undelivered, no Telegram id.
    const tmRows = insertsInto('telegramMessages');
    expect(tmRows).toHaveLength(1);
    expect(tmRows[0]!.payload).toMatchObject({
      text: 'hi there!',
      delivered: false,
      telegramMessageId: null,
    });
    expect(insertsInto('nodes')[0]!.payload.data.delivered).toBe(false);
    // Mirror row still lands (recoverable), without a message id.
    expect(outboundTurns()).toHaveLength(1);
    expect(outboundTurns()[0].externalRef.messageId).toBeUndefined();
    // The trace fails so the delivery failure surfaces in "Needs attention".
    expect(h.traces[0]!.error).toMatch(/Telegram send failed/);
  });

  it('skips a message with nothing actionable without opening a trace', async () => {
    h.selectQueue = [[makeMsgRow({ text: '(sticker)', attachments: [{ kind: 'sticker' }] })]];
    await handleTelegramMessage('msg-1');

    const processed = updatesOf('telegramMessages').find((u) => u.payload?.processed === true);
    expect(processed).toBeDefined();
    expect(h.traces).toHaveLength(0);
    expect(h.recordTurnCalls).toHaveLength(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handleTelegramMessage — voice', () => {
  const voiceRow = () =>
    makeMsgRow({ text: '(voice message)', attachments: [{ kind: 'voice', file_id: 'vf-1' }] });

  beforeEach(() => {
    h.sttWorker = {
      id: 'w-stt',
      slug: 'stt-1',
      provider: 'openai',
      model: 'whisper-1',
      params: {},
      apiKeyId: 'key-stt',
    };
    h.ttsWorker = {
      id: 'w-tts',
      slug: 'tts-1',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      params: {},
      apiKeyId: 'key-tts',
    };
    h.sttTranscribe.mockResolvedValue({
      text: 'hello from voice',
      model: 'whisper-1',
      language: 'en',
      durationSeconds: 2,
    });
    h.ttsSynthesize.mockResolvedValue({
      bytes: Buffer.from('OGG'),
      voice: 'nova',
      model: 'gpt-4o-mini-tts',
    });
  });

  it('voice in → transcribes, replaces the placeholder text, replies as voice', async () => {
    await runTurn(voiceRow());

    // Transcript replaces the placeholder in the transport row…
    const transcriptUpdate = updatesOf('telegramMessages').find(
      (u) => u.payload?.text === 'hello from voice',
    );
    expect(transcriptUpdate).toBeDefined();
    // …and downstream (the unified stream) sees real words.
    expect(inboundTurns()[0].text).toBe('hello from voice');

    // Voice in → voice out: TTS synthesis + sendVoice, no text message.
    expect(h.ttsSynthesize).toHaveBeenCalledTimes(1);
    expect(h.ttsSynthesize.mock.calls[0]![0].text).toBe('hi there!');
    expect(h.sendVoice).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    // Transport row carries the voice message's Telegram id.
    expect(insertsInto('telegramMessages')[0]!.payload.telegramMessageId).toBe('333');
  });

  it('a [VOICE] marker forces TTS and is stripped before send + persist', async () => {
    h.loopResult.reply = '[VOICE] hi love';
    await runTurn(makeMsgRow()); // typed text in — marker alone opts into voice

    expect(h.ttsSynthesize.mock.calls[0]![0].text).toBe('hi love');
    expect(h.sendVoice).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(insertsInto('telegramMessages')[0]!.payload.text).toBe('hi love');
    expect(outboundTurns()[0].text).toBe('hi love');
  });

  it('a reply that is ONLY the [VOICE] marker is treated as empty', async () => {
    h.loopResult.reply = '  [VOICE]  ';
    await runTurn(makeMsgRow());

    expect(h.sendVoice).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(outboundTurns()).toHaveLength(0);
  });

  it('TTS failure falls back to a text send instead of dropping the reply', async () => {
    h.ttsSynthesize.mockRejectedValue(new Error('tts down'));
    await runTurn(voiceRow());

    expect(h.sendVoice).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![2]).toBe('hi there!');
  });
});

describe('handleTelegramMessage — attachments', () => {
  const photoRow = () =>
    makeMsgRow({
      text: '(photo)',
      attachments: [{ kind: 'photo', file_id: 'pf-1', mime: 'image/jpeg' }],
    });

  it('a photo is ingested to a file node and its inline extraction folds into the turn', async () => {
    await runTurn(photoRow());

    // Bytes fetched + saved as a real file node, ingest ledger written.
    expect(h.downloadTelegramFile).toHaveBeenCalledWith(h.account, 'pf-1');
    expect(h.upsertFile).toHaveBeenCalledTimes(1);
    expect(h.recordIngest).toHaveBeenCalledTimes(1);
    expect(h.recordIngest.mock.calls[0]![0]).toMatchObject({
      source: 'telegram_upload',
      nodeId: 'file-node-1',
    });

    // Ingest trace + responder trace, in that order.
    expect(h.traces.map((t) => t.init.kind)).toEqual(['photo_ingest', 'responder_turn']);

    // The transcript-default routing: extraction text + node id folded into
    // the responder's user text (no raw pixels when a transcript exists).
    expect(h.buildAttachmentArgs).toHaveLength(1);
    expect(h.buildAttachmentArgs[0].text).toBe("Here's an image — tell me what you see.");
    expect(h.buildAttachmentArgs[0].info).toMatchObject({
      kind: 'image',
      transcript: 'a cat',
      nodeId: 'file-node-1',
    });
    expect(h.buildArgs[0].userImage).toBeUndefined();
    expect(h.buildArgs[0].newUserText).toContain('transcript=a cat');

    // Inbound mirror row carries the attachment provenance.
    expect(inboundTurns()[0].attachments).toEqual([
      { kind: 'image', mime: 'image/jpeg', fileId: 'pf-1', nodeId: 'file-node-1' },
    ]);
  });

  it('with no transcript and a vision model, the raw image is shown inline', async () => {
    h.extractResult = { kind: 'image', text: '', note: null };
    await runTurn(photoRow());

    expect(h.buildArgs[0].userImage).toEqual({
      base64: Buffer.from('IMGBYTES').toString('base64'),
      mimeType: 'image/jpeg',
    });
    expect(h.buildArgs[0].newUserText).toBe("Here's an image — tell me what you see.");
  });

  it('a failed attachment download apologises instead of going silent', async () => {
    h.downloadTelegramFile.mockRejectedValue(new Error('tg timeout'));
    await runTurn(photoRow());

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![2]).toMatch(/couldn't fetch that file/);
    expect(h.loopCalls).toHaveLength(0); // the responder never ran
  });
});

describe('handleTelegramMessage — parity-drift resolutions (audit #5c)', () => {
  it('b1 RESOLVED: per-turn loop overrides in memory_config ARE forwarded (clamped)', async () => {
    // Stage-0 pinned the OLD behavior (overrides silently ignored — the
    // Telegram copy predated the web path's forwarding). Stage 1 routes the
    // assembly through @mantle/assistant-runtime, adopting the web behavior:
    // max_iterations clamped to 30, tool-volume caps forwarded raw.
    await runTurn(
      makeMsgRow(),
      makeAgent({
        memoryConfig: { max_iterations: 50, max_tool_calls: 40, max_calls_per_tool: 9 },
      }),
    );

    expect(h.loopCalls).toHaveLength(1);
    expect(h.loopCalls[0].maxIterations).toBe(30); // 50 clamped to the hard cap
    expect(h.loopCalls[0].maxToolCallsPerTurn).toBe(40);
    expect(h.loopCalls[0].maxCallsPerToolPerTurn).toBe(9);
    expect(h.loopCalls[0].surface).toEqual({
      kind: 'telegram',
      telegramChatId: '777',
      replyToTelegramMessageId: '555',
    });
  });

  it('b2 RESOLVED: an LLM failure with a raw image attached retries once text-only', async () => {
    // Stage-0 pinned the OLD behavior (the error killed the turn — no reply).
    // Stage 1 adopts the web path's fix: retry WITHOUT the image, grounded in
    // the transcript marker, inside the same responder_turn trace.
    h.extractResult = { kind: 'image', text: '', note: null }; // no transcript → raw pixels
    h.loopError = new Error('Could not process image'); // one-shot: retry succeeds
    await runTurn(
      makeMsgRow({
        text: '(photo)',
        attachments: [{ kind: 'photo', file_id: 'pf-1', mime: 'image/jpeg' }],
      }),
    );

    expect(h.loopCalls).toHaveLength(2);
    // First attempt carried the raw image; the retry is text-only with the
    // attachment marker (empty transcript, node id surfaced) folded in.
    expect(h.buildArgs[0].userImage).toBeDefined();
    expect(h.buildArgs[1].userImage).toBeUndefined();
    expect(h.buildArgs[1].newUserText).toContain('node=file-node-1');
    // The reply lands: sent + persisted, trace ends clean.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(outboundTurns()).toHaveLength(1);
    const responder = h.traces.find((t) => t.init.kind === 'responder_turn');
    expect(responder!.error).toBeNull();
  });
});
