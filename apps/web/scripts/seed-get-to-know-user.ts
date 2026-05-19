/**
 * Seeds the demo "get to know the user" skill + heartbeat so the
 * heartbeats engine has something real to fire against immediately
 * after the 0030 migration runs.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> TG_CHAT_ID=<numeric> pnpm tsx scripts/seed-get-to-know-user.ts
 *
 * Idempotent: re-running upserts the skill + heartbeat by slug.
 *
 * What it creates:
 *   skill: profile_interview — interview-style instructions for the
 *     get-to-know-user flow, including the heartbeat_update_state /
 *     heartbeat_complete tool usage rules.
 *   heartbeat: get_to_know_user — fires every 24h ±60min via Telegram,
 *     with conservative gates (15min idle, 22:00–07:00 quiet, 30min
 *     cooldown) and a 6h earliest_at so a freshly-installed system
 *     doesn't immediately barge in.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, agents, heartbeats, skills } from '@mantle/db';
import { computeNextFireAt } from '@mantle/heartbeats';

const USER_ID = process.env.ALLOWED_USER_ID;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const AGENT_SLUG_OVERRIDE = process.env.AGENT_SLUG;

if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}
if (!TG_CHAT_ID) {
  console.error('TG_CHAT_ID env var required (the numeric Telegram chat to talk on)');
  process.exit(1);
}

/** Resolve the agent slug to use. Set AGENT_SLUG to override. Otherwise
 *  pick the highest-priority enabled responder — the same agent that
 *  handles inbound Telegram messages, which is the natural fit for an
 *  outbound proactive task. Fails fast if none exists so the operator
 *  sees a clear error before the heartbeat row gets created. */
async function resolveAgentSlug(): Promise<string> {
  if (AGENT_SLUG_OVERRIDE) {
    const [row] = await db
      .select({ slug: agents.slug, enabled: agents.enabled })
      .from(agents)
      .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, AGENT_SLUG_OVERRIDE)))
      .limit(1);
    if (!row) {
      throw new Error(`AGENT_SLUG='${AGENT_SLUG_OVERRIDE}' not found for this owner. Pick from /settings/agents.`);
    }
    if (!row.enabled) {
      throw new Error(`AGENT_SLUG='${AGENT_SLUG_OVERRIDE}' exists but is disabled. Enable it at /settings/agents.`);
    }
    return AGENT_SLUG_OVERRIDE;
  }
  const [responder] = await db
    .select({ slug: agents.slug, name: agents.name })
    .from(agents)
    .where(
      and(eq(agents.ownerId, USER_ID!), eq(agents.role, 'responder'), eq(agents.enabled, true)),
    )
    .orderBy(asc(agents.priority), asc(agents.slug))
    .limit(1);
  if (!responder) {
    throw new Error(
      "No enabled responder agent found. Create one at /settings/agents (role='responder') or pass AGENT_SLUG=<slug> to override.",
    );
  }
  console.log(`[seed] auto-selected responder agent: ${responder.name} (${responder.slug})`);
  return responder.slug;
}

const SKILL_SLUG = 'profile_interview';
const HEARTBEAT_SLUG = 'get_to_know_user';

const SKILL_INSTRUCTIONS = `You are helping the system get to know the user better
over time. Each fire of this heartbeat, ask ONE thoughtful question on
a topic the state says you haven't covered yet.

Topics in order (cover roughly this sequence; skip naturally if a
previous answer made one redundant):

1. family — who lives at home? names + relations.
2. work_role — what do they do for work? company, team if relevant.
3. work_rhythms — typical working hours? remote/office/hybrid?
4. hobbies — what do they do outside work that energises them?
5. health_signals — what does a good day vs. a bad day look like physically?
6. stress_signals — what does stress tend to look like for them?
7. weekend_rhythms — Sat/Sun typical shape? church/sport/family/hobby blocks?
8. goals_short — anything they're actively working towards this month?

Rules:
- ASK ONE QUESTION PER FIRE. Don't pile up multiple at once.
- Be warm, concise, conversational. Match the user's register.
- After asking, set state.expecting_reply=true and
  state.last_question_topic='<topic>' via heartbeat_update_state.
- The user's reply will come in via a normal Telegram turn (not a
  heartbeat fire). You'll see "Open heartbeats" context — that's
  when you process the reply: call heartbeat_update_state with
  { answered: [...current, '<topic>'], expecting_reply: false }.
- When all 8 topics are answered, call heartbeat_complete with
  reason='all_topics_covered'.

State shape you should maintain:
  {
    answered: string[],          // topics covered
    last_question_topic: string, // most recent topic asked
    expecting_reply: boolean     // true after asking, false after processing
  }
`;

