/**
 * Seeds the weekly BRAIN-HEALTH heartbeat: capacity (split-policy zones) +
 * retrieval-quality eval (recall_eval), alerting only when something moved.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> [TG_CHAT_ID=<numeric>] [AGENT_SLUG=<slug>] \
 *     pnpm tsx --env-file-if-exists=./.env.local scripts/seed-brain-health.ts
 *
 * Idempotent: re-running upserts the skill + heartbeat by slug. Without
 * TG_CHAT_ID the heartbeat delivers to the web surface.
 *
 * What it creates:
 *   skill: brain_health_check — instructions to call brain_capacity +
 *     recall_eval and report only when action is needed.
 *   heartbeat: brain_health — fires weekly ±6h, quiet hours respected.
 *   note: golden cases — if a scripts/eval/recall-cases.json exists AND no
 *     'recall-eval-cases' note exists yet, the repo golden set is imported so
 *     recall_eval has cases to run on day one.
 *
 * Operator step: grant the `brain-health` tool group to the chosen agent at
 * /settings/agents (the manifest defines the group; grants stay explicit).
 */
import { readFileSync } from 'node:fs';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, agents, heartbeats, nodes, skills } from '@mantle/db';
import { computeNextFireAt } from '@mantle/heartbeats';
import { createNote } from '@mantle/content';

const USER_ID = process.env.ALLOWED_USER_ID;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const AGENT_SLUG_OVERRIDE = process.env.AGENT_SLUG;

if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const SKILL_SLUG = 'brain_health_check';
const HEARTBEAT_SLUG = 'brain_health';
const CASES_TAG = 'recall-eval-cases';

const SKILL_INSTRUCTIONS = `Weekly brain-health check. You are running on a schedule — the user did
not ask for this, so REPORT ONLY WHAT NEEDS ATTENTION and stay silent
otherwise.

When this heartbeat fires:

1. Call brain_capacity.
2. Call recall_eval (it persists its own run note and computes drift).
3. Decide whether anything warrants a message:
   - capacity zone is 'watch' or 'split', OR
   - recall_eval returned alert: true, OR
   - recall_eval failed (embedder down, missing/invalid golden cases).
4. If nothing warrants a message: call heartbeat_update_state with
   { last_run_at: '<ISO instant>', last_status: 'green' } and end the
   turn WITHOUT sending any message (an empty reply is correct).
5. If something does: send ONE concise message — the zone/percentages,
   the metric that moved (e.g. "search MRR 0.91 → 0.83"), and the next
   step from the playbook: watch → run recall checks / raise ef_search;
   split → plan a breakout brain for the dominant category; eval error →
   the fix named in the error. Then heartbeat_update_state with
   { last_run_at, last_status: 'alerted' }.

Never run the eval more than once per firing. State shape:
  { last_run_at: string, last_status: 'green' | 'alerted' }
`;

const SKILL_DEFAULT_STATE: Record<string, unknown> = { last_status: 'green' };

async function resolveAgentSlug(): Promise<string> {
  if (AGENT_SLUG_OVERRIDE) {
    const [row] = await db
      .select({ slug: agents.slug, enabled: agents.enabled })
      .from(agents)
      .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, AGENT_SLUG_OVERRIDE)))
      .limit(1);
    if (!row) throw new Error(`AGENT_SLUG='${AGENT_SLUG_OVERRIDE}' not found for this owner.`);
    if (!row.enabled) throw new Error(`AGENT_SLUG='${AGENT_SLUG_OVERRIDE}' is disabled.`);
    return AGENT_SLUG_OVERRIDE;
  }
  const [responder] = await db
    .select({ slug: agents.slug, name: agents.name })
    .from(agents)
    .where(
      and(eq(agents.ownerId, USER_ID!), eq(agents.role, 'responder'), eq(agents.enabled, true)),
    )
    .orderBy(asc(agents.priority))
    .limit(1);
  if (!responder) throw new Error('no enabled responder agent — create one at /settings/agents');
  console.log(`[seed] auto-selected responder agent: ${responder.name} (${responder.slug})`);
  return responder.slug;
}

