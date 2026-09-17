/**
 * Mantle MCP server builder — the single source of truth for the MCP tool
 * surface, shared by BOTH transports:
 *   - the stdio entry (`server/mcp/src/server.ts`), spawned by Claude Desktop /
 *     Code over JSON-RPC on a trusted local machine;
 *   - the remote HTTP endpoint (`server/web/app/api/mcp/route.ts`), reached as a
 *     claude.ai custom connector behind OAuth.
 *
 * `registerMantleTools(server, ownerId, opts)` registers every tool onto a given
 * `McpServer`, scoped to `ownerId`; `buildMantleMcpServer(ownerId)` creates a
 * fresh server and registers them. The owner is a TRUSTED input here — each
 * transport authenticates and resolves it (stdio: the single local owner; HTTP:
 * the OAuth bearer) BEFORE calling in.
 *
 * FULL PARITY is the rule: every tool an in-brain agent can be granted is on
 * this surface. A desktop client is not a lesser citizen than an agent running
 * inside the brain — it is the owner, authenticated, driving their own data.
 * The surface used to be a hand-picked subset, and every gap read to the client
 * as a missing capability it could not even name (the CLI sandboxes were
 * enabled on a box and the client still reported it had no such tool).
 *
 * ONE tool is transport-dependent: `run_terminal` runs a shell in the brain's
 * OWN container — postgres, minio, the file store, the master key. Over stdio
 * that is no escalation at all (spawning the process already grants the owner's
 * full data access on a machine you control), so it ships. Over HTTP the
 * surface is reachable from the network and a stolen OAuth token would become a
 * root shell on the box, so it is OFF unless the operator sets
 * MANTLE_MCP_TERMINAL=1. `sandbox_exec` — the contained shell, in a container
 * with no route to any of that — is unconditional on both.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {} from '@mantle/files';
import {
  CONTACT_TOOLS,
  WORKER_DELEGATION_TOOLS,
  EXPORT_TOOLS,
  SHEET_TOOLS,
  DRAW_TOOLS,
  APP_TOOLS,
  TOOLSMITH_TOOLS,
  NOTE_TOOLS,
  TASK_TOOLS,
  EVENT_TOOLS,
  JOURNAL_TOOLS,
  PEER_TOOLS,
  EMAIL_TOOLS,
  RECALL_TOOLS,
  SANDBOX_TOOLS,
  NODE_READ_TOOLS,
  SEARCH_TOOLS,
  ENTITY_TOOLS,
  FILE_TOOLS,
  TELEGRAM_TOOLS,
  TELEGRAM_OPERATOR_TOOLS,
  NOTE_OPERATOR_TOOLS,
  PENDING_TOOLS,
  WORKER_GROUP_TOOLS,
  FILE_CREATE_TOOLS,
  CONTENT_CURATION_TOOLS,
  INGEST_TOOLS,
  SECRET_TOOLS,
  DELEGATION_TOOLS,
  CALCULATE_TOOLS,
  FORMULA_TOOLS,
  APP_DATA_TOOLS,
  REPLAY_TOOLS,
  IMAGE_TOOLS,
  TEAM_TOOLS,
  RESEARCH_TOOLS,
  CURATION_TOOLS,
  CRAWL_TOOLS,
  VIDEO_TOOLS,
  LOCATION_TOOLS,
  PERSONA_TOOLS,
  PROFILE_TOOLS,
  SHARE_TOOLS,
  RUN_TOOLS,
  TOOL_RESULT_TOOLS,
  EVAL_TOOLS,
  TERMINAL_TOOLS,
} from '@mantle/tools';
import {} from '@mantle/content';
import { env } from '@mantle/config';
import { makeRegisterContext } from './register/context';
import { registerSearchTools } from './register/search';
import { registerFileTools } from './register/files';
import { registerPageTools } from './register/pages';
import { registerTableTools } from './register/tables';
import { registerResponderTools } from './register/responder';

/** Mutating Toolsmith tools — gated behind MANTLE_MCP_TOOLSMITH_WRITE (default
 *  ON). Module-scope (env is process-stable) so the gate is evaluated once, not
 *  per build — for the HTTP transport a server is built per request. */
