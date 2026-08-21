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
import {
  db,
  agents,
  pendingToolCalls,
  skills,
  toolGroups,
  tools,
  type ToolHandler,
} from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { appUrl, loadProfilePreferences } from '@mantle/content';
import { parseTikaBytes } from '@mantle/files';
import { createTool, deleteTool, listToolsForOwner, updateTool } from './crud';
import { dispatchTool } from './dispatch';
import { notifyPendingCreated } from './pending-notify';
import { collectParamNames, collectSecretRefs, refKey, type HttpHandler } from './http-template';
import {
  apiSkillSlugForGroup,
  applyIntegrationInheritance,
  describeInheritance,
  getGroupIntegration,
  parseIntegrationMeta,
  readApiDocsFile,
  setGroupIntegration,
  upsertApiDocsFile,
  API_DOCS_MAX_CHARS,
  type InheritedPieces,
  type ToolGroupIntegration,
} from './integration';
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
import { str } from './coerce';

/* ───────────────────────────── helpers ───────────────────────────── */

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

/** Slugs no authored tool may take (final audit F2). `pending_approve` /
 *  `pending_reject` branch on these BEFORE tool resolution — a
 *  `requires_confirm` tool squatting one would let an agent mint pending
 *  rows whose args (`item_id` / `run_id`) reach the runner's answer/budget
 *  paths under an operator click that looks like an ordinary approval.
 *  Neither is a registered tool (by design), so only this reservation
 *  prevents the collision. Owner scoping inside applyHumanAnswer /
 *  applyBudgetDecision is the second layer. */
const RESERVED_PENDING_SLUGS: ReadonlySet<string> = new Set(['ask_human', 'run_budget']);

function reservedSlugError(slug: string): ToolHandlerResult | null {
  if (!RESERVED_PENDING_SLUGS.has(slug)) return null;
  return {
    ok: false,
    error:
      `slug '${slug}' is reserved for runner-queue approval rows (engine-created; ` +
      `the pending approve/reject handlers branch on it) — pick another slug`,
  };
}

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

/**
 * Validate + assemble an http handler from model input. Shared by create/update.
 * Returns an error string on the first problem.
 *
 * When the tool joins an integration group (`opts.integration`), the group's
 * base URL + auth template fold in HERE, at authoring time: a relative `url` is
 * joined onto the base and the group's headers/query merge UNDER the tool's own
 * (the tool wins on conflict). What comes back is what gets STORED, so the
 * dispatcher is untouched and `api_tool_get` shows exactly what will run.
 */
