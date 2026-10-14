/**
 * The input schema every Mantle tool goes onto an `McpServer` with (the one
 * registration, gated-tools.ts): a zod raw shape, wrapped so the JSON
 * Schema `tools/list` advertises is the one SDK 1.x advertised.
 *
 * SDK 2.x converts a tool's input schema itself, with zod's draft-2020-12
 * output, so a plain `z.object(shape)` would change every schema the
 * assistant sees on the upgrade (a different `$schema`, among others). This
 * wrapper keeps validation on zod and pins the advertised schema to SDK 1.x's
 * conversion: `z.toJSONSchema(…, { target: 'draft-7', io: 'input' })`, which
 * declares draft-07, so clients still validate it as draft-07. Moving the
 * surface to 2020-12 is its own decision, not a side effect of a dependency.
 */

import { z } from 'zod';
import { databaseErrorPublic } from '@mantle/std';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

export type ShapeSchema<S extends z.ZodRawShape> = StandardSchemaWithJSON<
  z.input<z.ZodObject<S>>,
  z.output<z.ZodObject<S>>
>;

/** `shape` as the Standard Schema `registerTool` takes, advertising the
 *  SDK 1.x JSON Schema. */
export function toolInputSchema<S extends z.ZodRawShape>(shape: S): ShapeSchema<S> {
  const obj = z.object(shape);
  const advertised = () =>
    z.toJSONSchema(obj, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return {
    '~standard': {
      version: 1,
      vendor: 'zod',
      validate: (value) => obj['~standard'].validate(value),
      jsonSchema: { input: advertised, output: advertised },
    },
  };
}

/** What a tool says for a database error: the one mapper
 *  (databaseErrorPublic, @mantle/std), the same on every exit. A thrown one
 *  is answered by the one registration (gated-tools.ts, through
 *  @mantle/tools thrownToolDatabaseError) since A5 step 4. */
export function toolDatabaseError(err: unknown): string {
  return databaseErrorPublic(err);
}
