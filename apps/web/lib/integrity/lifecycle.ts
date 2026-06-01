/**
 * Lifecycle sub-tests: update (does an edit re-extract correctly?) and delete
 * (does teardown fire the kind-aware reapers?).
 *
 * Update asserts: a NEW extractor_run fired, the node re-indexed, and edges
 * were rebuilt — not appended (the `dupMentionEdges` invariant catches the
 * "edges accumulate on every re-extract" bug class).
 *
 * Delete asserts the cleanup machinery ([[project_delete_cleanup_semantics]]):
 * the node and its chunks/edges are gone, episodic/factual facts are reaped,
 * and semantic/preference facts are KEPT (sourceless) — verified by capturing
 * fact ids before the delete and checking which survive. Finally it deletes the
 * node's traces (no FK/reaper covers them) so a delete-tested fixture leaves
 * nothing behind.
 */
import { db, traces } from '@mantle/db';
import { and, eq, sql } from 'drizzle-orm';
import { deleteFileById } from '@mantle/files';

import {
  loadProbeFootprint,
  waitForNewExtractor,
  loadFactRefs,
  existingFactIds,
} from './footprint';
import type { CheckResult, ProbeFootprint } from './types';
import type { FixtureSpec } from './spec';
import type { BuildCtx } from './fixtures';

/** Facts the reaper hard-deletes when their source node is deleted. */
const EPHEMERAL_KINDS = new Set(['episodic', 'factual']);
/** Facts the reaper keeps (source_node_id nulled by FK). */
const DURABLE_KINDS = new Set(['semantic', 'preference']);

export async function runUpdate(
  ownerId: string,
  spec: FixtureSpec,
  ctx: BuildCtx,
  nodeId: string,
  before: ProbeFootprint,
  timeoutMs: number,
): Promise<{ checks: CheckResult[]; after: ProbeFootprint }> {
  if (!spec.update) {
    return { checks: [{ label: 'Update', status: 'info', detail: 'no update defined for this type' }], after: before };
  }
  const priorTrace = before.run?.traceId ?? null;
  await spec.update(ctx, nodeId);
  const after = await waitForNewExtractor(ownerId, nodeId, priorTrace, timeoutMs);

  const checks: CheckResult[] = [];
  const newRun = !!after.run && after.run.traceId !== priorTrace;
  checks.push({
    label: 'New run',
    status: newRun ? 'pass' : 'fail',
    detail: newRun ? 're-extraction fired after edit' : 'no new extractor_run after the edit',
  });
  // Re-index assertions only bite when the re-run actually indexed. A type that
  // *correctly* skips (e.g. a task not in the allow-list) re-skips on edit —
  // that's informational, not a failure.
  if (newRun && after.run?.status === 'success') {
    const reindexed = !!after.summary && after.embDims != null;
    checks.push({
      label: 'Re-indexed',
      status: reindexed ? 'pass' : 'fail',
      detail: reindexed ? `summary + ${after.embDims}-dim embedding` : 'summary/embedding missing after edit',
    });
    checks.push({
      label: 'Idempotent',
      status: after.dupMentionEdges === 0 ? 'pass' : 'fail',
      detail:
        after.dupMentionEdges === 0
          ? 'no duplicate mentioned_in edges (delete-then-rebuild)'
          : `${after.dupMentionEdges} duplicate edges — appended instead of rebuilt`,
    });
  } else if (newRun) {
    checks.push({
      label: 'Re-extracted',
      status: 'info',
      detail: `re-run ${after.run?.status}${after.run?.disposition ? ` (${after.run.disposition})` : ''}`,
    });
  }
  return { checks, after };
}

export async function runDelete(
  ownerId: string,
  spec: FixtureSpec,
  nodeId: string,
  before: ProbeFootprint,
): Promise<{ checks: CheckResult[] }> {
  // Capture fact identities + kinds before the reaper runs.
  const factRefs = await loadFactRefs(ownerId, nodeId);
  const ephemeralIds = factRefs.filter((f) => EPHEMERAL_KINDS.has(f.kind)).map((f) => f.id);
  const durableIds = factRefs.filter((f) => DURABLE_KINDS.has(f.kind)).map((f) => f.id);

  // Delete via the real path (fires reapers 0058/0059 + FK cascade).
  if (spec.nodeType === 'file') {
    await deleteFileById({ ownerId, fileId: nodeId });
  } else {
    await db.execute(sql`DELETE FROM nodes WHERE id = ${nodeId} AND owner_id = ${ownerId}`);
  }

  const post = await loadProbeFootprint(ownerId, nodeId);
  const stillThere = await existingFactIds(ownerId, [...ephemeralIds, ...durableIds]);

  const checks: CheckResult[] = [];
  checks.push({ label: 'Node gone', status: post.exists ? 'fail' : 'pass', detail: post.exists ? 'node still present' : 'deleted' });
  checks.push({
    label: 'Edges reaped',
    status: post.nEntities === 0 ? 'pass' : 'fail',
    detail: post.nEntities === 0 ? 'mentioned_in edges removed (0058)' : `${post.nEntities} edges remain`,
  });
  checks.push({
    label: 'Chunks gone',
    status: post.nChunks === 0 ? 'pass' : 'fail',
    detail: post.nChunks === 0 ? 'content_chunks cascade-deleted' : `${post.nChunks} chunks remain`,
  });

  // Episodic/factual: must be gone. Semantic/preference: must be kept.
  if (ephemeralIds.length) {
    const leaked = ephemeralIds.filter((id) => stillThere.has(id));
    checks.push({
      label: 'Ephemeral reaped',
      status: leaked.length === 0 ? 'pass' : 'fail',
      detail: leaked.length === 0 ? `${ephemeralIds.length} episodic/factual facts deleted (0059)` : `${leaked.length} survived`,
    });
  } else {
    checks.push({ label: 'Ephemeral reaped', status: 'info', detail: 'no episodic/factual facts to reap' });
  }
  if (durableIds.length) {
    const kept = durableIds.filter((id) => stillThere.has(id));
    checks.push({
      label: 'Durable kept',
      status: kept.length === durableIds.length ? 'pass' : 'fail',
      detail:
        kept.length === durableIds.length
          ? `${durableIds.length} semantic/preference facts kept (sourceless)`
          : `${durableIds.length - kept.length} wrongly deleted`,
    });
  } else {
    checks.push({ label: 'Durable kept', status: 'info', detail: 'no semantic/preference facts present' });
  }

  // Teardown: the node's traces aren't covered by any reaper — delete them so a
  // delete-tested fixture leaves nothing behind (cleanup-by-tag can't find a
  // node that's already gone).
  await db.delete(traces).where(and(eq(traces.ownerId, ownerId), eq(traces.subjectId, nodeId)));

  return { checks };
}
