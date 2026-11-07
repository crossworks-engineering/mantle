/**
 * The HTTP API tool CRUD surface: list, get, create, update, delete,
 * test, plus the masked vault key references authoring needs.
 */

import { isUniqueViolation, type ToolHandler } from '@mantle/db';
import { areaSystem } from '../admin-gate';
import { inheritedToolMaker, secretRefsWriteRefusal, toolMaker } from '../secret-ref-gate';
import { listApiKeys } from '@mantle/api-keys';
import { loadProfilePreferences } from '@mantle/content';
import { createTool, deleteTool, listToolsForOwner, toolDeleteRefusal, updateTool } from '../crud';
import { dispatchViaBridge as dispatchTool } from '../dispatch-bridge';
import { type HttpHandler } from '../http-template';
import { describeInheritance, type InheritedPieces } from '../integration';
import { isMcpManagedSecretService } from '../mcp-oauth';
import { type BuiltinToolDef, type ToolHandlerContext, type ToolHandlerResult } from '../types';
import { isPersonCall } from '../person-only-acts';
import { ownerSurfaceLoginId } from '../surface';
import {
  setToolExternalAccess,
  externalAccessSummary,
  type ExternalAccessOffActor,
} from '../external-access';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import {
  SLUG_RE,
  TEST_MAY_WAIT,
  actsAtOnce,
  addToolToGroup,
  buildHandlerFromInput,
  groupListRefusal,
  groupsHoldingTool,
  handlerWarnings,
  heldGroupDoor,
  integrationWarnings,
  rec,
  reservedSlugError,
  resolveAuthoringGroup,
  summarizeHandler,
  switchedOffError,
  toolRowBySlug,
  waitForPerson,
} from './common';
import { CS } from '../client-sourced-rule';

const TEMPLATE_DOC =
  'Templating: {param} placeholders in url/query/headers/body fill from the tool-call input ' +
  '(URL-encoded in the url, JSON-encoded in the body — write "q": {query}, not "q": "{query}"). ' +
  '{{secret:service/label}} refs decrypt from the API-key vault at call time (list them with api_key_refs). ' +
  'Input fields no template consumes are sent as a JSON body (non-GET) or query params (GET).';

export const api_tool_list: BuiltinToolDef = {
  slug: 'api_tool_list',
  usageTier: 2,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
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
        ...(t.externalAccess?.on ? { external_access: true } : {}),
        description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
      }));
    ctx.step?.setMeta({ count: out.length });
    return { ok: true, output: { tools: out, count: out.length } };
  },
};

export const api_tool_get: BuiltinToolDef = {
  slug: 'api_tool_get',
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
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
        external_access: externalAccessSummary(row),
      },
    };
  },
};

const alreadyExists = (slug: string): ToolHandlerResult => ({
  ok: false,
  error: `a tool with slug '${slug}' already exists — use api_tool_update`,
});

export const api_tool_create: BuiltinToolDef = {
  slug: 'api_tool_create',
  usageTier: 3,
  optIn: 'toolsmithWrite',
  policy: {
    matrix: { none: 'a tool is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: { kind: 'write', groups: ['group_slug'] },
  },
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
          "integration group this tool joins, e.g. weather-tools — the tool is added to the group and inherits its base URL + credential placement. Must already exist (`tool_group_ensure`). An in-brain agent joining a group an assistant of another workspace than Admin holds waits for the operator's approval (Pending); an MCP client acts at once",
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
    // A template that sends a vault key needs the keys area.
    const keysRefused = await secretRefsWriteRefusal(handler);
    if (keysRefused) return { ok: false, error: keysRefused };
    // Refused before the door: a call that cannot run never waits.
    if (await toolRowBySlug(ctx.ownerId, slug)) return alreadyExists(slug);
    // The groups a new tool reaches: the one it joins, and any whose list names
    // this slug.
    const door = await heldGroupDoor(
      ctx,
      [...(group ? [group.slug] : []), ...(await groupsHoldingTool(ctx.ownerId, slug))],
      { toolSlug: 'api_tool_create', args: input },
    );
    if (!door.open) return door.result;
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
        createdBy: inheritedToolMaker(toolMaker(ctx.ownerId), group, handler),
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
            ? `Test it with api_tool_test (the group's base URL + credential are already baked into the stored tool), then grant '${group.slug}' with agent_grant_tool_group. ${TEST_MAY_WAIT}`
            : `Test it with api_tool_test, then add it to a group via tool_group_ensure and grant with agent_grant_tool_group. ${TEST_MAY_WAIT}`,
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      if (isUniqueViolation(err)) {
        return alreadyExists(slug);
      }
      return { ok: false, error: msg };
    }
  },
};

