/**
 * Layer-2 assertions: did the seed actually produce a brain?
 *
 * This is the tripwire v1 never had. v1's demo brain held 37 nodes and nobody
 * noticed until the screens were empty in public. Here, a seed that
 * under-produces — or whose extraction never ran — FAILS, loudly, with the
 * number that fell short.
 *
 * The derived counts matter most: chunks, facts, entities and edges are
 * produced by the real ingest pipeline, so non-zero derived data is the proof
 * that extraction actually ran rather than just content being inserted.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/verify.ts [--wait 900]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { Row, Sql } from './lib/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const targets = JSON.parse(readFileSync(join(here, '..', 'world', 'targets.json'), 'utf8'));
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';

const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const WAIT_S = argOf('--wait', 900);

const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;
const one = async (q: Promise<Row[]>) => Number((await q)[0]?.n ?? 0);

async function snapshot() {
  return {
    nodes: await one(sql`select count(*)::int n from nodes`),
    chunks: await one(sql`select count(*)::int n from content_chunks`),
    facts: await one(sql`select count(*)::int n from facts`),
    entities: await one(sql`select count(*)::int n from entities`),
    edges: await one(sql`select count(*)::int n from entity_edges`),
    // Long-form genres MUST split into multiple chunks or passage retrieval
    // has nothing to retrieve. This is the check a raw total was standing in
    // for, and unlike a total it does not move with corpus composition.
    longformRatio: Number(
      (
        await sql`select round(count(c.id)::numeric / greatest(count(distinct n.id), 1), 2) n
                  from nodes n join content_chunks c on c.node_id = n.id
                  where n.type in ('page', 'table')`
      )[0]?.n ?? 0,
    ),
    // Every extracted node should yield at least one chunk.
    chunkedNodes: await one(
      sql`select count(distinct node_id)::int n from content_chunks`,
    ),
    // A node counts as extracted once the extractor stamps its completion
    // marker — the same marker its own already_extracted guard keys on.
    extracted: await one(
      sql`select count(*)::int n from nodes where data ? 'extract_completed_at'`,
    ),
    runs: await one(sql`select count(*)::int n from runs`).catch(() => 0),
    maintenanceRuns: await one(sql`select count(*)::int n from maintenance_runs`).catch(() => 0),
    messages: await one(sql`select count(*)::int n from assistant_messages`).catch(() => 0),
    traces: await one(sql`select count(*)::int n from traces`).catch(() => 0),
    pending: await one(
      sql`select count(*)::int n from pgboss.job where name like '%extract%' and state in ('created','active','retry')`,
    ).catch(() => 0),
  };
}

async function waitForDrain() {
  const started = Date.now();
  let last = -1;
  let stableFor = 0;
  process.stdout.write('· waiting for the extractor queue to drain\n');
  while ((Date.now() - started) / 1000 < WAIT_S) {
    const s = await snapshot();
    const done = s.extracted;
    if (s.pending === 0 && done === last) {
      stableFor += 5;
      // Quiet queue AND no progress for 15s → extraction has settled.
      if (stableFor >= 15) return s;
    } else {
      stableFor = 0;
    }
    if (done !== last) {
      process.stdout.write(
        `  extracted ${done}/${s.nodes} · chunks ${s.chunks} · facts ${s.facts} · queue ${s.pending}\n`,
      );
    }
    last = done;
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stdout.write(`  (gave up waiting after ${WAIT_S}s — asserting on what landed)\n`);
  return snapshot();
}

async function main() {
  const s = await waitForDrain();

  const checks: Array<[string, number, number]> = [
    ['content_chunks', s.chunks, targets.derived.content_chunks.min],
    ['chunks/longform node', s.longformRatio, targets.derived.chunks_per_longform_node.min],
    ['nodes with a chunk', s.chunkedNodes, Math.round(s.extracted * 0.95)],
    ['facts', s.facts, targets.derived.facts.min],
    ['entities', s.entities, targets.derived.entities.min],
    ['entity_edges', s.edges, targets.derived.entity_edges.min],
  ];
  const byType = await sql`select type, count(*)::int n from nodes group by type`;
  const counts: Record<string, number> = Object.fromEntries(
    byType.map((r) => [String(r.type), Number(r.n)]),
  );
  const nodeTargets = targets.nodes as Record<string, { min: number }>;
  for (const [kind, spec] of Object.entries(nodeTargets)) {
    checks.unshift([`nodes.${kind}`, counts[kind] ?? 0, spec.min]);
  }
  checks.unshift(['emails', counts.email ?? 0, targets.emails.min]);
  // Behavioural data — produced by real turns and real worker runs (P4),
  // never written as rows.
  const b = targets.behavioural;
  checks.push(
    ['traces', s.traces, b.traces.min],
    ['assistant_messages', s.messages, b.assistant_messages.min],
    ['runs', s.runs, b.runs.min],
    ['maintenance_runs', s.maintenanceRuns, b.maintenance_runs.min],
  );

  console.log('\nlayer-2 assertions (min = a seed below this is a FAILED seed)\n');
  const pad = (x: string | number, n: number) => String(x).padEnd(n);
  console.log(`${pad('metric', 22)}${pad('got', 9)}${pad('min', 8)}status`);
  let failed = 0;
  for (const [name, got, min] of checks) {
    const ok = got >= min;
    if (!ok) failed++;
    console.log(`${pad(name, 22)}${pad(got, 9)}${pad(min, 8)}${ok ? 'ok' : 'UNDER'}`);
  }

  const unextracted = s.nodes - s.extracted;
  console.log(`\nextraction: ${s.extracted}/${s.nodes} nodes carry a completion marker` +
    (unextracted > 0 ? ` (${unextracted} outstanding)` : ''));

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) under minimum — this seed is NOT publishable.`);
    if (s.chunks === 0 || s.facts === 0) {
      console.error(
        '  Derived data is zero: content was created but EXTRACTION NEVER RAN.\n' +
          '  server/api must be running against this database, and it needs a working\n' +
          '  chat model (summaries + facts) and embedder. This is the exact shape of\n' +
          '  the v1 failure — content present, brain absent.',
      );
    }
    await sql.end();
    process.exit(1);
  }
  console.log('\n✓ all layer-2 assertions pass — the brain is real, not just populated.\n');
  await sql.end();
}

main().catch(async (err) => {
  console.error('\n✗ verify failed:', err instanceof Error ? err.message : err);
  await sql.end().catch(() => {});
  process.exit(1);
});
