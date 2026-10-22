/**
 * The static narrow write scan's pins (narrow-write-scan.ts): the writes of the source the narrow role's
 * allowlist does not hold, outside every full-route spot.
 */

/** Files that never run on a narrow exit, each with why: their writes run on
 *  the system pool whatever they name. */
export const NARROW_SCAN_SYSTEM_FILES: Readonly<Record<string, string>> = Object.freeze({
  'packages/calendar/src/sync.ts': 'the calendar sync worker (system work)',
  'packages/email/src/backfill-rfc-message-id.ts': 'a one-shot backfill job (system work)',
  'packages/email/src/sync.ts': 'the mail sync worker (pg-boss job: system work)',
  'packages/microsoft/src/drives/sync.ts': 'the drive sync worker (system work)',
  'packages/runs/src/budget.ts':
    "the runs engine's budget: the runs worker (system pool) or the run-control spot",
  'packages/runs/src/engine.ts':
    "the runs engine: the runs worker's step (system work, the system pool) or a run-control spot's transaction (run_plan, run_append, an answer, a budget)",
  'packages/runs/src/sweep.ts': 'the runs sweep: a worker loop (system work)',
  'packages/telegram/src/sync.ts':
    "the Telegram poller (system work; a chat's turn runs in the chat login's scope)",
  'server/api/src/bench/haystack.ts': 'the memory benchmark harness (a scratch brain, never a box)',
  'server/api/src/workflows/runs-worker-turn.ts': "the runs worker's turn (system work)",
  'server/web/lib/auth/device-token-reap.ts': 'a reaper loop (system work)',
  'server/web/lib/brain-identity.ts': "the brain's identity row made once at boot (system work)",
  'server/web/lib/maintenance/actor-misses-reap.ts': 'the maintenance runner (system work)',
  'server/web/lib/maintenance/history.ts':
    'the maintenance runner (CLI and nightly cron: system work)',
  'server/web/lib/system-manifest/reconcile.ts':
    "the manifest's boot reconcile (system work) and its apply at the manifest's spots",
  'server/web/workers/microsoft-sync.ts': 'the Microsoft sync worker (system work)',
});

/** Whether an open write reaches a narrow exit (the narrow login would meet
 *  it at run time, outside every spot), or is covered across files (every
 *  caller runs it at a spot, in a login's own scope, or as system work). */
export type NarrowScanOpenTag = 'reaches-narrow' | 'covered-across-files';

/**
 * Writes the allowlist does not hold, not lexically at a spot and not in a
 * system file, pinned by occurrence: `n` is how many times the scan finds
 * the key, so a new write of a known key fails narrow-write-scan.test.ts as
 * a new key does, and so does an entry the scan finds fewer times (keep it
 * exact). Each is tagged (the auditor's ask K): 'reaches-narrow' when an
 * Admin area or login-self exit, a narrow asSystem reason, or systemDb in a
 * login's turn or request scope runs it outside a spot (`why` names the
 * path, and whether the narrow login holds the write there or would refuse
 * it: those are the real gaps); 'covered-across-files' when every caller
 * reaches it at a spot in another file, in a login's own scope (the write
 * role) or as system work (`why` says how). This list only shrinks: each
 * entry must move to its spot, a definer or the allowlist (with a measured
 * cell), or its file be shown system only. TODO(narrow): empty it.
 */
export const NARROW_SCAN_OPEN: Readonly<
  Record<string, { n: number; tag: NarrowScanOpenTag; why: string }>