const TOOLSMITH_WRITE_SLUGS = new Set([
  'api_tool_create',
  'api_tool_update',
  'api_tool_delete',
  'recipe_tool_create',
  'tool_group_ensure',
  'agent_grant_tool_group',
  // Integration-group writes: api_docs_set writes a file node + the group's docs
  // pointer, api_skill_set writes a skills row every granted agent then reads.
  // (api_docs_get is a read — always exposed.)
  'api_docs_set',
  'api_skill_set',
]);
const toolsmithWriteEnabled = !/^(0|false|off|no)$/i.test(env('MANTLE_MCP_TOOLSMITH_WRITE') ?? '');
if (!toolsmithWriteEnabled) {
  console.error(
    '[mantle-mcp] MANTLE_MCP_TOOLSMITH_WRITE is off — exposing Toolsmith read-only ' +
      `(skipping ${[...TOOLSMITH_WRITE_SLUGS].join(', ')}).`,
  );
}

/** Which transport is registering. Only `run_terminal` reads it (see the file
 *  header); everything else is identical on both. */
export type MantleMcpTransport = 'stdio' | 'http';

/** Register every Mantle MCP tool onto `server`, scoped to `ownerId`. Both the
 *  stdio entry and the HTTP route call this; `ownerId` is already authenticated
 *  by the caller. `transport` defaults to the SAFER of the two: a caller that
 *  forgets to say gets the network posture, never the trusted-local one. */
