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

const SKILL_INSTRUCTIONS = `You are opening the relationship with the user. Fire ONCE: send ONE
warm, open-ended invitation that gives them room to share whatever
they want you to remember about them. Then stop.

Why ONE question (not an interview):
- Reflector + extractor already harvest entities, facts, and persona
  notes from EVERY message the user sends in normal conversation. You
  don't need to ask follow-up questions to learn the rest — the
  system passively absorbs it as you chat.
- A multi-question script feels like an interrogation. A single warm
  invitation feels like a friend asking "tell me about yourself."

When this heartbeat fires:

1. Craft a single open question, e.g.:
     "Hey 🌿 — quick one to help me be useful from day one: tell me
      a bit about yourself? Whatever you'd like me to remember
      — family, work, what you're into, whatever shape your days
      take. No need to be thorough."
   Match the user's register (casual / formal / playful as
   established).

2. Call heartbeat_update_state with:
     {
       expecting_reply: true,
       last_asked_at: '<current ISO instant>'
     }

3. End your turn. Send one message.

When the user REPLIES (normal responder turn, you'll see the "Open
heartbeats" awareness block):

1. Acknowledge what they shared in your own voice (1-2 sentences).
   The extractor will already create entities + facts from the
   message itself; the reflector will append persona notes. You
   don't need to enumerate or summarise — just be warm.

2. Call heartbeat_complete with slug='get_to_know_user' and
   reason='opened_relationship'. ONE reply is enough — don't keep
   asking follow-ups, the goal is met.

If the user ignores the invitation: the heartbeat stays expecting_reply=true
forever. That's fine — no nagging. If they engage organically later,
the awareness block will still apply and you can close it then.

If the user explicitly says "not now" or "skip": call
heartbeat_complete with reason='user_declined'.

State shape:
  {
    expecting_reply: boolean,    // true after asking, false on complete
    last_asked_at: string,       // ISO instant of the ask
  }
`;

/** Template state shape the profile_interview skill expects. Stored on
 *  the skill row so any heartbeat bound to it inherits these defaults
 *  on create (migration 0031). The simplified one-question design
 *  needs only two keys; the previous interview design's `answered`
 *  array isn't relevant anymore. */
const SKILL_DEFAULT_STATE: Record<string, unknown> = {
  expecting_reply: false,
};

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
        defaultState: SKILL_DEFAULT_STATE,
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
      defaultState: SKILL_DEFAULT_STATE,
      enabled: true,
    });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

async function upsertHeartbeat(agentSlug: string): Promise<void> {
  // Fire once, ~6 hours after install (with up to 30min jitter so it
  // doesn't always land at exactly the 6h mark — feels human).
  // Single fire only — the skill self-terminates on the user's first
  // reply. If they ignore it, the heartbeat sits expecting_reply=true
  // forever, no nagging. If they engage later, the responder's
  // awareness block closes it then.
  const fireAt = new Date(Date.now() + 6 * 3600_000 + Math.floor(Math.random() * 30 * 60_000));
  const schedule = {
    kind: 'once' as const,
    at: fireAt.toISOString(),
  };
  const nextFireAt = computeNextFireAt({
    schedule,
    anchor: new Date(),
    seed: `${HEARTBEAT_SLUG}:1`,
  });

  const [existing] = await db
    .select({ id: heartbeats.id })
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, USER_ID!), eq(heartbeats.slug, HEARTBEAT_SLUG)))
    .limit(1);

  const common = {
    name: 'Welcome invitation',
    description:
      "Single open invitation, ~6h after install: 'tell me a bit about yourself'. Self-terminates on the user's first substantive reply. No follow-ups — extractor + reflector handle the rest organically through normal conversation.",
    agentSlug,
    skillSlug: SKILL_SLUG,
    scheduleKind: 'once' as const,
    schedule,
    surface: { kind: 'telegram' as const, chat_id: TG_CHAT_ID! },
    // Quiet hours stay (don't barge in at 02:00 if install was at 20:00).
    // Idle gate looser since this is a first-touch; user expects the
    // assistant to take initiative once early.
    minIdleMinutes: 5,
    quietHours: { from: '22:00', to: '07:00', tz: null },
    cooldownMinutes: null,
    // earliestAt mirrors fireAt for `once`: the schedule's `at` already
    // controls timing, but setting earliestAt makes the gate explicit
    // and shows up nicely on the detail page.
    earliestAt: fireAt,
    // maxFires: 1 is belt-and-suspenders — `once` already only fires
    // once, but if a future migration ever flipped this row to
    // interval the cap still holds.
    maxFires: 1,
    nextFireAt,
    state: { expecting_reply: false } as Record<string, unknown>,
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

async function main() {
  const agentSlug = await resolveAgentSlug();
  // P6: the heartbeat-continuity tools (heartbeat_complete/snooze/update_state)
  // are no longer granted onto the agent — they're injected at runtime as a
  // per-turn affordance when an active heartbeat exists on the surface (see
  // apps/web/lib/assistant.ts + apps/agent/src/main.ts). Nothing to seed here.
  await upsertSkill();
  await upsertHeartbeat(agentSlug);
  console.log('[seed] done — single welcome-invitation fire scheduled ~6h from now.');
  console.log('[seed] use the /heartbeats page or the heartbeat_fire tool to test sooner.');
  console.log('[seed] the skill self-terminates on the user\'s first substantive reply.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] error:', err);
  process.exit(1);
});
