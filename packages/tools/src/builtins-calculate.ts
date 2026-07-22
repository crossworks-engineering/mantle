/**
 * The calculator builtin.
 *
 * Why agents get this: models read a calculation reliably and evaluate one
 * unreliably, and the failure is silent — a wrong number is indistinguishable
 * from a right one in the output. This tool exists so no agent ever has to do
 * arithmetic in its head. It is unit-aware, so a dimensionally impossible
 * request errors instead of returning something plausible.
 *
 * Distinct from `formula_evaluate`, which computes a STORED model by id. This
 * is for a one-off expression.
 */

import { calculate } from '@mantle/content';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';

const calculate_tool: BuiltinToolDef = {
  slug: 'calculate',
  name: 'Calculate',
  description:
    'Evaluate a mathematical expression exactly and return the result, with units when the expression carries them. **Use this for any arithmetic you would otherwise do mentally** — multi-step sums, powers, roots, logs, percentages, unit conversions — because a mis-computed number reads exactly like a correct one. Understands units (`2 ft + 3 in`, `100 lbf/in^2` with `to: "kPa"`), and a dimensionally impossible request is an error rather than a plausible answer. For a stored calculation model, use `formula_evaluate` instead; for arithmetic across rows of a table, use `table_aggregate` or `table_sql`.',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          'A single expression, e.g. "0.61 * 50 * sqrt(2 * 32.2 * 100 / 50)" or "2 ft + 3 in". Assignment is not supported.',
      },
      to: {
        type: 'string',
        description: 'Convert the result to this unit, e.g. "kPa". Errors if the dimensions differ.',
      },
      precision: {
        type: 'integer',
        minimum: 1,
        maximum: 15,
        default: 14,
        description: 'Significant digits in the formatted result.',
      },
    },
    required: ['expression'],
  },
  handler: async (input) => {
    const expression = str(input.expression);
    const to = typeof input.to === 'string' && input.to.trim() ? input.to.trim() : undefined;
    const precision =
      typeof input.precision === 'number' && Number.isFinite(input.precision)
        ? Math.min(15, Math.max(1, Math.trunc(input.precision)))
        : undefined;

    const result = calculate(expression, { to, precision });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      output: {
        expression,
        result: result.result,
        value: result.value,
        unit: result.unit,
      },
    };
  },
};

export const CALCULATE_TOOLS: BuiltinToolDef[] = [calculate_tool];
export const CALCULATE_TOOL_SLUGS: readonly string[] = CALCULATE_TOOLS.map((t) => t.slug);
