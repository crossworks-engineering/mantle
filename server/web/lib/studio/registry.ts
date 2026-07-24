/**
 * The prose registry — the single declarative list of every owner-editable field
 * that holds *human-written instructions to an AI*.
 *
 * Governing principle of Agent Studio: NO hidden prompts. Wherever a human gives
 * an AI instructions in prose, it must be visible + editable here. This registry
 * makes that provable: the Studio reads from it, so a new instruction field can't
 * silently escape the prose layer — you add it here and it's in scope.
 *
 * Phase 1 reads this to label the read-only prose it surfaces. Phase 2's
 * `prompt_versions` table is keyed by `(entityType, field)` straight from these
 * entries, so versioning auto-covers anything listed here.
 *
 * NOT in the registry: `*.description` columns (tool/skill/agent/heartbeat) —
 * those are catalog metadata (labels), not instructions to a model.
 *
 * See docs/agent-studio.md.
 */

export type ProseEntityType = 'agent' | 'skill' | 'worker';

export type ProseField = {
  entityType: ProseEntityType;
  /** The column / config key holding the prose. */
  field: string;
  /** Human label for the Studio UI. */
  label: string;
  /** One-line note on what this prose drives. */
  note: string;
  /** Free-text blob (versioned as one body) vs a structured value (e.g. the
   *  jsonb persona-notes array) that needs its own editor + per-item versioning. */
  shape: 'text' | 'structured';
};

export const PROSE_REGISTRY: readonly ProseField[] = [
  {
    entityType: 'agent',
    field: 'system_prompt',
    label: 'System prompt',
    note: 'The agent’s persona / instructions — the base of every turn’s prompt.',
    shape: 'text',
  },
  {
    entityType: 'skill',
    field: 'instructions',
    label: 'Skill instructions',
    note: 'Reusable behaviour, composed into the prompt of every agent that attaches it.',
    shape: 'text',
  },
  {
    entityType: 'worker',
    field: 'system_prompt',
    label: 'Worker system prompt',
    note: 'Instructions for a chat-shaped worker (extractor / summarizer / reflector / document).',
    shape: 'text',
  },
  {
    entityType: 'worker',
    field: 'extraction_prompt',
    label: 'Extraction prompt',
    note: 'The vision / document transcription instructions (worker config).',
    shape: 'text',
  },
  {
    entityType: 'agent',
    field: 'persona_notes',
    label: 'Persona notes',
    note: 'Human style / relationship calibrations the agent carries — structured, its own editor.',
    shape: 'structured',
  },
];

/** The text-blob prose fields for an entity type (what Phase 2 versions as a body). */
export function textProseFields(entityType: ProseEntityType): ProseField[] {
  return PROSE_REGISTRY.filter((p) => p.entityType === entityType && p.shape === 'text');
}
