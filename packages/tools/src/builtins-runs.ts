/**
 * Runner-queue builtins — the responder's handle on durable, inspectable
 * execution plans (docs/runs.md; design: "Runner queues & worker agents —
 * implementation plan v1").
 *
 * RESPONDER-ONLY by grant (the `runs` tool group is never given to workers or
 * specialists) and by guard (an invoked child agent is refused here). A run's
 * tool items execute headless in the runs worker through the same
 * `dispatchTool` executor as the inline loop — one executor, two entry
 * points — with `run_*` and `invoke_agent` banned inside items (no
 * recursion).
 *
 * Feature gate: creating runs (`run_plan` / `run_append`) requires
 * `MANTLE_RUNS=1` (dark by default; dogfood on dev). `run_state` /
 * `run_cancel` stay live so existing runs can always be inspected/stopped.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, db, runItems, runs } from '@mantle/db';
import {
  appendChildren,
  applyAuditVerdict,
  cancelRun,
  compileRunState,
  createRun,
  ensureWorkerAgent,
  enqueueRunActionsSafe,
  isRunsEnabled,
  listWorkerAgents,
  renderRunStateText,
  SealedGroupError,
  type AuditFinding,
  type PlanGroup,
  type PlanLeaf,
  type PlanNode,
} from '@mantle/runs';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { resolveTools } from './dispatch';
import { notFound } from './errors';

/** Tools that may never run as queue items: the run tools themselves (no
 *  recursion — `run_audit` especially, or a queue item could rubber-stamp the
 *  audit gate headlessly) and delegation (a headless item has no parent-agent
 *  context — fail at PLAN time with a clear error, not at execution).
 *
 *  SINGLE SOURCE: `execute-item.ts` imports this set for the execution-time
 *  re-check (defense in depth), and `builtins-runs.test.ts` asserts every
 *  RUN_TOOLS slug is in it — add a run_* tool and the test fails until it's
 *  banned here too. */
export const BANNED_ITEM_TOOLS: ReadonlySet<string> = new Set([
  'run_plan',
  'run_append',
  'run_state',
  'run_cancel',
  'run_audit',
  'invoke_agent',
]);

const MAX_PLAN_DEPTH = 4;
const MAX_PLAN_NODES = 50;

const DISABLED_ERROR =
  'Runner queues are disabled on this brain (MANTLE_RUNS is not set). ' +
  'Do the work inline with ordinary tool calls instead.';

/** run_* is a responder affordance — a delegated child agent must not open
 *  side channels of queued work its parent never sees. */
function refuseIfDelegated(ctx: ToolHandlerContext): ToolHandlerResult | null {
  if (ctx.agent && ctx.agent.depth > 1) {
    return {
      ok: false,
      error:
        'run tools are responder-only — a delegated agent cannot create or manage runs. ' +
        'Return your findings to the caller instead.',
    };
  }
  return null;
}

type ParsedPlan =
  | { ok: true; plan: PlanGroup; toolSlugs: string[]; workerSlugs: string[] }
  | { ok: false; error: string };

/** Validate + normalize the model-supplied plan tree into the engine shape.
 *  Every error names the offending path and the fix (error style guide). */
