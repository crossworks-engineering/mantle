/**
 * The subject box's other fleet writes (phase 4, docs/control-center.md
 * "Fleet writes"): a model pool entry, the update notice, a worker
 * group and a worker's model, each a fixed case on the signed route like agentModel
 * (agent-model.ts), so the same two checks hold them and no agent, MCP
 * client or API key on the box reaches them.
 *
 * Each runs the box's own path, with its own one check, no more:
 *  - poolEntry: the pool is one this box has, and the routes pass the
 *    box's model policy and fit the pool (poolRoutesIssue, the Pools
 *    screen's check). Then the entry is added at the end of the pool, or
 *    its routes (and vendor) updated, by pool and name.
 *  - updateNotice: no check of its own (it blocks logins for an hour at
 *    most, and clears by itself on a new version); the update notice
 *    tool's own store (setUpdateNotice).
 *  - workerGroup: every member is an enabled worker on this box (the
 *    worker group screen's rule). Then the group is made in one insert, or
 *    its members, name and switch updated, by slug.
 *  - workerModel: the model of a shipped kind's default worker, after the
 *    box's model policy (worker-model.ts, its own checks there).
 * The box's audit row is written by the route (box.ts), naming the change.
 */
import { z } from 'zod';
import { agentGroups, and, db, eq } from '@mantle/db';
import { writePoolEntry } from '@mantle/tools';
import { CONTROL_LABEL, CONTROL_MODEL_ID, CONTROL_PROVIDER, CONTROL_SLUG } from '@mantle/db/schema';
import { readUpdateNotice, setUpdateNotice } from '@mantle/content';
import { manualNoticeUntil } from '@mantle/client-types/update-notice';
import { APP_VERSION } from '@mantle/client-types/version';
import { MODEL_POOL_IDS } from '@/lib/model-pools';
import { poolRoutesIssue } from '@/lib/model-pool-routes';
import {
  createWorkerGroup,
  listEnabledWorkerAgents,
  updateWorkerGroup,
  validateWorkerGroupMembers,
} from '@/lib/worker-groups';
import { setWorkerModel } from './worker-model';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** The four calls, as box.ts's switch takes them. */
export const WRITE_CALLS = [
  strict({
    op: z.literal('poolEntry'),
    args: strict({
      pool: z.string().regex(CONTROL_SLUG),
      name: z.string().regex(CONTROL_LABEL),
      vendor: z.string().max(80).regex(CONTROL_LABEL).optional(),
      routes: z
        .array(
          strict({
            provider: z.string().regex(CONTROL_PROVIDER),
            model: z.string().regex(CONTROL_MODEL_ID),
          }),
        )
        .min(1)
        .max(8),
    }),
  }),
  strict({ op: z.literal('updateNotice'), args: strict({ on: z.boolean() }) }),
  strict({
    op: z.literal('workerGroup'),
    args: strict({
      slug: z.string().regex(CONTROL_SLUG),
      name: z.string().regex(CONTROL_LABEL).optional(),
      members: z.array(z.string().regex(CONTROL_SLUG)).min(1).max(10),
      enabled: z.boolean().optional(),
    }),
  }),
  strict({
    op: z.literal('workerModel'),
    args: strict({
      worker: z.string().regex(CONTROL_SLUG),
      provider: z.string().regex(CONTROL_PROVIDER),
      model: z.string().regex(CONTROL_MODEL_ID),
    }),
  }),
] as const;

export type WriteCall = z.infer<(typeof WRITE_CALLS)[number]>;

/** What a write call answers: its kind, ok and what it had (`was`: added,
 *  updated, on, off), or one fixed reason. Never a check's text. */
export type WriteAnswer = {
  kind: WriteCall['op'];
  ok: boolean;
  was?: string;
  reason?: 'pool' | 'fit' | 'members' | 'worker' | 'provider' | 'policy' | 'model';
};

export async function runWrite(ownerId: string, call: WriteCall): Promise<WriteAnswer> {
  switch (call.op) {
    case 'poolEntry':
      return setPoolEntry(ownerId, call.args);
    case 'updateNotice':
      return switchNotice(ownerId, call.args.on);
    case 'workerGroup':
      return ensureGroup(ownerId, call.args);
    case 'workerModel':
      return setWorkerModel(ownerId, call.args.worker, call.args.provider, call.args.model);
  }
}

async function setPoolEntry(
  ownerId: string,
  e: Extract<WriteCall, { op: 'poolEntry' }>['args'],
): Promise<WriteAnswer> {
  const kind = 'poolEntry';
  if (!MODEL_POOL_IDS.has(e.pool)) return { kind, ok: false, reason: 'pool' };
  if (await poolRoutesIssue(e.pool, e.routes)) return { kind, ok: false, reason: 'fit' };
  // The pool tool's own write (model_pool_set), at its full-route spot:
  // the routes, and the vendor when given, by pool and name.
  const done = await writePoolEntry(ownerId, {
    pool: e.pool,
    name: e.name,
    routes: e.routes,
    vendor: e.vendor ?? null,
  });
  return { kind, ok: true, was: done.updated ? 'updated' : 'added' };
}

async function switchNotice(ownerId: string, on: boolean): Promise<WriteAnswer> {
  const before = manualNoticeUntil(await readUpdateNotice(), APP_VERSION, Date.now());
  await setUpdateNotice(ownerId, on);
  return { kind: 'updateNotice', ok: true, was: before === null ? 'off' : 'on' };
}

async function ensureGroup(
  ownerId: string,
  g: Extract<WriteCall, { op: 'workerGroup' }>['args'],
): Promise<WriteAnswer> {
  const kind = 'workerGroup';
  const workers = new Set((await listEnabledWorkerAgents(ownerId)).map((w) => w.slug));
  if (validateWorkerGroupMembers(g.members, workers)) return { kind, ok: false, reason: 'members' };
  const [existing] = await db
    .select({ id: agentGroups.id })
    .from(agentGroups)
    .where(and(eq(agentGroups.ownerId, ownerId), eq(agentGroups.slug, g.slug)))
    .limit(1);
  const patch = {
    memberSlugs: g.members,
    ...(g.name ? { name: g.name } : {}),
    ...(g.enabled !== undefined ? { enabled: g.enabled } : {}),
  };
  if (existing) {
    // The group screen's own save (members, name, switch).
    await updateWorkerGroup(ownerId, existing.id, patch);
    return { kind, ok: true, was: 'updated' };
  }
  // A new group in one insert (the screen's own create, members given),
  // as worker_group_ensure does: never an empty shell left enabled.
  await createWorkerGroup(ownerId, {
    slug: g.slug,
    name: g.name ?? g.slug,
    memberSlugs: g.members,
    ...(g.enabled !== undefined ? { enabled: g.enabled } : {}),
  });
  return { kind, ok: true, was: 'added' };
}
