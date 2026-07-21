/**
 * Audit mechanics (plan §7 — the contract that prevents the nitpick loop).
 *
 * An `audit` item is judged by the RESPONDER in a resume turn (fresh context,
 * adversarial framing) — never dispatched to a tool queue. The turn records
 * its verdict through the `run_audit` tool, which calls
 * {@link applyAuditVerdict}:
 *
 *   pass — findings (advisory allowed) ride along; the audit item completes
 *          `done` and the group advances.
 *   redo — ONLY blocking findings justify it. The audited worker item is
 *          superseded (terminal→terminal relabel, counter untouched), a fresh
 *          worker item with the findings attached + a fresh audit are
 *          appended, and the old audit completes `done`. `max_redo_cycles=1`:
 *          a redo of a redo refuses and fails the audit `needs_human` instead
 *          (slice 3 turns that into a real ask_human gate).
 *
 * Composed of CAS-safe engine calls rather than one transaction: if the sweep
 * times the audit out mid-verdict, whichever completion wins drives the
 * counter exactly once, and appended redo items are simply the next queued
 * children either way.
 */
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { runItems, type Db, type RunItemRow } from '@mantle/db';

import { appendChildren, completeItem, supersedeItem, type PostCommitAction } from './engine';

export type AuditFinding = {
  severity: 'blocking' | 'advisory';
  claim: string;
  suggested_fix?: string;
  evidence_ref?: string;
};

export type AuditVerdictResult =
  | {
      ok: true;
      outcome: 'pass' | 'redo' | 'needs_human';
      replacementItemId?: string;
      actions: PostCommitAction[];
    }
  | { ok: false; error: string };

/** The worker item this audit judges: the nearest PRECEDING sibling
 *  `worker_invoke` that is terminal and not already superseded. */
export async function findAuditedWorkerItem(
  db: Db,
  audit: Pick<RunItemRow, 'id' | 'parentId' | 'position'>,
): Promise<RunItemRow | null> {
  if (!audit.parentId) return null;
  const rows = await db
    .select()
    .from(runItems)
    .where(
      and(
        eq(runItems.parentId, audit.parentId),
        eq(runItems.kind, 'worker_invoke'),
        lt(runItems.position, audit.position),
        inArray(runItems.state, ['done', 'failed']),
      ),
    )
    .orderBy(asc(runItems.position));
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

/**
 * Mechanical pre-check (plan §7): flags computed from the worker's RECORDED
 * tool ledger — not its prose — surfaced to the auditing model before it
 * judges. A claim of verification with no tool trace is auto-flagged; the
 * model cannot be talked out of a flag by a confident essay.
 */
export function mechanicalPreCheck(result: Record<string, unknown> | null): string[] {
  if (!result) return ['worker item has no recorded result'];
  const flags: string[] = [];
  const proposal = typeof result.proposal === 'string' ? result.proposal : '';
  const evidence = Array.isArray(result.evidence)
    ? (result.evidence as Array<{ tool?: string; ok?: boolean }>)
    : [];
  if (/\b(verif\w*|tested|confirmed|double-checked)\b/i.test(proposal) && evidence.length === 0) {
    flags.push(
      'AUTO-FLAG: the proposal claims verification/testing but the recorded tool ledger is EMPTY — nothing was actually checked.',
    );
  }
  const failed = evidence.filter((e) => e.ok === false);
  if (failed.length > 0) {
    flags.push(
      `AUTO-FLAG: ${failed.length} of the worker's tool calls FAILED (${failed
        .map((f) => f.tool ?? '?')
        .join(', ')}) — check whether the proposal silently leans on them.`,
    );
  }
  return flags;
}

export async function applyAuditVerdict(
  db: Db,
  opts: {
    auditItemId: string;
    verdict: 'pass' | 'redo';
    findings: AuditFinding[];
    /** The authoritative directive for the next step — downstream does not
     *  re-derive (plan §7). Stored on the audit result. */
    directive?: string;
  },
): Promise<AuditVerdictResult> {
  const [audit] = await db.select().from(runItems).where(eq(runItems.id, opts.auditItemId));
  if (!audit || audit.kind !== 'audit') {
    return { ok: false, error: `item ${opts.auditItemId} is not an audit item` };
  }
  if (audit.state !== 'ready' && audit.state !== 'running') {
    return {
      ok: false,
      error: `audit ${audit.id} is '${audit.state}' — its verdict was already recorded (or it timed out)`,
    };
  }
  const blocking = opts.findings.filter((f) => f.severity === 'blocking');
  if (opts.verdict === 'redo' && blocking.length === 0) {
    return {
      ok: false,
      error:
        "verdict 'redo' requires at least one blocking finding — advisory-only findings ride along on a 'pass' (this is the anti-nitpick rule)",
    };
  }
  if (opts.verdict === 'pass' && blocking.length > 0) {
    return {
      ok: false,
      error:
        "verdict 'pass' with blocking findings is contradictory — downgrade them to advisory or verdict 'redo'",
    };
  }

  const audited = await findAuditedWorkerItem(db, audit);
  const baseResult = {
    verdict: opts.verdict,
    findings: opts.findings,
    ...(opts.directive ? { directive: opts.directive } : {}),
    ...(audited ? { audited_item: audited.id } : {}),
  };

  if (opts.verdict === 'pass') {
    const { actions } = await completeItem(db, {
      itemId: audit.id,
      state: 'done',
      result: baseResult,
    });
    return { ok: true, outcome: 'pass', actions };
  }

  // redo
  if (!audited) {
    return {
      ok: false,
      error:
        'no completed worker_invoke step precedes this audit in its group — nothing to redo; use verdict pass or cancel the run',
    };
  }
  const [parent] = await db.select().from(runItems).where(eq(runItems.id, audit.parentId!));
  const auditedPayload = (audited.payload ?? {}) as Record<string, unknown>;
  const isSecondCycle = !!auditedPayload.redo_of;
  if (isSecondCycle || parent?.kind !== 'group_seq') {
    // Redo cap hit (max_redo_cycles=1), or a par-group audit (a redo appended
    // to a running par would promote its own audit before the worker ran).
    const { actions } = await completeItem(db, {
      itemId: audit.id,
      state: 'failed',
      result: baseResult,
      failure: {
        type: 'needs_human',
        message: isSecondCycle
          ? 'second blocking audit on this step — human decision required (redo cap, plan §7)'
          : 'blocking audit in a par group — redo cycles are seq-only; human decision required',
        itemId: audit.id,
      },
    });
    return { ok: true, outcome: 'needs_human', actions };
  }

  const appended = await appendChildren(db, {
    groupId: audit.parentId!,
    children: [
      {
        kind: 'worker_invoke',
        payload: {
          ...auditedPayload,
          redo_of: audited.id,
          audit_findings: opts.findings,
          ...(opts.directive ? { audit_directive: opts.directive } : {}),
        },
        agentId: audited.agentId ?? undefined,
        retryPolicy: audited.retryPolicy ?? undefined,
      },
      { kind: 'audit', payload: { scope: (audit.payload as Record<string, unknown>)?.scope } },
    ],
  });
  const newWorkerId = appended.itemIds[0]!;
  await supersedeItem(db, audited.id, newWorkerId);
  const completed = await completeItem(db, {
    itemId: audit.id,
    state: 'done',
    result: { ...baseResult, superseded_item: audited.id, replacement_item: newWorkerId },
  });
  return {
    ok: true,
    outcome: 'redo',
    replacementItemId: newWorkerId,
    actions: [...appended.actions, ...completed.actions],
  };
}
