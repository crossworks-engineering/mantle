/**
 * Tool-side types. The DB row shape lives in `@mantle/db` (`tools` table);
 * this file is the runtime contract every handler implements.
 */

import type { LoginRole } from '@mantle/client-types/role-names';
import type { TurnTaint } from './client-sourced';
import type { ToolCaller } from './gate-callers';
import type { ToolPolicy } from './tool-policy';

export type ToolHandlerContext = {
  /** The owner running this tool. Every handler scopes its work to one owner. */
  ownerId: string;
  /** Who calls the tool, by its entry (gate-callers.ts): an assistant
   *  turn, a run item, a pending approval, the owner MCP surface, a /api/v1
   *  route, an app tool broker, the dev console. dispatchTool runs every call
   *  through the one gate (@mantle/db enterCall), and a nested call (a recipe's
   *  step, a tool a handler dispatches) passes it on. Absent: the caller of the
   *  dispatch the code runs in, if any; a call with none is refused. */
  caller?: ToolCaller;
  /** Optional trace step handle — the runtime opens a step around the call;
   *  handlers can enrich its meta/output. A handler that calls a provider
   *  records nothing by hand: the adapter registry records the call's spend
   *  on the trace and step in context (docs/spend-recording.md). */
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
     *  Capped by MAX_AGENT_DEPTH in invoke-agent-guards.ts (3 only along a
     *  declared edge to a terminal specialist — MAX_TERMINAL_EDGE_DEPTH). */
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
    /** The turn's client-sourced taint, shared by reference: invoke_agent
     *  hands it to the child, so a child that reads client-written text holds
     *  the parent back too, and a tainted parent's child cannot lower anything
     *  on its own either. */
    taint?: TurnTaint;
    /** The turn's latest USER message (text parts joined). invoke_agent
     *  attaches it to the child prompt as ground-truth intent — the one-shot
     *  hand-off's main miscommunication gap is a parent under-packing the
     *  prompt, and the child never sees the conversation. Absent for
     *  background callers with no user turn. */
    lastUserMessage?: string;
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
        /** The login the chat is paired to (telegram_chats.login_id):
         *  set by the runtime from the chat row, never from
         *  model arguments. The turn answers it; outbound sends reach only
         *  its own chats. Absent on a path that names none (a run resumed
         *  into its origin chat, a heartbeat's surface). */
        loginId?: string;
        /** The bot account the chat belongs to (telegram_chats.account_id):
         *  set by the runtime from the chat row, so a
         *  tool sends through the chat's own bot, never the first enabled
         *  one. Absent on a path that names none. */
        accountId?: string;
        /** When set, voice/text replies thread under this Telegram
         *  message_id. Optional because a tool-initiated send might
         *  not have a natural parent message. */
        replyToTelegramMessageId?: string;
      }
    | {
        kind: 'web';
        /** The signed-in login the chat turn serves: set by the server from
         *  the session, never from model arguments. Absent when the path
         *  names none. */
        loginId?: string;
      }
    | {
        /** A team member is on the other end, not the owner: a member
         *  login's chat turn (POST /api/member/chat) or app tool call.
         *  `team_request_create`
         *  reads its provenance from here (never from model args, which an
         *  injected prompt could forge); owner-only and send tools must
         *  refuse on this surface. */
        kind: 'team';
        /** The team-code contact of the retired portal and team links;
         *  nothing sets it now. Absent on a member LOGIN's turn: users are
         *  the team, and `loginId` names the member instead. */
        contactId?: string;
        /** A member login's turn (member logins): the login is the member. */
        loginId?: string;
        contactName?: string;
        /** The owner's `teamPrivateReads` switch, read when the turn starts.
         *  Absent = OFF: the read tools hide the private corpus (email,
         *  journal) as well as the always-hidden types. */
        privateReads?: boolean;
        /** The login's daily token budget left when the turn started (the
         *  member turn ledger, read by the runtime when the turn claimed a
         *  slot). Absent: no budget (an Admin user, the budget off). A
         *  workspace turn delegates only while enough is left
         *  (WORKSPACE_DELEGATION_TOKEN_FLOOR, less the turn's own tokens so
         *  far). Set by the runtime, never from model arguments. */
        tokensLeft?: number;
        /** The inbound team_messages row that started this turn — stamped
         *  into a request task so the specialist can jump to the ask. */
        inboundMessageId?: string;
        /** The member's own MCP connection. */
        mcp?: LoginMcpChannel;
        /** A workspace assistant's Telegram turn: the chat the turn
         *  came from, set by the runtime from the chat row, never from model
         *  arguments. Only run_plan reads it, to stamp the run's origin
         *  channel so the run's report goes back to that chat (delivered only
         *  while the chat is paired to the run's login). No send tool uses
         *  it: they refuse on a team surface. */
        originTelegramChatId?: string;
      }
    | {
        /** A CONTACT on a contact-share link (/s, past the code gate) runs a
         *  shared app that calls an outside tool with External access
         *  (external-access.ts). Only such tools are ever dispatched here:
         *  no built-in runs on a link. Never the owner. */
        kind: 'contact';
        contactId: string;
        shareId: string;
      }
    | {
        /** The OWNER, on a path that is not a chat channel: MCP, a run, a
         *  delegated child, an approved pending call, the dev tool console, an
         *  owner app. A missing surface is NOT the owner (see surface.ts):
         *  every owner path names itself with this, or with 'web' /
         *  'telegram'. */
        kind: 'owner';
        /** Which owner path (telemetry and the owner-regression sweep). */
        via: OwnerSurfaceVia;
        /** The login acting on this path: an MCP
         *  connection's login, an API key's login. Set by the server from
         *  the credential, never from model arguments. Absent when the path
         *  names none (stdio, a run, a pending approval). */
        loginId?: string;
        /** The login's own MCP connection (every login has this
         *  surface): how it connected and its Write switch, for the
         *  app_data_* tools. Set by the server, never from model arguments. */
        mcp?: LoginMcpChannel;
        /** An approved call that was asked on a connection that spends
         *  nothing on the brain owner's provider keys: the approval's own
         *  surface keeps that rule (ownerKeysOff). Set by the server from the
         *  row's stamp, never from model arguments. */
        ownerKeysOff?: true;
      };
};

