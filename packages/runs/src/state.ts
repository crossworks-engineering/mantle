/**
 * Compiled run state — the projection every consumer reads instead of raw
 * rows: the `run_state` tool, the resume turn's prompt, and the run view UI.
 * "The queue is the memory": the responder resumes from THIS, never from held
 * context.
 *
 * Deliberately compact: per item a one-line outcome (result summaries and
 * failures, truncated), never full tool outputs — those live on the item's
 * trace (`trace_ref`) and are fetched only when wanted.
 */
import { asc, eq } from 'drizzle-orm';
import { runItems, runs, type Db, type RunItemRow, type RunRow } from '@mantle/db';

const OUTCOME_MAX_CHARS = 240;

export type CompiledRunItem = {
  id: string;
  kind: RunItemRow['kind'];
  state: RunItemRow['state'];
  position: number;
  /** One-line description of WHAT the item is (tool + arg sketch, note text,
   *  group label). */
  label: string;
  /** One-line outcome for terminal items (truncated result / failure). */
  outcome?: string;
  sideEffecting?: boolean;
  costMicroUsd: number;
  /** Rolled-up cost of the subtree (groups) or own cost (leaves). */
  subtreeCostMicroUsd: number;
  evidenceRefs?: string[];
  /** Executing agent (worker items) — soft ref to agents.id. */
  agentId?: string | null;
  traceRef?: string | null;
  supersededBy?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  deadlineAt?: string | null;
  joinPolicy?: string | null;
  childrenDone?: number;
  childrenTotal?: number;
  children?: CompiledRunItem[];
};

export type CompiledRun = {
  run: {
    id: string;
    ownerId: string;
    title: string;
    status: RunRow['status'];
    agentId: string | null;
    originTurnId: string | null;
    createdAt: string;
    completedAt: string | null;
    budgetMicroUsd: number | null;
    /** Micro-USD actually spent (WP4). */
    spentMicroUsd: number;
    /** Where the run was created from — the root resume reports back here
     *  (0134). NULL = web/background. */
    originChannel: RunRow['originChannel'];
  };
  tree: CompiledRunItem | null;
  totals: { items: number; byState: Record<string, number>; costMicroUsd: number };
};

function truncate(s: string, max = OUTCOME_MAX_CHARS): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function labelFor(item: RunItemRow): string {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  switch (item.kind) {
    case 'group_seq':
      return typeof p.label === 'string' ? `seq: ${p.label}` : 'seq';
    case 'group_par':
      return typeof p.label === 'string' ? `par: ${p.label}` : 'par';
    case 'tool_call': {
      const tool = typeof p.tool === 'string' ? p.tool : '?';
      const args = p.args && typeof p.args === 'object' ? Object.keys(p.args) : [];
      return args.length > 0 ? `tool ${tool}(${args.join(', ')})` : `tool ${tool}()`;
    }
    case 'note':
      return typeof p.text === 'string' ? `note: ${truncate(p.text, 80)}` : 'note';
    case 'worker_invoke': {
      const who = typeof p.worker === 'string' ? p.worker : 'worker';
      return typeof p.step === 'string' ? `${who}: ${truncate(p.step, 80)}` : who;
    }
    case 'audit':
      return 'audit';
    case 'ask_human':
      return typeof p.question === 'string' ? `ask: ${truncate(p.question, 80)}` : 'ask human';
  }
}

function outcomeFor(item: RunItemRow): string | undefined {
  const r = item.result as Record<string, unknown> | null;
  if (!r) return undefined;
  const failure = r.failure as { type?: string; message?: string } | undefined;
  if (failure) return truncate(`FAILED (${failure.type ?? 'error'}): ${failure.message ?? ''}`);
  if (r.summary && typeof r.summary === 'object') {
    const s = r.summary as Record<string, unknown>;
    return `done=${s.done ?? 0} failed=${s.failed ?? 0} cancelled=${s.cancelled ?? 0}`;
  }
  if (typeof r.verdict === 'string') {
    const findings = Array.isArray(r.findings) ? (r.findings as unknown[]).length : 0;
    return `verdict: ${r.verdict}${findings ? ` (${findings} finding${findings === 1 ? '' : 's'})` : ''}`;
  }
  // An answered question: the operator's decision is the outcome, and it is
  // the one thing later steps reason from — render it, never omit it.
  if (typeof r.answer === 'string') return truncate(`answered: ${r.answer}`);
  if (typeof r.proposal === 'string') return truncate(r.proposal);
  if (typeof r.output === 'string') return truncate(r.output);
  if (r.output !== undefined) return truncate(JSON.stringify(r.output));
  return undefined;
}