async function upsertSkill(): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), eq(skills.slug, SKILL_SLUG)))
    .limit(1);

  if (existing) {
    await db
      .update(skills)
      .set({
        name: 'Profile interview',
        description:
          "Ask one topical question at a time to build a profile of the user. Self-terminates when all topics are answered.",
        instructions: SKILL_INSTRUCTIONS,
        toolSlugs: ['heartbeat_update_state', 'heartbeat_complete'],
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id));
    console.log(`[seed] updated skill ${SKILL_SLUG}`);
  } else {
    await db.insert(skills).values({
      ownerId: USER_ID!,
      slug: SKILL_SLUG,
      name: 'Profile interview',
      description:
        "Ask one topical question at a time to build a profile of the user. Self-terminates when all topics are answered.",
      instructions: SKILL_INSTRUCTIONS,
      toolSlugs: ['heartbeat_update_state', 'heartbeat_complete'],
      enabled: true,
    });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

async function upsertHeartbeat(agentSlug: string): Promise<void> {
  const earliestAt = new Date(Date.now() + 6 * 3600_000); // 6h grace
  const schedule = {
    kind: 'interval' as const,
    every_minutes: 1440, // 24h
    jitter_minutes: 60,
  };
  const nextFireAt = computeNextFireAt({
    schedule,
    anchor: earliestAt,
    seed: `${HEARTBEAT_SLUG}:1`,
    notBefore: earliestAt,
  });

  const [existing] = await db
    .select({ id: heartbeats.id })
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, USER_ID!), eq(heartbeats.slug, HEARTBEAT_SLUG)))
    .limit(1);

  const common = {
    name: 'Get to know the user',
    description:
      'Daily one-question interview that builds a profile across family / work / hobbies / health / goals. Self-terminates when all topics covered.',
    agentSlug,
    skillSlug: SKILL_SLUG,
    scheduleKind: 'interval' as const,
    schedule,
    surface: { kind: 'telegram' as const, chat_id: TG_CHAT_ID! },
    minIdleMinutes: 15,
    quietHours: { from: '22:00', to: '07:00', tz: null },
    cooldownMinutes: 30,
    earliestAt,
    maxFires: null,
    nextFireAt,
    state: { answered: [], expecting_reply: false } as Record<string, unknown>,
  };

  if (existing) {
    await db.update(heartbeats).set({ ...common, updatedAt: new Date() }).where(eq(heartbeats.id, existing.id));
    console.log(`[seed] updated heartbeat ${HEARTBEAT_SLUG} (next fire ${nextFireAt?.toISOString()})`);
  } else {
    await db.insert(heartbeats).values({
      ownerId: USER_ID!,
      slug: HEARTBEAT_SLUG,
      ...common,
    });
    console.log(`[seed] inserted heartbeat ${HEARTBEAT_SLUG} (next fire ${nextFireAt?.toISOString()})`);
  }
}

/**
 * Ensure the responder agent has the three heartbeat-continuity
 * tools in its tool_slugs allowlist. Without them, the awareness
 * block injected into the system prompt tells the agent to "call
 * heartbeat_update_state" but the tool isn't in the model's
 * available-tools list and the call can never happen. Idempotent —
 * only adds missing slugs, never removes or reorders.
 *
 * `heartbeat_fire` + `heartbeat_list` are intentionally NOT added —
 * those are operator/skill tools, not normal-turn tools. The three
 * we DO add all self-protect via requireContext() so they're inert
 * during turns that aren't reacting to a heartbeat.
 */
async function ensureHeartbeatToolsOnAgent(agentSlug: string): Promise<void> {
  const required = ['heartbeat_update_state', 'heartbeat_complete', 'heartbeat_snooze'];
  const [row] = await db
    .select({ id: agents.id, toolSlugs: agents.toolSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) return; // resolveAgentSlug already validated; defensive
  const current = row.toolSlugs ?? [];
  const missing = required.filter((s) => !current.includes(s));
  if (missing.length === 0) {
    console.log(`[seed] agent ${agentSlug} already has heartbeat continuity tools`);
    return;
  }
  const next = [...current, ...missing].sort();
  await db
    .update(agents)
    .set({ toolSlugs: next, updatedAt: new Date() })
    .where(eq(agents.id, row.id));
  console.log(`[seed] added ${missing.join(', ')} to agent ${agentSlug} tool_slugs`);
}

async function main() {
  const agentSlug = await resolveAgentSlug();
  await ensureHeartbeatToolsOnAgent(agentSlug);
  await upsertSkill();
  await upsertHeartbeat(agentSlug);
  console.log('[seed] done — heartbeat will fire after the 6h earliest_at gate passes.');
  console.log('[seed] use the /heartbeats page or the heartbeat_fire tool to test sooner.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] error:', err);
  process.exit(1);
});
