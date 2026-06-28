/**
 * Built-in API catalog for the API Console — every REST route in
 * apps/web/app/api, grouped by resource. Hand-curated from the route
 * sources (zod schemas drive the body examples); when routes change,
 * update the matching entry here.
 *
 * Paths use `{param}` for dynamic segments — the console renders a chip
 * input per placeholder. URLs are prefixed with `{{baseUrl}}` at load
 * time so environment switching works.
 */

import type { CatalogEndpoint, CatalogGroup, HttpMethod, QueryParamDoc } from './types';

type E = {
  n: string; // name
  m: HttpMethod;
  p: string; // path
  d?: string; // description
  q?: QueryParamDoc[];
  b?: string | null; // body example
};

function group(id: string, name: string, description: string, entries: E[]): CatalogGroup {
  const endpoints: CatalogEndpoint[] = entries.map((e, i) => ({
    id: `api_${id}_${i}`,
    name: e.n,
    method: e.m,
    path: e.p,
    description: e.d,
    queryParams: e.q,
    bodyExample: e.b ?? null,
  }));
  return { id: `grp_${id}`, name, description, endpoints };
}

export const API_CATALOG: CatalogGroup[] = [
  group('auth', 'Auth', 'Session lifecycle — login, signup, password.', [
    { n: 'Login', m: 'POST', p: '/api/auth/login', d: 'Authenticate with email + password; sets the session cookie. Rate-limited 10/min per IP.', b: '{\n  "email": "user@example.com",\n  "password": "your-password"\n}' },
    { n: 'Logout', m: 'POST', p: '/api/auth/logout', d: 'Clears the session cookie.' },
    { n: 'Sign up', m: 'POST', p: '/api/auth/signup', d: 'First-run account creation — only works while no user exists (403 otherwise).', b: '{\n  "email": "user@example.com",\n  "password": "your-password"\n}' },
    { n: 'Change password', m: 'POST', p: '/api/auth/change-password', d: 'Verifies the old password first. Rate-limited 5/hour.', b: '{\n  "oldPassword": "current",\n  "newPassword": "next"\n}' },
  ]),

  group('assistant', 'Assistant', 'The web assistant chat surface.', [
    { n: 'Send message', m: 'POST', p: '/api/assistant/turn', d: 'Main inbound channel. JSON for text-only; multipart/form-data for text + image/file (≤100MB). Supports Idempotency-Key header.', b: '{\n  "text": "What is on my calendar today?",\n  "agentSlug": "assistant"\n}' },
    { n: 'Get earlier messages', m: 'GET', p: '/api/assistant/messages', d: 'Scroll-up lazy loading before a cursor.', q: [ { key: 'before', description: 'ISO timestamp cursor', required: true }, { key: 'limit', description: '1–200, default 100' }, { key: 'agent', description: 'agent slug to scope the thread' } ] },
    { n: 'Get current stage', m: 'GET', p: '/api/assistant/turn/stage', d: 'Live activity label ("Searching the web…"); {label: null} when idle.' },
    { n: 'Transcribe audio', m: 'POST', p: '/api/assistant/transcribe', d: 'Voice-to-text; multipart/form-data with an audio blob. 412 when no STT worker is configured.' },
  ]),

  group('agents', 'Agents', 'Agent registry — config, persona, Telegram binding.', [
    { n: 'List agents', m: 'GET', p: '/api/agents' },
    { n: 'Create agent', m: 'POST', p: '/api/agents', d: '409 if the slug exists. Slug: lowercase letters/digits/dash/underscore.', b: '{\n  "slug": "my-agent",\n  "name": "My Agent",\n  "description": "What this agent is for",\n  "role": "assistant",\n  "provider": "openrouter",\n  "model": "anthropic/claude-sonnet-4.6",\n  "systemPrompt": "You are a helpful assistant.",\n  "skillSlugs": [],\n  "toolGroupSlugs": [],\n  "params": { "temperature": 0.7 },\n  "enabled": true\n}' },
    { n: 'Update agent', m: 'PATCH', p: '/api/agents/{id}', d: 'All fields optional; 404 if not found.', b: '{\n  "name": "Renamed agent",\n  "enabled": true\n}' },
    { n: 'Delete agent', m: 'DELETE', p: '/api/agents/{id}' },
    { n: 'Manage persona notes', m: 'POST', p: '/api/agents/{id}/persona', d: 'Add/edit/retire/restore persona notes (style, relationship, correction). Soft-retire only.', b: '{\n  "action": "add",\n  "kind": "style",\n  "content": "Prefers concise replies"\n}' },
    { n: 'Get Telegram binding', m: 'GET', p: '/api/agents/{id}/telegram', d: 'Bot binding + paired chats for an agent.' },
    { n: 'Connect Telegram bot', m: 'POST', p: '/api/agents/{id}/telegram', d: '400 on invalid bot token.', b: '{\n  "token": "123456:bot-token-from-botfather"\n}' },
    { n: 'Disconnect Telegram bot', m: 'DELETE', p: '/api/agents/{id}/telegram' },
    { n: 'Approve/deny Telegram chat', m: 'POST', p: '/api/agents/{id}/telegram/chats', b: '{\n  "chatId": "550e8400-e29b-41d4-a716-446655440000",\n  "status": "allowed"\n}' },
    { n: 'Set chat responder', m: 'PATCH', p: '/api/telegram/chats/{id}', d: 'Override the responder agent for one Telegram chat.', b: '{\n  "responderAgentId": "550e8400-e29b-41d4-a716-446655440000"\n}' },
  ]),

  group('tools', 'Tools & groups', 'The agent tool registry and its grant groups.', [
    { n: 'List tools', m: 'GET', p: '/api/tools' },
    { n: 'Create tool', m: 'POST', p: '/api/tools', d: 'Register an http/shell tool. http handlers support {param} templating and {{secret:service/label}} vault refs.', b: '{\n  "slug": "find_route",\n  "name": "Find route",\n  "description": "Travel time between two places",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "origin": { "type": "string" }, "destination": { "type": "string" } },\n    "required": ["origin", "destination"]\n  },\n  "handler": {\n    "kind": "http",\n    "url": "https://api.example.com/route/{origin}/{destination}",\n    "method": "GET",\n    "query": { "access_token": "{{secret:mapbox/default}}" }\n  },\n  "enabled": true\n}' },
    { n: 'Get tool', m: 'GET', p: '/api/tools/{id}' },
    { n: 'Update tool', m: 'PATCH', p: '/api/tools/{id}', d: 'Built-ins only allow enabled/requiresConfirm changes.', b: '{\n  "description": "Updated description",\n  "enabled": true\n}' },
    { n: 'Delete tool', m: 'DELETE', p: '/api/tools/{id}', d: 'User-defined tools only — built-ins are code-backed.' },
    { n: 'List tool groups', m: 'GET', p: '/api/tool-groups', d: 'Includes backrefs showing which agents grant each group.' },
    { n: 'Create tool group', m: 'POST', p: '/api/tool-groups', b: '{\n  "slug": "external-apis",\n  "name": "External APIs",\n  "description": "Custom HTTP tools",\n  "toolSlugs": ["find_route"],\n  "enabled": true\n}' },
    { n: 'Get tool group', m: 'GET', p: '/api/tool-groups/{id}' },
    { n: 'Update tool group', m: 'PATCH', p: '/api/tool-groups/{id}', b: '{\n  "toolSlugs": ["find_route", "web_search"]\n}' },
    { n: 'Delete tool group', m: 'DELETE', p: '/api/tool-groups/{id}' },
  ]),

  group('skills', 'Skills', 'Reusable instruction packs granted to agents.', [
    { n: 'List skills', m: 'GET', p: '/api/skills' },
    { n: 'Create skill', m: 'POST', p: '/api/skills', b: '{\n  "slug": "daily-briefing",\n  "name": "Daily briefing",\n  "description": "How to compose the morning summary",\n  "instructions": "Each morning, summarize…",\n  "enabled": true\n}' },
    { n: 'Get skill', m: 'GET', p: '/api/skills/{id}' },
    { n: 'Update skill', m: 'PATCH', p: '/api/skills/{id}', b: '{\n  "instructions": "Updated instructions"\n}' },
    { n: 'Delete skill', m: 'DELETE', p: '/api/skills/{id}' },
  ]),

  group('pending', 'Pending approvals', 'Operator approval queue for requires-confirm tool calls.', [
    { n: 'List pending calls', m: 'GET', p: '/api/pending', q: [ { key: 'status', description: 'pending | approved | rejected | expired' }, { key: 'limit', description: '1–500' } ] },
    { n: 'Get pending call', m: 'GET', p: '/api/pending/{id}' },
    { n: 'Approve / reject call', m: 'PATCH', p: '/api/pending/{id}', b: '{\n  "decision": "approve"\n}' },
  ]),

  group('notes', 'Notes', '', [
    { n: 'List notes', m: 'GET', p: '/api/notes', q: [ { key: 'q', description: 'search filter' }, { key: 'tag' } ] },
    { n: 'Create note', m: 'POST', p: '/api/notes', b: '{\n  "title": "My note",\n  "content": "Note content",\n  "tags": ["work"]\n}' },
    { n: 'Get note', m: 'GET', p: '/api/notes/{id}' },
    { n: 'Update note', m: 'PATCH', p: '/api/notes/{id}', b: '{\n  "title": "Updated title"\n}' },
    { n: 'Delete note', m: 'DELETE', p: '/api/notes/{id}' },
  ]),

  group('pages', 'Pages', 'Rich documents with draft/commit lifecycle.', [
    { n: 'List pages', m: 'GET', p: '/api/pages', q: [ { key: 'q' }, { key: 'tag' } ] },
    { n: 'Create page', m: 'POST', p: '/api/pages', b: '{\n  "title": "My page",\n  "icon": "📄",\n  "tags": []\n}' },
    { n: 'Get page', m: 'GET', p: '/api/pages/{id}' },
    { n: 'Update page', m: 'PATCH', p: '/api/pages/{id}', d: 'reindex=false for the cheap autosave path.', b: '{\n  "title": "Updated title",\n  "tags": ["important"]\n}' },
    { n: 'Delete page', m: 'DELETE', p: '/api/pages/{id}', d: 'Cascades to nested pages.' },
    { n: 'Save draft', m: 'PUT', p: '/api/pages/{id}/draft', d: 'Autosave to draft_doc only — nothing is indexed until commit.', b: '{\n  "doc": { "type": "doc", "content": [] }\n}' },
    { n: 'Commit draft', m: 'POST', p: '/api/pages/{id}/commit', d: 'Publish + index — the only moment page content reaches the brain.', b: '{\n  "doc": { "type": "doc", "content": [] }\n}' },
    { n: 'Discard draft', m: 'POST', p: '/api/pages/{id}/discard-draft', d: 'Idempotent.' },
    { n: 'AI assist', m: 'POST', p: '/api/pages/{id}/ai-assist', d: 'Run the Pages agent against this page; writes land in the draft.', b: '{\n  "prompt": "Tighten the introduction"\n}' },
    { n: 'Count descendants', m: 'GET', p: '/api/pages/{id}/descendant-count', d: 'Pre-delete check for the subtree warning.' },
  ]),

  group('tables', 'Tables', 'Structured grids with draft/commit lifecycle.', [
    { n: 'List tables', m: 'GET', p: '/api/tables', q: [ { key: 'q' }, { key: 'tag' } ] },
    { n: 'Create table', m: 'POST', p: '/api/tables', b: '{\n  "title": "My table",\n  "tags": []\n}' },
    { n: 'Get table', m: 'GET', p: '/api/tables/{id}' },
    { n: 'Update table', m: 'PATCH', p: '/api/tables/{id}', b: '{\n  "title": "Renamed table"\n}' },
    { n: 'Delete table', m: 'DELETE', p: '/api/tables/{id}' },
    { n: 'Autosave draft', m: 'PUT', p: '/api/tables/{id}/draft', b: '{\n  "data": { "columns": [], "rows": [] }\n}' },
    { n: 'Commit table', m: 'POST', p: '/api/tables/{id}/commit', b: '{\n  "data": { "columns": [], "rows": [] }\n}' },
    { n: 'Discard draft', m: 'POST', p: '/api/tables/{id}/discard-draft' },
    { n: 'AI assist', m: 'POST', p: '/api/tables/{id}/ai-assist', d: 'Delegate to the Tables agent; writes land in the draft grid.', b: '{\n  "prompt": "Add a totals row"\n}' },
    { n: 'Import spreadsheet', m: 'POST', p: '/api/tables/{id}/import', d: 'multipart/form-data .xlsx/.xls/.csv; first sheet replaces this table as draft.' },
  ]),

  group('tasks', 'Tasks', '', [
    { n: 'List tasks', m: 'GET', p: '/api/tasks', q: [ { key: 'q' }, { key: 'status' }, { key: 'priority' }, { key: 'tag' } ] },
    { n: 'Create task', m: 'POST', p: '/api/tasks', b: '{\n  "title": "Finish report",\n  "priority": "high",\n  "dueAt": "2026-06-30T17:00:00Z",\n  "tags": []\n}' },
    { n: 'Get task', m: 'GET', p: '/api/tasks/{id}' },
    { n: 'Update task', m: 'PATCH', p: '/api/tasks/{id}', b: '{\n  "status": "done"\n}' },
    { n: 'Delete task', m: 'DELETE', p: '/api/tasks/{id}' },
  ]),

  group('events', 'Events', '', [
    { n: 'List events', m: 'GET', p: '/api/events', q: [ { key: 'q' }, { key: 'window', description: 'upcoming | past | all' }, { key: 'tag' } ] },
    { n: 'Create event', m: 'POST', p: '/api/events', b: '{\n  "title": "Team meeting",\n  "startsAt": "2026-06-15T10:00:00Z",\n  "endsAt": "2026-06-15T11:00:00Z",\n  "location": "Office",\n  "remindMinutesBefore": 15,\n  "tags": []\n}' },
    { n: 'Get event', m: 'GET', p: '/api/events/{id}' },
    { n: 'Update event', m: 'PATCH', p: '/api/events/{id}', b: '{\n  "title": "Moved meeting",\n  "startsAt": "2026-06-15T14:00:00Z"\n}' },
    { n: 'Delete event', m: 'DELETE', p: '/api/events/{id}' },
  ]),

  group('contacts', 'Contacts', 'The email allowlist + people registry.', [
    { n: 'List contacts', m: 'GET', p: '/api/contacts', q: [ { key: 'q' }, { key: 'tag' } ] },
    { n: 'Create contact', m: 'POST', p: '/api/contacts', d: 'Enqueues email backfills for new senders/domains.', b: '{\n  "first_name": "Jane",\n  "last_name": "Doe",\n  "company": "Acme",\n  "emails": ["jane@example.com"],\n  "tags": []\n}' },
    { n: 'Get contact', m: 'GET', p: '/api/contacts/{id}' },
    { n: 'Update contact', m: 'PATCH', p: '/api/contacts/{id}', b: '{\n  "emails": ["jane@example.com", "jane@work.com"]\n}' },
    { n: 'Delete contact', m: 'DELETE', p: '/api/contacts/{id}' },
  ]),

  group('journal', 'Journal', '', [
    { n: 'List entries', m: 'GET', p: '/api/journal', q: [ { key: 'q' }, { key: 'mood' }, { key: 'category' }, { key: 'tag' } ] },
    { n: 'Create entry', m: 'POST', p: '/api/journal', b: '{\n  "title": "Morning run",\n  "body": "5k in the park",\n  "mood": "energized",\n  "category": "fitness",\n  "tags": []\n}' },
    { n: 'Get entry', m: 'GET', p: '/api/journal/{id}' },
    { n: 'Update entry', m: 'PATCH', p: '/api/journal/{id}', b: '{\n  "mood": "calm"\n}' },
    { n: 'Delete entry', m: 'DELETE', p: '/api/journal/{id}' },
  ]),

  group('files', 'Files', 'The mirrored filesystem (folders + files).', [
    { n: 'List folders', m: 'GET', p: '/api/files/folders', q: [ { key: 'parent', description: "parent path, default 'files'" }, { key: 'tree', description: "'1' for the full tree" } ] },
    { n: 'Create folder', m: 'POST', p: '/api/files/folders', b: '{\n  "parentPath": "files",\n  "slug": "inbox",\n  "description": "Incoming files"\n}' },
    { n: 'Get folder', m: 'GET', p: '/api/files/folders/{id}' },
    { n: 'Update folder', m: 'PATCH', p: '/api/files/folders/{id}', b: '{\n  "description": "Updated description"\n}' },
    { n: 'Delete folder', m: 'DELETE', p: '/api/files/folders/{id}' },
    { n: 'List files', m: 'GET', p: '/api/files/files', q: [ { key: 'parent', description: 'parent directory path', required: true } ] },
    { n: 'Create / upload file', m: 'POST', p: '/api/files/files', d: 'JSON for text files; multipart/form-data for binary uploads.', b: '{\n  "parentPath": "files/inbox",\n  "filename": "notes.md",\n  "content": "# Notes"\n}' },
    { n: 'Get file', m: 'GET', p: '/api/files/files/{id}', q: [ { key: 'raw', description: "'1' for raw bytes instead of JSON" } ] },
    { n: 'Update file', m: 'PATCH', p: '/api/files/files/{id}', b: '{\n  "rename": "renamed.md"\n}' },
    { n: 'Delete file', m: 'DELETE', p: '/api/files/files/{id}', d: '409 for email attachments — delete from the email instead.' },
    { n: 'Bulk delete files', m: 'DELETE', p: '/api/files/files', b: '{\n  "ids": ["550e8400-e29b-41d4-a716-446655440000"]\n}' },
    { n: 'Download attachment', m: 'GET', p: '/api/attachments/{id}', d: 'Streams an email attachment with content-disposition.' },
  ]),

  group('secrets', 'Secrets', 'Sealed secret store (AES-256-GCM at rest).', [
    { n: 'List secrets', m: 'GET', p: '/api/secrets', d: 'Metadata only — never ciphertext or field values.', q: [ { key: 'q' }, { key: 'kind' }, { key: 'tag' } ] },
    { n: 'Create secret', m: 'POST', p: '/api/secrets', b: '{\n  "title": "Database credentials",\n  "kind": "password",\n  "tags": [],\n  "fields": [\n    { "label": "Username", "value": "admin" },\n    { "label": "Password", "value": "hunter2" }\n  ]\n}' },
    { n: 'Get secret metadata', m: 'GET', p: '/api/secrets/{id}' },
    { n: 'Update secret', m: 'PATCH', p: '/api/secrets/{id}', b: '{\n  "title": "Renamed secret"\n}' },
    { n: 'Reveal payload', m: 'POST', p: '/api/secrets/{id}/reveal', d: 'Decrypts note + fields; separate endpoint so reveals are auditable.' },
    { n: 'Delete secret', m: 'DELETE', p: '/api/secrets/{id}' },
  ]),

  group('keys', 'API keys', 'Encrypted vault for external service keys — referenced by tools as {{secret:service/label}}.', [
    { n: 'List keys', m: 'GET', p: '/api/keys', d: 'Masked previews only (first-4…last-4).' },
    { n: 'Add key', m: 'POST', p: '/api/keys', d: 'service+label must be unique together; plaintext is never returned again.', b: '{\n  "service": "mapbox",\n  "label": "default",\n  "plaintext": "pk.your-token-here"\n}' },
    { n: 'Rotate key', m: 'POST', p: '/api/keys/{id}/rotate', b: '{\n  "plaintext": "pk.new-token"\n}' },
    { n: 'Delete key', m: 'DELETE', p: '/api/keys/{id}' },
  ]),

  group('shares', 'Sharing', 'Public read-only share links.', [
    { n: 'Get share for node', m: 'GET', p: '/api/shares', q: [ { key: 'nodeId', required: true } ] },
    { n: 'Create share link', m: 'POST', p: '/api/shares', d: 'Returns the existing active link when one exists.', b: '{\n  "nodeId": "550e8400-e29b-41d4-a716-446655440000"\n}' },
    { n: 'Revoke share link', m: 'DELETE', p: '/api/shares/{id}' },
  ]),

  group('entities', 'Entities', 'Knowledge-graph entity dedup review.', [
    { n: 'List duplicate candidates', m: 'GET', p: '/api/entities/candidates' },
    { n: 'Merge entities', m: 'POST', p: '/api/entities/merge', d: 'Re-points edges + facts, folds the variant in as an alias.', b: '{\n  "canonicalId": "550e8400-e29b-41d4-a716-446655440000",\n  "dupId": "660e8400-e29b-41d4-a716-446655440001"\n}' },
    { n: 'Dismiss candidate pair', m: 'POST', p: '/api/entities/dismiss', b: '{\n  "idA": "550e8400-e29b-41d4-a716-446655440000",\n  "idB": "660e8400-e29b-41d4-a716-446655440001"\n}' },
  ]),

  group('peers', 'Peers & federation', 'Mantle-to-Mantle sharing.', [
    { n: 'List peers', m: 'GET', p: '/api/peers' },
    { n: 'Create peer', m: 'POST', p: '/api/peers', d: 'Returns the inbound token plaintext exactly once.', b: '{\n  "displayName": "Other Mantle",\n  "baseUrl": "https://peer.example.com",\n  "outboundToken": "their-inbound-token"\n}' },
    { n: 'Update peer', m: 'PATCH', p: '/api/peers/{id}', b: '{\n  "enabled": true\n}' },
    { n: 'Delete peer', m: 'DELETE', p: '/api/peers/{id}' },
    { n: 'Rotate inbound token', m: 'POST', p: '/api/peers/{id}/rotate', d: 'Old token stops working immediately.' },
    { n: 'List shares to peer', m: 'GET', p: '/api/peers/{id}/shares' },
    { n: 'Grant node to peer', m: 'POST', p: '/api/peers/{id}/shares', b: '{\n  "nodeId": "550e8400-e29b-41d4-a716-446655440000"\n}' },
    { n: 'Revoke node from peer', m: 'DELETE', p: '/api/peers/{id}/shares', q: [ { key: 'nodeId', required: true } ] },
    { n: 'Search grantable nodes', m: 'GET', p: '/api/peers/nodes', q: [ { key: 'q', required: true } ] },
    { n: 'Federation query (inbound)', m: 'POST', p: '/api/federation/query', d: 'What a peer calls — token-authed, returns only actively granted nodes.', b: '{\n  "query": "notes",\n  "limit": 20\n}' },
    { n: 'Fetch granted node (inbound)', m: 'GET', p: '/api/federation/node/{id}', d: '404 unless actively granted (indistinguishable from missing).' },
  ]),

  group('studio', 'Studio', 'Agent design surface.', [
    { n: 'Sandbox conversation', m: 'POST', p: '/api/studio/sandbox', d: 'Multi-turn test against an agent config — stateless, no tools, nothing persisted.', b: '{\n  "agentId": "550e8400-e29b-41d4-a716-446655440000",\n  "messages": [ { "role": "user", "content": "Hello!" } ]\n}' },
    { n: 'List prose versions', m: 'GET', p: '/api/studio/prose', q: [ { key: 'entityType', required: true }, { key: 'entityId', required: true }, { key: 'field', required: true } ] },
    { n: 'Save / revert prose', m: 'POST', p: '/api/studio/prose', b: '{\n  "entityType": "agent",\n  "entityId": "550e8400-e29b-41d4-a716-446655440000",\n  "field": "systemPrompt",\n  "body": "You are…",\n  "note": "tightened tone"\n}' },
    { n: 'Reset manifest agent', m: 'POST', p: '/api/studio/reset', d: 'Restore a manifest agent to canonical defaults.', b: '{\n  "slug": "pages"\n}' },
  ]),

  group('debug', 'Debug & integrity', 'Read-only invariant checks (safe to poll) + one repair action.', [
    { n: 'System integrity', m: 'GET', p: '/api/debug/integrity/system', d: 'Validates the agent/skill/tool/worker link graph against the manifest.' },
    { n: 'Corpus audit', m: 'GET', p: '/api/debug/integrity/audit' },
    { n: 'Landed content', m: 'GET', p: '/api/debug/integrity/landed', q: [ { key: 'limit' }, { key: 'types', description: 'comma-separated' } ] },
    { n: 'Delete landed node', m: 'POST', p: '/api/debug/integrity/landed/delete', d: 'Deletes one node + its brain footprint via the canonical cascade.', b: '{\n  "nodeId": "550e8400-e29b-41d4-a716-446655440000"\n}' },
  ]),

  group('system', 'System & meta', 'Health, versions, models, misc.', [
    { n: 'Health', m: 'GET', p: '/api/health', d: 'Live vitals for the dashboard; returns fast even when probes stall.' },
    { n: 'Version', m: 'GET', p: '/api/version', d: 'Build identity (version, git sha, build time). Unauthenticated.' },
    { n: 'Check for update', m: 'GET', p: '/api/updates/check', d: 'GitHub release check, server-cached 6h.' },
    { n: 'Updater status', m: 'GET', p: '/api/updates/status', d: 'Updater sidecar status + log tail.' },
    { n: 'Live activity', m: 'GET', p: '/api/activity', d: 'Current + recent runs with outcomes.' },
    { n: 'Realtime stream (SSE)', m: 'GET', p: '/api/realtime', d: 'Server-sent events of node changes — note: streams forever, cancel after testing.', q: [ { key: 'types', description: 'comma-separated node types' } ] },
    { n: 'Provider models', m: 'GET', p: '/api/models', q: [ { key: 'provider', required: true }, { key: 'refresh', description: "'1' busts the 5-min cache" } ] },
    { n: 'Model context map', m: 'GET', p: '/api/model-context', d: 'Model → context limit + pricing, from OpenRouter with fallback.' },
    { n: 'Mention search', m: 'GET', p: '/api/mentions/search', d: 'The editor @-mention resolver.', q: [ { key: 'q' } ] },
    { n: 'Get assist-agent overrides', m: 'GET', p: '/api/profile/assist-agent' },
    { n: 'Set assist-agent override', m: 'POST', p: '/api/profile/assist-agent', b: '{\n  "surface": "pages",\n  "agentSlug": "my-agent"\n}' },
    { n: 'List PDF passwords', m: 'GET', p: '/api/pdf-passwords' },
    { n: 'Add PDF password', m: 'POST', p: '/api/pdf-passwords', b: '{\n  "label": "Bank statements",\n  "password": "the-password"\n}' },
    { n: 'Delete PDF password', m: 'DELETE', p: '/api/pdf-passwords/{id}' },
  ]),
];

/** Total endpoint count — handy for the sidebar header. */
export const API_CATALOG_COUNT = API_CATALOG.reduce((n, g) => n + g.endpoints.length, 0);