/**
 * A login's own MCP connection (every login has one): stamped by the login MCP
 * surface (packages/mcp-core/src/login-surface.ts) from the caller the route
 * resolved, never from model arguments. Absent on every other path (a chat
 * turn, an app run), so a tool that needs it (the app_data_* tools) runs only
 * on MCP.
 */
export type LoginMcpChannel = {
  /** How the bearer was issued. */
  via: 'oauth' | 'peer' | 'key';
  /** The login's role: what `:host_me_kind` says it is in
   *  an app, as the app's own broker does in the browser. Absent = member. */
  role?: LoginRole;
  /** The login's Write switch (and for a key or a peer, theirs too). */
  write: boolean;
  /** The API key, the peer, or the OAuth client of this connection: the
   *  audit trail names it. */
  keyId?: string;
  peerId?: string;
  oauthClientId?: string;
  /** The connection's login is outside an Admin scope: nothing on it
   *  spends on the brain owner's provider keys, so a listed tool with a paid
   *  step (search_chunks' passage scoring) runs its plain path. Stamped by the
   *  login surface, never from arguments. */
  ownerKeysOff?: boolean;
  /** The connection was restored for an approved call (pending-origin.ts):
   *  its Write is off whatever it was when the call was
   *  asked, so a tool that needs Write says the approval ran without it. */
  approval?: true;
};