> = Object.freeze({
  'packages/content/src/app-access-log.ts delete public.app_access_log': {
    n: 1,
    tag: 'covered-across-files',
    why: "reapAppAccessLog: only the maintenance sweep app-access-log-reap (nightly cron, or the runner's spawned script): system work",
  },
  'packages/content/src/app-nav.ts insert public.item_marks [pinned_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "saveAppPins: only PUT /api/app-nav/pins, a content route: the login's own request scope (the login write gateway)",
  },
  'packages/content/src/app-nav.ts update public.item_marks [pinned_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "saveAppPins: only PUT /api/app-nav/pins, a content route: the login's own request scope (the login write gateway)",
  },
  'packages/content/src/contact-share-codes.ts insert public.share_access_log': {
    n: 1,
    tag: 'covered-across-files',
    why: 'checkContactShareCode: only POST /s/:token/code, a public route with no login (no exit: the system pool, full route)',
  },
  'packages/content/src/contact-share-codes.ts update public.contact_share_codes [failed_attempts,failed_since,last_used_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'checkContactShareCode: only POST /s/:token/code, a public route with no login (no exit: the system pool, full route)',
    },
  'packages/content/src/contact-share-codes.ts update public.contact_share_codes [failed_attempts,failed_since,locked_until]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'checkContactShareCode: only POST /s/:token/code, a public route with no login (no exit: the system pool, full route)',
    },
  'packages/content/src/entity-dedup.ts insert public.entity_merge_dismissals': {
    n: 1,
    tag: 'covered-across-files',
    why: "dismissMergeCandidate: only POST /api/entities/dismiss, a content route: the login's own request scope (write role)",
  },
  'packages/content/src/member-invites.ts insert auth.users': {
    n: 1,
    tag: 'covered-across-files',
    why: 'redeemMemberInvite (and linkContactHistoryToLogin inside it): only POST /api/auth/invite/accept, a public route with no login (no exit: the system pool, full route)',
  },
  'packages/content/src/member-invites.ts update public.member_invites [redeemed_at,redeemed_login_id]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'redeemMemberInvite (and linkContactHistoryToLogin inside it): only POST /api/auth/invite/accept, a public route with no login (no exit: the system pool, full route)',
    },
  'packages/content/src/member-invites.ts update public.team_access_log [login_id]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'redeemMemberInvite (and linkContactHistoryToLogin inside it): only POST /api/auth/invite/accept, a public route with no login (no exit: the system pool, full route)',
  },
  'packages/content/src/member-snapshots.ts insert public.accepted_snapshots [*]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'writeAcceptedSnapshots: only snapshotOf, reached from makeSnapshotCopies (systemWork: the boot step and its script)',
  },
  'packages/content/src/member-turn-ledger.ts delete public.member_turn_ledger': {
    n: 2,
    tag: 'reaches-narrow',
    why: "would be refused (42501) on the narrow route: a member's chat request (POST /api/assistant/turn, threads, continue, summarize, transcribe) claims or releases its slot through systemDb inside the login's request scope; the Telegram turn's claim runs outside any scope (full)",
  },
  'packages/content/src/member-turn-ledger.ts insert public.member_turn_ledger': {
    n: 1,
    tag: 'reaches-narrow',
    why: "would be refused (42501) on the narrow route: claimMemberTurn's systemDb transaction inside a member's chat request scope (POST /api/assistant/turn, threads, continue, summarize, transcribe); the Telegram turn's claim runs outside any scope (full)",
  },
  'packages/content/src/pdf-passwords.ts update public.pdf_passwords [last_used_at,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "markPdfPasswordUsed: only the extractor's PDF unlock (load-body.ts tryUnlockPdf, the extract queue worker): system work",
  },
  'packages/content/src/peers/registry.ts update public.mantle_peers [last_seen_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'verifyInboundToken: the inbound peer bearer check (federation routes, the /api/mcp bearer) runs before any login or exit: full route',
  },
  'packages/content/src/share-access-log.ts delete public.share_access_log': {
    n: 1,
    tag: 'covered-across-files',
    why: "reapShareAccessLog: only the maintenance sweep app-access-log-reap (nightly cron, or the runner's spawned script): system work",
  },
  'packages/content/src/share-access-log.ts insert public.share_access_log': {
    n: 1,
    tag: 'covered-across-files',
    why: "recordShareAccess: only the public /s/:token routes, the share page, the contact gate and the link's app broker: a public route with no login (no exit: the system pool, full route)",
  },
  'packages/content/src/tree/apps-nav.ts insert public.item_marks [open_count,opened_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "copyAppMarks: only under runReadPathWrite('backfill:app-marks'), which binds its own system actor, so no exit's narrow route holds (full)",
  },
  'packages/content/src/tree/apps-nav.ts insert public.item_marks [pinned_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "copyAppMarks: only under runReadPathWrite('backfill:app-marks'), which binds its own system actor, so no exit's narrow route holds (full)",
  },
  'packages/content/src/tree/marks.ts insert public.item_marks [open_count,opened_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "recordItemOpened, setItemPinned: the /api/tree/items/:id and /api/apps/:id/opened content routes: the login's own request scope (write gateway)",
  },
  'packages/content/src/tree/marks.ts insert public.item_marks [pinned_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "recordItemOpened, setItemPinned: the /api/tree/items/:id and /api/apps/:id/opened content routes: the login's own request scope (write gateway)",
  },
  'packages/content/src/tree/marks.ts update public.item_marks [pinned_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "recordItemOpened, setItemPinned: the /api/tree/items/:id and /api/apps/:id/opened content routes: the login's own request scope (write gateway)",
  },
  'packages/db/src/ai-workers-resolve.ts update public.ai_workers [last_used_at,updated_at,usage_count]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "bumpWorkerUsage (db): the workers (extractor, summarizer, reflector, Jev), the Telegram turn outside its scope, rule-in-query (full) or a login's turn or chat scope",
    },
  'packages/runtime/src/agent/chat-archive.ts insert public.chat_threads': {
    n: 3,
    tag: 'covered-across-files',
    why: "archiveAgentChat, summarizeChatThread: the chat routes run them under inRuleInQuery (asSystem 'rule-in-query': full route); Telegram /new runs outside any scope (full)",
  },
  'packages/runtime/src/agent/chat-archive.ts update public.chat_threads [archived_at,archived_by,status,turn_count,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "archiveAgentChat, summarizeChatThread: the chat routes run them under inRuleInQuery (asSystem 'rule-in-query': full route); Telegram /new runs outside any scope (full)",
    },
  'packages/runtime/src/agent/chat-archive.ts update public.chat_threads [seed_thread_id,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "archiveAgentChat, summarizeChatThread: the chat routes run them under inRuleInQuery (asSystem 'rule-in-query': full route); Telegram /new runs outside any scope (full)",
    },
  'packages/runtime/src/agent/chat-archive.ts update public.chat_threads [summary_node_id,title,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "archiveAgentChat, summarizeChatThread: the chat routes run them under inRuleInQuery (asSystem 'rule-in-query': full route); Telegram /new runs outside any scope (full)",
    },
  'packages/runtime/src/agent/chat-archive.ts update public.chat_threads [title,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "archiveAgentChat, summarizeChatThread: the chat routes run them under inRuleInQuery (asSystem 'rule-in-query': full route); Telegram /new runs outside any scope (full)",
  },
  'packages/telegram/src/channels.ts insert public.channels': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertTelegramChannel: only inside the full-route spot telegram-connect (agent-telegram.ts connectAgentTelegram) and the seed-telegram script',
  },
  'packages/telegram/src/channels.ts update public.channels [agent_id,config,credentials_enc,display_name,enabled,owner_id,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'upsertTelegramChannel: only inside the full-route spot telegram-connect (agent-telegram.ts connectAgentTelegram) and the seed-telegram script',
    },
  'packages/telegram/src/channels.ts update public.channels [credentials_enc]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertTelegramChannel: only inside the full-route spot telegram-connect (agent-telegram.ts connectAgentTelegram) and the seed-telegram script',
  },
  'packages/telegram/src/channels.ts update public.telegram_accounts [channel_id,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertTelegramChannel: only inside the full-route spot telegram-connect (agent-telegram.ts connectAgentTelegram) and the seed-telegram script',
  },
  'packages/telegram/src/chat-login.ts update public.telegram_chats [allowlist_status,login_id,pairing_code,pairing_expires_at,pairing_replies,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'unpairRefusedChat: only the Telegram turn workflow (runtime.ts handleTelegramMessage), outside any scope: the system pool, full route',
    },
  'packages/telegram/src/gate.ts insert public.telegram_chats': {
    n: 1,
    tag: 'covered-across-files',
    why: 'gate and upsertChat: only the Telegram poller (packages/telegram/src/sync.ts, a system file): system work',
  },
  'packages/telegram/src/gate.ts update public.telegram_chats [allowlist_status,pairing_code,pairing_expires_at,pairing_replies,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'gate and upsertChat: only the Telegram poller (packages/telegram/src/sync.ts, a system file): system work',
    },
  'packages/telegram/src/gate.ts update public.telegram_chats [pairing_code,pairing_expires_at,pairing_replies,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'gate and upsertChat: only the Telegram poller (packages/telegram/src/sync.ts, a system file): system work',
    },
  'packages/telegram/src/gate.ts update public.telegram_chats [pairing_replies,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'gate and upsertChat: only the Telegram poller (packages/telegram/src/sync.ts, a system file): system work',
  },
  'packages/tools/src/builtins-telegram.ts update public.telegram_messages [processed,processed_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "telegram_mark_processed writes inside telegramSystemWork (systemWork 'login-telegram'), which always runs on the full route",
    },
  'packages/tools/src/seed.ts insert public.tools': {
    n: 1,
    tag: 'covered-across-files',
    why: "seedBuiltinTools: the agent runtime's boot (system work), seedToolCapabilities at the full-route spot tool-group-grant, and a script",
  },
  'packages/tools/src/seed.ts update public.tools [description,handler,input_schema,name,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: "seedBuiltinTools: the agent runtime's boot (system work), seedToolCapabilities at the full-route spot tool-group-grant, and a script",
    },
  'packages/tools/src/tool-results.ts delete public.tool_results': {
    n: 1,
    tag: 'covered-across-files',
    why: 'cleanupToolResults: only maybeSweep from the events-reminders worker tick (system work, never a turn)',
  },
  'packages/tracing/src/store.ts update public.trace_steps [*,duration_ms,error,finished_at,meta,output,status]':
    {
      n: 1,
      tag: 'reaches-narrow',
      why: "systemDb in every login turn or request scope (a traced step's finish): held at run time, its set names only status, finished_at, duration_ms, output, meta, error (the '*' is the scan splitting the Record<string, unknown> cast)",
    },
  'server/api/src/agent/runtime.ts update public.agents [tool_group_slugs,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "ensureCoreToolsOnConversationalAgents: only the agent runtime's boot (runAsSystem 'boot:agent-runtime'): system work",
  },
  'server/api/src/agent/runtime.ts update public.telegram_messages [processed,processed_at]': {
    n: 4,
    tag: 'covered-across-files',
    why: 'handleTelegramMessage (the Telegram turn workflow, before any scope) and healRepliedTelegramMessages (the boot drain): full route',
  },
  'server/api/src/agent/summarizer.ts update public.assistant_messages [digest_node_id]': {
    n: 1,
    tag: 'covered-across-files',
    why: "summarizeThread: only the summarizer timer (runAsSystem 'timer:summarize' on the LISTEN notify): system work",
  },
  'server/api/src/agent/telegram/persist.ts insert public.telegram_messages': {
    n: 1,
    tag: 'covered-across-files',
    why: 'persistOutbound: only the Telegram turn workflow, outside any scope (its heads transaction on the system pool, full route)',
  },
  'server/api/src/agent/telegram/voice.ts update public.telegram_messages [attachments,text]': {
    n: 1,
    tag: 'covered-across-files',
    why: "transcribeInboundVoice: only runTelegramTurn's first step, outside any scope: the system pool, full route",
  },
  'server/web/app/api/auth/invite/accept/route.ts update auth.users [last_login_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "POST /api/auth/invite/accept stamps the new login's last login: a public route with no login (no exit: the system pool, full route)",
  },
  'server/web/app/api/auth/login/route.ts update auth.users [last_login_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "POST /api/auth/login stamps the login's last login: a public route with no login (no exit: the system pool, full route)",
  },
  'server/web/app/api/auth/pair/claim/route.ts update auth.users [last_login_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "POST /api/auth/pair/claim stamps the login's last login: a public route with no login (no exit: the system pool, full route)",
  },
  'server/web/app/api/auth/token/refresh/route.ts insert public.mobile_tokens': {
    n: 1,
    tag: 'covered-across-files',
    why: 'POST /api/auth/token/refresh checks the bearer itself, with no guard: a public route with no login (no exit: the system pool, full route)',
  },
  'server/web/app/api/auth/token/refresh/route.ts update public.mobile_tokens [revoked_at,rotated_to]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'POST /api/auth/token/refresh checks the bearer itself, with no guard: a public route with no login (no exit: the system pool, full route)',
    },
  'server/web/app/api/auth/token/refresh/route.ts update public.push_subscriptions [token_id]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'POST /api/auth/token/refresh checks the bearer itself, with no guard: a public route with no login (no exit: the system pool, full route)',
  },
  'server/web/lib/access-keys.ts insert public.access_keys': {
    n: 1,
    tag: 'covered-across-files',
    why: "mintAccessKey: only POST /api/access-keys, an any-login route: the login's own request scope (write role)",
  },
  'server/web/lib/access-keys.ts update public.access_keys [last_used_at,last_used_ip]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'touchAccessKey: the access key gate and the /api/mcp bearer check, before the guard notes any exit: full route',
  },
  'server/web/lib/agents.ts delete public.agents': {
    n: 1,
    tag: 'covered-across-files',
    why: 'deleteAgent takes the definer mantle_agent_delete whenever the narrow route holds (deleteAgentOnNarrow); these run only off it',
  },
  'server/web/lib/agents.ts delete public.assistant_messages': {
    n: 1,
    tag: 'covered-across-files',
    why: 'deleteAgent takes the definer mantle_agent_delete whenever the narrow route holds (deleteAgentOnNarrow); these run only off it',
  },
  'server/web/lib/agents.ts insert public.agents': {
    n: 1,
    tag: 'covered-across-files',
    why: 'createAgent wraps the insert in the full-route spot assistant-grant; its one tx caller (cloneAgentTx) opens its transaction at that spot',
  },
  'server/web/lib/agents.ts update public.telegram_chats [allowlist_status,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'deleteAgent takes the definer mantle_agent_delete whenever the narrow route holds (deleteAgentOnNarrow); these run only off it',
  },
  'server/web/lib/auth/first-owner.ts insert auth.users': {
    n: 1,
    tag: 'covered-across-files',
    why: 'createFirstOwner: POST /api/auth/signup (no login yet: no exit, full route) and the onboard script',
  },
  'server/web/lib/auth/login-row.ts update public.mobile_tokens [last_used_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: "touchBearerToken: the gate applies the bearer's effects once before its Admin step (enterRouteLogin, takeApplied), so before any exit is noted",
  },
  'server/web/lib/auth/session.ts update public.mobile_tokens [rotated_to]': {
    n: 1,
    tag: 'covered-across-files',
    why: "presentRotatedToken: the public token refresh route, and the gate's bearer effects applied before its Admin step notes any exit",
  },
  'server/web/lib/login-update.ts update auth.users [*]': {
    n: 1,
    tag: 'reaches-narrow',
    why: "PATCH /api/users/:id (the users area's narrow exit) off the login-credential spot: held at run time, its changes then hold only disabled_at (a disable)",
  },
  'server/web/lib/mcp-oauth.ts delete public.oauth_access_tokens': {
    n: 1,
    tag: 'covered-across-files',
    why: 'the public /api/oauth token and register routes, and the /api/mcp bearer check before any exit (ownerFromBearer: tests only): full route',
  },
  'server/web/lib/mcp-oauth.ts insert public.oauth_access_tokens': {
    n: 1,
    tag: 'covered-across-files',
    why: 'the public /api/oauth token and register routes, and the /api/mcp bearer check before any exit (ownerFromBearer: tests only): full route',
  },
  'server/web/lib/mcp-oauth.ts insert public.oauth_clients': {
    n: 1,
    tag: 'covered-across-files',
    why: 'the public /api/oauth token and register routes, and the /api/mcp bearer check before any exit (ownerFromBearer: tests only): full route',
  },
  'server/web/lib/mcp-oauth.ts update public.oauth_access_tokens [last_used_at,refresh_expires_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'the public /api/oauth token and register routes, and the /api/mcp bearer check before any exit (ownerFromBearer: tests only): full route',
    },
  'server/web/lib/mcp-oauth.ts update public.oauth_access_tokens [last_used_at]': {
    n: 2,
    tag: 'covered-across-files',
    why: 'the public /api/oauth token and register routes, and the /api/mcp bearer check before any exit (ownerFromBearer: tests only): full route',
  },
  'server/web/lib/pair-code.ts insert public.mobile_tokens': {
    n: 1,
    tag: 'covered-across-files',
    why: 'claimPairCode: only POST /api/auth/pair/claim, a public route with no login (no exit: the system pool, full route)',
  },
  'server/web/lib/pair-code.ts update public.pairing_codes [claimed_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'claimPairCode: only POST /api/auth/pair/claim, a public route with no login (no exit: the system pool, full route)',
  },
  'server/web/lib/pair-code.ts update public.pairing_codes [claimed_device_id]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'claimPairCode: only POST /api/auth/pair/claim, a public route with no login (no exit: the system pool, full route)',
  },
  'server/web/lib/push/store.ts insert public.push_login_prefs [*,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'updateLoginPushPrefs: only /api/member/push/preferences, an own-rule member route (no exit picked: full route)',
  },
  'server/web/lib/push/store.ts insert public.push_prefs [*]': {
    n: 1,
    tag: 'reaches-narrow',
    why: "PUT /api/push/preferences (a login-self exit, narrow): held at run time, its upsert sets only assistant_messages and approvals (the '*' is a variable set)",
  },
  'server/web/lib/system-manifest/seed.ts insert public.agents': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertAgent: only applyManifest (applyManifestHere), at the full-route spot assistant-grant',
  },
  'server/web/lib/system-manifest/seed.ts insert public.skills': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertSkill: only applyManifest and adoptManifestItem, each at the full-route spot assistant-grant',
  },
  'server/web/lib/system-manifest/seed.ts insert public.tool_groups': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertToolGroup: only seedToolCapabilities (spot tool-group-grant) and adoptManifestItem (spot assistant-grant)',
  },
  'server/web/lib/system-manifest/seed.ts update public.agents [*,api_key_id,description,enabled,memory_config,model,name,params,provider,role,skill_slugs,system_prompt,tool_group_slugs,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'upsertAgent: only applyManifest (applyManifestHere), at the full-route spot assistant-grant',
    },
  'server/web/lib/system-manifest/seed.ts update public.agents [*]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertAgent: only applyManifest (applyManifestHere), at the full-route spot assistant-grant',
  },
  'server/web/lib/system-manifest/seed.ts update public.agents [enabled,model,params,skill_slugs,system_prompt,tool_group_slugs,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'adoptSpecialist: only adoptManifestItem (adoptManifestItemHere), at the full-route spot assistant-grant',
    },
  'server/web/lib/system-manifest/seed.ts update public.agents [memory_config,tool_group_slugs,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'adoptPersonaStructure: only adoptManifestItem (adoptManifestItemHere), at the full-route spot assistant-grant',
    },
  'server/web/lib/system-manifest/seed.ts update public.agents [skill_slugs,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'syncPersonaSkills: only applyManifest and adoptManifestItem, each at the full-route spot assistant-grant',
  },
  'server/web/lib/system-manifest/seed.ts update public.skills [default_state,description,enabled,instructions,name,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'upsertSkill: only applyManifest and adoptManifestItem, each at the full-route spot assistant-grant',
    },
  'server/web/lib/system-manifest/seed.ts update public.tool_groups [admin_only,updated_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'upsertToolGroup: only seedToolCapabilities (spot tool-group-grant) and adoptManifestItem (spot assistant-grant)',
  },
  'server/web/lib/system-manifest/seed.ts update public.tool_groups [description,enabled,name,tool_slugs,updated_at]':
    {
      n: 1,
      tag: 'covered-across-files',
      why: 'upsertToolGroup: only seedToolCapabilities (spot tool-group-grant) and adoptManifestItem (spot assistant-grant)',
    },
  'server/web/lib/token-login.ts insert public.mobile_tokens': {
    n: 1,
    tag: 'covered-across-files',
    why: 'handleTokenLogin: only the public credential routes /api/auth/token, mobile-login and device-login: no exit, full route',
  },
  'server/web/lib/token-login.ts update auth.users [last_login_at]': {
    n: 1,
    tag: 'covered-across-files',
    why: 'handleTokenLogin: only the public credential routes /api/auth/token, mobile-login and device-login: no exit, full route',
  },
});

