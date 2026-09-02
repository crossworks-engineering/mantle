/**
 * Built-in tool handlers — wrappers around existing workspace functions so
 * the agent runtime can call them via the same dispatch path as user-defined
 * tools. Every entry maps 1:1 to a row that gets upserted into the `tools`
 * table on agent boot.
 *
 * Slug convention: snake_case, matching the MCP tool name where one exists,
 * so the same name surfaces to Claude Code and to in-app agents.
 */

import { type BuiltinToolDef } from './types';
import { WORKER_DELEGATION_TOOLS } from './builtins-workers';
import { VIDEO_TOOLS } from './builtins-video';
import { IMAGE_TOOLS } from './builtins-images';
import { EVENT_TOOLS } from './builtins-events';
import { PROFILE_TOOLS } from './builtins-profile';
import { TASK_TOOLS } from './builtins-tasks';
import { TEAM_TOOLS } from './builtins-team';
import { PERSONA_TOOLS } from './builtins-persona';
import { TERMINAL_TOOLS } from './builtins-terminal';
import { SANDBOX_TOOLS } from './builtins-sandbox';
import { RECALL_TOOLS } from './builtins-recall';
import { REPLAY_TOOLS } from './builtins-replay';
import { RESEARCH_TOOLS } from './builtins-research';
import { CRAWL_TOOLS } from './builtins-crawl';
import { CURATION_TOOLS } from './builtins-curation';
import { NOTE_TOOLS } from './builtins-notes';
import { EMAIL_TOOLS } from './builtins-email';
import { PAGE_TOOLS } from './builtins-pages';
import { DRAW_TOOLS } from './builtins-draws';
import { SHARE_TOOLS } from './builtins-share';
import { APP_TOOLS, APP_DATA_TOOLS } from './builtins-apps';
import { TABLE_TOOLS } from './builtins-tables';
import { TOOL_RESULT_TOOLS } from './builtins-tool-results';
import { CONTACT_TOOLS } from './builtins-contacts';
import { JOURNAL_TOOLS } from './builtins-journal';
import { FORMULA_TOOLS } from './builtins-formulas';
import { CALCULATE_TOOLS } from './builtins-calculate';
import { PEER_TOOLS } from './builtins-peers';
import { EVAL_TOOLS } from './builtins-eval';
import { RUN_TOOLS } from './builtins-runs';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import { LOCATION_TOOLS } from './builtins-locations';
import { EXPORT_TOOLS } from './builtins-export';
import { SHEET_TOOLS } from './builtins-sheets';
import { read_section, search_chunks, search_nodes, tree_list } from './builtins-search';
import {
  entity_facts,
  entity_mentions,
  entity_neighbors,
  entity_search,
  graph_path,
} from './builtins-entities';
import { brain_capacity, content_supersede, node_read, process_extraction } from './builtins-nodes';
import {
  file_copy,
  file_create,
  file_get,
  file_list,
  file_move,
  file_read,
  file_rename,
  file_set_indexing,
  folder_copy,
  folder_describe,
  folder_get_by_path,
  folder_list,
  folder_move,
  folder_rename,
  folder_set_indexing,
} from './builtins-files';
import { secret_create } from './builtins-secrets';
import { telegram_send } from './builtins-telegram';
import { TELEGRAM_OPERATOR_TOOLS } from './builtins-telegram';
import { PENDING_TOOLS, WORKER_GROUP_TOOLS } from './builtins-pending';
import { FILE_OPERATOR_TOOLS } from './builtins-files';
import { NOTE_OPERATOR_TOOLS } from './builtins-notes';
import { invoke_agent } from './builtins-delegation';

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  search_nodes,
  search_chunks,
  read_section,
  tree_list,
  entity_search,
  entity_neighbors,
  graph_path,
  entity_facts,
  entity_mentions,
  brain_capacity,
  folder_list,
  folder_get_by_path,
  file_list,
  file_get,
  file_read,
  node_read,
  content_supersede,
  secret_create,
  file_create,
  file_rename,
  folder_rename,
  folder_describe,
  file_set_indexing,
  folder_set_indexing,
  file_move,
  file_copy,
  folder_move,
  folder_copy,
  telegram_send,
  process_extraction,
  invoke_agent,
  // Worker-delegation tools live in builtins-workers.ts so they can
  // share helpers without bloating this file. Each one bridges
  // Saskia's agency to a configured ai_workers row — TTS, vision,
  // summarizer.
  ...WORKER_DELEGATION_TOOLS,
  // video_ingest — link (or stored video file) → audio clip + timestamped
  // transcript page, via the media sidecar (compose profile `media`).
  // Captions-first, STT fallback. Owner-only (`video-ingest` tool group).
  ...VIDEO_TOOLS,
  // Showing a stored image back to the user — the one image tool that turns
  // pixels into pixels rather than into words. The display half of the
  // extracted-document-images feature.
  ...IMAGE_TOOLS,
  // Event CRUD — mirrors the MCP event tools so Saskia can schedule
  // and manage calendar items from chat. None require_confirm by
  // operator choice; flip per-row in the tools table if you want
  // approval gates.
  ...EVENT_TOOLS,
  // Task CRUD — mirrors the MCP task tools so Saskia can capture and
  // manage tasks from chat. None require_confirm (trivially reversible).
  ...TASK_TOOLS,
  ...TEAM_TOOLS,
  // Persona self-edit — lets Saskia adjust her own style/relationship
  // notes when the user explicitly asks ("be more professional").
  // Scoped resolution + soft-retire; pure logic in @mantle/db.
  ...PERSONA_TOOLS,
  // Free-form terminal — UNRESTRICTED shell access for a power-user's
  // dedicated coder/ops agent (not for the untrusted-inbound responder).
  // See builtins-terminal.ts for the safety rationale.
  ...TERMINAL_TOOLS,
  // CLI sandboxes — isolated persistent containers for untrusted/project
  // work, run_terminal's contained sibling. See builtins-sandbox.ts.
  ...SANDBOX_TOOLS,
  // Recall — time-windowed replay of past conversations from the
  // permanent message archive. The toolset for the `remy` recall agent
  // (find_window locates via digests, replay_window pulls raw turns).
  ...RECALL_TOOLS,
  ...REPLAY_TOOLS,
  // Research — outward to the live internet via Perplexity Sonar. The
  // raw-search primitive for the `researcher` agent; the smart layer is
  // the agent that wraps it (plan → search → cross-check → synthesise).
  ...RESEARCH_TOOLS,
  // Crawl — whole-site ingestion via the Firecrawl CLOUD API (map = discover
  // URLs, crawl = fetch pages as markdown → documentation collection at
  // retrieval depth). Owner-only (`crawl` tool group); spends the operator's
  // Firecrawl credits, so never wired to a cron/trigger.
  ...CRAWL_TOOLS,
  // Model curation — OpenRouter Data API reads (rankings/benchmarks/task
  // classes/catalog) + the curated_models pool store behind /models/pools.
  // The Curator specialist's kit; advisory only, never touches live routing.
  ...CURATION_TOOLS,
  // Notes — persist a markdown note (auto-indexed into the brain). Lets
  // Saskia keep research findings she's decided are worth saving.
  ...NOTE_TOOLS,
  // Email — send mail from the user's own mailbox via provider SMTP. Pairs
  // with web_search/researcher ("research X and email it to me").
  ...EMAIL_TOOLS,
  // Pages — author rich documents (CRUD). Saskia writes the rich-markdown
  // dialect; markdownToDoc converts it to the ProseMirror JSON pages store.
  // page_delete is requires_confirm (irreversible).
  ...PAGE_TOOLS,
  // Draw — READ-ONLY access to the whiteboard workspace: list + read the
  // committed scene as text. Authoring stays on the canvas (Phase 6 is its
  // own decision; see docs/draw-plan.md).
  ...DRAW_TOOLS,
  // Generic sharing — mint/revoke a viewable link for ANY shareable item
  // (note/task/event/file/app/table/folder); the type-agnostic counterpart
  // of page_share. node_share is requires_confirm (publishes outward).
  ...SHARE_TOOLS,
  // Apps — Appsmith authors mini apps (TSX), builds them with esbuild, and
  // declares the api_tools/sqlite they use. app_delete + app_publish are the
  // admin subset; the broker enforces the per-app tool allowlist at runtime.
  ...APP_TOOLS,
  // App-data reads for the responder — query a mini app's SQLite (read-only).
  ...APP_DATA_TOOLS,
  // Tables — author + operate typed database grids (CRUD + row/column/cell
  // edits + totals + saved views). Stable row/column ids make "do row X" /
  // "total column Y" addressable; structural edits write to draft_data.
  ...TABLE_TOOLS,
  // read_result — dereference a spilled (oversized) tool result by handle:
  // page / grep / semantic query. The tool-loop always offers this so a
  // stored handle is never a dead end. Read-only.
  ...TOOL_RESULT_TOOLS,
  // Contacts — the index of people/orgs Saskia may email (and later SMS).
  // Contacts list IS the email allowlist; adding a contact extends reach.
  // Saskia adds/edits only when explicitly asked (tool descriptions emphasise).
  ...CONTACT_TOOLS,
  // Journal — the user's first-person self-knowledge (who they are, work,
  // family, feelings). Source of the always-on identity context. Saskia can
  // add/refine entries when the user shares something durable about themselves.
  ...JOURNAL_TOOLS,
  ...FORMULA_TOOLS,
  ...CALCULATE_TOOLS,
  // Federation — query other people's Mantles for data they've shared with
  // you. Outbound half of docs/federation.md; reads only what a peer granted.
  ...PEER_TOOLS,
  // Retrieval-quality self-check (recall_eval) — heartbeat-driven monitoring.
  ...EVAL_TOOLS,
  // Toolsmith — author/test/group/grant templated HTTP API tools (+ web_fetch
  // for reading API docs). Granted to the Toolsmith specialist; mirrored over
  // MCP so Claude Code can drive the same flow. http-only by design.
  ...TOOLSMITH_TOOLS,
  // Profile — adjust time-aware preferences (timezone) in-conversation, so a
  // travelling user's "Current time" stays right without a trip to Settings.
  ...PROFILE_TOOLS,
  // Locations — the local half of geo awareness: save a resolved place, find
  // saved places nearby (cache reader), haversine distance, and route_map (the
  // one that calls Mapbox — renders a route polyline to an inline PNG artifact).
  // Reverse-geocoding / search / directions are seeded Mapbox HTTP tools.
  ...LOCATION_TOOLS,
  // Export — render a page/note to Word (.docx) or a table to Excel (.xlsx) and
  // save it under /files/exports. Shares @mantle/content's resolveExport with
  // the web download button, so the assistant and the UI emit identical files.
  ...EXPORT_TOOLS,
  ...SHEET_TOOLS,
  // Runner queues — durable, inspectable execution plans (docs/runs.md).
  // Responder-only via the `runs` tool group; creation gated by MANTLE_RUNS.
  ...RUN_TOOLS,
  // Owner-only operator surface: the approval queue, the runner's worker
  // panels, and the Telegram inbox controls. Every def is `mcpOnly`, so these
  // are registered here (one implementation, one dispatch path) but never
  // seeded into `tools` and never nameable by a manifest group — no agent can
  // hold them. See BuiltinToolDef.mcpOnly.
  ...PENDING_TOOLS,
  ...WORKER_GROUP_TOOLS,
  ...TELEGRAM_OPERATOR_TOOLS,
  ...FILE_OPERATOR_TOOLS,
  ...NOTE_OPERATOR_TOOLS,
];

