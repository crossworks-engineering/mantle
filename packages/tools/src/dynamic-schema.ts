/**
 * Per-tool dynamic schema overrides — one mechanism for making a tool's
 * model-facing schema reflect CURRENT reality at toolset-assembly time
 * (enums of actually-valid values, limits that track config) instead of
 * restating reality in prose the model can ignore.
 *
 * A hook runs ONCE per turn when the loop assembles the chat `tools`
 * parameter — schemas stay frozen within a turn (prompt-cache friendly),
 * and a hook failure falls back to the static schema (never breaks the
 * turn). Register next to the tool's own definition; registration is a
 * module side effect, so anything loading the builtins barrel gets the
 * hooks too.
 *
 * First consumer: `invoke_agent` — after a hallucinated delegate slug once
 * ballooned a turn to 456K tokens (production incident, v0.82.2), the parent's
 * delegation allowlist is injected as a JSON-schema `enum`, making bad
 * slugs unrepresentable rather than merely discouraged. The runtime guards
 * in invoke-agent-guards stay as defence-in-depth for adapters that ignore
 * `enum`.
 */

export type DynamicSchemaContext = {
  ownerId: string;
  /** The calling agent's delegation allowlist, when the loop knows it. */
  delegateTo?: readonly string[];
};

/** What a hook may override. Null/undefined ⇒ keep the static schema. */
export type DynamicSchemaPatch = {
  description?: string;
  parameters?: Record<string, unknown>;
} | null;

export type DynamicSchemaFn = (
  current: { description: string; parameters: Record<string, unknown> },
  ctx: DynamicSchemaContext,
) => DynamicSchemaPatch | Promise<DynamicSchemaPatch>;

const DYNAMIC_SCHEMAS = new Map<string, DynamicSchemaFn>();

export function registerDynamicSchema(slug: string, fn: DynamicSchemaFn): void {
  DYNAMIC_SCHEMAS.set(slug, fn);
}

export function getDynamicSchema(slug: string): DynamicSchemaFn | null {
  return DYNAMIC_SCHEMAS.get(slug) ?? null;
}

/** Return a COPY of an `invoke_agent` parameter schema with `agent_slug`
 *  constrained to `slugs` (enum + the list spelled into its description).
 *  Copies rather than mutates — the builtin's `inputSchema` is a module
 *  singleton shared across every agent/turn. Exported for tests. */
export function withDelegateEnum(
  schema: Record<string, unknown>,
  slugs: readonly string[],
): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const agentSlug = (props.agent_slug as Record<string, unknown> | undefined) ?? {};
  const baseDesc = typeof agentSlug.description === 'string' ? `${agentSlug.description} ` : '';
  return {
    ...schema,
    properties: {
      ...props,
      agent_slug: {
        ...agentSlug,
        enum: [...slugs],
        description: `${baseDesc}Must be EXACTLY one of these slugs: ${slugs.join(', ')}. You cannot delegate to yourself — do that work directly.`,
      },
    },
  };
}

registerDynamicSchema('invoke_agent', (current, ctx) => {
  if (!ctx.delegateTo || ctx.delegateTo.length === 0) return null;
  return { parameters: withDelegateEnum(current.parameters, ctx.delegateTo) };
});