/** Who switched "External access" on or off through this tool: a person who
 *  approved a held call, naming them; a person in the dev tool console; or an
 *  agent, which only ever switches it off (person-only-acts.ts refused its on
 *  before this ran), named by the login it serves. */
function externalAccessActor(ctx: ToolHandlerContext): ExternalAccessOffActor {
  const login = ownerSurfaceLoginId(ctx.surface);
  const named = login ? { actorId: login } : {};
  if (!isPersonCall(ctx)) return { via: 'agent', ...named };
  if (ctx.caller?.entry !== 'pending') return { via: 'dev-tools', ...named };
  const approver = ctx.caller.approval?.approver;
  return { via: 'pending', ...(approver ? { actorId: approver } : {}) };
}

export const api_tool_update: BuiltinToolDef = {
  slug: 'api_tool_update',
  optIn: 'toolsmithWrite',
  policy: {
    destructive: true, // headers and query replace the whole map; no revision
    matrix: { none: 'a tool is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors' },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: { kind: 'write', groups: ['group_slug'], tools: ['slug'] },
  },
  name: 'Update an HTTP API tool',
  description:
    "Update a user-defined HTTP tool by slug, with only the fields to change; headers/query replace the whole map; body: null clears the template. Pass group_slug to join a group; its auth placement folds into the stored templates only when the same call changes a definition field, and its base URL only with a relative `url`. Built-ins allow only enabled/requires_confirm changes; agents cannot edit shell tools. An agent may tighten a gate, never loosen one: `requires_confirm: false`, `enabled: true` and `external_access: true` are a person's, in Settings > Tools. A group holds only http and recipe tools. On a group another workspace holds, an in-brain agent's join or definition edit waits for approval (Pending); an MCP client acts at once.",
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
          'integration group this tool should belong to, e.g. weather-tools: adds it. The group base URL and credential placement fold in only with a definition field in the same call (the base URL with a relative `url`)',
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
          'true parks calls for operator approval. false clears the gate, which a person does in Settings > Tools: an agent sending it is refused. With the owner\'s "require approval for agent-built tools" on, an agent\'s definition edit turns it back on.',
      },
      enabled: {
        type: 'boolean',
        description:
          'false disables the tool without deleting it. true turns it back on, which a person does in Settings > Tools: an agent sending it is refused.',
      },
      external_access: {
        type: 'boolean',
        description:
          "\"External access\". On an http tool: true lets everyone an app that declares it is shared with (members, clients, contacts on a contact link) call it, by hand too, with any input; false closes it. On an mcp connector tool: the read-only mark (true = reads). A person's false clears the mark; an agent's false leaves it for a person to mark again. Never for recipe or shell tools. true is a person's, in Settings > Tools: an agent sending it is refused.",
      },
      read_only_confirmed: {
        type: 'boolean',
        description:
          'with external_access: true, the person confirms the tool only reads data (the brain cannot check an outside tool). Required to switch on.',
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
    if (existing.kind === 'shell') {
      return { ok: false, error: 'shell tools are human-only — edit them in Settings → Tools' };
    }

    const patch: Parameters<typeof updateTool>[2] = {};
    // Who may send which value is the one check's, at dispatch
    // (person-only-acts.ts). Only a boolean changes a column.
    if (input.requires_confirm === true || input.requires_confirm === false) {
      patch.requiresConfirm = input.requires_confirm;
    }
    if (input.enabled === true || input.enabled === false) patch.enabled = input.enabled;

    // The group row is this area's system table: read whole, whatever this scope
    // sees of an integration group.
    const resolvedGroup = await areaSystem('connectors', () =>
      resolveAuthoringGroup(ctx.ownerId, input),
    );
    if (!resolvedGroup.ok) return { ok: false, error: resolvedGroup.error };
    const group = resolvedGroup.group;

    const isOpenapiMirror = existing.kind === 'http' && !!existing.openapi;

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
      // A template that sends a vault key needs the keys area, and the tool
      // is then the writer's: its refs resolve while the writer holds that
      // area.
      const keysRefused = await secretRefsWriteRefusal(built.handler);
      if (keysRefused) return { ok: false, error: keysRefused };
      patch.handler = built.handler;
      patch.createdBy = inheritedToolMaker(toolMaker(ctx.ownerId), group, built.handler);
      inherited = built.inherited;
    }

    // The group's list and the tool rows are this area's system tables: read
    // whole, whatever this scope sees of them.
    if (group) {
      const refused = await areaSystem('connectors', () => groupListRefusal(ctx.ownerId, [slug]));
      if (refused) return refused;
    }
    // A definition edit reaches the holders of every group that holds the tool;
    // joining reaches the holders of the one it joins. One ask for them all. A
    // flag with no definition edit asks nothing: an agent may tighten.
    const door = await areaSystem('connectors', async () =>
      heldGroupDoor(
        ctx,
        [
          ...(touchesDefinition ? await groupsHoldingTool(ctx.ownerId, slug) : []),
          ...(group && !group.toolSlugs.includes(slug) ? [group.slug] : []),
        ],
        { toolSlug: 'api_tool_update', args: input },
      ),
    );
    if (!door.open) return door.result;

    // As api_tool_create: with "require approval for agent-built tools" on, what
    // an agent wrote starts gated. A person's call does not: an approval looked
    // at the whole call. The owner's profile row, read on this area's route.
    if (touchesDefinition && !isPersonCall(ctx)) {
      const prefs = await areaSystem('connectors', () => loadProfilePreferences(ctx.ownerId));
      if (prefs.toolsmithRequireApproval) patch.requiresConfirm = true;
    }

    try {
      // The tool row, its group and its External access are this area's
      // own system tables (no workspace role writes them): areaSystem, the
      // area asked again, as api_tool_create's whole run is.
      const updated = await areaSystem('connectors', () => updateTool(ctx.ownerId, row.id, patch));
      if (!updated) return { ok: false, error: `tool '${slug}' not found` };
      // The warnings read the key vault, a system table too: areaSystem.
      const warnings =
        updated.handler.kind === 'http'
          ? await areaSystem('connectors', () =>
              handlerWarnings(ctx.ownerId, updated.handler as HttpHandler, updated.inputSchema),
            )
          : [];
      if (isOpenapiMirror && touchesDefinition) {
        warnings.push(
          "this tool is mirrored from an OpenAPI spec — your edit is recorded as hand-made and the connector's sync will preserve it (re-sync with overwrite_edited to restore the spec version)",
        );
      }
      if (group) {
        await areaSystem('connectors', () => addToolToGroup(ctx.ownerId, group.slug, slug));
        if (group.integration) {
          const integration = group.integration;
          warnings.push(
            ...(await areaSystem('connectors', () =>
              integrationWarnings(ctx.ownerId, integration),
            )),
          );
        }
      }
      let externalAccess = updated.externalAccess ?? null;
      if (input.external_access === true || input.external_access === false) {
        const set = await areaSystem('connectors', () =>
          setToolExternalAccess(ctx.ownerId, row.id, {
            allow: input.external_access === true,
            readOnlyConfirmed: input.read_only_confirmed === true,
            by: externalAccessActor(ctx),
          }),
        );
        if (!set.ok) return { ok: false, error: set.error };
        externalAccess = externalAccessSummary(set.tool);
      }
      ctx.step?.setOutput({ slug, warnings });
      return {
        ok: true,
        output: {
          slug,
          updated: true,
          ...(input.external_access !== undefined ? { external_access: externalAccess } : {}),
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
  usageTier: 3,
  optIn: 'toolsmithWrite',
  policy: {
    riskClass: 'delete', // removes a connector tool
    destructive: true, // the user-defined tool row is gone
    matrix: { none: 'a tool is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.free('removes a tool; hands nothing out'),
  },
  name: 'Delete a user-defined tool',
  description:
    "Delete a user-defined (http, recipe or shell) tool by slug and take its name out of every group list; a tool made again under that slug joins a group only through `tool_group_ensure` or group_slug. Built-ins cannot be deleted. Check tool_group_list first: deleting a tool other agents use breaks them silently. In a group another workspace holds, an in-brain agent's delete waits for approval (Pending); an MCP client acts at once.",
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
    // Refused before the door: a call that cannot run never waits.
    const refused = toolDeleteRefusal(row.handler as ToolHandler);
    if (refused) return { ok: false, error: refused };
    const door = await heldGroupDoor(ctx, await groupsHoldingTool(ctx.ownerId, slug), {
      toolSlug: 'api_tool_delete',
      args: input,
    });
    if (!door.open) return door.result;
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
  usageTier: 2,
  policy: {
    outside: { via: 'http' }, // runs a user-defined HTTP tool
    matrix: { none: 'a tool is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors' },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.always(CS.UNSEEN),
  },
  name: 'Test an HTTP API tool',
  description:
    "Execute an HTTP tool with the given input and return the real response — use after api_tool_create/update to prove the tool works before handing it to agents. Runs the exact dispatcher agents use (templating + vault secrets). Refuses builtin/shell tools. On a tool with requires_confirm on, an in-brain agent's test waits for approval (Pending); a person and an MCP client run it at once.",
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
    // The tool row is a system table: read after the
    // connectors area check. The test call itself runs in the caller's
    // scope, as the agents that will use the tool run it.
    const row = await areaSystem('connectors', () => toolRowBySlug(ctx.ownerId, slug));
    if (!row) return { ok: false, error: `tool '${slug}' not found` };
    const handler = row.handler as ToolHandler;
    if (handler.kind !== 'http') {
      return {
        ok: false,
        error: `api_tool_test only runs http tools — '${slug}' is ${handler.kind}`,
      };
    }
    if (!row.enabled) return { ok: false, error: switchedOffError(slug) };
    // Running a tool that sends a vault key is the keys area's, as writing
    // one is.
    const keysRefused = await secretRefsWriteRefusal(handler);
    if (keysRefused) return { ok: false, error: keysRefused };
    if (row.requiresConfirm && !actsAtOnce(ctx)) {
      return waitForPerson(
        ctx,
        { toolSlug: 'api_tool_test', args: input },
        `Tool '${slug}' has requires_confirm on: running it, in a test too, needs operator approval.`,
      );
    }
    const args = rec(input.input) ?? {};
    const t0 = performance.now();
    // The test call runs for whoever asked for the test: it inherits the
    // surface, and the caller (through the gate as the test ran).
    const result = await dispatchTool(row, args, {
      ownerId: ctx.ownerId,
      step: ctx.step,
      ...(ctx.surface ? { surface: ctx.surface } : {}),
      caller: ctx.caller,
    });
    const duration_ms = Math.round(performance.now() - t0);
    if (!result.ok) {
      return { ok: true, output: { slug, test_passed: false, error: result.error, duration_ms } };
    }
    return { ok: true, output: { slug, test_passed: true, duration_ms, response: result.output } };
  },
};

export const api_key_refs: BuiltinToolDef = {
  slug: 'api_key_refs',
  usageTier: 3,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'keys', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
  name: 'List vault key references',
  description:
    'List the encrypted vault entries: name, kind, target, tags, masked preview, and for a token the {{secret:service/label}} reference string for tool templates. Plaintext never leaves the vault. If the key the user wants is missing, ask them to add it under Settings → API keys.',
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
            name: k.name,
            kind: k.kind,
            service: k.service,
            label: k.label,
            masked: k.masked,
            target: k.target,
            tags: k.tags,
            // Only a token opens in a template (the vault's read paths).
            ...(k.kind === 'token' ? { ref: `{{secret:${k.service}/${k.label}}}` } : {}),
          })),
      },
    };
  },
};

/* ────────────────── integration docs + usage skill ───────────────── */