// P6: there is no flat "default assistant grant" anymore. A generalist persona's
// capability is the union of its granted tool GROUPS (the manifest persona's
// `toolGroupSlugs`; see server/web/lib/system-manifest/manifest.ts). The old
// DEFAULT_ASSISTANT_TOOL_SLUGS / ASSISTANT_TOOL_DENY pair was removed with the
// `agents.tool_slugs` column (migration 0083); the specialist/destructive split
// it encoded now lives in the group taxonomy (terminal / research / federation /
// replay-search groups + the `*-admin` delete groups).

// The group constants moved with their tools (2026-09-02 split); index.ts and
// mcp-core keep importing them from here.
export { SEARCH_TOOLS } from './builtins-search';
export { ENTITY_TOOLS } from './builtins-entities';
export { NODE_READ_TOOLS, CONTENT_CURATION_TOOLS, INGEST_TOOLS } from './builtins-nodes';
export { SECRET_TOOLS } from './builtins-secrets';
export {
  FILE_CREATE_TOOLS,
  FILE_MANAGE_TOOLS,
  FILE_OPERATOR_TOOLS,
  FILE_TOOLS,
} from './builtins-files';
export { TELEGRAM_TOOLS, TELEGRAM_OPERATOR_TOOLS } from './builtins-telegram';
export { PENDING_TOOLS, WORKER_GROUP_TOOLS } from './builtins-pending';
export { DELEGATION_TOOLS } from './builtins-delegation';
