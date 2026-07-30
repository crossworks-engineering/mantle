/**
 * Publish guard, run over the SEEDED DATABASE — the last gate before a public URL.
 *
 * demo/generator/guard.mjs already scans generated output, and that is not
 * enough. Clean input does not prove clean derived data: summaries, facts and
 * entities are written by an LLM at ingest, and a model asked to summarise a
 * fictional water utility can reach for a real one it has seen. The generator
 * cannot catch that, because at generation time it does not exist yet.
 *
 * Same SHAPE-based rules as the generator guard, deliberately: a denylist of
 * real names would have to enumerate the very things being kept out of a
 * public repo, which would be the leak it is meant to prevent.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/guard-db.ts
 */
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import { scanText } from '../generator/guard.mjs';
import type { Row, Sql } from './lib/types.ts';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;

type Finding = { where: string; kind: string; value: string };

/** Every column that can hold model-written or user-visible prose. Derived
 *  columns come FIRST — they are the ones the generator guard cannot see. */
const SURFACES: Array<{ label: string; query: () => Promise<Row[]> }> = [
  { label: 'nodes.data.summary (LLM-written)', query: () => sql`
      select id::text as id, data->>'summary' as text from nodes where data ? 'summary'` },
  { label: 'facts (LLM-extracted)', query: () => sql`
      select id::text as id,
             coalesce(subject,'') || ' ' || coalesce(predicate,'') || ' ' || coalesce(object,'') as text
      from facts` },
  { label: 'entities (LLM-extracted)', query: () => sql`
      select id::text as id, coalesce(name,'') || ' ' || coalesce(kind,'') as text from entities` },
  { label: 'content_chunks (indexed passages)', query: () => sql`
      select id::text as id, text from content_chunks` },
  { label: 'assistant_messages (model output)', query: () => sql`
      select id::text as id, content as text from assistant_messages where content is not null` },
  { label: 'nodes.title', query: () => sql`select id::text as id, title as text from nodes` },
  { label: 'emails', query: () => sql`
      select id::text as id,
             coalesce(subject,'') || ' ' || coalesce(from_addr,'') || ' ' ||
             array_to_string(to_addrs,' ') || ' ' || coalesce(body_text,'') as text
      from emails` },
  { label: 'contacts', query: () => sql`
      select id::text as id, coalesce(title,'') || ' ' || coalesce(data::text,'') as text
      from nodes where type = 'contact'` },
];

async function main() {
  console.log(`\npublish guard — seeded database\n  ${DB.replace(/:[^:@/]*@/, ':***@')}\n`);
  const all: Finding[] = [];
  let scanned = 0;

  for (const surface of SURFACES) {
    const rows = await surface.query().catch(() => [] as Row[]);
    const findings: Finding[] = [];
    for (const r of rows) {
      const text = r.text == null ? '' : String(r.text);
      if (!text) continue;
      scanned++;
      scanText(text, `${surface.label}#${String(r.id).slice(0, 8)}`, findings);
    }
    const mark = findings.length ? `✗ ${findings.length}` : 'clean';
    console.log(`  ${surface.label.padEnd(38)} ${String(rows.length).padStart(6)} rows   ${mark}`);
    all.push(...findings);
  }

  console.log(`\n  ${scanned} text values scanned`);
  if (all.length) {
    console.error(`\n✗ ${all.length} finding(s) — NOT publishable:\n`);
    for (const f of all.slice(0, 40)) console.error(`  [${f.kind}] ${f.value}  ← ${f.where}`);
    if (all.length > 40) console.error(`  … and ${all.length - 40} more`);
    console.error(
      '\nIf these sit in an LLM-written column (summary/facts/entities), the model\n' +
        'invented them — regenerating will not help. Re-run extraction, or correct\n' +
        'the offending rows, and scan again before anything is exposed.',
    );
    await sql.end();
    process.exit(1);
  }
  console.log('\n✓ publish guard clean over the seeded brain — including every LLM-written surface.\n');
  await sql.end();
}

main().catch(async (err) => {
  console.error('\n✗ guard-db failed:', err instanceof Error ? err.message : err);
  await sql.end().catch(() => {});
  process.exit(1);
});