function buildHandlerFromInput(
  input: Record<string, unknown>,
  opts?: { base?: HttpHandler; integration?: ToolGroupIntegration | null },
): { handler: HttpHandler; inherited: InheritedPieces } | { error: string } {
  const base = opts?.base;
  const url = str(input.url).trim() || base?.url || '';
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

  // Inheritance + the absolute-url check in one place: with no group this is
  // exactly the old rule (url must be http(s):// with no spaces); with a group
  // a relative path is joined onto its base and its auth merges underneath.
  const resolved = applyIntegrationInheritance(opts?.integration ?? null, {
    url,
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
  });
  if (!resolved.ok) return { error: resolved.error };

  return {
    handler: {
      kind: 'http',
      url: resolved.url,
      method: method as HttpHandler['method'],
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(resolved.query ? { query: resolved.query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    inherited: resolved.inherited,
  };
}

/**
 * Resolve `group_slug` on an authoring call: the group must already exist
 * (create it with `tool_group_ensure`), and its integration — if any — is what
 * the tool inherits. Returns null when no group_slug was passed.
 */
async function resolveAuthoringGroup(
  ownerId: string,
  input: Record<string, unknown>,
): Promise<
  | { ok: true; group: Awaited<ReturnType<typeof getGroupIntegration>> | null }
  | { ok: false; error: string }
> {
  const slug = str(input.group_slug).trim();
  if (!slug) return { ok: true, group: null };
  const group = await getGroupIntegration(ownerId, slug);
  if (!group) {
    return {
      ok: false,
      error: `tool group '${slug}' not found — list the real ones with tool_group_list, or create it (with its service/base_url/secret_ref) using tool_group_ensure before authoring into it`,
    };
  }
  return { ok: true, group };
}

/** Add a tool slug to a group's list (idempotent). The group is known to exist. */
async function addToolToGroup(ownerId: string, groupSlug: string, toolSlug: string): Promise<void> {
  const [existing] = await db
    .select({ id: toolGroups.id, toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!existing) return;
  const current = existing.toolSlugs ?? [];
  if (current.includes(toolSlug)) return;
  await db
    .update(toolGroups)
    .set({ toolSlugs: [...current, toolSlug], updatedAt: new Date() })
    .where(eq(toolGroups.id, existing.id));
}

/** Vault-presence check for a group's `secret_ref` — a warning, not a failure,
 *  mirroring `api_tool_create`'s missing-ref warning. The owner adds keys. */
async function integrationWarnings(ownerId: string, meta: ToolGroupIntegration): Promise<string[]> {
  if (!meta.secretRef) return [];
  const vault = await listApiKeys(ownerId);
  const have = new Set(vault.map((k) => `${k.service}/${k.label}`));
  if (have.has(meta.secretRef)) return [];
  const [service, label] = meta.secretRef.split('/');
  return [
    `secret_ref '${meta.secretRef}' has no matching vault entry — ask the owner to add it under Settings → API keys (service '${service}', label '${label}'); until then every tool in this group will fail at call time`,
  ];
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
  readOnly: true,
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
  readOnly: true,
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
    'Pass group_slug to author INTO an integration group: its base URL and credential fold into the stored tool (your own headers/query win). ' +
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
      url: {
        type: 'string',
        description:
          'http(s) URL template, may contain {param}. With group_slug a path relative to the group base URL is fine, e.g. /weather',
      },
      group_slug: {
        type: 'string',
        description:
          'integration group this tool joins, e.g. weather-tools — the tool is added to the group and inherits its base URL + credential placement. Must already exist (`tool_group_ensure`)',
      },
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
    const reserved = reservedSlugError(slug);
    if (reserved) return reserved;
    const name = str(input.name).trim();
    const description = str(input.description).trim();
    if (!name || !description) return { ok: false, error: 'name and description are required' };
    const inputSchema = rec(input.input_schema) ?? { type: 'object', properties: {} };
    const resolvedGroup = await resolveAuthoringGroup(ctx.ownerId, input);
    if (!resolvedGroup.ok) return { ok: false, error: resolvedGroup.error };
    const group = resolvedGroup.group;
    const built = buildHandlerFromInput(input, { integration: group?.integration ?? null });
    if ('error' in built) return { ok: false, error: built.error };
    const { handler, inherited } = built;
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
      if (group) {
        await addToolToGroup(ctx.ownerId, group.slug, row.slug);
        if (group.integration)
          warnings.push(...(await integrationWarnings(ctx.ownerId, group.integration)));
      }
      ctx.step?.setOutput({ slug: row.slug, warnings });
      return {
        ok: true,
        output: {
          slug: row.slug,
          created: true,
          warnings,
          ...(group
            ? {
                group_slug: group.slug,
                added_to_group: true,
                inherited: describeInheritance(inherited),
                request: summarizeHandler(handler),
              }
            : {}),
          next: group
            ? `Test it with api_tool_test (the group's base URL + credential are already baked into the stored tool), then grant '${group.slug}' with agent_grant_tool_group.`
            : `Test it with api_tool_test, then add it to a group via tool_group_ensure and grant with agent_grant_tool_group.`,
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
    'Update a user-defined HTTP tool by slug. Provide only the fields to change; headers/query replace the whole map when given; body: null clears the template. Pass group_slug to (re)join an integration group — the tool is added to it and re-inherits its base URL + auth placement into the stored templates. Built-in tools only allow enabled/requires_confirm changes; shell tools cannot be edited by agents.',
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
      url: {
        type: 'string',
        description:
          'replacement http(s) URL template, may contain {param}; relative to the group base URL when group_slug is given',
      },
      group_slug: {
        type: 'string',
        description:
          'integration group this tool should belong to, e.g. weather-tools — adds it and re-applies the group base URL + credential placement',
      },
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

    const resolvedGroup = await resolveAuthoringGroup(ctx.ownerId, input);
    if (!resolvedGroup.ok) return { ok: false, error: resolvedGroup.error };
    const group = resolvedGroup.group;

    let inherited: InheritedPieces | null = null;
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
      const built = buildHandlerFromInput(input, {
        base: existing,
        integration: group?.integration ?? null,
      });
      if ('error' in built) return { ok: false, error: built.error };
      patch.handler = built.handler;
      inherited = built.inherited;
    }

    try {
      const updated = await updateTool(ctx.ownerId, row.id, patch);
      if (!updated) return { ok: false, error: `tool '${slug}' not found` };
      const warnings =
        updated.handler.kind === 'http'
          ? await handlerWarnings(ctx.ownerId, updated.handler as HttpHandler, updated.inputSchema)
          : [];
      if (group) {
        await addToolToGroup(ctx.ownerId, group.slug, slug);
        if (group.integration) {
          warnings.push(...(await integrationWarnings(ctx.ownerId, group.integration)));
        }
      }
      ctx.step?.setOutput({ slug, warnings });
      return {
        ok: true,
        output: {
          slug,
          updated: true,
          warnings,
          ...(group
            ? {
                group_slug: group.slug,
                ...(inherited ? { inherited: describeInheritance(inherited) } : {}),
                request: summarizeHandler(updated.handler as ToolHandler),
              }
            : {}),
        },
      };
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
  readOnly: true,
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

/* ────────────────── integration docs + usage skill ───────────────── */

const DEFAULT_DOCS_PAGE = 20_000;
const MAX_DOCS_PAGE = 60_000;

/** Resolve a group for a docs/skill call, with a teaching error when it's not
 *  there and a warning when it isn't an integration yet. */
async function groupForIntegrationWrite(
  ownerId: string,
  slug: string,
): Promise<
  | { ok: true; group: NonNullable<Awaited<ReturnType<typeof getGroupIntegration>>> }
  | { ok: false; error: string }
> {
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'group_slug must be lowercase letters/digits/dash/underscore' };
  }
  const group = await getGroupIntegration(ownerId, slug);
  if (!group) {
    return {
      ok: false,
      error: `tool group '${slug}' not found — list them with tool_group_list, or create it with tool_group_ensure (pass service/base_url/secret_ref to make it an integration) and then retry`,
    };
  }
  return { ok: true, group };
}

const api_docs_set: BuiltinToolDef = {
  slug: 'api_docs_set',
  name: "Store an integration's API docs",
  description:
    "Store (or REPLACE) an integration group's API documentation as a markdown file on this brain and point the group at it. Returns the stored size. Do this right after `web_fetch`ing a service's docs, before authoring: the next pass — any agent, months later — then reads `api_docs_get` instead of re-fetching a page that may have moved or gone behind auth. The stored copy is indexed, so every agent's `search_nodes` can find it. Keep the endpoint reference, auth scheme, parameters, and an example response; drop the marketing pages. Pass source_url so provenance is recorded.",
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group these docs belong to, e.g. weather-tools',
      },
      markdown: {
        type: 'string',
        description:
          "the documentation itself, as markdown — endpoints, auth, parameters, an example response. Replaces the whole file, so include everything you still want (read the old copy first with `api_docs_get` when you're extending)",
      },
      source_url: {
        type: 'string',
        description:
          'where it came from, e.g. https://openweathermap.org/api/one-call-3 — recorded in the file header so a later reader can refresh it',
      },
    },
    required: ['group_slug', 'markdown'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    const markdown = str(input.markdown);
    if (markdown.trim().length < 40) {
      return {
        ok: false,
        error:
          'markdown is empty or too short to be documentation — pass the endpoint reference you read (web_fetch the docs first, following offset for long pages)',
      };
    }
    const sourceUrl = str(input.source_url).trim();
    if (sourceUrl && !URL_RE.test(sourceUrl)) {
      return {
        ok: false,
        error: 'source_url must start with http(s):// — omit it if you have none',
      };
    }

    const warnings: string[] = [];
    // A group with no integration yet still gets its docs — recording the
    // service from the slug beats refusing and losing the fetched page. Say so.
    const service = group.integration?.service ?? groupSlug;
    if (!group.integration) {
      warnings.push(
        `group '${groupSlug}' had no integration binding — recorded service '${service}'. Set the real service, base_url and secret_ref with tool_group_ensure, or tools authored into this group inherit no credential`,
      );
    }
    if (markdown.length > API_DOCS_MAX_CHARS) {
      warnings.push(
        `docs were clipped to fit the stored file — keep the endpoint reference and drop prose if anything important is missing`,
      );
    }

    try {
      const stored = await upsertApiDocsFile({
        ownerId: ctx.ownerId,
        groupSlug,
        markdown,
        service,
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      await setGroupIntegration(ctx.ownerId, groupSlug, {
        service,
        docsNodeId: stored.nodeId,
        docsUpdatedAt: stored.capturedAt,
        ...(sourceUrl ? { docsSourceUrl: sourceUrl } : {}),
      });
      ctx.step?.setOutput({ groupSlug, file: stored.filename, chars: stored.chars });
      return {
        ok: true,
        output: {
          group_slug: groupSlug,
          file: `files/api-docs/${stored.filename}`,
          chars: stored.chars,
          stored: true,
          warnings,
          next: 'Author calls with group_slug so they inherit the base URL + credential, then distil what you learned into the usage skill with api_skill_set.',
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const api_docs_get: BuiltinToolDef = {
  slug: 'api_docs_get',
  readOnly: true,
  name: "Read an integration's stored API docs",
  description:
    "Read back the API documentation stored on an integration group — the markdown `api_docs_set` saved, in slices (pass offset to continue). **Read this FIRST when adding a call to an existing integration**: it's this brain's captured copy, so it costs nothing and can't have moved. Use `web_fetch` only when a group has no stored docs or they don't cover the endpoint you need — then `api_docs_set` the refreshed copy back. Returns has_docs false (not an error) when nothing is stored, plus where the copy came from and when it was captured, so you can judge staleness.",
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group whose docs to read, e.g. weather-tools',
      },
      offset: {
        type: 'number',
        description: 'character offset to resume from when the previous slice was truncated',
        default: 0,
        minimum: 0,
      },
      max_chars: {
        type: 'number',
        description: 'size of the slice to return',
        default: DEFAULT_DOCS_PAGE,
        minimum: 1_000,
        maximum: MAX_DOCS_PAGE,
      },
    },
    required: ['group_slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    const meta = group.integration;
    const noDocs = (note: string): ToolHandlerResult => ({
      ok: true,
      output: {
        group_slug: groupSlug,
        has_docs: false,
        note,
        next: "web_fetch the service's documentation, then store it with api_docs_set so the next pass doesn't have to.",
      },
    });
    if (!meta?.docsNodeId)
      return noDocs('no documentation has been stored for this integration yet');

    const file = await readApiDocsFile({ ownerId: ctx.ownerId, nodeId: meta.docsNodeId });
    if (!file) {
      return noDocs(
        'the stored docs file is gone (deleted from Files) — the group still points at it',
      );
    }
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const cap = Math.min(
      MAX_DOCS_PAGE,
      Math.max(1_000, Math.floor(Number(input.max_chars) || DEFAULT_DOCS_PAGE)),
    );
    const slice = file.text.slice(offset, offset + cap);
    ctx.step?.setMeta({ groupSlug, totalChars: file.text.length, offset });
    return {
      ok: true,
      output: {
        group_slug: groupSlug,
        has_docs: true,
        service: meta.service,
        base_url: meta.baseUrl ?? null,
        secret_ref: meta.secretRef ?? null,
        source_url: meta.docsSourceUrl ?? null,
        captured_at: meta.docsUpdatedAt ?? null,
        file: `files/api-docs/${file.filename}`,
        text: slice,
        offset,
        total_chars: file.text.length,
        truncated: offset + cap < file.text.length,
      },
    };
  },
};

/** Usage-skill body bounds. The skill ships in the system prompt of EVERY agent
 *  granted the group, on every turn — a long one is a permanent tax, so the cap
 *  is a hard refusal and the soft bound is a warning. */
const MAX_SKILL_BODY_CHARS = 6_000;
const SOFT_SKILL_WORDS = 320;

/**
 * The ONLY skill-authoring tool in the codebase — and its narrow scope is the
 * safety property, not a convenience. An agent must never be able to edit
 * persona/manifest behaviour, so this tool:
 *
 *   - derives the slug (`api-<group-slug>`) from the group; the model cannot
 *     name the row it writes,
 *   - refuses a group with no integration binding, so it only ever touches an
 *     API integration's own skill,
 *   - refuses when a row with that slug exists but ISN'T already linked to this
 *     integration — that row belongs to the operator (or the manifest), and
 *     overwriting it is exactly the escalation this guard exists to prevent.
 *
 * Hence no `slug` parameter and no update-by-id path: there is nothing else it
 * can reach. (Mutation → gated behind MANTLE_MCP_TOOLSMITH_WRITE on MCP.)
 */
const api_skill_set: BuiltinToolDef = {
  slug: 'api_skill_set',
  name: "Write an integration's usage skill",
  description:
    'Write (or replace) the short USAGE skill that travels with an integration group: distilled judgment — which endpoint answers which question, unit and date conventions, how to chain two calls, how to read the response. Every agent granted the group gets this in its context on every turn, so keep it tight and never paste the reference docs in (those live in `api_docs_set`; this is what you learned USING them). Do it last, after the calls test green. Creates/updates one skill per group and links it, so calling twice revises rather than forking.',
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group this skill belongs to, e.g. weather-tools',
      },
      body: {
        type: 'string',
        description:
          'the skill in markdown, ~150–250 words: when to reach for each tool, the conventions a caller gets wrong (units, timezones, id lookups), and per-tool notes where one call needs special handling',
      },
      name: {
        type: 'string',
        description:
          'display name for the skill, e.g. "Weather API usage" — defaults to the group name plus "usage"',
      },
    },
    required: ['group_slug', 'body'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    // Integration-only by construction: no binding, no skill. Keeps this tool
    // categorically unable to author a general-purpose behaviour pack.
    if (!group.integration) {
      return {
        ok: false,
        error: `tool group '${groupSlug}' is not an integration — this tool only writes an API integration's own usage skill. Bind it first with tool_group_ensure (service, base_url, secret_ref, auth_template); a general behaviour skill is the owner's to write in Settings → Skills`,
      };
    }
    const body = str(input.body).trim();
    if (body.length < 80) {
      return {
        ok: false,
        error:
          'body is too short to be useful know-how — say which tool answers which question and the conventions a caller gets wrong (units, timezones, id lookups)',
      };
    }
    if (body.length > MAX_SKILL_BODY_CHARS) {
      return {
        ok: false,
        error: `body is ${body.length} characters — this ships in every granted agent's prompt on every turn, so trim it to the judgment (the reference belongs in api_docs_set)`,
      };
    }
    const warnings: string[] = [];
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words > SOFT_SKILL_WORDS) {
      warnings.push(
        `the skill is ${words} words — it rides in every granted agent's prompt on every turn; cut anything a reader could look up in the stored docs`,
      );
    }
    if (group.toolSlugs.length === 0) {
      warnings.push(
        `group '${groupSlug}' has no tools yet — write the skill AFTER authoring and testing the calls, or it describes usage of nothing`,
      );
    }
    if (!group.integration.docsNodeId) {
      warnings.push(
        `no API documentation is stored on this group — api_docs_set it too, so the next pass can extend the integration without re-fetching the vendor's site`,
      );
    }

    // The slug is DERIVED, never model-supplied: one skill per group, and no way
    // to name a different row.
    const skillSlug = apiSkillSlugForGroup(groupSlug);
    const name = str(input.name).trim() || `${group.name} usage`;
    const description = `How to use the ${group.integration.service} integration's tools — written by Toolsmith from the stored API docs.`;
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.ownerId, ctx.ownerId), eq(skills.slug, skillSlug)))
      .limit(1);
    // A row under this slug that this integration doesn't already point at is
    // someone else's (operator-authored, or a manifest skill). Refuse rather
    // than overwrite — an agent must not be able to rewrite behaviour it doesn't
    // own, and silently clobbering a persona skill is the worst version of that.
    if (existing && group.integration.skillSlug !== skillSlug) {
      return {
        ok: false,
        error: `a skill '${skillSlug}' already exists but isn't linked to this integration — it belongs to the owner (or ships with the product), so I won't overwrite it. Ask the owner to rename or remove it in Settings → Skills, then retry`,
      };
    }
    if (existing) {
      await db
        .update(skills)
        .set({ name, description, instructions: body, updatedAt: new Date() })
        .where(eq(skills.id, existing.id));
    } else {
      await db.insert(skills).values({
        ownerId: ctx.ownerId,
        slug: skillSlug,
        name,
        description,
        instructions: body,
        enabled: true,
      });
    }
    await setGroupIntegration(ctx.ownerId, groupSlug, { skillSlug });
    ctx.step?.setOutput({ groupSlug, skillSlug, words });
    return {
      ok: true,
      output: {
        group_slug: groupSlug,
        skill_slug: skillSlug,
        created: !existing,
        words,
        warnings,
        note: `Every agent granted '${groupSlug}' now carries this skill in its context — no separate attach step.`,
      },
    };
  },
};

/* ─────────────────────────── recipe tools ────────────────────────── */

const tool_catalog: BuiltinToolDef = {
  slug: 'tool_catalog',
  readOnly: true,
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
    const reserved = reservedSlugError(slug);
    if (reserved) return reserved;
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
  readOnly: true,
  name: 'List tool groups',
  description:
    'List tool groups (capability bundles agents are granted): slug, tool slugs, and which agents currently grant each group. A group bound to an API also reports its integration — service, base URL, vault ref, whether documentation is stored, and its usage skill. Start here when extending an existing integration: find the group, then `api_docs_get` its stored docs.',
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
          // The binding, when this group IS an API integration. Refs only — a
          // secret_ref is a vault pointer, the same string api_key_refs returns.
          integration: g.integration
            ? {
                service: g.integration.service,
                base_url: g.integration.baseUrl ?? null,
                secret_ref: g.integration.secretRef ?? null,
                auth_template: g.integration.authTemplate ?? null,
                has_stored_docs: !!g.integration.docsNodeId,
                docs_captured_at: g.integration.docsUpdatedAt ?? null,
                skill_slug: g.integration.skillSlug ?? null,
              }
            : null,
        })),
      },
    };
  },
};

