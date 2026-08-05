/**
 * Skill-composition helpers usable from any process (the agent runner,
 * the Next request handler, future cron workers). Pure logic — no DB
 * imports beyond what's already wired into the runtime. The CRUD lib
 * stays in apps/web for now.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, skills, toolGroups, type Skill } from '@mantle/db';

export type SkillForRuntime = {
  id: string;
  slug: string;
  name: string;
  instructions: string;
};

function toRuntime(s: Skill): SkillForRuntime {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    instructions: s.instructions,
  };
}

/**
 * Resolve an agent's skills to enabled rows: its OWN `skillSlugs`, plus the
 * usage skill of every integration tool group it's granted (`opts.toolGroupSlugs`).
 * An integration's know-how travels with the grant — grant the group, get the
 * skill — so there's no separate attach step to forget. The agent's own skills
 * come first; the union is deduped and capped.
 *
 * Callers that only ever have literal skill slugs (studio previews, tests) can
 * omit `opts` and get exactly the old behaviour.
 */
export async function resolveAgentSkills(
  ownerId: string,
  slugs: string[],
  opts?: { toolGroupSlugs?: string[] },
): Promise<SkillForRuntime[]> {
  const groupSkillSlugs = await resolveToolGroupSkillSlugs(ownerId, opts?.toolGroupSlugs ?? []);
  const wanted = effectiveSkillSlugs(slugs, groupSkillSlugs);
  if (wanted.length === 0) return [];
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(eq(skills.ownerId, ownerId), eq(skills.enabled, true), inArray(skills.slug, wanted)),
    );
  // Return in the requested order (own skills first) so the composed prompt is
  // deterministic rather than dependent on row order.
  const bySlug = new Map(rows.map((r) => [r.slug, r] as const));
  return wanted.flatMap((s) => {
    const row = bySlug.get(s);
    return row ? [toRuntime(row)] : [];
  });
}

/**
 * Granted tool-group slugs → the usage-skill slugs their integrations declare
 * (ENABLED groups only, matching `resolveAgentToolGroups`). A group with no
 * integration, or an integration with no skill, contributes nothing.
 */
export async function resolveToolGroupSkillSlugs(
  ownerId: string,
  groupSlugs: string[],
): Promise<string[]> {
  if (groupSlugs.length === 0) return [];
  const rows = await db
    .select({ integration: toolGroups.integration })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        inArray(toolGroups.slug, groupSlugs),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    const slug = r.integration?.skillSlug;
    if (slug) out.add(slug);
  }
  return Array.from(out);
}

/** Upper bound on the effective skill union. A skill's whole body is injected
 *  into the system prompt on every turn, so this is a context-cost guard, not a
 *  provider limit — and it's loud when it bites. */
const MAX_EFFECTIVE_SKILL_SLUGS = 32;

/**
 * Union of an agent's own skill slugs with the skills its granted groups carry.
 * Agent's own first (they're the operator's explicit choice), deduped, capped.
 * Pure — the DB reads happen in `resolveAgentSkills`.
 */
export function effectiveSkillSlugs(ownSlugs: string[], groupSkillSlugs: string[]): string[] {
  const all = Array.from(new Set<string>([...ownSlugs, ...groupSkillSlugs]));
  if (all.length > MAX_EFFECTIVE_SKILL_SLUGS) {
    const dropped = all.slice(MAX_EFFECTIVE_SKILL_SLUGS);
    console.warn(
      `[skills] effective skill union (${all.length}) exceeds cap ${MAX_EFFECTIVE_SKILL_SLUGS}; dropping ${dropped.length}: ${dropped.join(', ')}`,
    );
    return all.slice(0, MAX_EFFECTIVE_SKILL_SLUGS);
  }
  return all;
}

/**
 * Resolve granted tool-group slugs → the flat, deduped union of their member
 * tool slugs (ENABLED groups only, matching the runtime's resolve-or-omit rule).
 * Empty in ⇒ empty out (no DB hit). See docs/tools-and-skills.md (Phase 3).
 */
export async function resolveAgentToolGroups(ownerId: string, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        inArray(toolGroups.slug, slugs),
      ),
    );
  const set = new Set<string>();
  for (const r of rows) for (const t of r.toolSlugs ?? []) set.add(t);
  return Array.from(set);
}

