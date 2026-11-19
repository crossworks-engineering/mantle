/**
 * The model check over MCP (admin settings are never screen-only): does
 * this box run the shipped default model on each worker and manifest
 * agent? The same report as GET /api/config/models, through the model
 * check bridge (model-check-bridge.ts). Read-only: it never changes a row.
 *
 * `mcpOnly`: an Admin user's own client; no in-brain agent is granted it.
 * The settings area, run whole (a worker is the box's, not a workspace's).
 */
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { getModelCheckProvider, MODEL_CHECK_UNAVAILABLE } from './model-check-bridge';

export const config_models_check: BuiltinToolDef = {
  slug: 'config_models_check',
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
  name: 'Check models against the defaults',
  description:
    "Report whether this box runs the shipped default model on each AI worker (by kind) and each shipped agent (by slug): per row the status (`ok`, `drift`, `missing`, `off`), the box's provider and model, and the default's. `notOk` counts the rows not `ok`. Read-only: a box's model is its operator's choice and nothing here changes one (Settings > AI workers and Agents do).",
  inputSchema: {
    type: 'object',
    properties: {
      only_not_ok: {
        type: 'boolean',
        description: 'true returns only the rows not `ok`.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const p = getModelCheckProvider();
    if (!p) return { ok: false, error: MODEL_CHECK_UNAVAILABLE };
    const report = await p(ctx.ownerId);
    if (input.only_not_ok === true) {
      return {
        ok: true,
        output: { ...report, rows: report.rows.filter((r) => r.status !== 'ok') },
      };
    }
    return { ok: true, output: report };
  },
};

/** Registered on the MCP surface (build-server.ts); no agent is granted it. */
export const MODEL_CHECK_TOOLS: readonly BuiltinToolDef[] = [config_models_check];
