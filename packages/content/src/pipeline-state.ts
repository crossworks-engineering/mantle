/**
 * The state of a pipeline on this box (docs/pipelines-options.md): the ONE
 * reader and the ONE writer of the table pipeline_state (migration 0373).
 * Nothing else imports that table: a second reader would skip
 * effectiveOptions and read an old value as it is.
 *
 *  - pipelineStateOf: the row over the defaults of the code (defaultState),
 *    with effectiveOptions. No row is the defaults. A reader is always on,
 *    in every workspace, whatever the row says (phase 2: on and the attach
 *    list are for `after` pipelines only).
 *  - setPipelineState: checkOptions, then one upsert. It refuses `on` and
 *    `workspaces` for a reader, and a workspace that is not this brain's.
 *
 * No rights check here, by design: the Admin check is the route's declared
 * policy and the tool's scope (area `settings`). The table holds no secret
 * and grants no right; a pipeline writes only into a file's own database.
 *
 * systemDb, in a scope too (the narrow role: SELECT, and the upsert's
 * columns in NARROW_WRITES): the workspace role holds no read of this table,
 * and the list, a test and a run read it in the caller's scope.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pipelineState, systemDb, workspaces } from '@mantle/db';
import {
  checkOptions,
  defaultState,
  effectiveOptions,
  isAfterPipeline,
  optionsHash,
  type PipelineManifest,
} from '@mantle/files';
import { UUID_RE } from '@mantle/std';

/** What a pipeline does on this box. */
export type PipelineState = {
  on: boolean;
  /** 'all', or the ids of the workspaces it is attached to. */
  workspaces: 'all' | readonly string[];
  /** Every declared option, with the value in force. */
  options: Record<string, unknown>;
  /** optionsHash of `options`: '' when all are the defaults. */
  optionsHash: string;
};

/** A change an Admin asks for. A name left out stays as it is. */
export type PipelineStateChange = {
  on?: boolean;
  /** The options to set; the others keep their stored values. */
  options?: Record<string, unknown>;
  workspaces?: readonly string[];
};

/** The most workspaces one attach list may name. */
export const PIPELINE_WORKSPACES_MAX = 200;

/** The state of `manifest` on the brain of `ownerId`. */
export async function pipelineStateOf(
  ownerId: string,
  manifest: PipelineManifest,
): Promise<PipelineState> {
  const [row] = await systemDb
    .select({
      enabled: pipelineState.enabled,
      options: pipelineState.options,
      workspaces: pipelineState.workspaces,
    })
    .from(pipelineState)
    .where(and(eq(pipelineState.ownerId, ownerId), eq(pipelineState.pipelineId, manifest.id)))
    .limit(1);
  const base = defaultState(manifest);
  const options = effectiveOptions(manifest, row?.options);
  const after = isAfterPipeline(manifest);
  return {
    on: after ? (row?.enabled ?? base.on) : true,
    workspaces: after ? (row?.workspaces ?? base.workspaces) : 'all',
    options,
    optionsHash: optionsHash(manifest, options),
  };
}

/**
 * Set what an Admin changed, then give the state back. A refusal is a plain
 * sentence for the screen and the tool, and writes nothing.
 */
export async function setPipelineState(
  ownerId: string,
  loginId: string | null,
  manifest: PipelineManifest,
  change: PipelineStateChange,
): Promise<{ ok: true; state: PipelineState } | { ok: false; error: string }> {
  const after = isAfterPipeline(manifest);
  if (!after && (change.on !== undefined || change.workspaces !== undefined)) {
    return { ok: false, error: 'A reader is on in every workspace.' };
  }
  if (change.on !== undefined && typeof change.on !== 'boolean') {
    return { ok: false, error: '"on" must be yes or no.' };
  }
  const checked = checkOptions(manifest, change.options ?? {});
  if (!checked.ok) return checked;

  let ws: string[] | undefined;
  if (change.workspaces !== undefined) {
    if (!Array.isArray(change.workspaces)) {
      return { ok: false, error: '"workspaces" must be a list of workspace ids.' };
    }
    ws = [...new Set(change.workspaces)];
    if (ws.length > PIPELINE_WORKSPACES_MAX) {
      return {
        ok: false,
        error: `A pipeline is attached to at most ${PIPELINE_WORKSPACES_MAX} workspaces.`,
      };
    }
    const bad = ws.find((id) => typeof id !== 'string' || !UUID_RE.test(id));
    if (bad !== undefined)
      return { ok: false, error: `${String(bad).slice(0, 40)} is not a workspace id.` };
    if (ws.length > 0) {
      const found = await systemDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.ownerId, ownerId), inArray(workspaces.id, ws)));
      const known = new Set(found.map((r) => r.id));
      const unknown = ws.find((id) => !known.has(id));
      if (unknown) return { ok: false, error: `${unknown} is not a workspace of this brain.` };
    }
  }

  const now = new Date();
  // One upsert. The options merge into the stored ones (jsonb ||), so a
  // change of one option keeps the others.
  await systemDb
    .insert(pipelineState)
    .values({
      ownerId,
      pipelineId: manifest.id,
      enabled: change.on ?? null,
      options: checked.values,
      workspaces: ws ?? null,
      updatedBy: loginId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pipelineState.ownerId, pipelineState.pipelineId],
      set: {
        ...(change.on !== undefined ? { enabled: change.on } : {}),
        ...(ws !== undefined ? { workspaces: ws } : {}),
        options: sql`${pipelineState.options} || excluded."options"`,
        updatedBy: loginId,
        updatedAt: now,
      },
    });
  return { ok: true, state: await pipelineStateOf(ownerId, manifest) };
}
