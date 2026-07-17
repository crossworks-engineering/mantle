/**
 * Draft constructors — turn a catalog entry / MCP tool / agent tool /
 * saved request into the builder's editable draft shape.
 */

import { genId } from './storage';
import type {
  AgentToolInfo,
  CatalogEndpoint,
  DraftRequest,
  KeyValueEntry,
  McpToolInfo,
  SavedRequest,
} from './types';
import { exampleFromSchema } from './client';

function kvFrom(key: string, value: string, enabled: boolean): KeyValueEntry {
  return { id: genId('kv'), enabled, key, value };
}

export function draftFromCatalog(e: CatalogEndpoint): DraftRequest {
  return {
    kind: 'http',
    name: e.name,
    method: e.method,
    url: `{{baseUrl}}${e.path}`,
    // Required query params start enabled; optional ones are present but off.
    params: (e.queryParams ?? []).map((q) => kvFrom(q.key, '', q.required === true)),
    headers: [],
    body: {
      mode: e.bodyExample ? 'json' : 'none',
      text: e.bodyExample ?? '',
    },
    auth: { mode: 'session' },
    pathValues: {},
    targetName: '',
    argsText: '{}',
    description: e.description,
    sourceId: e.id,
  };
}

export function draftFromMcpTool(t: McpToolInfo): DraftRequest {
  return {
    kind: 'mcp',
    name: t.name,
    method: 'POST',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', text: '' },
    auth: { mode: 'session' },
    pathValues: {},
    targetName: t.name,
    argsText: exampleFromSchema(t.inputSchema),
    description: t.description,
    schema: t.inputSchema,
    sourceId: `mcp_${t.name}`,
  };
}

export function draftFromAgentTool(t: AgentToolInfo): DraftRequest {
  return {
    kind: 'tool',
    name: t.name,
    method: 'POST',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', text: '' },
    auth: { mode: 'session' },
    pathValues: {},
    targetName: t.slug,
    argsText: exampleFromSchema(t.inputSchema),
    description: t.description,
    schema: t.inputSchema,
    sourceId: `tool_${t.slug}`,
  };
}

export function draftFromSaved(r: SavedRequest): DraftRequest {
  // Deep-ish clone so edits don't mutate the stored object.
  const { id: _id, savedAt: _savedAt, ...rest } = r;
  return {
    ...rest,
    params: rest.params.map((p) => ({ ...p })),
    headers: rest.headers.map((h) => ({ ...h })),
    body: { ...rest.body },
    auth: { ...rest.auth },
    pathValues: { ...rest.pathValues },
  };
}

/** One searchable haystack per entry: name, path, method, params, etc.
 *  Searching "{id}" or a param name like "agentSlug" works because both
 *  the raw path and the param keys are included. */
export function catalogHaystack(e: CatalogEndpoint): string {
  return [
    e.name,
    e.method,
    e.path,
    e.description ?? '',
    ...(e.queryParams ?? []).map((q) => q.key),
    e.bodyExample ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

export function schemaHaystack(
  name: string,
  description: string,
  schema: Record<string, unknown> | null | undefined,
): string {
  const props =
    schema && typeof schema === 'object'
      ? Object.keys((schema.properties as Record<string, unknown>) ?? {})
      : [];
  return [name, description, ...props].join(' ').toLowerCase();
}
