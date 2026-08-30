import { z } from 'zod';

/**
 * The ONE avatar body schema, shared by agents POST, agents PATCH, and (for
 * the parts half) the profile PUT — three routes must accept the same avatar,
 * and a cap or pattern change edited in one pasted copy is how they drift.
 * Same shared-schema convention as task-schemas.ts / heartbeat-schema.ts.
 *
 * `parts` are the avatar-builder choices: component → pinned variant, or null
 * to hide an optional component. NAMES are validated per-style at RENDER time,
 * not here (see AgentAvatar in @mantle/db) — these caps only bound the stored
 * blob. `{}` is the explicit clear; an ABSENT parts key means "keep what's
 * stored" on updates (see updateAgent), so parts-unaware clients can't wipe
 * pins.
 */
export const AvatarPartsSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(64).nullable())
  .refine((p) => Object.keys(p).length <= 64, 'too many parts');

export const AvatarSchema = z
  .object({
    style: z.string().min(1).max(64),
    seed: z.string().min(1).max(200),
    parts: AvatarPartsSchema.optional(),
  })
  .strict()
  .nullable();
