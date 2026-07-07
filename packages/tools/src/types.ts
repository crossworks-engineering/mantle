/**
 * Tool-side types. The DB row shape lives in `@mantle/db` (`tools` table);
 * this file is the runtime contract every handler implements.
 */

export type ToolHandlerContext = {
  /** The owner running this tool. Every handler scopes its work to one owner. */
  ownerId: string;
  /** Optional trace step handle — the runtime opens a step around the call;
   *  handlers can enrich its meta/output and attribute LLM cost via this.
   *  `addTokens`/`addCost` let a handler that itself calls an LLM (e.g.
   *  `web_search` → Perplexity Sonar) roll that spend into the active trace,
   *  so /debug "spend by agent" stays accurate. Shape is a superset of
   *  `@mantle/tracing`'s `LlmUsageSink`, so `captureLlmUsage(ctx.step, …)`
   *  accepts it directly. */
  step?: {
    setMeta(m: Record<string, unknown>): void;
    setOutput(o: Record<string, unknown>): void;
    addTokens(delta: { input?: number; output?: number; cacheRead?: number }): void;
    addCost(microUsd: number): void;
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
    /** The parent turn's resolved (pre-clamp) thinking budget, so a delegated
     *  specialist inherits the operator's per-user thinking preference. The
     *  child re-clamps it against its OWN max_tokens. Unset/0 ⇒ no thinking. */
    thinkingBudget?: number;
  };
  /** Which surface this turn is running on. Populated by the agent
   *  runtime so worker-delegation tools can target the right channel
   *  — e.g. synthesize_speech needs to know the Telegram chat id to
   *  send the voice note to. Tools that don't care leave this
   *  undefined and ignore it.
   *
   *  kind='telegram': turn came from a Telegram inbound message.
   *    telegramChatId is the chat to send back to;
   *    replyToTelegramMessageId is set when threading is appropriate.
   *  kind='web':      turn came from /assistant. No outbound channel
   *    other than the assistant's own reply stream — voice/file send
   *    tools should refuse with a clear "web surface only" message.
   *  Undefined:       background/cron path (reflector, extractor).
   *    Worker-delegation tools should refuse here too — there's no
   *    user on the other end to send anything to. */
  surface?:
    | {
        kind: 'telegram';
        telegramChatId: string;
        /** When set, voice/text replies thread under this Telegram
         *  message_id. Optional because a tool-initiated send might
         *  not have a natural parent message. */
        replyToTelegramMessageId?: string;
      }
    | { kind: 'web' }
    | {
        /** Turn came from the external Team Chat surface (/team or
         *  /api/team/*) — the caller is a team-member CONTACT, not the
         *  owner. `team_request_create` reads its provenance from here
         *  (never from model args, which an injected prompt could forge);
         *  owner-only and send tools must refuse on this surface. */
        kind: 'team';
        contactId: string;
        contactName?: string;
        /** The inbound team_messages row that started this turn — stamped
         *  into a request task so the specialist can jump to the ask. */
        inboundMessageId?: string;
      };
};

/** A sidecar artifact a tool produces alongside its JSON output —
 *  audio bytes from synthesize_speech, an image from generate_image,
 *  etc. The LLM's tool-result message stays clean (just the JSON);
 *  the runtime collects artifacts separately and hands them back to
 *  the calling surface (the web /assistant renders them inline; the
 *  Telegram path uses them via its own sendVoice/sendPhoto calls
 *  rather than artifacts).
 *
 *  Why split from `output`: the LLM should reason about what
 *  happened ("I sent a voice note") without burning prompt budget
 *  on tens of KB of base64. The output JSON keeps the metadata; the
 *  artifact carries the bytes. */
export type ToolArtifact = {
  /** The kind of media. Drives client-side rendering choice. */
  kind: 'audio' | 'image';
  /** MIME, e.g. 'audio/ogg', 'image/png'. */
  mimeType: string;
  /** Base64-encoded bytes. Sized for inline embedding in JSON
   *  responses — for very large blobs we'd switch to a URL/nodeId
   *  reference but the current voice/image-gen sizes are fine
   *  (audio ≤ 300KB, images ≤ 2MB). */
  base64: string;
  /** Optional persisted node id when the artifact is also stored
   *  (e.g. generate_image saves to /files/generated-images and
   *  returns the node id so the client can deep-link). */
  nodeId?: string;
  /** Optional human-readable caption — the prompt for image gen,
   *  the text spoken for TTS. Surfaced in the UI as a hover/aria
   *  label. */
  caption?: string;
  /** Which tool produced this — useful for debugging + UI grouping. */
  producedBy: string;
};

export type ToolHandlerResult =
  | {
      ok: true;
      output: unknown;
      artifacts?: ToolArtifact[];
      /** Set by the dispatch layer when the output embeds THIRD-PARTY
       *  authored content (http tools hit arbitrary endpoints; a recipe may
       *  run an http/web step mid-chain). The tool-loop fences flagged
       *  results as data before the model reads them. Builtins never set
       *  this themselves — the web builtins are fenced by slug, and
       *  provenance for composed tools is dispatch's call, not the
       *  handler's. */
      untrusted?: boolean;
    }
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
