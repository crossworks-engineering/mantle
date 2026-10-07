import { z } from 'zod';
import type { AgentMemoryConfigDTO } from '@mantle/client-types';
import type { AgentMemoryConfig } from '@mantle/db';

/**
 * The ONE agent `memory_config` body schema, shared by agents POST and agents
 * PATCH. Two pasted copies had drifted: the POST copy refused chunk_limit,
 * the corpus map and journal keys, so a create with those set was a 400. Same
 * shared-schema convention as avatar-schema.ts.
 *
 * Saving MERGES (see updateAgent): a key the body leaves out keeps its stored
 * value, so a client that shows only some fields cannot wipe the rest. To
 * clear a key back to the runtime default, send it as `null`.
 */
const shape = {
  history_limit: z.number().int().min(0).max(500).optional(),
  history_window_hours: z
    .number()
    .min(0)
    .max(24 * 365)
    .optional(),
  digest_limit: z.number().int().min(0).max(20).optional(),
  fact_limit: z.number().int().min(0).max(100).optional(),
  content_hit_limit: z.number().int().min(0).max(20).optional(),
  chunk_limit: z.number().int().min(0).max(50).optional(),
  corpus_map_limit: z.number().int().min(0).max(2_000).optional(),
  corpus_map_chars: z.number().int().min(1_000).max(50_000).optional(),
  // Journal context (docs/journal.md §4a/§4b). notes_target = 'journal'
  // implies journal_tiers = 'live' at runtime.
  inject_journal: z.boolean().optional(),
  inject_working_notes: z.boolean().optional(),
  journal_tiers: z.enum(['off', 'shadow', 'live']).optional(),
  journal_relevance_min: z.number().min(0).max(1).optional(),
  journal_relevant_chars: z.number().int().min(200).max(20_000).optional(),
  notes_target: z.enum(['persona', 'journal']).optional(),
  summarize_threshold: z.number().int().min(1).max(10_000).optional(),
  summarize_batch: z.number().int().min(1).max(1_000).optional(),
  extract_types: z.array(z.string().min(1).max(64)).max(32).optional(),
  extract_facts: z.boolean().optional(),
  extract_cost_cap_micro_usd: z.number().int().min(0).max(1_000_000_000).optional(),
  // Agent-delegation allowlist: slugs this agent may invoke_agent into.
  // Empty array = delegation disabled (the runtime fails closed).
  delegate_to: z.array(z.string().min(1).max(120)).max(32).optional(),
  // Tool-loop iteration cap (set per-specialist by the manifest; editable from
  // the Studio structure editor).
  max_iterations: z.number().int().min(1).max(100).optional(),
  // Per-turn tool-call caps (the manifest sets them on some specialists;
  // without them a UI round-trip of memory_config was rejected).
  max_tool_calls: z.number().int().min(1).max(200).optional(),
  max_calls_per_tool: z.number().int().min(1).max(100).optional(),
  // Tool-result handling (KB): when a tool output exceeds inline_max_kb it
  // spills to the tool-result store; embed_min_kb is where the envelope
  // recommends semantic query. Fall back to env/global defaults.
  result_handling: z
    .object({
      inline_max_kb: z.number().int().min(1).max(1024).optional(),
      embed_min_kb: z.number().int().min(1).max(8192).optional(),
      spill_max_kb: z.number().int().min(1).max(65536).optional(),
    })
    .strict()
    .optional(),
};

type Shape = typeof shape;

/** Every key also takes `null`: "remove this key" (the runtime default
 *  applies). For history_window_hours and extract_cost_cap_micro_usd a null
 *  meant "no window" / "no cap" before, which is what an absent key means. */
export const AgentMemoryConfigSchema = z
  .object(
    Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.nullable()])) as {
      [K in keyof Shape]: z.ZodNullable<Shape[K]>;
    },
  )
  .strict();

/** A memory_config write: a value sets the key, `null` removes it. */
export type AgentMemoryConfigPatch = {
  [K in keyof AgentMemoryConfig]?: AgentMemoryConfig[K] | null;
};

/** Split a patch into the keys to set and the keys to remove. */
export function splitMemoryConfigPatch(patch: AgentMemoryConfigPatch): {
  set: AgentMemoryConfig;
  clear: string[];
} {
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) clear.push(k);
    else if (v !== undefined) set[k] = v;
  }
  return { set: set as AgentMemoryConfig, clear };
}

// Drift guards: the stored type, this schema and the contract DTO must name
// the same keys. A key added to one and not the others fails the build.
type SameKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
  ? true
  : false;
type Assert<T extends true> = T;
export type MemoryConfigSchemaInSync = Assert<SameKeys<Shape, AgentMemoryConfig>>;
export type MemoryConfigDtoInSync = Assert<SameKeys<AgentMemoryConfigDTO, AgentMemoryConfig>>;