export function registerMantleTools(
  server: McpServer,
  ownerId: string,
  opts: { transport?: MantleMcpTransport } = {},
): void {
  const transport = opts.transport ?? 'http';
  const ctx = makeRegisterContext(server, ownerId, transport);
  const { exposeTerminal, registerBuiltinTools } = ctx;

  registerSearchTools(ctx);
  registerFileTools(ctx);

  // ─── owner-operator surface: approvals, panels, the Telegram inbox ────────
  // Bridged from `mcpOnly` builtins since tier 3 of the 2026-09-02 audit; they
  // were hand-written here until then, which made them the one part of the
  // surface with no in-repo test and no shared implementation. `mcpOnly` keeps
  // the exposure identical: registered here, never seeded, never grantable —
  // an agent that could call `pending_approve` would approve its own gated
  // call, which is the gate these rows exist to impose.
  registerBuiltinTools(PENDING_TOOLS);
  registerBuiltinTools(WORKER_GROUP_TOOLS);
  registerBuiltinTools(TELEGRAM_OPERATOR_TOOLS);

  // ─── Notes / Tasks / Events / Journal / Email / Peers ──────────────────────
  //
  // Content surfaces the assistant can drive. Notes, tasks, events and journal
  // entries are all jsonb on `nodes` (no dedicated tables) and all flow through
  // the extractor for summary + embedding, so semantic search ("what notes do I
  // have about X?") works without explicit indexing here. The journal is the
  // owner's first-person self-knowledge, which feeds the always-on "who you
  // are" context injected into every agent turn — so logging from an MCP client
  // teaches the in-app assistant who the user is.
  //
  // Bridged from the in-app groups rather than hand-wired, so both surfaces run
  // one implementation. That is what gets MCP the things the hand-written
  // twins had drifted away from: ingest provenance on create (the node's
  // biography says an agent made it, instead of "appeared from nowhere"),
  // permalinks and teaching errors on read, and `isError` actually set on a
  // failure rather than a bare "not found" the client reads as success.
  //
  // These groups were once restricted with `only` to the slugs MCP already had,
  // so that bridging stayed a deduplication rather than a widening. The widening
  // has since been made deliberately (see "Full parity" above), so the whole
  // group goes out: note_from_file / note_from_page here, peer_search_chunks and
  // email_send / email_page below.
  registerBuiltinTools(NOTE_TOOLS);
  registerBuiltinTools(NOTE_OPERATOR_TOOLS);
  registerBuiltinTools(TASK_TOOLS);
  registerBuiltinTools(EVENT_TOOLS);

  // ─── Recall — the memory-map system (docs/recall.md) ─────────────────────
  // The tier-1 hook for external agents: these four read-only tools plus the
  // server instructions (MANTLE_MCP_INSTRUCTIONS) are the only surfaces an
  // MCP client auto-loads, so their descriptions carry the "enter the map /
  // match your task" nudge. Serving rows are compiled at page commit; every
  // read here is one indexed row.
  registerBuiltinTools(RECALL_TOOLS);
  registerBuiltinTools(JOURNAL_TOOLS);
  registerBuiltinTools(PEER_TOOLS);
  // Outbound email included: email_send is gated by the contacts allowlist the
  // same way it is for the responder, so the allowlist stays the boundary on
  // every surface rather than the surface being its own second boundary.
  registerBuiltinTools(EMAIL_TOOLS);

  // The one exception: there is no note_delete builtin — the in-app agent
  // cannot delete notes — so MCP's own registration is not a duplicate and
  // stays hand-written.
  registerPageTools(ctx);

  // ─── Draw (read-only) ──────────────────────────────────────────────────────
  // Whiteboard scenes (type='draw'). Read-only over MCP — drawings are
  // authored on the canvas; agents read the committed scene as text (frame
  // headings, shape labels, `A -> B: label` relations). Bridged from the
  // in-app DRAW_TOOLS: same tested handlers, plaintext read shape.
  registerBuiltinTools(DRAW_TOOLS);
  registerTableTools(ctx);

  // ── Federation: query other people's Mantles for data they've shared ─────────

  // ─── Contacts ────────────────────────────────────────────────────────────────
  // The email allowlist (nodes of type='contact'). Exposing these closes the gap
  // where an MCP client could read the brain but not extend the assistant's reach:
  // contact_create is what lets email_send target a new recipient (and kicks off
  // the 90-day inbound history backfill). Bridged from the in-app CONTACT_TOOLS so
  // both surfaces share one tested handler (incl. the enqueueBackfills side effect).
  registerBuiltinTools(CONTACT_TOOLS);

  // ─── Workers (modality delegation) ───────────────────────────────────────────
  // extract_from_image / summarize_text / generate_image run headless: they read
  // from the file store or take inline text and return text (or, for image gen, a
  // file node whose id is in the output — the base64 artifact is dropped over MCP
  // but the saved /files node is retrievable via file_read). synthesize_speech is
  // omitted: it structurally needs a live delivery surface (Telegram chat / web
  // reply stream) the MCP bridge can't supply, so it would only ever error here.
  registerBuiltinTools(WORKER_DELEGATION_TOOLS, {
    skip: (def) => def.slug === 'synthesize_speech',
  });
  registerResponderTools(ctx);

  // ─── Export (Word / Excel) ───────────────────────────────────────────────────
  // Renders a page/note → .docx or a table → .xlsx into /files/exports and returns
  // the new file's id/path. Pure (no surface, no artifact) — bridges as-is.
  registerBuiltinTools(EXPORT_TOOLS);

  // ─── Spreadsheet authoring ───────────────────────────────────────────────────
  // `sheet_build` composes a formatted .xlsx from data the client already holds
  // and saves it under /files. Belongs on this surface for the same reason
  // `export_node` does: an MCP client is often the one holding the numbers (a
  // Claude Desktop session working through a costing) and wants a file back.
  // Pure — writes one file node, no surface, no artifact.
  registerBuiltinTools(SHEET_TOOLS);

  // ─── Apps (mini-app builder) ──────────────────────────────────────────────────
  // Author Mantle mini-apps end-to-end from an MCP client: create, write the TSX
  // source tree (app_file_write per file or app_source_set for the whole tree at
  // once), declare the data tools the app may broker (app_tools_set) + per-app
  // SQLite schema (app_db_schema_set), compile server-side via esbuild (app_build
  // returns file/line/column diagnostics to iterate on), preview, and publish.
  // The app reaches owner data only through its declared tool allowlist — pair
  // this with the Toolsmith tools below to mint the data-access tools an app needs.
  registerBuiltinTools(APP_TOOLS);

  // ─── CLI sandboxes ────────────────────────────────────────────────────────────
  // Isolated Ubuntu containers the client can work in: clone a repo and explain
  // it, evaluate a package, build and run a small service. This is the ONE place
  // an MCP client gets command execution, and it is deliberately the contained
  // one: `run_terminal` (the brain's own shell) stays off this surface, while
  // `sandbox_exec` runs inside a container on an egress-only network with no
  // route to postgres, minio or the web tier (docs/sandboxes.md).
  //
  // Bridged unconditionally, exactly as the in-app coder agent holds them: the
  // handlers already answer "sandboxes are not enabled on this box" when the
  // `sandboxes` compose profile is off, so a box without sandboxd gives the
  // client a clear reason instead of a missing tool it cannot ask about.
  registerBuiltinTools(SANDBOX_TOOLS);

  // ─── Full parity: the rest of the in-app catalog ─────────────────────────────
  // Everything below was agent-only until the parity rule above. Grouped by what
  // it does, with a note only where the exposure is worth a second thought.

  // Reads. node_read fetches any node by id (the typed getters cover one type
  // each); brain_capacity is the corpus-vs-split-policy self-check.
  registerBuiltinTools(NODE_READ_TOOLS);
  // 2026-09-02 (audit): the search / entity / file-read / telegram groups now
  // exist in @mantle/tools, so their MCP twins are bridged from the one tested
  // handler each. Deliberately still hand-written (read-shape divergence, or a schema MCP
  // clients already depend on): tree_list, file_get/file_read/file_rename (id
  // vs file_id), folder_describe/folder_rename (accept a path as well as an
  // id). `search_nodes` is skipped here because MCP registers it under its
  // shipped name `search` in register/search.ts — a REGISTRATION alias since
  // v0.232.171, not a second implementation: it runs this same def through
  // callBuiltin.
  registerBuiltinTools(SEARCH_TOOLS, {
    skip: (def) => def.slug === 'search_nodes' || def.slug === 'tree_list',
  });
  registerBuiltinTools(ENTITY_TOOLS);
  registerBuiltinTools(FILE_TOOLS, { only: new Set(['folder_list', 'file_list']) });
  registerBuiltinTools(TELEGRAM_TOOLS);
  registerBuiltinTools(TOOL_RESULT_TOOLS);
  registerBuiltinTools(IMAGE_TOOLS);
  registerBuiltinTools(APP_DATA_TOOLS);

  // Pure computation — no I/O, no spend.
  registerBuiltinTools(CALCULATE_TOOLS);
  registerBuiltinTools(FORMULA_TOOLS);

  // Files: create-from-text and resolve-a-folder-by-path, the two the
  // hand-written file surface never had.
  registerBuiltinTools(FILE_CREATE_TOOLS);

  // Content lifecycle. content_supersede down-weights, never deletes;
  // process_extraction spends model budget, which is the point of asking for it.
  registerBuiltinTools(CONTENT_CURATION_TOOLS);
  registerBuiltinTools(INGEST_TOOLS);

  // Replay reads the owner's OWN past conversations. Private, but the caller is
  // the authenticated owner — the same person those conversations belong to.
  registerBuiltinTools(REPLAY_TOOLS);

  // Owner-side Team Chat: read members, threads and the access log, and file a
  // member-to-member notification. This is the OWNER's view over the team
  // surface, never the team responder's own tools.
  registerBuiltinTools(TEAM_TOOLS);

  // Outbound and spend. web_search / video_ingest / web_map / web_crawl all
  // reach the open internet and bill the owner's keys, so they are real actions
  // rather than reads — exposed because a client asked to research something
  // should be able to, and refusing quietly is worse than spending on request.
  registerBuiltinTools(RESEARCH_TOOLS);
  registerBuiltinTools(VIDEO_TOOLS);
  registerBuiltinTools(CRAWL_TOOLS);
  registerBuiltinTools(LOCATION_TOOLS);

  // Owner state: persona calibration, timezone, stored credentials.
  registerBuiltinTools(PERSONA_TOOLS);
  registerBuiltinTools(PROFILE_TOOLS);
  registerBuiltinTools(SECRET_TOOLS);

  // node_share PUBLISHES outward (mints a public link). It is confirm-gated in
  // the in-app loop and keeps that gate here — the bridge runs the same def.
  registerBuiltinTools(SHARE_TOOLS);

  // Delegation + durable runs. invoke_agent hands work to an in-brain
  // specialist; the run tools plan and drive background queues (creation is
  // additionally gated by MANTLE_RUNS on the box, docs/runs.md).
  registerBuiltinTools(DELEGATION_TOOLS);
  registerBuiltinTools(RUN_TOOLS);

  // Model curation (OpenRouter reads + the curated pools) and the retrieval
  // eval. recall_eval embeds a query set, so it costs — advisory tools, none of
  // which change what any agent actually runs.
  registerBuiltinTools(CURATION_TOOLS);
  registerBuiltinTools(EVAL_TOOLS);

  // ─── The brain's own shell ────────────────────────────────────────────────────
  // The one transport-dependent tool on this surface. See the file header: over
  // stdio it grants nothing that spawning the process did not already grant;
  // over HTTP it turns a stolen bearer into a root shell on the box, so it needs
  // MANTLE_MCP_TERMINAL=1. `sandbox_exec` above is the contained alternative and
  // is always available.
  if (exposeTerminal) registerBuiltinTools(TERMINAL_TOOLS);

  /* ───────────────────────── Toolsmith over MCP ──────────────────────────
   *
   * The api_tool_* / tool_group_* / agent_* / web_fetch / api_key_refs set
   * lets an MCP client (Claude Code, Claude Desktop) author, test, group,
   * and grant templated HTTP API tools — the same capability the in-app
   * Toolsmith agent has, on the user's own Claude subscription instead of
   * Mantle's metered API key. "Read these Mapbox docs and build me the
   * tool set" works end-to-end from Claude Code.
   *
   * Registered straight from TOOLSMITH_TOOLS (single source of truth) via
   * a JSON-Schema→zod shape bridge, so the two surfaces cannot drift. The
   * handlers run with the MCP process's ownerId — same trust model as
   * every other tool in this file.
   *
   * Scoping: the read-only set (list/get/test/api_key_refs/api_docs_get/
   * web_fetch) is always exposed. The mutating set — authoring
   * (create/update/delete), grouping (tool_group_ensure), the integration
   * writes (api_docs_set / api_skill_set), and granting
   * (agent_grant_tool_group) — is gated on MANTLE_MCP_TOOLSMITH_WRITE,
   * which defaults ON. Set it to
   * 0/false/off on a shared or headless deployment to expose Toolsmith
   * read-only while keeping tool authoring + granting to the in-app agent.
   */
  // ─── Toolsmith ───────────────────────────────────────────────────────────────
  // Writes gated behind MANTLE_MCP_TOOLSMITH_WRITE (see TOOLSMITH_WRITE_SLUGS).
  registerBuiltinTools(TOOLSMITH_TOOLS, {
    skip: (def) => !toolsmithWriteEnabled && TOOLSMITH_WRITE_SLUGS.has(def.slug),
  });
}

