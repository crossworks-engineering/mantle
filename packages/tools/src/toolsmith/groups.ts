/**
 * Tool groups and the agent grants that turn a group into an ability.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { and, eq } from 'drizzle-orm';
import { db, agents, pendingToolCalls, toolGroups } from '@mantle/db';
import { appUrl } from '@mantle/content';
import { listToolsForOwner } from '../crud';
import { notifyPendingCreated } from '../pending-notify';
import { parseIntegrationMeta, type ToolGroupIntegration } from '../integration';
import { AGENT_GRANTABLE_KINDS } from '../recipe';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { SLUG_RE, integrationWarnings } from './common';

export const tool_group_list: BuiltinToolDef = {
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

export const tool_group_ensure: BuiltinToolDef = {
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

    const ownerTools = await listToolsForOwner(ctx.ownerId);
    const kindBySlug = new Map(ownerTools.map((t) => [t.slug, t.handler.kind] as const));
    const mirrorSlugs = new Set(
      ownerTools.filter((t) => t.handler.kind === 'http' && t.handler.openapi).map((t) => t.slug),
    );

    // Hard stop: agents may only bundle agent-grantable tools (http + recipe).
    // A shell/builtin slug (e.g. the unrestricted `run_terminal`) would let a
    // later grant escalate an agent past the authoring boundary — refuse, don't warn.
    // Connector-mirrored tools (`mcp`, and http rows carrying openapi
    // provenance) are also refused here: their connector group's sync owns
    // membership, so they never get bundled into a second group.
    const nonGrantable = requested.filter(
      (s) =>
        mirrorSlugs.has(s) || (kindBySlug.has(s) && !AGENT_GRANTABLE_KINDS.has(kindBySlug.get(s)!)),
    );
    if (nonGrantable.length > 0) {
      return {
        ok: false,
        error: `tool groups may only contain http or recipe tools (connector-mirrored tools stay in their own connector group); refused: ${nonGrantable.join(', ')}`,
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

    // MCP connector groups are off-limits to ensure entirely: their SYNC owns
    // membership (a mode:'replace' here could silently empty a granted
    // connector), and the mcp- prefix is the connector namespace — creating a
    // plain group there would squat a future connector's slug.
    if (
      existing?.integration?.mcp ||
      existing?.integration?.openapi ||
      (!existing && (slug.startsWith('mcp-') || slug.startsWith('openapi-')))
    ) {
      return {
        ok: false,
        error: `'${slug}' is ${existing ? 'a connector group' : "in a reserved connector namespace ('mcp-' / 'openapi-')"} — its membership is owned by the connector sync; manage it via Settings → Connectors (or the connectors APIs), and pick another slug for a plain bundle`,
      };
    }

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

export const agent_list: BuiltinToolDef = {
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

export const agent_grant_tool_group: BuiltinToolDef = {
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
    // out http capabilities, so refuse to grant a group that holds anything
    // else. `mcp` connector tools are grantable — a connector group is a
    // normal capability bundle (and agent-initiated grants still park below
    // for operator approval) — they just can't be BUNDLED (see
    // tool_group_ensure's guard: sync owns connector-group membership).
    const kindBySlug = new Map(
      (await listToolsForOwner(ctx.ownerId)).map((t) => [t.slug, t.handler.kind] as const),
    );
    const nonGrantable = (group.toolSlugs ?? []).filter(
      (s) =>
        kindBySlug.has(s) &&
        !AGENT_GRANTABLE_KINDS.has(kindBySlug.get(s)!) &&
        kindBySlug.get(s) !== 'mcp',
    );
    if (nonGrantable.length > 0) {
      return {
        ok: false,
        error: `group '${groupSlug}' contains non-grantable tools (${nonGrantable.join(', ')}) — agents can only grant http/recipe/mcp tool groups`,
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
