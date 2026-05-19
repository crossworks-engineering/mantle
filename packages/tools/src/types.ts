/**
 * Tool-side types. The DB row shape lives in `@mantle/db` (`tools` table);
 * this file is the runtime contract every handler implements.
 */

export type ToolHandlerContext = {
  /** The owner running this tool. Every handler scopes its work to one owner. */
  ownerId: string;
  /** Optional trace step handle — the runtime opens a step around the call;
   *  handlers can enrich its meta via this. */
  step?: {
    setMeta(m: Record<string, unknown>): void;
    setOutput(o: Record<string, unknown>): void;
  };
  /** Parent-agent metadata. Populated by `runToolLoop` so handlers
   *  that need to reason about the calling agent can — currently only
   *  the `invoke_agent` builtin uses it, for depth + allowlist checks.
   *  Regular tools leave this undefined and ignore it. */
  agent?: {
    /** Stable agent slug, e.g. 'responder'. Used by invoke_agent to
     *  refuse self-calls. */
    slug: string;
    /** 1 for the entry-point agent; 2 for an invoked child; etc.
     *  Capped by MAX_AGENT_DEPTH in invoke-agent-guards.ts. */
    depth: number;
    /** Slugs the parent agent is allowed to delegate to. Sourced
     *  from `agents.memory_config.delegate_to`. Empty/missing means
     *  no delegation permitted (fail closed). */
    delegateTo: readonly string[];
    /** Parent trace id, threaded into the child trace for navigation. */
    parentTraceId?: string | null;
  };
};

export type ToolHandlerResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

/** A built-in handler: pure TS function. Lives in this package or in apps
 *  that import the registry to register their own. */
export type BuiltinToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolHandlerResult>;

/** A registered built-in: the handler + the definition the seed step
 *  upserts into the `tools` table. */
export type BuiltinToolDef = {
  /** Stable slug matching the `tools.slug` column (and the `handler.ref`). */
  slug: string;
  name: string;
  description: string;
  /** JSON Schema — sent verbatim to the model. */
  inputSchema: Record<string, unknown>;
  /** Whether the tool-call loop should pause for operator approval. */
  requiresConfirm?: boolean;
  /** Handler implementation. */
  handler: BuiltinToolHandler;
  /** Input fields that contain sensitive data and MUST be replaced with
   *  `'[REDACTED]'` before the call args are written to `trace_steps.input`
   *  or any other persisted log. Example: `secret_create` lists
   *  `['value']` so the plaintext secret never lands in the DB anywhere
   *  except the sealed `secrets` row. Field names are top-level keys of
   *  the input object; nested redaction is not currently supported. */
  redactInputFields?: readonly string[];
};

/** Shape the agent runtime exposes to the OpenRouter `tools` parameter.
 *  OpenAI / Anthropic / Gemini all accept this via the OpenRouter SDK. */
export type ToolForModel = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/** Per-turn execution telemetry the runtime aggregates. */
export type ToolCallRecord = {
  slug: string;
  argsJson: string;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  error?: string;
};
