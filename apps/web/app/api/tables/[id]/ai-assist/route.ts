/**
 * /api/tables/[id]/ai-assist — invoke the Tables specialist on the open grid
 * with the user's instruction. The agent does its work through the table tools
 * (table_rows_list → table_row_update / table_set_aggregate / table_column_add …),
 * all writes land in `draft_data`, and we return its status text plus the fresh
 * table so the editor reloads the draft without a refresh round-trip.
 *
 * Like the Pages editor panel: the user is already IN the table, so we skip the
 * Saskia hop, preload the grid's structure into the prompt, and hand back the
 * updated draft directly.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { getTable } from '@/lib/tables';
import { listRows, type TableDoc } from '@mantle/content';
import { invokeAgent } from '@mantle/agent-runtime';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';

const Body = z.object({ prompt: z.string().min(1).max(8000) });

function structureSummary(doc: TableDoc): string {
  const cols = doc.columns
    .map((c) => `${c.name} (${c.type}${c.id ? `, id=${c.id}` : ''}${c.formula ? `, formula="${c.formula}"` : ''})`)
    .join('; ');
  const aggs = Object.entries(doc.aggregates ?? {})
    .map(([colId, kind]) => `${doc.columns.find((c) => c.id === colId)?.name ?? colId}=${kind}`)
    .join(', ');
  // A small sample so the agent can reason about values without a tool call,
  // but it must still call table_rows_list to get the row ids it edits by.
  const sample = listRows(doc, { limit: 5 });
  return (
    `Columns: ${cols || '(none)'}\n` +
    `Row count: ${doc.rows.length}\n` +
    (aggs ? `Totals: ${aggs}\n` : '') +
    `First rows (preview only — use table_rows_list for ids):\n` +
    sample.rows.map((r) => `  ${JSON.stringify(r.cells)}`).join('\n')
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }

  const before = await getTable(user.id, id);
  if (!before) return NextResponse.json({ error: 'table not found' }, { status: 404 });

  const baseline = (before.draft ?? before.data) as TableDoc;
  const delegationPrompt =
    `You are editing the table below in the user's grid editor. ALWAYS call ` +
    `table_rows_list (and table_get if you need totals/columns) FIRST to get the ` +
    `current row + column ids, then make the requested change with the table ` +
    `tools (table_row_update / table_cell_set / table_column_add / ` +
    `table_set_aggregate / table_set_view / …). Every edit lands in the DRAFT — ` +
    `the user reviews and commits, so do NOT call table_commit unless they ask. ` +
    `Report a short status of what you changed; do not echo the whole grid.\n` +
    `\n` +
    `Table id:    ${id}\n` +
    `Table title: ${before.title}\n` +
    `${structureSummary(baseline)}\n` +
    `\n` +
    `User request:\n${parsed.data.prompt}`;

  // Which agent handles table-assist is configurable on the /tables surface
  // (the Assist panel picker → profiles.preferences.tablesAssistAgentSlug);
  // falls back to the default `tables` (Ledger) specialist seeded at onboarding.
  const agentSlug = await resolveAssistAgentSlug(user.id, 'tables');
  if (!agentSlug) {
    return NextResponse.json(
      {
        error:
          'No Tables assistant is set up yet. Pick one in the Assist panel, or finish onboarding to provision the default Ledger specialist.',
      },
      { status: 409 },
    );
  }

  const result = await invokeAgent({
    ownerId: user.id,
    agentSlug,
    prompt: delegationPrompt,
    depth: 1,
    parentTraceId: null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  const after = await getTable(user.id, id);
  if (!after) return NextResponse.json({ error: 'table disappeared mid-run' }, { status: 500 });
  const afterDoc = (after.draft ?? after.data) as TableDoc;

  return NextResponse.json({
    ok: true,
    reply: result.text,
    table: after,
    hasDraft: !!after.draft,
    summary: {
      columnsBefore: baseline.columns.length,
      columnsAfter: afterDoc.columns.length,
      rowsBefore: baseline.rows.length,
      rowsAfter: afterDoc.rows.length,
    },
  });
}
