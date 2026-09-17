/**
 * @mantle/client-types · agents
 *
 * Agents themselves: role, avatar, memory/params jsonb, persona notes and
 * the experience readout.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Agents ────────────────────────────────────────────────────────────────────

/** Conversational + worker roles an agent row can carry. Mirrors the
 *  `agent_role` enum (`packages/db/src/schema/agents.ts`); the `/settings/agents`
 *  page only lists the conversational ones. */
export type AgentRole =
  | 'assistant'
  | 'responder'
  | 'extractor'
  | 'summarizer'
  | 'reflector'
  | 'custom'
  // Runner-queue worker template (docs/runs.md) — never conversational.
  | 'worker';

/** Per-agent generated avatar (style + seed → DiceBear). null = initials. */
export interface AgentAvatarDTO {
  style: string;
  seed: string;
  /** Avatar-builder component choices layered over the seed: component name →
   *  pinned variant, or null to hide an optional component. Stale entries
   *  (from another style) are ignored at render time.
   *
   *  READ: absent = seed only. WRITE protocol (agents create/patch): an
   *  ABSENT parts key means "keep what's stored" — so a parts-unaware client
   *  can never wipe pins — `{}` is the explicit clear, and a non-empty map
   *  replaces. Every client that writes avatars must send `{}` to clear. */
  parts?: Record<string, string | null>;
}

/** Memory/budget tuning (jsonb). All fields optional — empty = runtime defaults.
 *  Replicated standalone (NOT re-exported from @mantle/db) to keep this package
 *  zero-dep; the server aliases its `AgentMemoryConfig` against this so drift is
 *  a compile error. */
export interface AgentMemoryConfigDTO {
  history_limit?: number;
  history_window_hours?: number | null;
  digest_limit?: number;
  fact_limit?: number;
  content_hit_limit?: number;
  chunk_limit?: number;
  inject_journal?: boolean;
  inject_working_notes?: boolean;
  summarize_threshold?: number;
  summarize_batch?: number;
  extract_types?: string[];
  extract_facts?: boolean;
  extract_cost_cap_micro_usd?: number | null;
  delegate_to?: string[];
  max_iterations?: number;
  result_handling?: {
    inline_max_kb?: number;
    embed_min_kb?: number;
    spill_max_kb?: number;
  };
}

/** Sampling + voice-reply params (jsonb). */
export interface AgentParamsDTO {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  max_retries?: number;
  voice?: {
    enabled?: boolean;
    name?: 'alloy' | 'echo' | 'fable' | 'nova' | 'onyx' | 'shimmer';
    model?: 'tts-1' | 'tts-1-hd';
    speed?: number;
  };
  /** Propose a follow-up question after each completed turn (the suggester
   *  worker's chip above the chat composer). Absent/false = off. */
  suggest_follow_up?: boolean;
}

/** One persona note (jsonb element). Soft-retired, never deleted — the read
 *  path filters `retiredAt`. `at`/`retiredAt` are ISO strings. */
export interface PersonaNoteDTO {
  id?: string;
  kind: 'style' | 'relationship' | 'correction';
  content: string;
  at: string;
  source?: { type: 'turn' | 'digest'; id: string };
  retiredAt?: string;
  retiredReason?: 'superseded' | 'removed';
  supersededBy?: string;
}

/** Raw counters behind an agent's experience level — always shipped next to
 *  the level so the UI can show WHY it is level N. All are lifetime counts for
 *  THIS brain (experience is per-brain, display-only — never a trust gate). */
export interface AgentExperienceComponentsDTO {
  /** Completed conversation turns this agent answered on the assistant
   *  stream (web, Telegram, mobile). Team/forum turns live in a different
   *  store and are not counted (yet). */
  turns: number;
  /** Tool calls that succeeded across those turns. */
  toolSuccesses: number;
  /** Delegated runs this agent completed for other agents. */
  delegations: number;
  /** Heartbeat fires this agent completed. */
  heartbeats: number;
}

/** An agent's experience readout — a soft-capped level derived from real
 *  accumulated usage (see `agent-experience.ts` server-side for the weights
 *  and curve). Computed at read time; nothing is stored. */
export interface AgentExperienceDTO {
  level: number;
  /** Total XP earned. */
  xp: number;
  /** Cumulative XP at which the current level began. */
  levelXp: number;
  /** Cumulative XP needed to reach the next level. */
  nextLevelXp: number;
  components: AgentExperienceComponentsDTO;
}

/** An agent as returned by `GET /api/agents` (and `…/[id]`). Dates are ISO
 *  strings. The server aliases its `AgentSummary` to this so the wire shape and
 *  the consuming client can't drift. */
export interface AgentDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: AgentRole;
  provider: string;
  model: string;
  apiKeyId: string | null;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
  baseUrl: string | null;
  viaTailnet: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
  ttsWorkerId: string | null;
  systemPrompt: string;
  skillSlugs: string[];
  toolGroupSlugs: string[];
  memoryConfig: AgentMemoryConfigDTO;
  params: AgentParamsDTO;
  avatar: AgentAvatarDTO | null;
  personaNotes: PersonaNoteDTO[];
  /** The co-admin login this agent is the personal assistant for (migration
   *  0143), or null for a shared agent. Set, it becomes that login's default
   *  chat target — the mechanism that keeps two people typing at once out of
   *  one interleaved thread. Not a privacy boundary: every login still sees
   *  and can open every agent. */
  assignedUserId: string | null;
  /** ISO timestamp of the current assignment; null when unassigned. */
  assignedAt: string | null;
  priority: number;
  enabled: boolean;
  /** True when this agent ships from the system manifest (a def-synced
   *  specialist). Since 2026-07-29 only its params/memoryConfig tuning
   *  re-syncs on upgrade — prompt, model, provider and key are operator-owned
   *  and survive. Drives the "system" badge on the agents screens. */
  manifestManaged: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  /** Experience readout (level + raw counters). Optional: filled on the list
   *  reads the agent screens use (`GET /api/agents`, the assistant thread
   *  bundle); absent on single-row CRUD echoes where computing it would cost
   *  extra queries for nothing. */
  experience?: AgentExperienceDTO;
  createdAt: string;
  updatedAt: string;
}

/** A lightweight agent option (slug + name + role) for picker dropdowns —
 *  `GET /api/agents/options`. Unlike `GET /api/agents` (conversational roles
 *  only), this lists EVERY agent, so heartbeats can bind worker-role agents. */
export interface AgentOptionDTO {
  slug: string;
  name: string;
  role: AgentRole;
}