/** The owner paths that carry an explicit owner surface. */
export type OwnerSurfaceVia =
  | 'mcp'
  | 'run'
  | 'delegate'
  | 'pending'
  | 'dev-tools'
  | 'app'
  | 'recipe-test'
  | 'federation'
  | 'heartbeat'
  // The public API (inbound API keys, 0232): a /api/v1 route that runs a
  // builtin, or an API key acting as the owner on /api/mcp.
  | 'api';

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
   *  (e.g. generate_image saves to /files/auto-filed/generated-images and
   *  returns the node id so the client can deep-link). */
  nodeId?: string;
  /** Optional human-readable caption — the prompt for image gen,
   *  the text spoken for TTS. Surfaced in the UI as a hover/aria
   *  label. */
  caption?: string;
  /** Which tool produced this — useful for debugging + UI grouping. */
  producedBy: string;
};

/** A picture for the MODEL that called the tool, not for the person (that
 *  is `ToolArtifact`). The agent tool loop shows it to a vision-capable model
 *  right after the call's result, and tells a text-only model it was left
 *  out; MCP returns it as an image content block next to the JSON. Never in
 *  `output`, which is text the model reads and traces keep. */
export type ToolModelImage = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64-encoded bytes. No caption: the picture rides in a user-role
   *  message, so nothing author-written travels with it. */
  base64: string;
};