function parsePlan(raw: unknown): ParsedPlan {
  const toolSlugs: string[] = [];
  const workerSlugs: string[] = [];
  let nodes = 0;

  function fail(path: string, msg: string): { ok: false; error: string } {
    return { ok: false, error: `plan${path}: ${msg}` };
  }

  function parseNode(
    v: unknown,
    path: string,
    depth: number,
    parentKind: 'seq' | 'par' | null,
  ): PlanNode | { error: string } {
    if (depth > MAX_PLAN_DEPTH) {
      return { error: `plan${path}: nesting deeper than ${MAX_PLAN_DEPTH} — flatten the tree` };
    }
    if (++nodes > MAX_PLAN_NODES) {
      return {
        error: `plan has more than ${MAX_PLAN_NODES} nodes — split the job into multiple runs`,
      };
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { error: `plan${path}: expected an object with a 'kind' field` };
    }
    const o = v as Record<string, unknown>;
    switch (o.kind) {
      case 'seq':
      case 'par': {
        if (!Array.isArray(o.children)) {
          return { error: `plan${path}: '${o.kind}' group needs a 'children' array` };
        }
        const children: PlanNode[] = [];
        for (let i = 0; i < o.children.length; i++) {
          const c = parseNode(o.children[i], `${path}.children[${i}]`, depth + 1, o.kind);
          if ('error' in c) return c;
          children.push(c);
        }
        const jp = o.join_policy;
        if (jp !== undefined && jp !== 'wait_all' && jp !== 'fail_fast') {
          return {
            error: `plan${path}: join_policy must be 'wait_all' or 'fail_fast' (got ${JSON.stringify(jp)})`,
          };
        }
        return {
          kind: o.kind,
          ...(jp ? { joinPolicy: jp as 'wait_all' | 'fail_fast' } : {}),
          ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim() } : {}),
          children,
        };
      }
      case 'tool_call': {
        if (typeof o.tool !== 'string' || !o.tool.trim()) {
          return { error: `plan${path}: tool_call needs 'tool' (a tool slug string)` };
        }
        const slug = o.tool.trim();
        if (BANNED_ITEM_TOOLS.has(slug)) {
          return {
            error:
              `plan${path}: '${slug}' cannot run as a queue item (no run recursion / ` +
              `delegation from items). Call it inline in your own turn instead.`,
          };
        }
        if (o.args !== undefined && (typeof o.args !== 'object' || Array.isArray(o.args))) {
          return { error: `plan${path}: 'args' must be an object of tool arguments` };
        }
        toolSlugs.push(slug);
        const timeout = o.timeout_seconds;
        return {
          kind: 'tool_call',
          payload: {
            tool: slug,
            args: (o.args as Record<string, unknown>) ?? {},
            ...(typeof timeout === 'number' && timeout > 0 ? { timeout_seconds: timeout } : {}),
          },
          sideEffecting: o.side_effecting === true,
        };
      }
      case 'note': {
        if (typeof o.text !== 'string' || !o.text.trim()) {
          return { error: `plan${path}: note needs non-empty 'text'` };
        }
        return { kind: 'note', payload: { text: o.text.trim() } };
      }
      case 'worker_invoke': {
        if (typeof o.step !== 'string' || !o.step.trim()) {
          return {
            error: `plan${path}: worker_invoke needs 'step' — the delegated task, self-contained`,
          };
        }
        if (o.worker !== undefined && typeof o.worker !== 'string') {
          return { error: `plan${path}: 'worker' must be a worker agent slug string` };
        }
        if (o.worker) workerSlugs.push((o.worker as string).trim());
        const timeout = o.timeout_seconds;
        return {
          kind: 'worker_invoke',
          payload: {
            step: o.step.trim(),
            ...(typeof o.acceptance_criteria === 'string' && o.acceptance_criteria.trim()
              ? { acceptance_criteria: o.acceptance_criteria.trim() }
              : {}),
            ...(typeof o.worker === 'string' && o.worker.trim() ? { worker: o.worker.trim() } : {}),
            ...(Array.isArray(o.subject_node_ids)
              ? { subject_node_ids: o.subject_node_ids.filter((x) => typeof x === 'string') }
              : {}),
            ...(typeof timeout === 'number' && timeout > 0 ? { timeout_seconds: timeout } : {}),
          },
        };
      }
      case 'audit': {
        if (parentKind !== 'seq') {
          return {
            error:
              `plan${path}: an audit belongs in a 'seq' group, directly after the ` +
              `worker_invoke step it judges (par audits can't drive a redo cycle)`,
          };
        }
        return {
          kind: 'audit',
          payload: {
            ...(typeof o.scope === 'string' && o.scope.trim() ? { scope: o.scope.trim() } : {}),
            ...(typeof o.timeout_seconds === 'number' && o.timeout_seconds > 0
              ? { timeout_seconds: o.timeout_seconds }
              : {}),
          },
        };
      }
      case 'ask_human':
        return {
          error: `plan${path}: item kind 'ask_human' is not available yet (slice 3)`,
        };
      default:
        return {
          error: `plan${path}: unknown kind ${JSON.stringify(o.kind)} — use seq | par | tool_call | note | worker_invoke | audit`,
        };
    }
  }

  const root = parseNode(raw, '', 1, null);
  if ('error' in root) return { ok: false, error: root.error };
  if (root.kind !== 'seq' && root.kind !== 'par') {
    return fail('', `the root must be a 'seq' or 'par' group (got '${root.kind}')`);
  }
  return { ok: true, plan: root as PlanGroup, toolSlugs, workerSlugs };
}