/** Load one run and compile its item tree. Returns null for an unknown id. */
export async function compileRunState(db: Db, runId: string): Promise<CompiledRun | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const items = await db
    .select()
    .from(runItems)
    .where(eq(runItems.runId, runId))
    .orderBy(asc(runItems.position), asc(runItems.createdAt));

  const byParent = new Map<string | null, RunItemRow[]>();
  for (const it of items) {
    const list = byParent.get(it.parentId) ?? [];
    list.push(it);
    byParent.set(it.parentId, list);
  }
  const byState: Record<string, number> = {};
  for (const it of items) byState[it.state] = (byState[it.state] ?? 0) + 1;

  function compile(item: RunItemRow): CompiledRunItem {
    const children = (byParent.get(item.id) ?? []).map(compile);
    const own = item.costMicroUsd ?? 0;
    const subtree = own + children.reduce((s, c) => s + c.subtreeCostMicroUsd, 0);
    const isGroup = item.kind === 'group_seq' || item.kind === 'group_par';
    return {
      id: item.id,
      kind: item.kind,
      state: item.state,
      position: item.position,
      label: labelFor(item),
      outcome: outcomeFor(item),
      ...(item.sideEffecting ? { sideEffecting: true } : {}),
      costMicroUsd: own,
      subtreeCostMicroUsd: subtree,
      ...(item.evidenceRefs?.length ? { evidenceRefs: item.evidenceRefs } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      traceRef: item.traceRef,
      supersededBy: item.supersededBy,
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
      deadlineAt: item.deadlineAt?.toISOString() ?? null,
      ...(isGroup
        ? {
            joinPolicy: item.joinPolicy,
            childrenDone: item.childrenDone,
            childrenTotal: item.childrenTotal,
            children,
          }
        : {}),
    };
  }

  const root = run.rootItemId ? items.find((i) => i.id === run.rootItemId) : undefined;
  const tree = root ? compile(root) : null;
  return {
    run: {
      id: run.id,
      ownerId: run.ownerId,
      title: run.title,
      status: run.status,
      agentId: run.agentId,
      originTurnId: run.originTurnId,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      budgetMicroUsd: run.budgetMicroUsd,
      spentMicroUsd: run.spentMicroUsd,
      originChannel: run.originChannel,
    },
    tree,
    totals: { items: items.length, byState, costMicroUsd: tree?.subtreeCostMicroUsd ?? 0 },
  };
}

/** Render a compiled run as indented text — the resume prompt / `run_state`
 *  tool output shape. */
export function renderRunStateText(compiled: CompiledRun): string {
  const lines: string[] = [];
  const { run, totals } = compiled;
  const cost = (totals.costMicroUsd / 1_000_000).toFixed(4);
  lines.push(`Run "${run.title}" — status: ${run.status}, items: ${totals.items}, cost: $${cost}`);
  function walk(item: CompiledRunItem, depth: number): void {
    const pad = '  '.repeat(depth);
    const bits = [`[${item.state}]`, item.label];
    if (item.sideEffecting) bits.push('(side-effecting)');
    if (item.outcome) bits.push(`→ ${item.outcome}`);
    if (item.costMicroUsd > 0) bits.push(`($${(item.costMicroUsd / 1_000_000).toFixed(4)})`);
    lines.push(`${pad}- ${bits.join(' ')} <item:${item.id}>`);
    for (const c of item.children ?? []) walk(c, depth + 1);
  }
  if (compiled.tree) walk(compiled.tree, 0);
  return lines.join('\n');
}
