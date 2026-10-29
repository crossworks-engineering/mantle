/**
 * The body sweep's valid bodies (a10-body-sweep.test.ts):
 * a body a route's own zod schema accepts, made from that schema. Test
 * support only: nothing in the server imports it.
 *
 * The schema is found at the read: the sweep sends a probe body and the
 * schema whose safeParse meets it (hookSafeParse) is the route's body
 * schema. A sample is built from its JSON Schema (zod's toJSONSchema, the
 * input side) and kept only when the schema accepts it, so a refinement no
 * sample meets leaves the route with no valid body (the sweep sends `{}`).
 */
import { z } from 'zod';

/** The id every sample and every path of the sweep uses. */
export const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

/** The probe a route's body schema meets: a key no schema names. */
export const PROBE_KEY = '__a10BodySweepProbe';

/** The schemas safeParse met with the probe, in order. */
const met: z.ZodType[] = [];
let quiet = 0;

/** Note every schema whose safeParse meets the probe (once per process):
 *  the schema classes a body schema's root can be, each prototype's
 *  safeParse wrapped (zod 4 installs it there, built per instance on first
 *  read). */
export function hookSafeParse(): void {
  const g = globalThis as { __a10Hooked?: boolean };
  if (g.__a10Hooked) return;
  g.__a10Hooked = true;
  const roots: z.ZodType[] = [
    z.object({}),
    z.object({}).transform((x) => x),
    z.union([z.string(), z.number()]),
    z.discriminatedUnion('k', [z.object({ k: z.literal('a') })]),
    z.intersection(z.object({}), z.object({})),
    z.array(z.string()),
    z.record(z.string(), z.string()),
    z.any(),
    z.unknown(),
    z.lazy(() => z.string()),
    z.preprocess((x) => x, z.object({})),
  ];
  for (const s of roots) {
    const proto = Object.getPrototypeOf(s) as Record<string, unknown>;
    const desc = Object.getOwnPropertyDescriptor(proto, 'safeParse');
    if (!desc?.get || (proto as { __a10?: boolean }).__a10) continue;
    (proto as { __a10?: boolean }).__a10 = true;
    const get = desc.get;
    Object.defineProperty(proto, 'safeParse', {
      ...desc,
      get(this: z.ZodType) {
        const bound = get.call(this) as (d: unknown, p?: unknown) => unknown;
        const f = (d: unknown, p?: unknown) => {
          if (quiet === 0 && d && typeof d === 'object' && PROBE_KEY in (d as object)) {
            met.push(this);
          }
          return bound(d, p);
        };
        Object.defineProperty(this, 'safeParse', {
          value: f,
          configurable: true,
          writable: true,
          enumerable: false,
        });
        return f;
      },
    });
  }
}

/** The schemas met since the last call (and forget them). */
export function takeMet(): z.ZodType[] {
  return met.splice(0);
}

function stringFor(s: Schema): string {
  const fmt = s.format as string | undefined;
  let v: string;
  if (fmt === 'uuid' || fmt === 'guid') v = SAMPLE_ID;
  else if (fmt === 'email') v = 'sweep@example.invalid';
  else if (fmt === 'uri' || fmt === 'url') v = 'https://example.invalid/a';
  else if (fmt === 'date-time') v = '2026-10-01T00:00:00.000Z';
  else if (fmt === 'date') v = '2026-10-01';
  else if (fmt === 'time') v = '00:00:00';
  else if (fmt === 'ipv4') v = '192.0.2.1';
  else if (typeof s.pattern === 'string' && /\[0-9a-fA-F\]\{8\}/.test(s.pattern)) v = SAMPLE_ID;
  else v = 'sweep';
  const min = typeof s.minLength === 'number' ? s.minLength : 0;
  const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
  while (v.length < min) v += 'x';
  if (v.length > max) v = v.slice(0, Math.max(min, max));
  return v;
}

function numberFor(s: Schema): number {
  const int = s.type === 'integer';
  let n = 1;
  if (typeof s.minimum === 'number') n = Math.max(n, s.minimum);
  if (typeof s.exclusiveMinimum === 'number') n = Math.max(n, s.exclusiveMinimum + (int ? 1 : 0.5));
  if (typeof s.maximum === 'number') n = Math.min(n, s.maximum);
  if (typeof s.exclusiveMaximum === 'number') n = Math.min(n, s.exclusiveMaximum - (int ? 1 : 0.5));
  return int ? Math.ceil(n) : n;
}

/** Samples of `s`, the first the most likely; `all`: optional keys too. */
function samplesOf(s: Schema, defs: Schema, all: boolean, depth = 0): Json[] {
  if (depth > 6) return [null];
  if (typeof s.$ref === 'string') {
    const name = s.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    const d = defs[name] as Schema | undefined;
    return d ? samplesOf(d, defs, all, depth + 1) : [null];
  }
  if ('const' in s) return [s.const as Json];
  if (Array.isArray(s.enum)) return s.enum as Json[];
  if (s.default !== undefined)
    return [s.default as Json, ...samplesOf({ ...s, default: undefined }, defs, all, depth)];
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[k])) {
      return (s[k] as Schema[]).flatMap((o) => samplesOf(o, defs, all, depth + 1).slice(0, 2));
    }
  }
  if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as Schema[]).map((o) => samplesOf(o, defs, all, depth + 1)[0]);
    return [Object.assign({}, ...parts.filter((p) => p && typeof p === 'object'))];
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string':
      return [stringFor(s)];
    case 'number':
    case 'integer':
      return [numberFor(s)];
    case 'boolean':
      return [true, false];
    case 'null':
      return [null];
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      const items = (s.items as Schema | undefined) ?? {};
      const one = samplesOf(items, defs, all, depth + 1)[0] ?? null;
      return min === 0 ? [[], [one]] : [Array.from({ length: min }, () => one)];
    }
    case 'object': {
      const props = (s.properties as Record<string, Schema> | undefined) ?? {};
      const required = new Set((s.required as string[] | undefined) ?? []);
      const out: Record<string, Json> = {};
      for (const [k, p] of Object.entries(props)) {
        if (!all && !required.has(k)) continue;
        out[k] = samplesOf(p, defs, all, depth + 1)[0] ?? null;
      }
      return [out];
    }
    default:
      return [{}];
  }
}

/** A body `schema` accepts, or null when no sample of it passes. */
export function sampleBody(schema: z.ZodType): Json | null {
  let js: Schema;
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Schema;
  } catch {
    return null;
  }
  const defs = ((js.$defs ?? js.definitions) as Schema | undefined) ?? {};
  quiet += 1;
  try {
    for (const all of [false, true]) {
      for (const sample of samplesOf(js, defs, all)) {
        if (schema.safeParse(sample).success) return sample;
      }
    }
    return null;
  } finally {
    quiet -= 1;
  }
}

/** `body` with a NUL appended to every string in it (JSON escapes it). */
export function withNul(body: Json): Json {
  if (typeof body === 'string') return `${body}\u0000`;
  if (Array.isArray(body)) return body.map(withNul);
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, withNul(v)]));
  }
  return body;
}
