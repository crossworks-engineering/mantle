/**
 * Toolsmith tool set — lets an agent author, test, group, and grant
 * templated HTTP API tools. The same capability is mirrored by the MCP
 * server (apps/mcp) so Claude Code/Desktop can drive it on the user's
 * own subscription; keep semantics in sync.
 *
 * The intended loop: web_fetch the service's API docs → api_tool_create
 * with {param} templates + {{secret:service/label}} vault refs →
 * api_tool_test against the live API → tool_group_ensure →
 * agent_grant_tool_group. One prompt, a deployed ability.
 *
 * Security stances (deliberate, mirrored in apps/mcp):
 *   - Agents author HTTP tools ONLY. Shell tools stay human-authored.
 *   - api_tool_test refuses non-http targets — otherwise "testing" a
 *     shell/builtin tool would be an unconfirmed execution side-channel.
 *   - api_key_refs returns masked previews + ref strings, never plaintext.
 *     (Dispatch decrypts refs server-side; see http-template.ts.)
 */

import { and, eq } from 'drizzle-orm';
import { db, agents, pendingToolCalls, toolGroups, tools, type ToolHandler } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { loadProfilePreferences } from '@mantle/content';
import { parseTikaBytes } from '@mantle/files';
import { createTool, deleteTool, listToolsForOwner, updateTool } from './crud';
import { dispatchTool } from './dispatch';
import { notifyPendingCreated } from './pending-notify';
import { collectParamNames, collectSecretRefs, refKey, type HttpHandler } from './http-template';
import { guardedFetch } from './ssrf-guard';
import {
  AGENT_GRANTABLE_KINDS,
  classifyRecipeStepTool,
  collectRecipeParams,
  parseRecipeSteps,
  recipeVerdictReason,
  RECIPE_FORBIDDEN_SLUGS,
} from './recipe';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

/* ───────────────────────────── helpers ───────────────────────────── */

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strRecord(
  v: unknown,
  label: string,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const r = rec(v);
  if (!r) return { ok: false, error: `${label} must be an object of string values` };
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val !== 'string') return { ok: false, error: `${label}.${k} must be a string` };
    out[k] = val;
  }
  return { ok: true, value: out };
}

