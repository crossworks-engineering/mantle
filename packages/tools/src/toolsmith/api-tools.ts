/**
 * The HTTP API tool CRUD surface: list, get, create, update, delete,
 * test, plus the masked vault key references authoring needs.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { type ToolHandler } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { loadProfilePreferences } from '@mantle/content';
import { createTool, deleteTool, listToolsForOwner, updateTool } from '../crud';
import { dispatchViaBridge as dispatchTool } from '../dispatch-bridge';
import { type HttpHandler } from '../http-template';
import { describeInheritance, type InheritedPieces } from '../integration';
import { isMcpManagedSecretService } from '../mcp-oauth';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import {
  SLUG_RE,
  addToolToGroup,
  buildHandlerFromInput,
  handlerWarnings,
  integrationWarnings,
  rec,
  reservedSlugError,
  resolveAuthoringGroup,
  summarizeHandler,
  toolRowBySlug,
} from './common';

const TEMPLATE_DOC =
  'Templating: {param} placeholders in url/query/headers/body fill from the tool-call input ' +
  '(URL-encoded in the url, JSON-encoded in the body — write "q": {query}, not "q": "{query}"). ' +
  '{{secret:service/label}} refs decrypt from the API-key vault at call time (list them with api_key_refs). ' +
  'Input fields no template consumes are sent as a JSON body (non-GET) or query params (GET).';

export const api_tool_list: BuiltinToolDef = {
  slug: 'api_tool_list',
  readOnly: true,
  name: 'List registered tools',
  description:
    'List every tool in the registry (builtin, http, shell, recipe, mcp): slug, kind, enabled, requires_confirm, and a short description. Use api_tool_get for full details of one tool.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'optional substring filter on slug/name/description' },
      kind: {
        type: 'string',
        enum: ['builtin', 'http', 'shell', 'recipe', 'mcp'],
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

export const api_tool_get: BuiltinToolDef = {
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

export const api_tool_create: BuiltinToolDef = {
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
      const msg = errorMessage(err);
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

export const api_tool_update: BuiltinToolDef = {
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

    const isOpenapiMirror = existing.kind === 'http' && !!existing.openapi;
    if (group && (existing.kind === 'mcp' || isOpenapiMirror)) {
      return {
        ok: false,
        error:
          "connector-mirrored tools stay in their connector's group — group_slug cannot re-home or bundle them",
      };
    }

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
      if (existing.kind === 'mcp') {
        return {
          ok: false,
          error:
            "mcp connector tools mirror the remote server — edit the connector's binding and re-run its sync instead of patching the tool (enabled/requires_confirm can still toggle here)",
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
      if (isOpenapiMirror && touchesDefinition) {
        warnings.push(
          "this tool is mirrored from an OpenAPI spec — your edit is recorded as hand-made and the connector's sync will preserve it (re-sync with overwrite_edited to restore the spec version)",
        );
      }
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const api_tool_delete: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const api_tool_test: BuiltinToolDef = {
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

export const api_key_refs: BuiltinToolDef = {
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
        keys: keys
          // Connector-sealed OAuth state (live tokens under 'mcp-*') is never
          // a template credential — the dispatcher refuses such refs too.
          .filter((k) => !isMcpManagedSecretService(k.service))
          .map((k) => ({
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
