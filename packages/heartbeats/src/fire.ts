/**
 * Single-heartbeat fire orchestration.
 *
 * Sequence:
 *   1. gate check (idle / quiet / cooldown / earliest)
 *      - on skip → record heartbeat_fires row, reschedule, return
 *   2. resolve agent + skill rows
 *   3. open trace (kind='heartbeat_fire')
 *   4. build synthetic prompt + resolve tool allowlist (agent's own +
 *      skill's + the 5 heartbeat-control builtins)
 *   5. run tool loop under withHeartbeatContext so the control tools
 *      know which row they're mutating
 *   6. deliver the reply text to the surface (telegram sendMessage)
 *   7. record heartbeat_fires row + reschedule next_fire_at
 *
 * Errors at step 2 (config) auto-pause the heartbeat — operator
 * intervention required. Errors during the tool loop (LLM, network)
 * record disposition='error' but leave the heartbeat active so the
 * next tick can retry.
 */

import { and, eq } from 'drizzle-orm';
import {
  db,
  agents,
  skills,
  heartbeats,
  heartbeatFires,
  type Heartbeat,
  type AgentParams,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { currentTrace, recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import { getChatAdapter } from '@mantle/voice';
import { accountForChat, sendMessage } from '@mantle/telegram';
import {
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  resolveBackupAdapter,
  runToolLoop,
  type ChatMessage,
} from '@mantle/agent-runtime';
import { loadProfilePreferences, buildTimeContextLine, resolveThinkingBudget } from '@mantle/content';
import { checkGates } from './gates';
import { computeNextFireAt } from './schedule';
import { withHeartbeatContext } from './context';
import { buildHeartbeatPrompt, HEARTBEAT_DATA_BOUNDARY } from './prompt';
import { runWithInflightLock } from './inflight';

const HEARTBEAT_CONTROL_TOOLS = [
  'heartbeat_complete',
  'heartbeat_snooze',
  'heartbeat_update_state',
  'heartbeat_list',
  'heartbeat_fire',
];

/** Tools that reach OUT of the brain — email + web. When the operator
 *  enables `heartbeatEgressGate`, these are force-confirmed for an
 *  unattended fire so they park for approval instead of running inline.
 *  The heartbeat's own surface reply is delivered separately (not a tool)
 *  and is unaffected. */
const HEARTBEAT_EGRESS_SLUGS = new Set(['email_send', 'web_fetch', 'web_search']);

export type FireResult = {
  /** See HeartbeatFireDisposition in @mantle/db for the canonical
   *  vocabulary + operator-triage semantics. Kept in sync as a
   *  narrower union for the FireResult return shape. */
  disposition:
    | 'fired'
    | 'fired_undelivered'
    | 'skipped_idle'
    | 'skipped_quiet'
    | 'skipped_cooldown'
    | 'skipped_earliest'
    | 'completed'
    | 'auto_paused'
    | 'error';
  replyText?: string;
  error?: string;
};

/** Force-fire a heartbeat right now, bypassing gate checks. Used by
 *  the "Fire now" UI button and the `heartbeat_fire` tool. Distinct
 *  from `tickFire` which honours gates.
 *
 *  Goes through the in-flight lock: if tick or another forceFire is
 *  already firing this heartbeat, we wait for it to finish before
 *  running ours. Two concurrent UI clicks queue rather than collide. */
export async function forceFire(hb: Heartbeat): Promise<FireResult> {
  return runWithInflightLock(hb.id, () => fireInner(hb, { skipGates: true }));
}

/** Tick-driven fire: runs gate checks, fires if all pass.
 *  The tick loop already filters in-flight rows out before calling
 *  this, but we wrap defensively in case a future caller skips the
 *  filter — exclusion still holds. */
export async function tickFire(hb: Heartbeat): Promise<FireResult> {
  return runWithInflightLock(hb.id, () => fireInner(hb, { skipGates: false }));
}

async function fireInner(
  hb: Heartbeat,
  opts: { skipGates: boolean },
): Promise<FireResult> {
  const now = new Date();

  // Capture the heartbeat's `next_fire_at` as it was when the fire
  // started. We need this at the end of the success path to detect
  // whether a tool (heartbeat_snooze) pushed next_fire_at further
  // out than the schedule would naturally compute. Without this,
  // the post-loop UPDATE silently clobbered snooze. See P0-1 in
  // the audit and docs/heartbeats.md §7.
  const beforeNextFireAt = hb.nextFireAt ?? null;

  // 1. Gates -----------------------------------------------------
  if (!opts.skipGates) {
    const gate = await checkGates(hb, now);
    if (!gate.ok) {
      // Soft-skip: don't burn fire_count, but bump next_fire_at so
      // the tick loop doesn't churn on this row every minute. The
      // bump is conservative — half the cooldown if there is one,
      // else 10 minutes — so the gate is re-checked reasonably soon.
      const bumpMs = (hb.cooldownMinutes ? hb.cooldownMinutes * 30_000 : 10 * 60_000);
      await db
        .update(heartbeats)
        .set({
          nextFireAt: new Date(now.getTime() + bumpMs),
          updatedAt: now,
        })
        .where(eq(heartbeats.id, hb.id));
      // Record a skipped trace so /traces shows the skip too. Cheap.
      // Capture the trace id back so the heartbeat_fires row can
      // link to it — the detail page's "trace →" link depends on
      // this. (Audit: P-trace-1.)
      // Note: no agentId on this skip trace. traces.agent_id FKs to
      // agents.id (NOT ai_workers, NOT heartbeats) — putting any other
      // uuid here triggers the silent FK violation documented in
      // observability.md §12. The heartbeat link lives on subject_id.
      const skippedTraceId = await recordSkippedTrace({
        ownerId: hb.ownerId,
        kind: 'heartbeat_fire',
        subjectKind: 'heartbeat',
        subjectId: hb.id,
        disposition: gate.reason,
        details: {
          heartbeat_slug: hb.slug,
          detail: gate.detail,
        },
      });
      await recordFire(hb, {
        disposition: gate.reason,
        stateBefore: hb.state,
        stateAfter: null,
        traceId: skippedTraceId,
      });
      return { disposition: gate.reason };
    }
  }

  // 2. Resolve agent + skill ------------------------------------
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, hb.ownerId), eq(agents.slug, hb.agentSlug), eq(agents.enabled, true)))
    .limit(1);
  if (!agent) return autoPause(hb, `agent '${hb.agentSlug}' not found or disabled`);

  const [skill] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.ownerId, hb.ownerId), eq(skills.slug, hb.skillSlug), eq(skills.enabled, true)))
    .limit(1);
  if (!skill) return autoPause(hb, `skill '${hb.skillSlug}' not found or disabled`);

  if (!agent.apiKeyId) return autoPause(hb, `agent '${agent.slug}' has no api_key configured`);
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) return autoPause(hb, `agent '${agent.slug}' api key could not be decrypted`);

  // 3. Compose system prompt -----------------------------------
  //    Agent's normal persistent skills go in (these are general
  //    behaviour packs like "format dates as en-GB"). The HEARTBEAT
  //    skill is NOT injected here — it goes into the user-role
  //    synthetic prompt below, because it's situational to this
  //    fire, not a persistent persona trait.
  const persistentSkills = await resolveAgentSkills(hb.ownerId, agent.skillSlugs ?? []);
  const prefs = await loadProfilePreferences(hb.ownerId);
  const baseSystem = composeSystemPromptWithSkills(agent.systemPrompt, persistentSkills);
  const systemPrompt = `${buildTimeContextLine(prefs, now)}\n\n${baseSystem}\n\n${HEARTBEAT_DATA_BOUNDARY}`;

  // Resolve tool allowlist = the agent's effective set (from its granted tool
  // groups; P6) + the heartbeat control tools (always granted on a heartbeat
  // turn). The bound heartbeat skill is pure teaching (P4) — it contributes
  // instructions via the synthetic prompt, never tools.
  const agentGroupTools = await resolveAgentToolGroups(hb.ownerId, agent.toolGroupSlugs ?? []);
  const allSlugs = new Set<string>([
    ...effectiveToolSlugs(agentGroupTools),
    ...HEARTBEAT_CONTROL_TOOLS,
  ]);
  const resolvedTools = await resolveAgentTools(hb.ownerId, [...allSlugs]);
  // Egress gate (opt-in): on an unattended fire, route email/web tools
  // through the approval queue rather than letting them run inline. The
  // queued call fires a Telegram approval card (see @mantle/tools
  // notifyPendingCreated, reached via the tool-loop's requires_confirm
  // path), so the operator can clear it from a phone. No effect when the
  // preference is off — the common case.
  const tools = prefs.heartbeatEgressGate
    ? resolvedTools.map((t) =>
        HEARTBEAT_EGRESS_SLUGS.has(t.slug) ? { ...t, requiresConfirm: true } : t,
      )
    : resolvedTools;

  // 4. Run loop inside a trace + heartbeat context --------------
  const hbAdapter = getChatAdapter(agent.provider);
  if (!hbAdapter) {
    throw new Error(
      `heartbeats/fire: no chat adapter registered for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  const userPrompt = buildHeartbeatPrompt({
    hb,
    skill,
    lastFiredHuman: hb.lastFiredAt ? humanizeAgo(now.getTime() - hb.lastFiredAt.getTime()) : undefined,
  });
  // Direct construction — heartbeats are episodic, no history to fold in.
  // The synthetic user prompt is the "task to do right now"; the agent's
  // persistent persona + persistent skills are in systemPrompt.
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

    // Snapshot the trace id from inside startTrace so we can stamp
    // it onto heartbeat_fires.trace_id. Without this, the detail
    // page's "trace →" link is permanently dark. (Audit P-trace-1.)
    let openedTraceId: string | null = null;
  try {
    // Both the LLM tool loop AND the surface delivery run inside
    // the same startTrace block so their steps attach to the same
    // trace row. step() is a no-op outside a trace context — moving
    // delivery out of the trace would lose the deliver_surface step
    // we want for debugging delivery failures. (Audit P-trace-4.)
    const { reply, replySurfaceRef, delivered } = await startTrace(
      {
        ownerId: hb.ownerId,
        kind: 'heartbeat_fire',
        subjectKind: 'heartbeat',
        subjectId: hb.id,
        agentId: agent.id,
        data: {
          heartbeat_slug: hb.slug,
          skill_slug: hb.skillSlug,
          fire_number: hb.fireCount + 1,
          force: opts.skipGates,
        },
      },
      async () => {
        // currentTrace() is safe to read here — we're inside the
        // AsyncLocalStorage scope startTrace just opened.
        openedTraceId = currentTrace()?.id ?? null;
        const hbBackup = await resolveBackupAdapter(hb.ownerId, agent);
        const result = await withHeartbeatContext({ heartbeatId: hb.id, slug: hb.slug, ownerId: hb.ownerId }, () =>
          runToolLoop({
            adapter: hbAdapter,
            apiKey,
            model: agent.model,
            baseUrl: agent.baseUrl,
            viaTailnet: agent.viaTailnet,
            backup: hbBackup,
            params: (agent.params ?? {}) as AgentParams,
            ownerId: hb.ownerId,
            agentId: agent.id,
            agentSlug: agent.slug,
            agentDepth: 1,
            delegateTo: [],
            // Per-user adaptive thinking on unattended heartbeat runs too (same
            // profile gate; prefs already loaded above). Clamped vs max_tokens
            // inside runToolLoop.
            thinkingBudget: resolveThinkingBudget(prefs),
            initialMessages,
            tools,
            surface:
              hb.surface.kind === 'telegram'
                ? { kind: 'telegram', telegramChatId: hb.surface.chat_id }
                : { kind: 'web' },
          }),
        );
        const replyText = result.reply;

        // Deliver — own step so a telegram outage shows up
        // distinctly in the trace graph (kind='send', so it sits
        // visually next to the LLM 'llm_call' steps).
        //
        // delivered captures whether the message actually reached
        // the surface. Used by the outer disposition decision
        // (fired vs fired_undelivered): if the LLM ran but the
        // delivery couldn't happen (no account, sendMessage
        // threw), we mark the outer disposition fired_undelivered
        // so the operator can see "we spent the LLM cost but the
        // user got nothing" at a glance instead of having to drill
        // into the trace's step skipped reason. P1-1 from the
        // audit.
        let surfaceRef: Record<string, unknown> | null = null;
        let delivered = true;
        if (replyText.trim() && hb.surface.kind === 'telegram') {
          surfaceRef = await step(
            {
              name: 'deliver_surface',
              kind: 'send',
              input: { kind: 'telegram', chat_id: hb.surface.chat_id, reply_chars: replyText.length },
            },
            async (h) => {
              if (hb.surface.kind !== 'telegram') return null;
              const account = await accountForChat(hb.surface.chat_id);
              if (!account) {
                h.setSkipped('no_enabled_telegram_account');
                delivered = false;
                return null;
              }
              try {
                const ids = await sendMessage(account, hb.surface.chat_id, replyText);
                h.setMeta({ message_ids: ids });
                return { kind: 'telegram', message_ids: ids } as Record<string, unknown>;
              } catch (err) {
                // Network / Telegram API failure. Don't throw out
                // of the trace closure — keep the LLM work
                // recorded, mark the outer disposition
                // fired_undelivered, let the operator decide.
                h.setMeta({
                  error: err instanceof Error ? err.message : String(err),
                });
                h.setSkipped('telegram_send_failed');
                delivered = false;
                return null;
              }
            },
          );
        } else if (replyText.trim() && hb.surface.kind !== 'telegram') {
          // Web surface (and any future surface without an outbound
          // channel) has no in-process delivery — the reply text
          // would surface via the assistant message stream. v1
          // heartbeats targeting kind:'web' have no realtime push;
          // delivered=true is a small lie that says "we did what we
          // could", documented under §9 out-of-scope.
        }

        return { reply: replyText, replySurfaceRef: surfaceRef, delivered };
      },
    );

    // 6. Reload to capture state mutations from tools ------------
    const [latest] = await db.select().from(heartbeats).where(eq(heartbeats.id, hb.id)).limit(1);
    const after = latest ?? hb;

    // 7. If a tool flipped status to 'completed', honour it -----
    const stillActive = after.status === 'active';
    const computedNextFireAt = stillActive
      ? computeNextFireAt({
          schedule: after.schedule,
          anchor: now,
          seed: `${after.id}:${after.fireCount + 1}`,
          notBefore: after.earliestAt,
        })
      : null;

    // P0-1: snooze preservation. If a tool (heartbeat_snooze)
    // updated next_fire_at to something further in the future than
    // the schedule would naturally produce, honour it. We only do
    // this when `after.nextFireAt` differs from what we saw at fire
    // start AND is later than the computed value — otherwise the
    // schedule wins. This treats snooze as "at least until X",
    // never as a way to fire SOONER than the schedule would.
    let nextFireAt = computedNextFireAt;
    if (
      stillActive &&
      after.nextFireAt &&
      after.nextFireAt.getTime() !== (beforeNextFireAt?.getTime() ?? -1) &&
      (computedNextFireAt == null || after.nextFireAt > computedNextFireAt)
    ) {
      nextFireAt = after.nextFireAt;
    }

    // 8. Max-fires auto-complete ---------------------------------
    let finalStatus = after.status;
    let finalReason = after.completionReason;
    if (stillActive && after.maxFires != null && after.fireCount + 1 >= after.maxFires) {
      finalStatus = 'completed';
      finalReason = 'max_fires';
    }

    await db
      .update(heartbeats)
      .set({
        lastFiredAt: now,
        fireCount: after.fireCount + 1,
        nextFireAt: finalStatus === 'active' ? nextFireAt : null,
        status: finalStatus,
        completionReason: finalReason,
        updatedAt: now,
      })
      .where(eq(heartbeats.id, hb.id));

    // Disposition decision matrix:
    //   completed   → tool set status=completed during the fire
    //   fired       → LLM ran AND reply reached the surface
    //   fired_undelivered → LLM ran, reply text exists, but surface
    //                       refused (no account / send failed).
    //                       State updates still landed; user got
    //                       nothing this fire. Operator-visible at a
    //                       glance via /heartbeats/[id] log. (P1-1.)
    const disposition: FireResult['disposition'] =
      finalStatus === 'completed'
        ? 'completed'
        : delivered
          ? 'fired'
          : 'fired_undelivered';

    await recordFire(hb, {
      disposition,
      stateBefore: hb.state,
      stateAfter: after.state,
      replyText: reply,
      replySurfaceRef,
      traceId: openedTraceId,
    });

    return { disposition, replyText: reply };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordFire(hb, {
      disposition: 'error',
      stateBefore: hb.state,
      stateAfter: null,
      errorMessage: msg,
      // openedTraceId may be set if the trace opened before the throw
      // (most common case) — capture it so operators can click into
      // the partial trace and see where it died.
      traceId: openedTraceId,
    });
    // Don't pause on transient errors — push next_fire forward a bit
    // so we don't tight-loop, but leave status active.
    await db
      .update(heartbeats)
      .set({
        nextFireAt: new Date(now.getTime() + 5 * 60_000),
        updatedAt: now,
      })
      .where(eq(heartbeats.id, hb.id));
    return { disposition: 'error', error: msg };
  }
}

async function autoPause(hb: Heartbeat, reason: string): Promise<FireResult> {
  // Distinct from the catch-block 'error' path: auto-pause is for
  // config issues caught BEFORE the LLM runs (agent missing,
  // skill missing, key undecryptable). The heartbeat is moved to
  // status=paused — operator must intervene. 'error' (catch block)
  // is for transient mid-fire failures that the next tick will
  // retry. Splitting the disposition lets /heartbeats/[id] colour
  // them differently so triage is at-a-glance. P1-2 from audit.
  await db
    .update(heartbeats)
    .set({
      status: 'paused',
      completionReason: `auto_pause:${reason}`,
      nextFireAt: null,
      updatedAt: new Date(),
    })
    .where(eq(heartbeats.id, hb.id));
  await recordFire(hb, {
    disposition: 'auto_paused',
    stateBefore: hb.state,
    stateAfter: null,
    errorMessage: reason,
  });
  return { disposition: 'auto_paused', error: reason };
}

async function recordFire(
  hb: Heartbeat,
  fields: {
    disposition: FireResult['disposition'];
    stateBefore?: Record<string, unknown> | null;
    stateAfter?: Record<string, unknown> | null;
    traceId?: string | null;
    replyText?: string | null;
    replySurfaceRef?: Record<string, unknown> | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(heartbeatFires).values({
      heartbeatId: hb.id,
      disposition: fields.disposition,
      stateBefore: fields.stateBefore ?? null,
      stateAfter: fields.stateAfter ?? null,
      traceId: fields.traceId ?? null,
      replyText: fields.replyText ?? null,
      replySurfaceRef: fields.replySurfaceRef ?? null,
      errorMessage: fields.errorMessage ?? null,
    });
  } catch (err) {
    // Soft-fail: don't let an audit-log write failure kill the fire.
    // The same pattern as @mantle/tracing's write path.
    console.error(
      '[heartbeats] failed to record heartbeat_fires row:',
      err instanceof Error ? err.message : err,
    );
  }
}

function humanizeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
