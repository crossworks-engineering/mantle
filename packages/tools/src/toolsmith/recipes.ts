/**
 * Composable recipe tools and the catalog an author browses to build one.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { type ToolHandler } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';
import { createTool, listToolsForOwner } from '../crud';
import { dispatchViaBridge as dispatchTool } from '../dispatch-bridge';
import {
  classifyRecipeStepTool,
  collectRecipeParams,
  parseRecipeSteps,
  recipeVerdictReason,
  RECIPE_FORBIDDEN_SLUGS,
} from '../recipe';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import { SLUG_RE, rec, reservedSlugError, toolRowBySlug } from './common';

export const tool_catalog: BuiltinToolDef = {
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

export const recipe_tool_create: BuiltinToolDef = {
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
      const msg = errorMessage(err);
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

export const recipe_tool_test: BuiltinToolDef = {
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
