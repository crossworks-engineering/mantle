/**
 * The state of a pipeline on this box (docs/pipelines.md, "Options and the
 * state of a pipeline"): the ONE
 * reader and the ONE writer of the table pipeline_state (migrations 0373
 * and 0375).
 * Nothing else imports that table: a second reader would skip
 * effectiveOptions and read an old value as it is.
 *
 *  - pipelineStateOf: the row over the defaults of the code (defaultState),
 *    with effectiveOptions. No row is the defaults: on in every workspace.
 *    A router has no off list, whatever the row says.
 *  - pipelineOffHere: the ONE test of the off list, for a file's home
 *    workspace. Nothing else compares the ids. Two spots ask it: the
 *    automatic run (the upload's read of a reader, auto-table.ts, and
 *    runAfterPipelines for an `after` pipeline) and pipeline_run's skipOf.
 *  - setPipelineState: checkOptions, then one upsert. It refuses `offIn`
 *    for a router, and a workspace that is not this brain's.
 *  - countPipelineRun: one upsert that adds one run. Called where a build
 *    or a patch wrote (packages/content/src/file-database.ts). It touches
 *    only `runs` and `last_run_at`, so a row it makes reads as the defaults.
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
import { liveWorkspace, pipelineState, systemDb, workspaces } from '@mantle/db';
import {
  checkOptions,
  defaultState,
  effectiveOptions,
  isRouter,
  optionsHash,
  type PipelineManifest,
} from '@mantle/files';
import { UUID_RE } from '@mantle/std';

/** What a pipeline does on this box. */
export type PipelineState = {
  /** The ids of the workspaces it is off in. Empty: on in every workspace.
   *  Always empty for a router. */
  offIn: readonly string[];
  /** Every declared option, with the value in force. */
  options: Record<string, unknown>;
  /** optionsHash of `options`: '' when all are the defaults. */
  optionsHash: string;
  /** How many times it wrote its result into a file's database on this box. */
  runs: number;
  /** When it last wrote; null before its first run. */
  lastRunAt: Date | null;
};

/** A change an Admin asks for. A name left out stays as it is. */
export type PipelineStateChange = {
  /** The options to set; the others keep their stored values. */
  options?: Record<string, unknown>;
  /** Replaces the off list. `[]`: on in every workspace. */
  offIn?: readonly string[];
};

/** A router's refusal of an off list: it runs wherever its readers do. */
export const ROUTER_HAS_NO_OFF_LIST =
  'A router has no off list: it is used wherever its readers are.';

/** The most workspaces one off list may name. */
const PIPELINE_WORKSPACES_MAX = 200;

/**
 * The off list as it is used: total, so a row written by hand never throws
 * into an extract. NULL is the default of the code (off nowhere), and so is
 * a value that is no list. Only lower-case
 * uuid strings are kept (a NULL element or a nested array goes), and at most
 * PIPELINE_WORKSPACES_MAX of them, as the writer allows. An id of an
 * archived or deleted workspace stays: no file has it as its home, so it is
 * harmless, and the use is a membership test only.
 */
function offListOf(stored: unknown): readonly string[] {
  if (!Array.isArray(stored)) return defaultState().offIn;
  const out: string[] = [];
  for (const id of stored) {
    if (out.length >= PIPELINE_WORKSPACES_MAX) break;
    if (
      typeof id === 'string' &&
      UUID_RE.test(id) &&
      id === id.toLowerCase() &&
      !out.includes(id)
    ) {
      out.push(id);
    }
  }
  return out;
}

/** The state of `manifest` on the brain of `ownerId`. */
export async function pipelineStateOf(
  ownerId: string,
  manifest: PipelineManifest,
): Promise<PipelineState> {
  const [row] = await systemDb
    .select({
      options: pipelineState.options,
      offIn: pipelineState.offIn,
      runs: pipelineState.runs,
      lastRunAt: pipelineState.lastRunAt,
    })
    .from(pipelineState)
    .where(and(eq(pipelineState.ownerId, ownerId), eq(pipelineState.pipelineId, manifest.id)))
    .limit(1);
  const options = effectiveOptions(manifest, row?.options);
  return {
    offIn: isRouter(manifest) ? defaultState().offIn : offListOf(row?.offIn),
    options,
    optionsHash: optionsHash(manifest, options),
    runs: Number(row?.runs ?? 0),
    lastRunAt: row?.lastRunAt ?? null,
  };
}

/**
 * Whether the pipeline is off for a file whose home workspace is `home`:
 * the ONE test of the off list. A file with no home workspace: on.
 */
export function pipelineOffHere(state: Pick<PipelineState, 'offIn'>, home: string | null): boolean {
  return home !== null && state.offIn.includes(home);
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
  if (isRouter(manifest) && change.offIn !== undefined) {
    return { ok: false, error: ROUTER_HAS_NO_OFF_LIST };
  }
  const checked = checkOptions(manifest, change.options ?? {});
  if (!checked.ok) return checked;

  let ws: string[] | undefined;
  if (change.offIn !== undefined) {
    if (!Array.isArray(change.offIn)) {
      return { ok: false, error: '"offIn" must be a list of workspace ids.' };
    }
    const bad = change.offIn.find((id: unknown) => typeof id !== 'string' || !UUID_RE.test(id));
    if (bad !== undefined)
      return { ok: false, error: `${String(bad).slice(0, 40)} is not a workspace id.` };
    // Stored lower case, as the workspace ids are, so the same id in upper
    // case is the same workspace.
    ws = [...new Set(change.offIn.map((id) => id.toLowerCase()))];
    if (ws.length > PIPELINE_WORKSPACES_MAX) {
      return {
        ok: false,
        error: `A pipeline is off in at most ${PIPELINE_WORKSPACES_MAX} workspaces.`,
      };
    }
    if (ws.length > 0) {
      // An archived workspace is not one to switch it off in.
      const found = await systemDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.ownerId, ownerId), inArray(workspaces.id, ws), liveWorkspace()));
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
      options: checked.values,
      offIn: ws ?? null,
      updatedBy: loginId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pipelineState.ownerId, pipelineState.pipelineId],
      set: {
        ...(ws !== undefined ? { offIn: ws } : {}),
        options: sql`${pipelineState.options} || excluded."options"`,
        updatedBy: loginId,
        updatedAt: now,
      },
    });
  return { ok: true, state: await pipelineStateOf(ownerId, manifest) };
}

/**
 * Count one run of a pipeline: one write of its result into one file's
 * database (a reader's build, an `after` pipeline's patch). One upsert:
 * `runs + 1` and `last_run_at = now()`. It touches no other column, so a
 * row it makes has the defaults of the code (options `{}`, no off list)
 * and `options`, `off_in`, `updated_by` and `updated_at` keep saying who
 * changed the settings last. Its callers catch its error: a count never
 * fails or undoes a build or a patch.
 */
export async function countPipelineRun(ownerId: string, pipelineId: string): Promise<void> {
  await systemDb
    .insert(pipelineState)
    .values({ ownerId, pipelineId, runs: 1, lastRunAt: sql`now()` })
    .onConflictDoUpdate({
      target: [pipelineState.ownerId, pipelineState.pipelineId],
      set: { runs: sql`${pipelineState.runs} + 1`, lastRunAt: sql`now()` },
    });
}