export type ToolHandlerResult =
  | {
      ok: true;
      output: unknown;
      artifacts?: ToolArtifact[];
      modelImages?: ToolModelImage[];
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

/** A declarative requirement checked centrally BEFORE the handler runs
 *  (see preconditions.ts): the named input param must reference an existing
 *  node the owner holds — and of the given type when set. Produces uniform
 *  teaching errors (malformed id / missing / wrong node type); the
 *  handler's own checks remain as backstops. */
export type ToolPrecondition =
  | {
      kind: 'node_exists';
      /** Top-level input key holding the node id. Skipped when absent/empty. */
      param: string;
      /** Expected node type ('page', 'table', 'note', …). Unset ⇒ any node. */
      nodeType?: string;
      /** The node must sit at or under this root path ('files'): every kind's
       *  folders are branch rows, and a Files folder tool must not be handed
       *  another kind's. Unset ⇒ anywhere. */
      pathRoot?: string;
      /** Lookup tools quoted in the teaching error, e.g. 'page_list / search_nodes'. */
      lookup: string;
    }
  | {
      /** Every `media:` / `page:` / `mention:node:` reference inside a markdown
       *  body must name a real node of the right type. A dangling one renders
       *  as nothing, so without this the model gets no signal at all. */
      kind: 'markdown_refs';
      /** Top-level input key holding the markdown, or an array of op objects. */
      param: string;
      /** When `param` is an array, the key on each item holding the markdown
       *  (e.g. `ops[].markdown` for page_blocks_apply). */
      itemKey?: string;
    };

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
  /** Granted at boot to the conversational agents (responder, assistant)
   *  of its family's auto-grant list (CONTACT_, JOURNAL_ and
   *  FORMULA_AUTO_GRANT_SLUGS, read by the system manifest). Set on each
   *  tool by name, never inferred: a new
   *  tool of the family is not granted to every agent until it says so.
   *  Never on a delete. */
  autoGrant?: true;
  /** What the tool is, for every check that asks (tool-policy.ts):
   *  read or write, what it spends, its Admin step, what it creates, what
   *  it reaches outside the database. Required: a builtin with no policy
   *  does not build. */
  policy: ToolPolicy;
  /** SAFE FOR A READ-ONLY TURN: `policy.effect === 'read'`, read through
   *  this accessor (withPolicyFlags); never set it on a definition. Consumed
   *  by the `read_only` turn preset (see `isBuiltinReadOnly`), which is
   *  DEFAULT-DENY: a tool whose effect is not `read` is excluded, so a new
   *  write/egress builtin is locked out the day it ships.
   *
   *  A policy says `read` only when ALL of these hold:
   *    1. No write to the owner's data (no node/file/table/app row touched).
   *    2. Nothing leaves the box — no email, no Telegram, no arbitrary URL.
   *    3. No hand-off to something that could do either (`invoke_agent` is
   *       NOT read-only: the child runs its own, possibly writing, grants).
   *  If you are unsure, say `write`. Excluding a safe read costs a probe
   *  some reach; including an unsafe one sends real mail. */
  readonly readOnly?: true;
  /** Starts paid model work on a call: `policy.startsModelWork`, read
   *  through this accessor (withPolicyFlags); never set it on a definition.
   *  A chat, vision, speech, image or decider adapter, a web-search model,
   *  or a delegated agent turn (the local embedder does not count).
   *  Orthogonal to `readOnly`: a read can spend (extract_from_image reads an
   *  image through the vision model). A member's app never calls a spending
   *  tool (member-app-tools.ts), and spends-drift.test.ts fails until every
   *  builtin that calls one of those adapters carries it. */
  readonly spends?: true;
  /** Referential requirements checked centrally pre-dispatch — see
   *  {@link ToolPrecondition}. */
  preconditions?: readonly ToolPrecondition[];
  /** Registered in the builtin registry (one tested implementation, reachable
   *  through the normal dispatch path) but NOT offered to in-brain agents: it
   *  is never seeded into the `tools` table and never nameable by a manifest
   *  tool group, so no agent can be granted it. The MCP surface registers these
   *  explicitly by group — see build-server.ts.
   *
   *  Use it for owner-only operator surface. `pending_approve` is the clearest
   *  case: an agent that could approve its own queued call would defeat the
   *  very gate that queued it. */
  mcpOnly?: true;
  /** Runs only for the brain owner. dispatchTool refuses it with
   *  OWNER_ONLY_ERROR unless `isOwnerSurface` holds, before preconditions and
   *  the handler: a team, client or missing surface never reaches it. The
   *  handler keeps its own check too, because the MCP server calls
   *  `def.handler` directly. */
  ownerOnly?: true;
  /** With `ownerOnly`: a login's workspace turn runs it too (a team surface
   *  naming the login its turn scope answers: the login's web chat with a
   *  workspace assistant, its run, a delegated child of either). The
   *  turn's scope and the database decide what it may change, as on the
   *  login's own MCP connection. The app tools carry it (a user's agents
   *  may write what the user may, never more). */
  loginTurns?: true;
  /** Registered on the owner MCP surface only when the box opts in (not
   *  access policy: what the surface offers, build-server.ts). `toolsmithWrite`:
   *  the Toolsmith writes, unless MANTLE_MCP_TOOLSMITH_WRITE is off;
   *  `terminal`: the brain's own shell, over stdio, or over HTTP with
   *  MANTLE_MCP_TERMINAL on. */
  optIn?: 'toolsmithWrite' | 'terminal';
  /** How often the fleet calls it, coarse: round(log2(calls)) over 90 days
   *  on four brains. A tie-break prior of `tool_search`
   *  only (pseudo-usage 2^tier, selection/deferred.ts); never access.
   *  Unset: none. Refresh from traces when the tool set moves. */
  usageTier?: number;
  /** A heartbeat control tool (@mantle/runtime heartbeats/tools.ts; the one
   *  source for the lists that name them). `firing`: it changes
   *  the firing heartbeat, so a heartbeat turn in any scope is granted it
   *  and a responder turn on a surface with active heartbeats is offered
   *  it, in `responderOrder`; `every`: it reaches every heartbeat (an
   *  operator's tool), granted on a heartbeat turn outside a workspace
   *  scope or in the Admin assistant's. */
  heartbeat?: Readonly<{ reaches: 'firing'; responderOrder: number } | { reaches: 'every' }>;
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
  /** The artifact a successful write-style call touched (node id + title from
   *  the tool's own output), captured so the NEXT turn's history can say what
   *  this turn actually did: the reply prose alone often doesn't. Absent
   *  for reads and failures. */
  target?: { id: string; title?: string };
  /** The call's outcome carried third-party text (outcomeIsThirdParty):
   *  a reply written after it is marked. */
  untrusted?: true;
};