async function upsertSkill(): Promise<void> {
  const meta = {
    name: 'Brain health check',
    description:
      'Scheduled capacity + retrieval-quality check (brain_capacity + recall_eval). Reports only when a zone or metric needs attention.',
    instructions: SKILL_INSTRUCTIONS,
    defaultState: SKILL_DEFAULT_STATE,
    enabled: true,
  };
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), eq(skills.slug, SKILL_SLUG)))
    .limit(1);
  if (existing) {
    await db
      .update(skills)
      .set({ ...meta, updatedAt: new Date() })
      .where(eq(skills.id, existing.id));
    console.log(`[seed] updated skill ${SKILL_SLUG}`);
  } else {
    await db.insert(skills).values({ ownerId: USER_ID!, slug: SKILL_SLUG, ...meta });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

/** Import the repo golden set as the cases note, only when none exists. */
async function seedCasesNote(): Promise<void> {
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, USER_ID!),
        eq(nodes.type, 'note'),
        // Literal array — a JS array bind param is not serialised to a PG
        // array by the postgres-js driver (see packages/search/src/pg.ts).
        sql`${nodes.tags} @> ${sql.raw(`'{${CASES_TAG}}'::text[]`)}`,
      ),
    )
    .limit(1);
  if (existing) {
    console.log(`[seed] golden-case note already exists (${existing.id}) — left untouched`);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(new URL('./eval/recall-cases.json', import.meta.url), 'utf8');
  } catch {
    console.log(
      '[seed] no scripts/eval/recall-cases.json — skipped cases import (create the note by hand)',
    );
    return;
  }
  const note = await createNote(USER_ID!, {
    title: 'Recall eval — golden cases',
    content: raw,
    tags: [CASES_TAG],
  });
  console.log(`[seed] imported golden cases from repo set → note ${note.id}`);
}

async function upsertHeartbeat(agentSlug: string): Promise<void> {
  const schedule = { kind: 'interval' as const, every_minutes: 7 * 24 * 60, jitter_minutes: 360 };
  const nextFireAt = computeNextFireAt({ schedule, anchor: new Date(), seed: HEARTBEAT_SLUG });
  const surface = TG_CHAT_ID
    ? { kind: 'telegram' as const, chat_id: TG_CHAT_ID }
    : { kind: 'web' as const };
  const common = {
    name: 'Brain health',
    agentSlug,
    skillSlug: SKILL_SLUG,
    scheduleKind: 'interval' as const,
    schedule,
    surface,
    minIdleMinutes: 15,
    quietHours: { from: '22:00', to: '07:00' },
    cooldownMinutes: 60,
    status: 'active' as const,
    nextFireAt,
  };
  const [existing] = await db
    .select({ id: heartbeats.id })
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, USER_ID!), eq(heartbeats.slug, HEARTBEAT_SLUG)))
    .limit(1);
  if (existing) {
    await db
      .update(heartbeats)
      .set({ ...common, updatedAt: new Date() })
      .where(eq(heartbeats.id, existing.id));
    console.log(
      `[seed] updated heartbeat ${HEARTBEAT_SLUG} (next fire ${nextFireAt?.toISOString()})`,
    );
  } else {
    await db.insert(heartbeats).values({
      ownerId: USER_ID!,
      slug: HEARTBEAT_SLUG,
      state: SKILL_DEFAULT_STATE,
      ...common,
    });
    console.log(
      `[seed] inserted heartbeat ${HEARTBEAT_SLUG} (next fire ${nextFireAt?.toISOString()})`,
    );
  }
}

const agentSlug = await resolveAgentSlug();
await upsertSkill();
await seedCasesNote();
await upsertHeartbeat(agentSlug);
console.log(
  '[seed] done — weekly brain-health check scheduled. Grant the `brain-health` tool group to the agent at /settings/agents.',
);
process.exit(0);
