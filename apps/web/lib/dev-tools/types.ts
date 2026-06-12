/**
 * Client-side types for the API Console (/dev-tools).
 *
 * Three kinds of runnable things share one builder/response surface:
 *   'http' — a REST request (built-in API catalog entries + free-form)
 *   'tool' — a `tools` table row, run via /api/dev-tools/execute-tool
 *   'mcp'  — an MCP server tool, run via /api/dev-tools/mcp
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type BodyMode = 'none' | 'json' | 'raw';
export type AuthMode = 'session' | 'bearer' | 'none';
export type RequestKind = 'http' | 'tool' | 'mcp';

export type KeyValueEntry = {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
};

export type QueryParamDoc = { key: string; description?: string; required?: boolean };

/** One built-in REST endpoint in the static catalog. */
export type CatalogEndpoint = {
  id: string;
  name: string;
  method: HttpMethod;
  path: string; // '/api/notes/{id}' — dynamic segments as {param}
  description?: string;
  queryParams?: QueryParamDoc[];
  bodyExample?: string | null;
};

export type CatalogGroup = {
  id: string;
  name: string;
  description?: string;
  endpoints: CatalogEndpoint[];
};

/** The single draft the builder edits. Kind decides which fields matter. */
export type DraftRequest = {
  kind: RequestKind;
  name: string;
  // http
  method: HttpMethod;
  url: string; // may contain {{vars}}, {pathParams}, and {{secret:…}} refs
  params: KeyValueEntry[];
  headers: KeyValueEntry[];
  body: { mode: BodyMode; text: string };
  auth: { mode: AuthMode; token?: string };
  pathValues: Record<string, string>;
  // tool / mcp
  targetName: string;
  argsText: string;
  description?: string;
  schema?: Record<string, unknown> | null;
  /** Catalog/saved id this draft came from (for provenance display). */
  sourceId?: string;
};

export type SavedRequest = DraftRequest & { id: string; savedAt: number };
export type SavedCollection = { id: string; name: string; requests: SavedRequest[] };

export type ConsoleResponse = {
  via: 'direct' | 'proxy' | 'tool' | 'mcp';
  status: number; // 0 = network error; tool/mcp use 200/422 semantics
  statusText: string;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  truncated?: boolean;
  headers: Array<[string, string]>;
  bodyText: string;
  json: unknown | null;
  networkError?: string;
  resolvedUrl?: string;
  startedAt: string;
  artifacts?: Array<{ kind: string; mimeType: string; caption?: string; nodeId?: string }>;
};

export type HistoryEntry = {
  id: string;
  at: number;
  kind: RequestKind;
  label: string;
  method?: HttpMethod;
  status: number;
  ok: boolean;
  durationMs: number;
  draft: DraftRequest; // bearer tokens scrubbed before persisting
};

export type Environment = {
  id: string;
  name: string;
  baseUrl: string; // '' = this server (same-origin relative URLs)
  vars: KeyValueEntry[];
};

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentToolHandlerHttp = {
  kind: 'http';
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
};

export type AgentToolInfo = {
  id: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: { kind: 'builtin'; ref: string } | AgentToolHandlerHttp | { kind: 'shell'; cmd: string };
  requiresConfirm: boolean;
  enabled: boolean;
};