/**
 * Append every skill's instructions to a base system prompt as
 * `## Skill: <name>` blocks. Keeps each skill's voice fenced so the
 * model can tell which guidance belongs to which skill.
 *
 * `houseStyle` (Settings → Profile, brain-level) lands LAST, after the skills,
 * because it is the owner overriding the shipped guidance rather than another
 * voice alongside it: when `chat_writing` and the owner disagree about a dash,
 * the owner wins, and recency is the cheapest way to say so.
 *
 * This function is the single composition seam — the responder turn
 * (assemble-turn), delegated specialists (invoke-agent), heartbeat turns
 * (heartbeats/fire), the Studio sandbox, and Studio's composed-prompt PREVIEW
 * all route through it. That is why the setting reaches page authoring when a
 * persona note cannot, and why the preview shows it (no hidden prompts).
 *
 * Being that seam is also why `{{name}}` resolves HERE rather than deeper in
 * `renderPersonaBlock`: substituting later would make the model see a name the
 * Studio preview does not, which is exactly the hidden prompt this seam exists
 * to prevent. `agentName` is REQUIRED so a new call site cannot forget it and
 * silently ship a literal token to a model.
 */
export type ComposePromptOptions = {
  /** The agent's display name — what `{{name}}` resolves to. */
  agentName: string;
  /** Owner's brain-level house style (Settings → Profile). */
  houseStyle?: string;
};

export function composeSystemPromptWithSkills(
  basePrompt: string,
  skillsList: SkillForRuntime[],
  opts: ComposePromptOptions,
): string {
  const blocks = skillsList
    .filter((s) => s.instructions.trim().length > 0)
    .map((s) => `## Skill: ${s.name}\n\n${s.instructions.trim()}`)
    .join('\n\n');
  const style = opts.houseStyle?.trim();
  // Unset ⇒ emit nothing, so the cached prompt prefix stays byte-identical to
  // what a brain without a house style has always sent.
  const styleBlock = style
    ? `## House style\n\n${style}\n\nThis is the owner's own instruction and outranks any writing guidance above. It governs prose YOU author. Never apply it to material you are reproducing: quoted text, retrieved content, code, or a document you were asked to copy or edit verbatim.`
    : '';
  const tail = [blocks, styleBlock].filter(Boolean).join('\n\n');
  const composed = tail ? `${basePrompt.trim()}\n\n${tail}` : basePrompt;
  return applyAgentName(composed, opts.agentName);
}

/** The one token a prompt may use to mean "whatever this agent is called".
 *
 *  Deliberately NOT a general `{{…}}` expansion: `{{secret:service/label}}`
 *  is a different mechanism, resolved much later in the HTTP tool dispatcher,
 *  and its literal syntax appears in the toolsmith skill's own instructions.
 *  A greedy matcher would eat those and hand the model a broken example. */
export const AGENT_NAME_TOKEN = '{{name}}';

/**
 * Resolve `{{name}}` to the agent's actual name.
 *
 * Why a token instead of the name baked into the prompt text: the two are
 * separate columns, and nothing kept them in step. `updateAgent` writes `name`
 * and never touches `system_prompt`, so renaming an agent in /settings/agents
 * left it introducing itself by its old name — and a per-login assistant
 * (migration 0143), which is a COPY of another agent's prompt, answered as the
 * agent it was copied from. One resolution point fixes both, permanently.
 *
 * A prompt with no token comes back byte-identical, so every existing brain's
 * cached prefix (block 1 of buildChatMessages) is untouched until it opts in.
 * A blank/whitespace name is left alone for the same reason — better a literal
 * token the operator can see and fix than an agent that is nameless mid-prompt.
 */
export function applyAgentName(prompt: string, agentName: string): string {
  const name = agentName?.trim();
  if (!name || !prompt.includes(AGENT_NAME_TOKEN)) return prompt;
  return prompt.split(AGENT_NAME_TOKEN).join(name);
}

/** Upper bound on the effective tool-slug union sent to a model. Agent slugs
 *  and each skill's slugs are individually capped at 256; many attached skills
 *  could still union into a huge `tools` array that bloats the prompt or trips
 *  a provider limit. Generous enough that no legitimate config hits it. */
const MAX_EFFECTIVE_TOOL_SLUGS = 512;

/**
 * An agent's effective tool allowlist: exactly the tools conferred by its
 * granted tool groups (pre-resolved via resolveAgentToolGroups). P6: tool groups
 * are the SOLE grant — the `agents.tool_slugs` column is gone, and skills are
 * pure teaching (P4). Deduped + capped.
 */
export function effectiveToolSlugs(groupToolSlugs: string[]): string[] {
  const all = Array.from(new Set<string>(groupToolSlugs));
  if (all.length > MAX_EFFECTIVE_TOOL_SLUGS) {
    const dropped = all.slice(MAX_EFFECTIVE_TOOL_SLUGS);
    // Not silent — log exactly which slugs were cut so a misconfiguration is
    // diagnosable rather than presenting as "some tools just don't work".
    console.warn(
      `[skills] effective tool-slug union (${all.length}) exceeds cap ${MAX_EFFECTIVE_TOOL_SLUGS}; dropping ${dropped.length}: ${dropped.join(', ')}`,
    );
    return all.slice(0, MAX_EFFECTIVE_TOOL_SLUGS);
  }
  return all;
}