/** What every connecting MCP client auto-loads alongside the tool list — the
 *  ONLY automatic surface the protocol gives a server, so it carries Recall's
 *  tier-1 hook (docs/recall.md §"Automatic, honestly bounded"). Static by
 *  design: the live catalog is one cheap `recall_index` call away, and a
 *  static string can never go stale against it. */
export const MANTLE_MCP_INSTRUCTIONS = [
  'This brain carries Recall: owner-authored memory maps and prompts for agents.',
  'Before starting a distinct task, call recall_match with one line describing it and apply a strong match.',
  'When working in a domain the owner has mapped, recall_index lists the maps — recall_open the relevant one and follow its options instead of searching blind.',
  "Pass intent= on recall_* calls (one line on why you came) so the owner's recall log can show it.",
].join(' ');

/** Create a fresh `McpServer` with the full Mantle tool surface, scoped to
 *  `ownerId`. This is the STDIO entry's builder — no port, no token, spawned by
 *  a client on a machine the owner controls — so it registers the stdio
 *  posture. The HTTP route registers onto the adapter-provided server via
 *  `registerMantleTools` with `transport: 'http'`. */
export function buildMantleMcpServer(ownerId: string): McpServer {
  const server = new McpServer(
    { name: 'mantle', version: '0.0.1' },
    { instructions: MANTLE_MCP_INSTRUCTIONS },
  );
  registerMantleTools(server, ownerId, { transport: 'stdio' });
  return server;
}