/**
 * The function calls of the source the narrow role may not run, outside
 * every full-route spot (narrow-write-scan.ts scanRepoCalls): each
 * function's decision, by name. A call of a function not listed here fails
 * narrow-write-scan.test.ts: put it at a spot, put the function on
 * NARROW_SYSTEM_FUNCTIONS (a read with no identity), or decide it here.
 * runtime-role.db.test.ts checks every name against the catalog: the narrow
 * role may run none of them.
 */
export const NARROW_SCAN_FN_DECIDED: Readonly<Record<string, string>> = Object.freeze({
  mantle_access_key_revoke:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_access_keys_seen:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_app_holders:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_app_trash_act:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_bridge_login:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_check_note:
    'denied to the runtime role too (RUNTIME_DENIED_FUNCTIONS): migrate, the operator check switch or tests only',
  mantle_client_sourced_among:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_client_sourced_any:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_contact_shares_revoke_all:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_contact_shares_revoke_rows:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_contact_sharing_rows:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_contact_sharing_set:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_conversation_taint:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_conversation_taint_keep:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_deleted_apps:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_embed_host:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_entity_merge:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_entity_merge_rows:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_file_name_taken:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_file_restamp_home:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_folder_grant_rows:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_folder_trail:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_grant_change:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_grant_counts:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_grant_move_home:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_is_brain_space:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_item_embeds:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_item_grants:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_item_others_read:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_kind_root_id:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_lexeme_df:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_lock_heads:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_lock_heads_more:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_lock_heads_nested:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_lock_subtree_heads:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_login_connector_rows:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_login_is_admin:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_mail_branch_holds:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_mark_created_client_sourced:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_mark_export_client_sourced:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_may_manage_home:
    'runs as its caller and is taken from PUBLIC: called in a login scope or on the full route',
  mantle_name_taken:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_page_folder_id:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_pending_count:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_profile_writable:
    'runs as its caller and is taken from PUBLIC: called in a login scope or on the full route',
  mantle_read_cursor_mark:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_read_cursors:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_recall_retarget:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_runs_workspaces:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_scope_has_area:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_scope_is_admin:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_secret_put:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_set_actor_check:
    'denied to the runtime role too (RUNTIME_DENIED_FUNCTIONS): migrate, the operator check switch or tests only',
  mantle_set_edit_check:
    'denied to the runtime role too (RUNTIME_DENIED_FUNCTIONS): migrate, the operator check switch or tests only',
  mantle_share_close_admin:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_share_contact_write_set:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_share_with_contacts:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_share_with_contacts_rows:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_snapshot_bytes:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_space_settle_promotion:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_subtree_refuse_hidden:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_subtree_rewrite:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_table_app_link:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_tg_login_moderates:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_tg_moderated_chats:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_tg_my_chats:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_tg_replay:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_turn_heartbeats:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_workspace_event:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_add_user:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_admin_id:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_any_holder:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_archive:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_attach_assistants:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_create:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_item_counts:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_live:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_login_search:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_migrate_locked:
    'denied to the runtime role too (RUNTIME_DENIED_FUNCTIONS): migrate, the operator check switch or tests only',
  mantle_ws_names:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_people:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_private_workspace:
    "the runtime role's (RUNTIME_SYSTEM_FUNCTIONS): full system work on the system pool, or a login scope",
  mantle_ws_remove_user:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_resource_add:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_resource_remove:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_resource_rows:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_resource_set_write:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_seen:
    'a read or write definer granted to the viewer roles: called in a login scope (the request and turn reads of the workspaces, grants, tree and tools screens)',
  mantle_ws_set_assistant:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_set_contact:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_set_landing:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_set_moderator:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
  mantle_ws_update_about:
    'denied to the narrow role by name (NARROW_DENIED_FUNCTIONS, its reason there): its narrow callers run at a full-route spot, its others in a login scope or full system work',
});