/** Reject plan-time references to tools the owner doesn't have (missing,
 *  disabled) so the failure is a teaching error now, not a dead item later. */
async function checkPlanTools(ownerId: string, slugs: string[]): Promise<string | null> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return null;
  const found = await resolveTools(ownerId, unique);
  const have = new Set(found.map((t) => t.slug));
  const missing = unique.filter((s) => !have.has(s));
  if (missing.length === 0) return null;
  return (
    `unknown or disabled tool(s) in plan: ${missing.join(', ')} — ` +
    `only tools you can call yourself can run as items; fix the slug or drop the step`
  );
}

/** Resolve worker routing at plan time (§6b — the roster is a routing
 *  table): explicit `worker` slugs must name enabled worker agents; steps
 *  without one run on the default Worker (lazily created on first use).
 *  Mutates the tree's worker_invoke leaves with the resolved agent id.
 *  Returns a teaching error string, or null on success. */
async function resolveWorkerRouting(ownerId: string, plan: PlanGroup): Promise<string | null> {
  const leaves: PlanLeaf[] = [];
  const walk = (node: PlanNode): void => {
    if (node.kind === 'seq' || node.kind === 'par') {
      for (const c of (node as PlanGroup).children) walk(c);
    } else if (node.kind === 'worker_invoke') {
      leaves.push(node as PlanLeaf);
    }
  };
  walk(plan);
  if (leaves.length === 0) return null;

  const workers = await listWorkerAgents(db, ownerId);
  const bySlug = new Map(workers.map((w) => [w.slug, w]));
  let defaultWorker: Awaited<ReturnType<typeof ensureWorkerAgent>> = null;
  for (const leaf of leaves) {
    const slug = typeof leaf.payload.worker === 'string' ? leaf.payload.worker : undefined;
    if (slug) {
      const w = bySlug.get(slug);
      if (!w) {
        const available =
          workers.map((x) => x.slug).join(', ') || '(none yet — omit `worker` to use the default)';
        return `unknown worker '${slug}' — enabled worker agents: ${available}`;
      }
      leaf.agentId = w.id;
    } else {
      defaultWorker ??= await ensureWorkerAgent(db, ownerId);
      if (!defaultWorker) {
        return 'no worker agent available and the default could not be created — check /settings/agents';
      }
      leaf.agentId = defaultWorker.id;
    }
  }
  return null;
}

async function loadOwnedRun(ownerId: string, runId: unknown) {
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId.trim()), eq(runs.ownerId, ownerId)));
  return run ?? null;
}

