/**
 * JSON-Schema to zod shape bridge, so a bridged BuiltinToolDef validates on
 * the MCP surface exactly as validate-args does in-app.
 *
 * Lifted out of registerMantleTools. Pure: it closed over neither the server
 * nor the owner id, which is why it comes out whole. Only the indentation
 * changed (nested to module scope).
 */

import { z } from 'zod';

/** Convert one JSON-Schema property def into a zod type. Honors `items` for
 *  arrays, `integer` (vs number), nested object `properties`, `[T,'null']`
 *  nullable unions, and the size bounds (`minLength`/`maxLength`,
 *  `minimum`/`maximum`, `minItems`/`maxItems`) — so validation isn't silently
 *  dropped if a def grows past the original string/number/boolean/array
 *  vocabulary.
 *
 *  The bounds matter as much as the types: `validate-args` enforces them for
 *  the in-app agent, so dropping them here would leave the MCP surface the
 *  only one that accepts a 10 000-character title. */
export function zodForDef(def: Record<string, unknown>): z.ZodTypeAny {
  const type = def.type;
  if (Array.isArray(def.enum) && def.enum.every((v) => typeof v === 'string')) {
    return z.enum(def.enum as [string, ...string[]]);
  }
  if (Array.isArray(type)) {
    const base = type.find((x) => x !== 'null');
    const inner = base ? zodForDef({ ...def, type: base }) : z.unknown();
    return type.includes('null') ? inner.nullable() : inner;
  }
  const bound = (key: string): number | undefined =>
    typeof def[key] === 'number' ? (def[key] as number) : undefined;
  /** Apply a `[min, max]` pair, skipping the ends the schema left open. */
  const bounded = <T extends { min(n: number): T; max(n: number): T }>(
    t: T,
    minKey: string,
    maxKey: string,
  ): T => {
    const min = bound(minKey);
    const max = bound(maxKey);
    let out = t;
    if (min !== undefined) out = out.min(min);
    if (max !== undefined) out = out.max(max);
    return out;
  };
  switch (type) {
    case 'string':
      return bounded(z.string(), 'minLength', 'maxLength');
    case 'number':
      return bounded(z.number(), 'minimum', 'maximum');
    case 'integer':
      return bounded(z.number().int(), 'minimum', 'maximum');
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = (def.items ?? {}) as Record<string, unknown>;
      const inner = 'type' in items || 'enum' in items ? zodForDef(items) : z.unknown();
      return bounded(z.array(inner), 'minItems', 'maxItems');
    }
    case 'object': {
      const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
      // zod 4 requires the key type explicitly (`z.record(z.string(), z.unknown())` was
      // zod 3). JSON object keys are always strings, so this is the same shape.
      if (Object.keys(props).length === 0) return z.record(z.string(), z.unknown());
      return z.object(buildZodShape(def));
    }
    default:
      return z.unknown();
  }
}

/** Build a zod raw shape from a JSON-Schema object node (properties + required). */
export function buildZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    let t = zodForDef(def);
    if (typeof def.description === 'string') t = t.describe(def.description);
    if (!required.has(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

export function zodShapeFromJsonSchema(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  return buildZodShape(schema);
}
