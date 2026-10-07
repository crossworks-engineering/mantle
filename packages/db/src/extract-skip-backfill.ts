/**
 * One-off cleanup for nodes that looped through the extractor before the
 * terminal-skip stamp existed (extract-exempt.ts, `data.extract_skipped`).
 *
 * A brain node with no embedding whose LATEST extractor run was a skip that
 * is a verdict on its content (TERMINAL_EXTRACT_SKIPS), recorded after the
 * node's last write, gets the stamp the extractor now writes itself. A
 * telegram turn counts when its text is under 2 chars (nothing to embed).
 * Everything else is left for the drain: a vision or OCR skip (the old trace
 * cannot always show the worker ran), a machinery failure, a node changed
 * since its last run.
 *
 * Plain SQL: no model, no embedding, no queue. Dry run by default.
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './client';
import { nodes } from './schema/nodes';
import {
  TERMINAL_EXTRACT_SKIPS,
  extractExemptSql,
  extractSkippedSql,
  extractSkippedStamp,
} from './extract-exempt';

export interface TerminalSkipBackfill {
  /** Nodes stamped (apply) or that would be (dry run). */
  stamped: number;
  /** The same nodes by `type:disposition`. Counts only, safe to print on a
   *  client box. */
  byKind: Record<string, number>;
  /** Up to 10 node ids, for a spot check. Ids only, never titles. */
  sampleIds: string[];
}

export async function backfillTerminalSkips(opts: {
  dryRun: boolean;
}): Promise<TerminalSkipBackfill> {
  const terminal = sql.join(
    TERMINAL_EXTRACT_SKIPS.map((d) => sql`${d}`),
    sql`, `,
  );
  const rows = (await systemDb.execute(sql`
    with last_run as (
      select distinct on (t.subject_id)
             t.subject_id, t.status, t.data->>'disposition' as disposition, t.started_at
        from public.traces t
       where t.kind = 'extractor_run'
         and t.subject_id in (select id from ${nodes} where ${nodes.embedding} is null)
       order by t.subject_id, t.started_at desc
    )
    select ${nodes.id} as id, ${nodes.type}::text as type, l.disposition
      from ${nodes}
      join last_run l on l.subject_id = ${nodes.id}
     where public.mantle_is_brain_space(${nodes.ownerId})
       and ${nodes.type} <> 'branch'
       and ${nodes.embedding} is null
       and not ${extractExemptSql()}
       and not ${extractSkippedSql()}
       and l.status = 'skipped'
       and l.started_at >= ${nodes.updatedAt}
       and (l.disposition in (${terminal})
            or (${nodes.type} = 'telegram_message'
                and l.disposition = 'telegram_embed_only'
                and length(btrim(coalesce(${nodes.data}->>'text', ''))) < 2))
  `)) as unknown as Array<{ id: string; type: string; disposition: string }>;

  const byKind: Record<string, number> = {};
  for (const r of rows) {
    const k = `${r.type}:${r.disposition}`;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  if (!opts.dryRun) {
    // One statement per disposition: the stamp carries the reason.
    const byDisposition = new Map<string, string[]>();
    for (const r of rows) {
      const list = byDisposition.get(r.disposition) ?? [];
      list.push(r.id);
      byDisposition.set(r.disposition, list);
    }
    for (const [disposition, ids] of byDisposition) {
      const idList = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      await systemDb.execute(sql`
        update ${nodes}
           set data = coalesce(${nodes.data}, '{}'::jsonb) || ${extractSkippedStamp(disposition)}
         where ${nodes.id} in (${idList})`);
    }
  }
  return { stamped: rows.length, byKind, sampleIds: rows.slice(0, 10).map((r) => r.id) };
}