export const RUN_TOOLS: BuiltinToolDef[] = [
  {
    slug: 'run_plan',
    name: 'Plan a durable run',
    description:
      'Create a durable run — a tree of seq/par groups of tool_call, note, worker_invoke, and audit items executed in the background — and return its id plus the started tree. Use for delegated multi-step jobs worth tracking; for a quick answer or one or two calls, just call the tools inline. The default shape for real work: seq( note(plan) → worker_invoke(step) → audit → … ) — every worker step followed by an audit you will judge (via `run_audit`) when resumed. You are resumed with compiled results when the run completes. Check progress with `run_state`, extend with `run_append`, stop with `run_cancel`.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable goal, shown in the run view.' },
        plan: {
          type: 'object',
          description:
            "The run tree. Node shapes: {kind:'seq'|'par', label?, join_policy?:'wait_all'|'fail_fast', children:[…]} | {kind:'tool_call', tool:'<slug>', args:{…}, side_effecting?:true, timeout_seconds?:600} | {kind:'note', text:'…'} | {kind:'worker_invoke', step:'<self-contained task>', acceptance_criteria?:'…', worker?:'<worker slug — omit for the default>', subject_node_ids?:[…]} | {kind:'audit', scope?:'…'} (seq-only, right after the worker step it judges). Root must be a group. Mark any state-changing call side_effecting (it then never auto-retries).",
          additionalProperties: true,
        },
      },
      required: ['title', 'plan'],
    },
    handler: async (input, ctx) => {
      const refused = refuseIfDelegated(ctx);
      if (refused) return refused;
      if (!isRunsEnabled()) return { ok: false, error: DISABLED_ERROR };
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title)
        return { ok: false, error: "title is required — a short goal, e.g. 'Weekly inbox digest'" };
      const parsed = parsePlan(input.plan);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const toolError = await checkPlanTools(ctx.ownerId, parsed.toolSlugs);
      if (toolError) return { ok: false, error: toolError };
      const workerError = await resolveWorkerRouting(ctx.ownerId, parsed.plan);
      if (workerError) return { ok: false, error: workerError };

      // Soft ref to the creating responder (conversation identity is
      // (owner, agent) — see runs schema). Best-effort by slug.
      let agentId: string | undefined;
      if (ctx.agent?.slug) {
        const [a] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, ctx.agent.slug)));
        agentId = a?.id;
      }
      const { runId, rootItemId, actions } = await createRun(db, {
        ownerId: ctx.ownerId,
        agentId,
        title,
        plan: parsed.plan,
      });
      await enqueueRunActionsSafe(actions);
      const compiled = await compileRunState(db, runId);
      ctx.step?.setMeta({ run_id: runId });
      return {
        ok: true,
        output: {
          run_id: runId,
          root_item_id: rootItemId,
          state: compiled ? renderRunStateText(compiled) : undefined,
          message:
            'Run created and started. You will be resumed with results when it completes — ' +
            'tell the user what was delegated and end your turn.',
        },
      };
    },
  },
  {
    slug: 'run_append',
    name: 'Append items to a run',
    description:
      'Append tool_call / note items (or nested groups) to an OPEN group of an existing run; returns the new item ids. Sealed (completed) groups refuse — check `run_state` first and target an open group, or start a new run with `run_plan`. Same node shapes as `run_plan`.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run to extend (from run_plan or run_state).' },
        group_id: {
          type: 'string',
          description: 'Target group item id (defaults to the root group).',
        },
        children: {
          type: 'array',
          description: 'Plan nodes to append, in order.',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['run_id', 'children'],
    },
    handler: async (input, ctx) => {
      const refused = refuseIfDelegated(ctx);
      if (refused) return refused;
      if (!isRunsEnabled()) return { ok: false, error: DISABLED_ERROR };
      const run = await loadOwnedRun(ctx.ownerId, input.run_id);
      if (!run) return notFound('run', String(input.run_id ?? ''), 'run_state');
      const groupId =
        typeof input.group_id === 'string' && input.group_id.trim()
          ? input.group_id.trim()
          : run.rootItemId;
      if (!groupId) return { ok: false, error: 'run has no root group — it cannot be appended to' };
      if (!Array.isArray(input.children) || input.children.length === 0) {
        return {
          ok: false,
          error: "children is required — an array of plan nodes (see run_plan's shapes)",
        };
      }
      // Wrap in a throwaway seq to reuse the same parser, then unwrap.
      const parsed = parsePlan({ kind: 'seq', children: input.children });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const toolError = await checkPlanTools(ctx.ownerId, parsed.toolSlugs);
      if (toolError) return { ok: false, error: toolError };
      const workerError = await resolveWorkerRouting(ctx.ownerId, parsed.plan);
      if (workerError) return { ok: false, error: workerError };
      // Ownership of the group: it must belong to this run.
      const [group] = await db
        .select({ id: runItems.id, runId: runItems.runId, kind: runItems.kind })
        .from(runItems)
        .where(eq(runItems.id, groupId));
      if (!group || group.runId !== run.id) {
        return notFound('run group', groupId, 'run_state');
      }
      // The parser saw a throwaway seq wrapper, so re-check the audit rule
      // against the REAL target: an audit appended into a par group could
      // never drive a redo (it would fail needs_human at verdict time) —
      // teach that now instead.
      if (
        group.kind === 'group_par' &&
        (parsed.plan as PlanGroup).children.some((c) => c.kind === 'audit')
      ) {
        return {
          ok: false,
          error:
            `group ${groupId} is a par group — audits belong in a 'seq' group directly after ` +
            `the worker_invoke step they judge (par audits can't drive a redo cycle). ` +
            `Append a seq group containing worker_invoke + audit instead.`,
        };
      }
      try {
        const { itemIds, actions } = await appendChildren(db, {
          groupId,
          children: (parsed.plan as PlanGroup).children as PlanNode[],
        });
        await enqueueRunActionsSafe(actions);
        return { ok: true, output: { item_ids: itemIds } };
      } catch (err) {
        if (err instanceof SealedGroupError) {
          return {
            ok: false,
            error:
              `group ${groupId} is sealed (already completed) — appended work needs a new home: ` +
              `run_state to find an open group, or run_plan for a new run`,
          };
        }
        throw err;
      }
    },
  },
  {
    slug: 'run_state',
    name: 'Inspect runs',
    description:
      "With run_id: return the compiled state of one run — per-item status, one-line outcomes, costs — as text plus structured data. Without run_id: list this brain's recent runs (id, title, status). The compiled state is the ground truth to re-read at resume; never rely on remembered progress.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Omit to list recent runs.' },
        limit: { type: 'number', description: 'List mode: max runs to return (default 10).' },
      },
    },
    handler: async (input, ctx) => {
      const refused = refuseIfDelegated(ctx);
      if (refused) return refused;
      if (typeof input.run_id === 'string' && input.run_id.trim()) {
        const run = await loadOwnedRun(ctx.ownerId, input.run_id);
        if (!run) return notFound('run', String(input.run_id), 'run_state');
        const compiled = await compileRunState(db, run.id);
        if (!compiled) return notFound('run', run.id, 'run_state');
        return { ok: true, output: { text: renderRunStateText(compiled), ...compiled } };
      }
      const limit =
        typeof input.limit === 'number' && input.limit >= 1 && input.limit <= 50
          ? Math.floor(input.limit)
          : 10;
      const rows = await db
        .select({
          id: runs.id,
          title: runs.title,
          status: runs.status,
          createdAt: runs.createdAt,
          completedAt: runs.completedAt,
          costMicroUsd: sql<number>`coalesce((select sum(${runItems.costMicroUsd}) from ${runItems} where ${runItems.runId} = ${runs.id}), 0)::bigint`,
        })
        .from(runs)
        .where(eq(runs.ownerId, ctx.ownerId))
        .orderBy(desc(runs.createdAt))
        .limit(limit);
      return {
        ok: true,
        output: {
          runs: rows.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            created_at: r.createdAt,
            completed_at: r.completedAt,
            cost_micro_usd: Number(r.costMicroUsd),
          })),
        },
      };
    },
  },
  {
    slug: 'run_cancel',
    name: 'Cancel a run',
    description:
      'Cancel a run: every queued/ready/running item in its tree is marked cancelled and no resume fires. Idempotent — cancelling a finished or already-cancelled run reports cancelled=false. In-flight tool executions are not interrupted mid-call; their late results are discarded.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run to cancel (from run_plan or run_state).' },
      },
      required: ['run_id'],
    },
    handler: async (input, ctx) => {
      // Depth guard on the read/stop tools too (§2.7 "every run_* tool"): a
      // delegated worker must never cancel the run it is a step of.
      const refused = refuseIfDelegated(ctx);
      if (refused) return refused;
      const run = await loadOwnedRun(ctx.ownerId, input.run_id);
      if (!run) return notFound('run', String(input.run_id ?? ''), 'run_state');
      const { cancelled } = await cancelRun(db, run.id);
      return { ok: true, output: { run_id: run.id, cancelled } };
    },
  },
  {
    slug: 'run_audit',
    name: 'Record an audit verdict',
    description:
      "Record your verdict on a pending audit item: 'pass' (advisory findings allowed) advances the run; 'redo' requires at least one blocking finding and supersedes the audited worker step with a fresh attempt carrying your findings (one redo max — a second blocking audit fails the step for human decision). Judge the worker's recorded tool ledger against its claims, not its confidence. Use during a resume turn that presents a pending audit; `run_state` shows which item is waiting.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run the audit belongs to.' },
        audit_item_id: {
          type: 'string',
          description: 'The pending audit item (from the resume prompt or run_state).',
        },
        verdict: {
          type: 'string',
          enum: ['pass', 'redo'],
          description:
            "'pass' advances the run; 'redo' reruns the audited step (blocking findings required).",
        },
        findings: {
          type: 'array',
          description:
            'Your findings. Only blocking severity justifies a redo; advisory rides along into the record.',
          items: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                enum: ['blocking', 'advisory'],
                description:
                  'blocking = must be fixed (drives redo); advisory = noted, rides along.',
              },
              claim: {
                type: 'string',
                description: 'The specific defect or observation, one sentence.',
              },
              suggested_fix: {
                type: 'string',
                description: 'What the redo should do differently.',
              },
            },
            required: ['severity', 'claim'],
            additionalProperties: false,
          },
        },
        directive: {
          type: 'string',
          description:
            'The authoritative instruction for the next step — downstream executes this, it does not re-derive.',
        },
      },
      required: ['run_id', 'audit_item_id', 'verdict'],
    },
    handler: async (input, ctx) => {
      const refused = refuseIfDelegated(ctx);
      if (refused) return refused;
      const run = await loadOwnedRun(ctx.ownerId, input.run_id);
      if (!run) return notFound('run', String(input.run_id ?? ''), 'run_state');
      const auditItemId = typeof input.audit_item_id === 'string' ? input.audit_item_id.trim() : '';
      const [item] = await db
        .select({ id: runItems.id, runId: runItems.runId })
        .from(runItems)
        .where(eq(runItems.id, auditItemId));
      if (!item || item.runId !== run.id) return notFound('audit item', auditItemId, 'run_state');
      const verdict = input.verdict === 'pass' || input.verdict === 'redo' ? input.verdict : null;
      if (!verdict) return { ok: false, error: "verdict must be 'pass' or 'redo'" };
      const findings: AuditFinding[] = Array.isArray(input.findings)
        ? (input.findings as Array<Record<string, unknown>>)
            .filter(
              (f) =>
                f &&
                (f.severity === 'blocking' || f.severity === 'advisory') &&
                typeof f.claim === 'string' &&
                f.claim.trim(),
            )
            .map((f) => ({
              severity: f.severity as 'blocking' | 'advisory',
              claim: (f.claim as string).trim(),
              ...(typeof f.suggested_fix === 'string' && f.suggested_fix.trim()
                ? { suggested_fix: f.suggested_fix.trim() }
                : {}),
            }))
        : [];
      const res = await applyAuditVerdict(db, {
        auditItemId,
        verdict,
        findings,
        ...(typeof input.directive === 'string' && input.directive.trim()
          ? { directive: input.directive.trim() }
          : {}),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await enqueueRunActionsSafe(res.actions);
      return {
        ok: true,
        output: {
          outcome: res.outcome,
          ...(res.replacementItemId ? { replacement_item_id: res.replacementItemId } : {}),
          message:
            res.outcome === 'redo'
              ? 'Redo appended — the step will run again with your findings attached. End your turn; you will be resumed when it completes.'
              : res.outcome === 'needs_human'
                ? 'Redo cap reached — the step is marked for human decision. Report the situation to the user when the run resumes you.'
                : 'Verdict recorded — the run advances.',
        },
      };
    },
  },
];
