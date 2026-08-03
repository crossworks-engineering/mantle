/**
 * Pure clone decisions for per-login assistants (migration 0143).
 *
 * Extracted from the DB wrapper (`cloneAgentForUser` in ./agents.ts) so what a
 * clone inherits — and what it deliberately does NOT — is unit-testable with no
 * database, mirroring the pattern `packages/assistant-runtime/src/select.ts`
 * uses for the web-default pick.
 *
 * The product shape: give a co-admin login its own agent row and every
 * downstream surface splits for free (the conversation store, the
 * `conversation_changed` NOTIFY payload, read cursors, digests, the inbox are
 * all already keyed per agent). So the clone must be a faithful copy of the
 * source's BEHAVIOUR — same model, route, prompt, skills, tools, delegation —
 * differing only in identity.
 */

import type { CreateAgentInput } from './agents';
import type { AgentDTO } from '@mantle/client-types';

/**
 * Kebab-case an assistant name into a slug candidate.
 *
 * `agents.slug` is constrained to `[a-z0-9_-]+` by the create route's zod
 * schema, so anything else (spaces, punctuation, accents) collapses to a dash.
 * Returns '' for a name with no usable characters — callers fall back to a
 * generic stem rather than inserting an empty slug.
 */
export function slugifyAgentName(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Strip combining marks so "Renée" → "renee" rather than "ren-e".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
  );
}

/**
 * The first slug in the `base`, `base-2`, `base-3` … series that `taken`
 * doesn't already hold. `agents_owner_slug_uq` is per-owner and every agent in
 * a brain shares the anchor owner, so `taken` is simply every existing slug.
 *
 * A blank base (a name of pure punctuation/emoji) falls back to `assistant`,
 * which then uniquifies like any other — the canonical persona usually holds
 * that slug already, so the result is `assistant-2`.
 */
export function uniqueAgentSlug(base: string, taken: Iterable<string>): string {
  const stem = base || 'assistant';
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // 998 collisions on one stem is not a real brain; fail loudly rather than
  // hand the caller a slug that will violate the unique index.
  throw new Error(`could not find a free slug for '${stem}'`);
}

/**
 * Build the `createAgent` input for a login's personal assistant.
 *
 * Copied verbatim — the whole point is "the same assistant, its own thread":
 * role, provider, both chat routes (primary + backup, base URLs, tailnet
 * flags), the TTS voice, the system prompt, skills, tool groups, params,
 * avatar, and `memoryConfig` INCLUDING `delegate_to` (specialists are shared
 * across the brain, so a clone must be able to delegate to them on day one).
 *
 * Deliberately not copied:
 *
 * - **`personaNotes`** — start empty. Notes are things the assistant learned
 *   about the person it was talking to; carrying the anchor's notes into a
 *   co-admin's assistant would misattribute them to the wrong human.
 * - **Channels** — a Telegram binding is a separate `channels` row keyed to
 *   `agent_id` (migration 0077), so a fresh agent has no transport and no
 *   credentials by construction. Nothing to skip here; noted because "clone the
 *   agent" could otherwise be read as cloning the bot too.
 * - **`priority`** — the clone sits one BELOW its source. `pickWebDefaultAgent`
 *   breaks priority ties on slug, so an equal-priority clone could silently
 *   become the brain-wide default for headless callers (the reminders worker,
 *   heartbeats). Ranking clones below keeps the canonical persona the
 *   background default. Floored at 0, since the column is non-negative.
 */
export function cloneAgentFields(
  source: AgentDTO,
  identity: { name: string; slug: string; assignedUserEmail: string },
): CreateAgentInput {
  return {
    slug: identity.slug,
    name: identity.name,
    description: `Personal assistant for ${identity.assignedUserEmail}.`,
    role: source.role,
    provider: source.provider,
    model: source.model,
    apiKeyId: source.apiKeyId,
    backupProvider: source.backupProvider,
    backupModel: source.backupModel,
    backupApiKeyId: source.backupApiKeyId,
    backupEnabled: source.backupEnabled,
    baseUrl: source.baseUrl,
    viaTailnet: source.viaTailnet,
    backupBaseUrl: source.backupBaseUrl,
    backupViaTailnet: source.backupViaTailnet,
    ttsWorkerId: source.ttsWorkerId,
    systemPrompt: source.systemPrompt,
    skillSlugs: [...(source.skillSlugs ?? [])],
    toolGroupSlugs: [...(source.toolGroupSlugs ?? [])],
    memoryConfig: { ...(source.memoryConfig ?? {}) },
    params: { ...(source.params ?? {}) },
    avatar: source.avatar ?? null,
    priority: Math.max(0, source.priority - 1),
    enabled: true,
  };
}