const SLUG_RE = /^[a-z0-9_-]{1,120}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function toolRowBySlug(ownerId: string, slug: string) {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** Cross-check templates against the declared input schema + the vault.
 *  Returned as `warnings` so the agent can self-correct in the same turn. */
async function handlerWarnings(
  ownerId: string,
  handler: HttpHandler,
  inputSchema: Record<string, unknown>,
): Promise<string[]> {
  const warnings: string[] = [];
  const props = new Set(Object.keys(rec(inputSchema.properties) ?? {}));
  for (const p of collectParamNames(handler)) {
    if (!props.has(p)) {
      warnings.push(
        `template placeholder {${p}} is not declared in input_schema.properties — the model will never fill it`,
      );
    }
  }
  const refs = collectSecretRefs(handler);
  if (refs.length > 0) {
    const vault = await listApiKeys(ownerId);
    const have = new Set(vault.map((k) => `${k.service}/${k.label}`));
    for (const ref of refs) {
      if (!have.has(refKey(ref))) {
        warnings.push(
          `secret ref {{secret:${refKey(ref)}}} has no matching vault entry — ask the user to add it under Settings → API keys (service '${ref.service}', label '${ref.label}')`,
        );
      }
    }
  }
  return warnings;
}

/** Validate + assemble an http handler from model input. Shared by
 *  create/update. Returns an error string on the first problem. */
function buildHandlerFromInput(
  input: Record<string, unknown>,
  base?: HttpHandler,
): HttpHandler | { error: string } {
  const url = str(input.url).trim() || base?.url || '';
  if (!URL_RE.test(url)) return { error: 'url must start with http(s):// and contain no spaces' };
  const method = (str(input.method).trim() || base?.method || 'POST').toUpperCase();
  if (!METHODS.has(method)) return { error: `method must be one of ${[...METHODS].join(', ')}` };

  let headers = base?.headers;
  if (input.headers !== undefined) {
    const parsed = strRecord(input.headers, 'headers');
    if (!parsed.ok) return { error: parsed.error };
    headers = Object.keys(parsed.value).length > 0 ? parsed.value : undefined;
  }
  let query = base?.query;
  if (input.query !== undefined) {
    const parsed = strRecord(input.query, 'query');
    if (!parsed.ok) return { error: parsed.error };
    query = Object.keys(parsed.value).length > 0 ? parsed.value : undefined;
  }
  let body = base?.body;
  if (input.body !== undefined) {
    if (input.body !== null && typeof input.body !== 'string') {
      return { error: 'body must be a string template (or null to clear)' };
    }
    body = input.body === null || input.body === '' ? undefined : input.body;
  }
  let timeoutMs = base?.timeoutMs;
  if (input.timeout_ms !== undefined) {
    const t = Number(input.timeout_ms);
    if (!Number.isInteger(t) || t < 100 || t > 120_000) {
      return { error: 'timeout_ms must be an integer between 100 and 120000' };
    }
    timeoutMs = t;
  }

  return {
    kind: 'http',
    url,
    method: method as HttpHandler['method'],
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function summarizeHandler(h: ToolHandler): Record<string, unknown> {
  if (h.kind === 'http') {
    return {
      kind: 'http',
      url: h.url,
      method: h.method ?? 'POST',
      headers: h.headers ?? {},
      query: h.query ?? {},
      body: h.body ?? null,
      timeoutMs: h.timeoutMs ?? null,
    };
  }
  if (h.kind === 'builtin') return { kind: 'builtin', ref: h.ref };
  if (h.kind === 'recipe') {
    return {
      kind: 'recipe',
      steps: h.steps.map((s) => ({
        tool: s.tool,
        ...(s.as ? { as: s.as } : {}),
        input: s.input ?? {},
      })),
      output: h.output ?? null,
    };
  }
  return { kind: 'shell' };
}

/* ───────────────────────────── web_fetch ─────────────────────────── */

const FETCH_TIMEOUT_MS = 25_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TEXT_CAP = 40_000;
const MAX_TEXT_CAP = 80_000;

/** Last-resort HTML→text when Tika is down: drop scripts/styles/tags. */
function crudeHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const web_fetch: BuiltinToolDef = {
  slug: 'web_fetch',
  name: 'Fetch a web page',
  description:
    "Fetch a URL (API documentation, OpenAPI spec, reference page) and return its readable text. HTML is converted to plain text; JSON/markdown/plain text come back as-is. Long pages are truncated — pass offset to continue reading. Use this to read a service's API docs before authoring tools with api_tool_create.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to fetch' },
      offset: {
        type: 'number',
        description: 'character offset to start from (for paging long documents), default 0',
      },
      max_chars: {
        type: 'number',
        description: `characters to return, default ${DEFAULT_TEXT_CAP}, max ${MAX_TEXT_CAP}`,
      },
    },
    required: ['url'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const url = str(input.url).trim();
    if (!URL_RE.test(url)) return { ok: false, error: 'url must start with http(s)://' };
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const cap = Math.min(
      MAX_TEXT_CAP,
      Math.max(1_000, Math.floor(Number(input.max_chars) || DEFAULT_TEXT_CAP)),
    );
    try {
      // guardedFetch blocks private/loopback/link-local/metadata targets and
      // re-checks each redirect hop, so an injected agent can't turn web_fetch
      // into an SSRF probe of internal services or the cloud-metadata endpoint.
      const res = await guardedFetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'mantle-toolsmith/1.0 (+self-hosted assistant)' },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const clipped = buf.subarray(0, FETCH_MAX_BYTES);
      const contentType = res.headers.get('content-type') ?? '';
      let text: string;
      if (/html/i.test(contentType)) {
        text = await parseTikaBytes(clipped, { mimeType: 'text/html' });
        if (!text) text = crudeHtmlToText(clipped.toString('utf8'));
      } else {
        text = clipped.toString('utf8');
      }
      const slice = text.slice(offset, offset + cap);
      ctx.step?.setMeta({ url, status: res.status, totalChars: text.length });
      return {
        ok: true,
        output: {
          url,
          status: res.status,
          contentType,
          text: slice,
          totalChars: text.length,
          offset,
          truncated: offset + cap < text.length,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/* ─────────────────────────── api_tool CRUD ───────────────────────── */

const TEMPLATE_DOC =
  'Templating: {param} placeholders in url/query/headers/body fill from the tool-call input ' +
  '(URL-encoded in the url, JSON-encoded in the body — write "q": {query}, not "q": "{query}"). ' +
  '{{secret:service/label}} refs decrypt from the API-key vault at call time (list them with api_key_refs). ' +
  'Input fields no template consumes are sent as a JSON body (non-GET) or query params (GET).';

const api_tool_list: BuiltinToolDef = {
  slug: 'api_tool_list',
  name: 'List registered tools',
  description:
    'List every tool in the registry (builtin, http, shell): slug, kind, enabled, requires_confirm, and a short description. Use api_tool_get for full details of one tool.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'optional substring filter on slug/name/description' },
      kind: {
        type: 'string',
        enum: ['builtin', 'http', 'shell'],
        description: 'optional kind filter',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const q = str(input.q).toLowerCase();
    const kind = str(input.kind);
    const rows = await listToolsForOwner(ctx.ownerId);
    const out = rows
      .filter((t) => (kind ? t.handler.kind === kind : true))
      .filter((t) => (q ? `${t.slug} ${t.name} ${t.description}`.toLowerCase().includes(q) : true))
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        kind: t.handler.kind,
        enabled: t.enabled,
        requires_confirm: t.requiresConfirm,
        description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
      }));
    ctx.step?.setMeta({ count: out.length });
    return { ok: true, output: { tools: out, count: out.length } };
  },
};

const api_tool_get: BuiltinToolDef = {
  slug: 'api_tool_get',
  name: 'Get one tool',
  description:
    'Full definition of one tool by slug: description, input schema, and handler (url/method/headers/query/body templates for http tools).',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'slug of the tool to inspect, e.g. mapbox_geocode' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    const row = await toolRowBySlug(ctx.ownerId, slug);
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    return {
      ok: true,
      output: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        input_schema: row.inputSchema,
        handler: summarizeHandler(row.handler as ToolHandler),
        requires_confirm: row.requiresConfirm,
        enabled: row.enabled,
      },
    };
  },
};

const api_tool_create: BuiltinToolDef = {
  slug: 'api_tool_create',
  name: 'Create an HTTP API tool',
  description:
    `Register a new HTTP tool agents can call. ${TEMPLATE_DOC} ` +
    'Write a precise description (the model granting agents read it) and declare every {param} in input_schema.properties. ' +
    'Always api_tool_test after creating. Only http tools can be authored this way — shell tools are human-only.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'lowercase letters/digits/dash/underscore — the function name models call',
      },
      name: {
        type: 'string',
        description:
          'display name shown in tool pickers and Settings → Tools, e.g. "Mapbox geocode"',
      },
      description: {
        type: 'string',
        description: 'what it does + when to use it — models read this',
      },
      input_schema: {
        type: 'object',
        description: 'JSON Schema for the tool input. Declare every {param} used in the templates.',
      },
      url: { type: 'string', description: 'http(s) URL template, may contain {param}' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'default POST',
      },
      headers: { type: 'object', description: 'header → value template map' },
      query: { type: 'object', description: 'query key → value template map' },
      body: {
        type: 'string',
        description:
          'body template; omit to send unconsumed input as a JSON body (query string for GET/HEAD)',
      },
      timeout_ms: { type: 'number', description: '100–120000, default 15000' },
      requires_confirm: {
        type: 'boolean',
        description:
          'park calls for operator approval — set true for destructive endpoints (deletes, payments, sends). If the owner has "require approval for agent-built tools" on, every authored tool starts gated regardless and only the operator can clear it in Settings → Tools.',
      },
    },
    required: ['slug', 'name', 'description', 'url'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    if (!SLUG_RE.test(slug)) {
      return {
        ok: false,
        error: 'slug must be lowercase letters/digits/dash/underscore (max 120)',
      };
    }
    const name = str(input.name).trim();
    const description = str(input.description).trim();
    if (!name || !description) return { ok: false, error: 'name and description are required' };
    const inputSchema = rec(input.input_schema) ?? { type: 'object', properties: {} };
    const handler = buildHandlerFromInput(input);
    if ('error' in handler) return { ok: false, error: handler.error };
    // When the owner has turned on "require approval for agent-built tools",
    // authored tools start confirm-gated so an injected agent can't stand up a
    // no-confirmation exfiltration endpoint; the operator clears the gate per
    // tool in Settings → Tools. Off (the default) trusts the single owner and
    // honours the agent's own requires_confirm choice.
    const requireApproval = (await loadProfilePreferences(ctx.ownerId)).toolsmithRequireApproval;
    try {
      const row = await createTool(ctx.ownerId, {
        slug,
        name,
        description,
        inputSchema,
        handler,
        requiresConfirm: requireApproval ? true : input.requires_confirm === true,
        enabled: true,
      });
      const warnings = await handlerWarnings(ctx.ownerId, handler, inputSchema);
      ctx.step?.setOutput({ slug: row.slug, warnings });
      return {
        ok: true,
        output: {
          slug: row.slug,
          created: true,
          warnings,
          next: `Test it with api_tool_test, then add it to a group via tool_group_ensure and grant with agent_grant_tool_group.`,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('tools_owner_slug_uq') || msg.includes('duplicate key')) {
        return {
          ok: false,
          error: `a tool with slug '${slug}' already exists — use api_tool_update`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const api_tool_update: BuiltinToolDef = {
  slug: 'api_tool_update',
  name: 'Update an HTTP API tool',
  description:
    'Update a user-defined HTTP tool by slug. Provide only the fields to change; headers/query replace the whole map when given; body: null clears the template. Built-in tools only allow enabled/requires_confirm changes; shell tools cannot be edited by agents.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'slug of the tool to update — the slug itself cannot be changed',
      },
      name: {
        type: 'string',
        description: 'replacement display name; omit to keep the current one',
      },
      description: {
        type: 'string',
        description:
          'replacement description — what it does + when to use it, as in `api_tool_create`',
      },
      input_schema: {
        type: 'object',
        description:
          'replacement JSON Schema for the tool input (the whole schema, not a merge). Declare every {param} the templates use.',
      },
      url: { type: 'string', description: 'replacement http(s) URL template, may contain {param}' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'replacement HTTP method; omit to keep the current one',
      },
      headers: {
        type: 'object',
        description:
          'replacement header → value template map — replaces the whole map ({} clears it)',
      },
      query: {
        type: 'object',
        description:
          'replacement query key → value template map — replaces the whole map ({} clears it)',
      },
      body: {
        type: ['string', 'null'],
        description:
          'replacement body template; null clears it so unconsumed input is sent as a JSON body (query string for GET/HEAD)',
      },
      timeout_ms: { type: 'number', description: 'replacement timeout, 100–120000 ms' },
      requires_confirm: {
        type: 'boolean',
        description:
          'toggle the confirm gate. When the owner requires approval for agent-built tools, you can only tighten it (clearing is operator-only, in Settings → Tools).',
      },
      enabled: {
        type: 'boolean',
        description: 'set false to disable the tool without deleting it; true re-enables',
      },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    const row = await toolRowBySlug(ctx.ownerId, slug);
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    const existing = row.handler as ToolHandler;

    // Shell tools are human-only end to end: refuse before applying ANY field.
    // Flipping enabled/requires_confirm here would let an agent strip the
    // operator-confirmation gate off (or re-enable) a destructive shell tool.
    if (existing.kind === 'shell') {
      return { ok: false, error: 'shell tools are human-only — edit them in Settings → Tools' };
    }

    const patch: Parameters<typeof updateTool>[2] = {};
    // With "require approval" ON, agents may only TIGHTEN the confirm gate,
    // never clear it (lowering is operator-only) — otherwise an agent could
    // re-author a tool confirm-free after create forced it on. With it OFF,
    // the owner trusts the agent's own requires_confirm choice.
    const requireApproval = (await loadProfilePreferences(ctx.ownerId)).toolsmithRequireApproval;
    if (requireApproval) {
      if (input.requires_confirm === true) patch.requiresConfirm = true;
    } else if (input.requires_confirm !== undefined) {
      patch.requiresConfirm = input.requires_confirm === true;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled === true;

    const touchesDefinition =
      input.name !== undefined ||
      input.description !== undefined ||
      input.input_schema !== undefined ||
      input.url !== undefined ||
      input.method !== undefined ||
      input.headers !== undefined ||
      input.query !== undefined ||
      input.body !== undefined ||
      input.timeout_ms !== undefined;

    if (touchesDefinition) {
      if (existing.kind === 'builtin') {
        return {
          ok: false,
          error: 'built-in tools are code-backed — only enabled/requires_confirm can change',
        };
      }
      if (existing.kind === 'recipe') {
        return {
          ok: false,
          error:
            "recipe tools aren't patched in place — api_tool_delete and recipe_tool_create a new one (enabled/requires_confirm can still toggle here)",
        };
      }
      if (input.name !== undefined) patch.name = str(input.name).trim();
      if (input.description !== undefined) patch.description = str(input.description).trim();
      if (input.input_schema !== undefined) {
        const schema = rec(input.input_schema);
        if (!schema) return { ok: false, error: 'input_schema must be an object' };
        patch.inputSchema = schema;
      }
      const handler = buildHandlerFromInput(input, existing);
      if ('error' in handler) return { ok: false, error: handler.error };
      patch.handler = handler;
    }

    try {
      const updated = await updateTool(ctx.ownerId, row.id, patch);
      if (!updated) return { ok: false, error: `tool '${slug}' not found` };
      const warnings =
        updated.handler.kind === 'http'
          ? await handlerWarnings(ctx.ownerId, updated.handler as HttpHandler, updated.inputSchema)
          : [];
      ctx.step?.setOutput({ slug, warnings });
      return { ok: true, output: { slug, updated: true, warnings } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const api_tool_delete: BuiltinToolDef = {
  slug: 'api_tool_delete',
  name: 'Delete a user-defined tool',
  description:
    'Delete a user-defined (http/shell) tool by slug. Built-ins cannot be deleted. Check tool_group_list first — deleting a tool other agents use breaks them silently.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'slug of the user-defined tool to delete' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    const row = await toolRowBySlug(ctx.ownerId, slug);
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    try {
      const ok = await deleteTool(ctx.ownerId, row.id);
      if (!ok) return { ok: false, error: `tool '${slug}' not found` };
      ctx.step?.setOutput({ slug });
      return { ok: true, output: { slug, deleted: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const api_tool_test: BuiltinToolDef = {
  slug: 'api_tool_test',
  name: 'Test an HTTP API tool',
  description:
    'Execute an HTTP tool with the given input and return the real response — use after api_tool_create/update to prove the tool works before handing it to agents. Runs the exact dispatcher agents use (templating + vault secrets). Refuses builtin/shell tools.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'slug of the http tool to run' },
      input: { type: 'object', description: 'tool input matching its input_schema' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    const row = await toolRowBySlug(ctx.ownerId, slug);
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    const handler = row.handler as ToolHandler;
    if (handler.kind !== 'http') {
      return {
        ok: false,
        error: `api_tool_test only runs http tools — '${slug}' is ${handler.kind}`,
      };
    }
    const args = rec(input.input) ?? {};
    const t0 = performance.now();
    const result = await dispatchTool(row, args, { ownerId: ctx.ownerId, step: ctx.step });
    const duration_ms = Math.round(performance.now() - t0);
    if (!result.ok) {
      return { ok: true, output: { slug, test_passed: false, error: result.error, duration_ms } };
    }
    return { ok: true, output: { slug, test_passed: true, duration_ms, response: result.output } };
  },
};

const api_key_refs: BuiltinToolDef = {
  slug: 'api_key_refs',
  name: 'List vault key references',
  description:
    'List the encrypted API-key vault entries as {{secret:service/label}} reference strings for use in tool templates. Returns masked previews only — plaintext never leaves the vault. If the service the user wants is missing, ask them to add the key under Settings → API keys.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const keys = await listApiKeys(ctx.ownerId);
    return {
      ok: true,
      output: {
        keys: keys.map((k) => ({
          service: k.service,
          label: k.label,
          masked: k.masked,
          ref: `{{secret:${k.service}/${k.label}}}`,
        })),
      },
    };
  },
};

/* ─────────────────────────── recipe tools ────────────────────────── */

const tool_catalog: BuiltinToolDef = {
  slug: 'tool_catalog',
  name: 'Browse composable tools',
  description:
    "List the tools you can COMPOSE into a recipe tool (recipe_tool_create) — the brain's own content/search/file/page/task/journal/event/table builtins plus your authored http tools. Returns each tool's slug, kind, full description, and input_schema so you know the exact slug + input shape to chain. Excludes tools recipes may not call (terminal, secrets, delegation, the tool-authoring kit, confirm-gated, shell). Filter with q. This is how you discover the steps for a new recipe.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'optional substring filter on slug/name/description' },
      include_input_schema: {
        type: 'boolean',
        description:
          "include each tool's full input_schema (default true; set false for a terse list)",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const q = str(input.q).toLowerCase();
    const withSchema = input.include_input_schema !== false;
    const rows = await listToolsForOwner(ctx.ownerId);
    let excluded = 0;
    const composable = rows
      .filter((t) => {
        const verdict = classifyRecipeStepTool({
          slug: t.slug,
          exists: true,
          kind: t.handler.kind,
          requiresConfirm: t.requiresConfirm,
        });
        if (verdict !== 'ok') {
          excluded++;
          return false;
        }
        return q ? `${t.slug} ${t.name} ${t.description}`.toLowerCase().includes(q) : true;
      })
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        kind: t.handler.kind,
        description: t.description,
        ...(withSchema ? { input_schema: t.inputSchema } : {}),
      }));
    ctx.step?.setMeta({ count: composable.length, excluded });
    return {
      ok: true,
      output: {
        tools: composable,
        count: composable.length,
        excluded_count: excluded,
        note: "Use these slugs as recipe steps. Reference a step's output in a later step with $0 / $name.path; reference the recipe's own input with {param}.",
      },
    };
  },
};

const RECIPE_DOC =
  'A recipe chains existing tools server-side — data flows between steps, never through the model. ' +
  'In a step\'s input an EXACT "{param}" pulls the recipe\'s own input value (any type) and an EXACT "$0" / "$name" / "$name.field" pulls a prior step\'s output; ' +
  'embedded in a longer string ("{first} {last}") they substitute as text.';

const recipe_tool_create: BuiltinToolDef = {
  slug: 'recipe_tool_create',
  name: 'Create a recipe tool',
  description:
    `Author a NEW tool by composing EXISTING tools — no external service, no code change. ${RECIPE_DOC} ` +
    'Use it to fill a local-capability gap (e.g. "turn a note into a page" = `note_get` → `page_create`) as one reusable, agent-callable tool. ' +
    'Steps may only call composable tools — browse `tool_catalog`; shell, confirm-gated, and terminal/secrets/delegation/tool-authoring tools are refused. ' +
    'Always `recipe_tool_test` after creating, then `tool_group_ensure` + `agent_grant_tool_group` to grant it.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'lowercase letters/digits/dash/underscore — the function name models call',
      },
      name: {
        type: 'string',
        description: 'display name shown in tool pickers and Settings → Tools, e.g. "Note to page"',
      },
      description: {
        type: 'string',
        description: 'what it does + when to use it — models read this',
      },
      input_schema: {
        type: 'object',
        description: 'JSON Schema for the tool input. Declare every {param} used in the steps.',
      },
      steps: {
        type: 'array',
        description: 'ordered list of { tool, input?, as? } — the tools to chain',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'slug of an existing composable tool' },
            input: {
              type: 'object',
              description: 'input for the tool; values may use {param} and $ref templates',
            },
            as: {
              type: 'string',
              description: "optional name to reference this step's output as $name (else $index)",
            },
          },
          required: ['tool'],
        },
      },
      output: {
        description:
          "optional output template (resolved like a step input); default = last step's output",
      },
      requires_confirm: {
        type: 'boolean',
        description: 'park calls for operator approval before running the recipe',
      },
    },
    required: ['slug', 'name', 'description', 'steps'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    if (!SLUG_RE.test(slug)) {
      return {
        ok: false,
        error: 'slug must be lowercase letters/digits/dash/underscore (max 120)',
      };
    }
    if (RECIPE_FORBIDDEN_SLUGS.has(slug)) {
      return { ok: false, error: `slug '${slug}' is reserved` };
    }
    const name = str(input.name).trim();
    const description = str(input.description).trim();
    if (!name || !description) return { ok: false, error: 'name and description are required' };
    const inputSchema = rec(input.input_schema) ?? { type: 'object', properties: {} };

    const parsed = parseRecipeSteps(input.steps);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const { steps } = parsed;

    // Validate every step against the safety envelope, reporting ALL violations
    // at once so the agent can fix the recipe in a single follow-up.
    const kindBySlug = new Map(
      (await listToolsForOwner(ctx.ownerId)).map((t) => [t.slug, t] as const),
    );
    const violations: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const row = kindBySlug.get(steps[i]!.tool);
      const verdict = classifyRecipeStepTool({
        slug: steps[i]!.tool,
        exists: !!row,
        kind: row?.handler.kind,
        requiresConfirm: row?.requiresConfirm,
      });
      if (verdict !== 'ok')
        violations.push(`step ${i}: ${recipeVerdictReason(steps[i]!.tool, verdict)}`);
    }
    if (violations.length > 0) {
      return { ok: false, error: `recipe rejected:\n${violations.join('\n')}` };
    }

    // Warn (don't fail) on {param} tokens the input_schema doesn't declare —
    // the model would never fill them, so the step gets undefined.
    const declared = new Set(Object.keys(rec(inputSchema.properties) ?? {}));
    const warnings = [...collectRecipeParams(steps, input.output)]
      .filter((p) => !declared.has(p))
      .map(
        (p) =>
          `{${p}} is used in a step but not declared in input_schema.properties — the model can't fill it`,
      );

    const handler = {
      kind: 'recipe' as const,
      steps,
      ...(input.output !== undefined ? { output: input.output } : {}),
    };
    const requireApproval = (await loadProfilePreferences(ctx.ownerId)).toolsmithRequireApproval;
    try {
      const row = await createTool(ctx.ownerId, {
        slug,
        name,
        description,
        inputSchema,
        handler,
        requiresConfirm: requireApproval ? true : input.requires_confirm === true,
        enabled: true,
      });
      ctx.step?.setOutput({ slug: row.slug, steps: steps.map((s) => s.tool), warnings });
      return {
        ok: true,
        output: {
          slug: row.slug,
          created: true,
          steps: steps.map((s) => s.tool),
          warnings,
          next: 'Test it with recipe_tool_test, then add it to a group via tool_group_ensure and grant with agent_grant_tool_group.',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('tools_owner_slug_uq') || msg.includes('duplicate key')) {
        return {
          ok: false,
          error: `a tool with slug '${slug}' already exists — use api_tool_delete then recreate, or pick a new slug`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const recipe_tool_test: BuiltinToolDef = {
  slug: 'recipe_tool_test',
  name: 'Test a recipe tool',
  description:
    'Run a recipe tool with the given input and return its real output — use after recipe_tool_create to prove the chain works before granting it. Runs the exact dispatcher agents use, so side effects ARE real (a recipe that creates a page will create one). Refuses non-recipe tools (use api_tool_test for http).',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'slug of the recipe tool to run' },
      input: { type: 'object', description: 'tool input matching its input_schema' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    const row = await toolRowBySlug(ctx.ownerId, slug);
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    const handler = row.handler as ToolHandler;
    if (handler.kind !== 'recipe') {
      return {
        ok: false,
        error: `recipe_tool_test only runs recipe tools — '${slug}' is ${handler.kind}`,
      };
    }
    const args = rec(input.input) ?? {};
    const t0 = performance.now();
    const result = await dispatchTool(row, args, { ownerId: ctx.ownerId, step: ctx.step });
    const duration_ms = Math.round(performance.now() - t0);
    if (!result.ok) {
      return { ok: true, output: { slug, test_passed: false, error: result.error, duration_ms } };
    }
    return { ok: true, output: { slug, test_passed: true, duration_ms, response: result.output } };
  },
};

/* ─────────────────────── groups + agent grants ───────────────────── */

const tool_group_list: BuiltinToolDef = {
  slug: 'tool_group_list',
  name: 'List tool groups',
  description:
    'List tool groups (capability bundles agents are granted): slug, tool slugs, and which agents currently grant each group.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const groups = await db.select().from(toolGroups).where(eq(toolGroups.ownerId, ctx.ownerId));
    const agentRows = await db
      .select({ slug: agents.slug, groups: agents.toolGroupSlugs })
      .from(agents)
      .where(eq(agents.ownerId, ctx.ownerId));
    const grantedBy = new Map<string, string[]>();
    for (const a of agentRows) {
      for (const g of a.groups ?? []) {
        grantedBy.set(g, [...(grantedBy.get(g) ?? []), a.slug]);
      }
    }
    return {
      ok: true,
      output: {
        groups: groups.map((g) => ({
          slug: g.slug,
          name: g.name,
          description: g.description,
          tool_slugs: g.toolSlugs ?? [],
          enabled: g.enabled,
          granted_to_agents: grantedBy.get(g.slug) ?? [],
        })),
      },
    };
  },
};

const tool_group_ensure: BuiltinToolDef = {
  slug: 'tool_group_ensure',
  name: 'Create or update a tool group',
  description:
    "Create a tool group if it doesn't exist, or update its tool list. mode 'add' (default) merges slugs in; 'replace' overwrites the list. Unknown tool slugs are reported as warnings, not errors.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'group slug, e.g. mapbox-tools' },
      name: { type: 'string', description: 'display name (required when creating)' },
      description: {
        type: 'string',
        description:
          'what the bundle is for, e.g. "Mapbox geocoding + routing"; omit to keep the existing one',
      },
      tool_slugs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'slugs of the tools the group should contain — http/recipe tools only, e.g. ["mapbox_geocode"]',
      },
      mode: { type: 'string', enum: ['add', 'replace'], description: "default 'add'" },
    },
    required: ['slug', 'tool_slugs'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = str(input.slug).trim();
    if (!SLUG_RE.test(slug)) {
      return { ok: false, error: 'slug must be lowercase letters/digits/dash/underscore' };
    }
    const requested = Array.isArray(input.tool_slugs)
      ? input.tool_slugs.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : null;
    if (!requested) return { ok: false, error: 'tool_slugs must be an array of strings' };
    const mode = str(input.mode) === 'replace' ? 'replace' : 'add';

    const kindBySlug = new Map(
      (await listToolsForOwner(ctx.ownerId)).map((t) => [t.slug, t.handler.kind] as const),
    );

    // Hard stop: agents may only bundle agent-grantable tools (http + recipe).
    // A shell/builtin slug (e.g. the unrestricted `run_terminal`) would let a
    // later grant escalate an agent past the authoring boundary — refuse, don't warn.
    const nonGrantable = requested.filter(
      (s) => kindBySlug.has(s) && !AGENT_GRANTABLE_KINDS.has(kindBySlug.get(s)!),
    );
    if (nonGrantable.length > 0) {
      return {
        ok: false,
        error: `tool groups may only contain http or recipe tools; refused: ${nonGrantable.join(', ')}`,
      };
    }

    const warnings = requested
      .filter((s) => !kindBySlug.has(s))
      .map((s) => `tool '${s}' does not exist (yet) — it will be ignored at runtime until created`);

    const [existing] = await db
      .select()
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, slug)))
      .limit(1);

    let toolSlugs: string[];
    if (existing) {
      toolSlugs =
        mode === 'replace'
          ? [...new Set(requested)]
          : [...new Set([...(existing.toolSlugs ?? []), ...requested])];
      await db
        .update(toolGroups)
        .set({
          toolSlugs,
          ...(str(input.name).trim() ? { name: str(input.name).trim() } : {}),
          ...(str(input.description).trim() ? { description: str(input.description).trim() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(toolGroups.id, existing.id));
    } else {
      const name = str(input.name).trim();
      if (!name) return { ok: false, error: 'name is required when creating a new group' };
      toolSlugs = [...new Set(requested)];
      await db.insert(toolGroups).values({
        ownerId: ctx.ownerId,
        slug,
        name,
        description: str(input.description).trim(),
        toolSlugs,
        enabled: true,
      });
    }
    ctx.step?.setOutput({ slug, toolSlugs, warnings });
    return {
      ok: true,
      output: { slug, created: !existing, tool_slugs: toolSlugs, warnings },
    };
  },
};

const agent_list: BuiltinToolDef = {
  slug: 'agent_list',
  name: 'List agents',
  description:
    'Read-only list of the agents on this Mantle: slug, name, role, enabled, and which tool groups each grants. Use before agent_grant_tool_group.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const rows = await db
      .select({
        slug: agents.slug,
        name: agents.name,
        role: agents.role,
        enabled: agents.enabled,
        toolGroupSlugs: agents.toolGroupSlugs,
      })
      .from(agents)
      .where(eq(agents.ownerId, ctx.ownerId));
    return {
      ok: true,
      output: {
        agents: rows.map((a) => ({
          slug: a.slug,
          name: a.name,
          role: a.role,
          enabled: a.enabled,
          tool_group_slugs: a.toolGroupSlugs ?? [],
        })),
      },
    };
  },
};

const agent_grant_tool_group: BuiltinToolDef = {
  slug: 'agent_grant_tool_group',
  name: 'Grant a tool group to an agent',
  description:
    "Add a tool group to an agent's grants so its tools become callable by that agent (chat turns and heartbeat fires alike). Confirm with the user which agent should receive new capabilities before granting.",
  inputSchema: {
    type: 'object',
    properties: {
      agent_slug: {
        type: 'string',
        description:
          'agent receiving the grant — must differ from the calling agent (self-grants are refused); list candidates with `agent_list`',
      },
      group_slug: {
        type: 'string',
        description: 'tool group to grant; must already exist — create it with `tool_group_ensure`',
      },
    },
    required: ['agent_slug', 'group_slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const agentSlug = str(input.agent_slug).trim();
    const groupSlug = str(input.group_slug).trim();
    // Refuse self-grant: an injected agent must not be able to widen its OWN
    // capabilities. New grants go to a different, operator-intended agent
    // (mirrors invoke_agent's self-call refusal).
    if (ctx.agent?.slug && ctx.agent.slug === agentSlug) {
      return {
        ok: false,
        error: 'an agent cannot grant a tool group to itself — ask the operator to grant it',
      };
    }
    const [agent] = await db
      .select({ id: agents.id, groups: agents.toolGroupSlugs })
      .from(agents)
      .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, agentSlug)))
      .limit(1);
    if (!agent) return { ok: false, error: `agent '${agentSlug}' not found` };
    const [group] = await db
      .select({ id: toolGroups.id, toolSlugs: toolGroups.toolSlugs })
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, groupSlug)))
      .limit(1);
    if (!group) {
      return {
        ok: false,
        error: `tool group '${groupSlug}' not found — create it with tool_group_ensure`,
      };
    }

    // Re-check at grant time: a slug bundled while unknown may since have
    // resolved to a human-authored shell/builtin tool. Agents may only hand
    // out http capabilities, so refuse to grant a group that holds anything else.
    const kindBySlug = new Map(
      (await listToolsForOwner(ctx.ownerId)).map((t) => [t.slug, t.handler.kind] as const),
    );
    const nonGrantable = (group.toolSlugs ?? []).filter(
      (s) => kindBySlug.has(s) && !AGENT_GRANTABLE_KINDS.has(kindBySlug.get(s)!),
    );
    if (nonGrantable.length > 0) {
      return {
        ok: false,
        error: `group '${groupSlug}' contains non-grantable tools (${nonGrantable.join(', ')}) — agents can only grant http/recipe tool groups`,
      };
    }
    const current = agent.groups ?? [];
    if (current.includes(groupSlug)) {
      return {
        ok: true,
        output: { agent_slug: agentSlug, group_slug: groupSlug, already_granted: true },
      };
    }

    // Cross-agent grant confirmation: when an AGENT initiates this (ctx.agent
    // set, as opposed to the operator driving it via the API Console / MCP),
    // don't widen another agent's powers on the agent's say-so. Park it for
    // operator approval. On approval the same tool re-runs with NO agent
    // context (pending dispatch passes only ownerId) → this branch is skipped
    // and the grant applies. Validation above already ran, so we never queue
    // an unknown-agent / non-http / already-granted call. (Self-grant is hard-
    // refused earlier — it never reaches here.)
    if (ctx.agent) {
      const grantArgs = { agent_slug: agentSlug, group_slug: groupSlug };
      const [requester] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, ctx.agent.slug)))
        .limit(1);
      const [pending] = await db
        .insert(pendingToolCalls)
        .values({
          ownerId: ctx.ownerId,
          agentId: requester?.id ?? null,
          toolSlug: 'agent_grant_tool_group',
          args: grantArgs,
        })
        .returning({ id: pendingToolCalls.id });
      if (pending?.id) {
        void notifyPendingCreated({
          ownerId: ctx.ownerId,
          pendingId: pending.id,
          toolSlug: 'agent_grant_tool_group',
          args: grantArgs,
          via: `agent ${ctx.agent.slug}`,
        });
      }
      return {
        ok: true,
        output: {
          status: 'queued_for_approval',
          pending_id: pending?.id ?? null,
          message:
            `Granting '${groupSlug}' to agent '${agentSlug}' needs operator approval. ` +
            `Queued at /pending; it applies once approved. Do not retry this turn.`,
        },
      };
    }

    await db
      .update(agents)
      .set({ toolGroupSlugs: [...current, groupSlug], updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    ctx.step?.setOutput({ agentSlug, groupSlug });
    return {
      ok: true,
      output: { agent_slug: agentSlug, group_slug: groupSlug, granted: true },
    };
  },
};

/* ───────────────────────────── exports ───────────────────────────── */

export const TOOLSMITH_TOOLS: BuiltinToolDef[] = [
  web_fetch,
  api_tool_list,
  api_tool_get,
  api_tool_create,
  api_tool_update,
  api_tool_delete,
  api_tool_test,
  api_key_refs,
  tool_catalog,
  recipe_tool_create,
  recipe_tool_test,
  tool_group_list,
  tool_group_ensure,
  agent_list,
  agent_grant_tool_group,
];

/** The full set, granted to the Toolsmith specialist via its tool group. */
export const TOOLSMITH_TOOL_SLUGS: readonly string[] = TOOLSMITH_TOOLS.map((t) => t.slug);