const tool_group_ensure: BuiltinToolDef = {
  slug: 'tool_group_ensure',
  name: 'Create or update a tool group',
  description:
    "Create a tool group if it doesn't exist, or update its tool list. mode 'add' (default) merges slugs in; 'replace' overwrites the list. Unknown tool slugs are reported as warnings, not errors. " +
    'Pass `service` (+ `base_url` / `secret_ref` / `auth_template`) to make the group an INTEGRATION: auth placement and the base URL are decided ONCE here, and every tool later authored with group_slug inherits them. ' +
    'Then `api_docs_set` the API documentation onto the same group so the next authoring pass reads it instead of the web.',
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
      service: {
        type: 'string',
        description:
          "vendor key for the API this group integrates, e.g. 'openweathermap' — set it (with the fields below) to turn a plain bundle into an integration",
      },
      base_url: {
        type: 'string',
        description:
          'URL every call in this group hangs off, e.g. https://api.openweathermap.org/data/2.5 — authored tools may then use relative paths',
      },
      secret_ref: {
        type: 'string',
        description:
          "vault entry that authenticates this API as 'service/label', e.g. openweathermap/default — list the real ones with `api_key_refs` and ask the user when two could fit",
      },
      auth_template: {
        type: 'object',
        description:
          'WHERE the credential goes: { "query": { "appid": "{{secret:openweathermap/default}}" } } or { "headers": { "Authorization": "Bearer {{secret:svc/default}}" } }',
        properties: {
          headers: { type: 'object', description: 'header name → value template' },
          query: { type: 'object', description: 'query key → value template' },
        },
      },
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

    // Integration binding. Only touched when the call carries one of its fields,
    // so a plain capability-bundle ensure leaves `integration` NULL as before.
    // Merged onto whatever is already there: re-declaring auth must not drop the
    // docs pointer, and attaching docs must not require restating the service.
    const wantsIntegration =
      input.service !== undefined ||
      input.base_url !== undefined ||
      input.secret_ref !== undefined ||
      input.auth_template !== undefined;
    let integration: ToolGroupIntegration | null = existing?.integration ?? null;
    if (wantsIntegration) {
      const parsed = parseIntegrationMeta({
        ...(integration ?? {}),
        ...(input.service !== undefined ? { service: str(input.service).trim() } : {}),
        ...(input.base_url !== undefined ? { base_url: input.base_url } : {}),
        ...(input.secret_ref !== undefined ? { secret_ref: input.secret_ref } : {}),
        ...(input.auth_template !== undefined ? { auth_template: input.auth_template } : {}),
      });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      integration = parsed.value;
      warnings.push(...parsed.warnings);
      warnings.push(...(await integrationWarnings(ctx.ownerId, integration)));
    }

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
          ...(wantsIntegration ? { integration } : {}),
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
        ...(integration ? { integration } : {}),
        enabled: true,
      });
    }
    ctx.step?.setOutput({ slug, toolSlugs, warnings });
    return {
      ok: true,
      output: {
        slug,
        created: !existing,
        tool_slugs: toolSlugs,
        warnings,
        ...(integration
          ? {
              integration: {
                service: integration.service,
                base_url: integration.baseUrl ?? null,
                secret_ref: integration.secretRef ?? null,
                auth_template: integration.authTemplate ?? null,
                has_stored_docs: !!integration.docsNodeId,
                skill_slug: integration.skillSlug ?? null,
              },
              next: integration.docsNodeId
                ? 'Author calls with group_slug so they inherit the base URL + credential, then api_tool_test.'
                : 'Store the API documentation on this group with api_docs_set, then author calls with group_slug so they inherit the base URL + credential.',
            }
          : {}),
      },
    };
  },
};

const agent_list: BuiltinToolDef = {
  slug: 'agent_list',
  readOnly: true,
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
          // Clickable settings deep link — opens this agent's editor.
          url: appUrl(`/settings/agents?selected=${encodeURIComponent(a.slug)}`),
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
  api_docs_set,
  api_docs_get,
  api_skill_set,
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