/** Files whose SQL text never runs on a narrow exit, for the call scan
 *  (their calls are DDL migrate runs or the migrator's own checks). */
export const NARROW_SCAN_FN_SYSTEM_FILES: Readonly<Record<string, string>> = Object.freeze({
  'packages/db/src/access-matrix.ts':
    'the rights DDL migrate runs (trigger and grant text, never a narrow statement)',
  'packages/db/src/runtime-role.ts': "migrate's grants and the box count (run as the migrator)",
  'packages/db/src/identity-gateway.ts': "migrate's identity leak check (run as the migrator)",
  'packages/db/src/migrator-steps.ts':
    "migrate's steps: the narrow counts' epoch row (run as the migrator)",
});

/** Each file and function call pair found outside a spot, with its count:
 *  exact (a new call, in any file, fails; so does one gone: shrink it). */
export const NARROW_SCAN_FN_OPEN: Readonly<Record<string, number>> = Object.freeze({
  'packages/content/src/admin-acts.ts mantle_app_trash_act': 1,
  'packages/content/src/admin-acts.ts mantle_contact_shares_revoke_all': 1,
  'packages/content/src/admin-acts.ts mantle_contact_sharing_set': 1,
  'packages/content/src/admin-acts.ts mantle_entity_merge': 1,
  'packages/content/src/admin-acts.ts mantle_share_close_admin': 1,
  'packages/content/src/admin-acts.ts mantle_share_contact_write_set': 1,
  'packages/content/src/admin-acts.ts mantle_share_with_contacts': 1,
  'packages/content/src/app-table-exports.ts mantle_mark_export_client_sourced': 1,
  'packages/content/src/app-trash.ts mantle_deleted_apps': 1,
  'packages/content/src/contact-share-codes.ts mantle_contact_sharing_rows': 1,
  'packages/content/src/contact-shares.ts mantle_contact_shares_revoke_rows': 1,
  'packages/content/src/contact-shares.ts mantle_share_with_contacts_rows': 1,
  'packages/content/src/entity-dedup.ts mantle_entity_merge_rows': 1,
  'packages/content/src/link-serve.ts mantle_item_embeds': 1,
  'packages/content/src/link-serve.ts mantle_ws_admin_id': 1,
  'packages/content/src/member-invites.ts mantle_bridge_login': 1,
  'packages/content/src/pages/read.ts mantle_page_folder_id': 1,
  'packages/content/src/profile-preferences.ts mantle_profile_writable': 1,
  'packages/content/src/recall-native.ts mantle_recall_retarget': 1,
  'packages/content/src/tables/shared.ts mantle_table_app_link': 1,
  'packages/content/src/tree/node-ops.ts mantle_subtree_refuse_hidden': 1,
  'packages/content/src/tree/node-ops.ts mantle_subtree_rewrite': 1,
  'packages/content/src/tree/visibility.ts mantle_folder_grant_rows': 1,
  'packages/content/src/tree/visibility.ts mantle_ws_admin_id': 3,
  'packages/content/src/tree/visibility.ts mantle_ws_live': 2,
  'packages/content/src/tree/visibility.ts mantle_ws_names': 3,
  'packages/db/src/brain-answers.ts mantle_name_taken': 1,
  'packages/db/src/brain-answers.ts mantle_snapshot_bytes': 1,
  'packages/db/src/check-floor.ts mantle_check_note': 1,
  'packages/db/src/check-floor.ts mantle_set_actor_check': 1,
  'packages/db/src/check-floor.ts mantle_set_edit_check': 1,
  'packages/db/src/email-attachment.ts mantle_mail_branch_holds': 1,
  'packages/db/src/extract-skip-backfill.ts mantle_is_brain_space': 1,
  'packages/db/src/first-owner-exit.ts mantle_ws_migrate_locked': 1,
  'packages/db/src/folder-trail.ts mantle_folder_trail': 1,
  'packages/db/src/gateway/heads.ts mantle_lock_heads': 1,
  'packages/db/src/gateway/heads.ts mantle_lock_heads_more': 1,
  'packages/db/src/gateway/heads.ts mantle_lock_heads_nested': 1,
  'packages/db/src/gateway/heads.ts mantle_lock_subtree_heads': 1,
  'packages/db/src/gateway/scope-answers.ts mantle_login_is_admin': 1,
  'packages/db/src/gateway/scope-answers.ts mantle_scope_has_area': 1,
  'packages/db/src/gateway/scope-answers.ts mantle_scope_is_admin': 1,
  'packages/db/src/gateway/spot-definers.ts mantle_space_settle_promotion': 1,
  'packages/db/src/gateway/viewer-scope.ts mantle_ws_private_workspace': 1,
  'packages/db/src/grant-reads.ts mantle_ws_any_holder': 1,
  'packages/db/src/hidden-rows.ts mantle_subtree_refuse_hidden': 1,
  'packages/db/src/item-rights.ts mantle_may_manage_home': 1,
  'packages/files/src/email-attachments.ts mantle_mail_branch_holds': 1,
  'packages/files/src/move-copy.ts mantle_subtree_rewrite': 1,
  'packages/files/src/ops/files.ts mantle_file_name_taken': 1,
  'packages/files/src/ops/files.ts mantle_file_restamp_home': 1,
  'packages/files/src/ops/files.ts mantle_folder_trail': 1,
  'packages/files/src/ops/files.ts mantle_kind_root_id': 1,
  'packages/files/src/ops/folders.ts mantle_subtree_refuse_hidden': 1,
  'packages/files/src/ops/folders.ts mantle_subtree_rewrite': 1,
  'packages/files/src/ops/shared.ts mantle_kind_root_id': 1,
  'packages/runs/src/boss.ts mantle_runs_workspaces': 1,
  'packages/runtime/src/heartbeats/tick.ts mantle_turn_heartbeats': 1,
  'packages/search/src/keyword-query.ts mantle_lexeme_df': 1,
  'packages/telegram/src/chat-login.ts mantle_tg_login_moderates': 1,
  'packages/tools/src/builtins-replay.ts mantle_tg_replay': 1,
  'packages/tools/src/builtins-secrets.ts mantle_secret_put': 1,
  'packages/tools/src/client-sourced.ts mantle_client_sourced_among': 1,
  'packages/tools/src/client-sourced.ts mantle_client_sourced_any': 1,
  'packages/tools/src/client-sourced.ts mantle_conversation_taint': 1,
  'packages/tools/src/client-sourced.ts mantle_conversation_taint_keep': 1,
  'packages/tools/src/client-sourced.ts mantle_mark_created_client_sourced': 1,
  'packages/tools/src/external-access.ts mantle_app_holders': 1,
  'packages/tools/src/external-access.ts mantle_login_connector_rows': 1,
  'packages/tools/src/pending.ts mantle_pending_count': 1,
  'packages/tools/src/shared-item.ts mantle_item_others_read': 1,
  'server/web/app/api/access-keys/[id]/route.ts mantle_access_key_revoke': 1,
  'server/web/lib/access-keys-admin.ts mantle_access_keys_seen': 1,
  'server/web/lib/agent-telegram.ts mantle_tg_moderated_chats': 1,
  'server/web/lib/agent-telegram.ts mantle_tg_my_chats': 1,
  'server/web/lib/assistant-inbox.ts mantle_read_cursor_mark': 1,
  'server/web/lib/assistant-inbox.ts mantle_read_cursors': 1,
  'server/web/lib/auth/login-row.ts mantle_login_is_admin': 1,
  'server/web/lib/auth/login.ts mantle_scope_has_area': 1,
  'server/web/lib/auth/login.ts mantle_scope_is_admin': 1,
  'server/web/lib/grants.ts mantle_grant_change': 1,
  'server/web/lib/grants.ts mantle_grant_counts': 1,
  'server/web/lib/grants.ts mantle_grant_move_home': 1,
  'server/web/lib/grants.ts mantle_item_embeds': 1,
  'server/web/lib/grants.ts mantle_item_grants': 3,
  'server/web/lib/grants.ts mantle_workspace_event': 1,
  'server/web/lib/grants.ts mantle_ws_admin_id': 1,
  'server/web/lib/grants.ts mantle_ws_live': 1,
  'server/web/lib/grants.ts mantle_ws_names': 2,
  'server/web/lib/maintenance/doc-reindex.ts mantle_is_brain_space': 1,
  'server/web/lib/maintenance/ocr-rescan.ts mantle_is_brain_space': 1,
  'server/web/lib/maintenance/refold-embeds.ts mantle_embed_host': 1,
  'server/web/lib/mcp-oauth.ts mantle_login_is_admin': 1,
  'server/web/lib/pair-code.ts mantle_login_is_admin': 1,
  'server/web/lib/token-login.ts mantle_login_is_admin': 1,
  'server/web/lib/workspace-ticks.ts mantle_ws_set_moderator': 1,
  'server/web/lib/workspaces-migrate.ts mantle_ws_attach_assistants': 1,
  'server/web/lib/workspaces-migrate.ts mantle_ws_migrate_locked': 1,
  'server/web/lib/workspaces.ts mantle_ws_add_user': 1,
  'server/web/lib/workspaces.ts mantle_ws_admin_id': 1,
  'server/web/lib/workspaces.ts mantle_ws_archive': 1,
  'server/web/lib/workspaces.ts mantle_ws_create': 1,
  'server/web/lib/workspaces.ts mantle_ws_item_counts': 1,
  'server/web/lib/workspaces.ts mantle_ws_login_search': 1,
  'server/web/lib/workspaces.ts mantle_ws_people': 1,
  'server/web/lib/workspaces.ts mantle_ws_remove_user': 1,
  'server/web/lib/workspaces.ts mantle_ws_resource_add': 1,
  'server/web/lib/workspaces.ts mantle_ws_resource_remove': 1,
  'server/web/lib/workspaces.ts mantle_ws_resource_rows': 1,
  'server/web/lib/workspaces.ts mantle_ws_resource_set_write': 1,
  'server/web/lib/workspaces.ts mantle_ws_seen': 1,
  'server/web/lib/workspaces.ts mantle_ws_set_assistant': 1,
  'server/web/lib/workspaces.ts mantle_ws_set_contact': 1,
  'server/web/lib/workspaces.ts mantle_ws_set_landing': 1,
  'server/web/lib/workspaces.ts mantle_ws_update_about': 1,
});
