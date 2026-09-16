/**
 * Tool-schema compatibility with STRICT providers.
 *
 * Google (Gemini, via OpenRouter) validates every function declaration before
 * the model runs and REJECTS the whole request when an array property has no
 * `items`: "GenerateContentRequest.tools[0].function_declarations[47]
 * .parameters.properties[params].items: missing field." Anthropic and OpenAI
 * accept the same schema, so an itemless array is invisible until an agent on
 * a Google model is handed the tool — then EVERY turn of that agent 400s, no
 * matter what it was asked (NATREF, 2026-09-16: Rea's delegation to the
 * pcms-analyst failed twice on `app_db_query.params`).
 *
 * The blast radius is the whole tool list, not the one broken tool: the
 * provider refuses the request outright. So this is a hard gate.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLS } from './builtins';

function itemlessArrays(schema: unknown, path: string, out: string[]) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  if (node.type === 'array' && !('items' in node)) out.push(path);
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') itemlessArrays(value, `${path}.${key}`, out);
  }
}

describe('builtin tool schemas', () => {
  it('declare `items` on every array property (Google rejects arrays without it)', () => {
    const offenders: string[] = [];
    for (const tool of BUILTIN_TOOLS) {
      const found: string[] = [];
      itemlessArrays(tool.inputSchema, 'inputSchema', found);
      offenders.push(...found.map((p) => `${tool.slug} → ${p}`));
    }
    expect(offenders).toEqual([]);
  });
});
