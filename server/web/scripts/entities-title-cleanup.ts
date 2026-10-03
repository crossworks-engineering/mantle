/**
 * Entity cleanup for document corpora (2026-10-03). On a brain of a few
 * thousand sermon PDFs, most `project` / `event` entities were document
 * titles ("The Soul's Best Food", "Sermon #2268"), and one author was split
 * across "C.H. Spurgeon" and "Charles Spurgeon". The extractor no longer
 * makes these (isDocumentTitleMention, the initials step in reconcileEntity);
 * this script cleans what is already there.
 *
 * FREE: pure DB work, no model calls, no embeddings. DRY-RUN by default.
 *
 *   1. Remove project/event entities whose name equals the title of a node of
 *      the given types (default: file, documentation, sermon), compared by
 *      titleKey (catalogue number, [bracket tags] and extension stripped), or
 *      that are a bare numbered-work label ("Sermon #2268"). Their edges are
 *      deleted; their facts keep the text and lose the entity link (FK set
 *      null).
 *   2. Merge person entities whose names agree by initials ("C.H. Spurgeon" =
 *      "Charles Spurgeon"); a group merges only when every pair agrees
 *      (planPersonInitialMerges). Uses mergeEntities: edges and facts move to
 *      the canonical, names fold in as aliases.
 *   3. Drop person aliases that name a different person on the same surname
 *      ("J. A. Spurgeon" on "C.H. Spurgeon"), left by past fuzzy merges.
 *
 * --apply first writes a JSON backup of every affected row (entities with
 * embeddings, their edges, their fact links) and prints its path.
 *
 * Usage:
 *   tsx scripts/entities-title-cleanup.ts                      # dry-run
 *   tsx scripts/entities-title-cleanup.ts --apply
 *   flags: --types=file,page   --backup-dir=<dir>   --owner=<uuid>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, entities, entityEdges, facts, nodes, type Entity } from '@mantle/db';
import {
  isNumberedWorkLabel,
  mergeEntities,
  personNamesConflict,
  planPersonInitialMerges,
  titleKey,
} from '@mantle/content';
import { env } from '@mantle/config';

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const has = (f: string) => process.argv.includes(`--${f}`);

/** Split ids into chunks so an `in (...)` list stays well under the param cap. */
function chunks<T>(xs: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function countsByKind(ownerId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: entities.kind, n: sql<number>`count(*)::int` })
    .from(entities)
    .where(eq(entities.ownerId, ownerId))
    .groupBy(entities.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

async function main() {
  if (!env('DATABASE_URL')) {
    console.error('entities-title-cleanup: DATABASE_URL must be set');
    process.exit(1);
  }
  const apply = has('apply');
  const types = (arg('types') ?? 'file,documentation,sermon')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const ownerId =
    arg('owner') ?? (await db.select({ id: nodes.ownerId }).from(nodes).limit(1))[0]?.id;
  if (!ownerId) {
    console.log('No owner found.');
    return;
  }

  const before = await countsByKind(ownerId);
  console.log(`owner ${ownerId}`);
  console.log('entities by kind (before):', before);

  // ── 1. title-like project/event entities ──────────────────────────────
  const titleRows = await db
    .select({ title: nodes.title })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        inArray(nodes.type, types as (typeof nodes.$inferSelect)['type'][]),
      ),
    );
  const titleKeys = new Set(titleRows.map((r) => titleKey(r.title)).filter((k) => k.length >= 3));
  const titleProne = await db
    .select()
    .from(entities)
    .where(and(eq(entities.ownerId, ownerId), inArray(entities.kind, ['project', 'event'])));
  const removals: { entity: Entity; reason: string }[] = [];
  for (const e of titleProne) {
    if (titleKeys.has(titleKey(e.name))) removals.push({ entity: e, reason: 'node title' });
    else if (isNumberedWorkLabel(e.name)) removals.push({ entity: e, reason: 'numbered label' });
  }
  console.log(
    `\n── REMOVE title-like project/event (${removals.length} of ${titleProne.length}; ` +
      `${titleKeys.size} distinct titles of type ${types.join('/')}) ──`,
  );
  for (const r of removals) console.log(`  [${r.entity.kind}] ${r.entity.name}  (${r.reason})`);
  const kept = titleProne.filter((e) => !removals.some((r) => r.entity.id === e.id));
  console.log(`\n── KEEP project/event (${kept.length}) ──`);
  for (const e of kept) console.log(`  [${e.kind}] ${e.name}`);

  // ── 2. person initials merges ─────────────────────────────────────────
  const persons = await db
    .select({
      row: entities,
      // "entities"."id" spelled out: drizzle renders ${entities.id} here as a
      // bare "id", which the subquery would bind to ed.id.
      edgeCount: sql<number>`(select count(*)::int from ${entityEdges} ed
        where ed.source_id = "entities"."id" or ed.target_id = "entities"."id")`,
    })
    .from(entities)
    .where(and(eq(entities.ownerId, ownerId), eq(entities.kind, 'person')));
  const plan = planPersonInitialMerges(
    persons.map((p) => ({ id: p.row.id, name: p.row.name, edgeCount: p.edgeCount, row: p.row })),
  );
  const merges = plan.groups.map((g) => {
    // canonical: most edges, then the longer name
    const sorted = [...g].sort(
      (a, b) => b.edgeCount - a.edgeCount || b.name.length - a.name.length,
    );
    return { canonical: sorted[0]!, dups: sorted.slice(1) };
  });
  console.log(`\n── MERGE persons by initials (${merges.length} groups) ──`);
  for (const m of merges)
    console.log(
      `  "${m.canonical.name}" (${m.canonical.edgeCount} edges)  ←  ` +
        m.dups.map((d) => `"${d.name}" (${d.edgeCount})`).join(', '),
    );
  if (plan.ambiguous.length > 0) {
    console.log(`\n── SKIPPED ambiguous person groups (${plan.ambiguous.length}) ──`);
    for (const g of plan.ambiguous) console.log(`  ${g.map((p) => `"${p.name}"`).join(', ')}`);
  }

  // ── 3. alias pruning (computed on the post-merge alias sets) ──────────
  const dupIds = new Set(merges.flatMap((m) => m.dups.map((d) => d.id)));
  const prunes: { id: string; name: string; drop: string[] }[] = [];
  for (const p of persons) {
    if (dupIds.has(p.row.id)) continue;
    const merge = merges.find((m) => m.canonical.id === p.row.id);
    const all = [
      ...p.row.aliases,
      ...(merge?.dups.flatMap((d) => [d.row.name, ...d.row.aliases]) ?? []),
    ];
    const drop = [...new Set(all.filter((a) => personNamesConflict(p.row.name, a)))];
    if (drop.length > 0) prunes.push({ id: p.row.id, name: p.row.name, drop });
  }
  console.log(`\n── PRUNE person aliases naming someone else (${prunes.length}) ──`);
  for (const p of prunes)
    console.log(`  "${p.name}": drop ${p.drop.map((d) => `"${d}"`).join(', ')}`);

  if (!apply) {
    console.log('\nDRY RUN: nothing changed. Re-run with --apply to write a backup and apply.');
    return;
  }

  // ── backup ────────────────────────────────────────────────────────────
  const removeIds = removals.map((r) => r.entity.id);
  const touchedIds = [
    ...removeIds,
    ...merges.flatMap((m) => [m.canonical.id, ...m.dups.map((d) => d.id)]),
    ...prunes.map((p) => p.id),
  ];
  const backupEntities: Entity[] = [];
  const backupEdges: (typeof entityEdges.$inferSelect)[] = [];
  const backupFactLinks: { id: string; entityId: string | null }[] = [];
  for (const ids of chunks([...new Set(touchedIds)])) {
    backupEntities.push(...(await db.select().from(entities).where(inArray(entities.id, ids))));
    backupEdges.push(
      ...(await db
        .select()
        .from(entityEdges)
        .where(
          and(
            eq(entityEdges.ownerId, ownerId),
            or(inArray(entityEdges.sourceId, ids), inArray(entityEdges.targetId, ids)),
          ),
        )),
    );
    backupFactLinks.push(
      ...(await db
        .select({ id: facts.id, entityId: facts.entityId })
        .from(facts)
        .where(inArray(facts.entityId, ids))),
    );
  }
  const dir = resolve(arg('backup-dir') ?? process.cwd());
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(dir, `entities-title-cleanup-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        ownerId,
        plan: {
          remove: removals.map((r) => ({ id: r.entity.id, name: r.entity.name, reason: r.reason })),
          merge: merges.map((m) => ({
            canonical: m.canonical.id,
            dups: m.dups.map((d) => d.id),
          })),
          prune: prunes,
        },
        entities: backupEntities,
        edges: backupEdges,
        factLinks: backupFactLinks,
      },
      null,
      0,
    ),
  );
  console.log(
    `\nBackup: ${backupPath} (${backupEntities.length} entities, ${backupEdges.length} edges, ` +
      `${backupFactLinks.length} fact links)`,
  );

  // ── apply ─────────────────────────────────────────────────────────────
  let edgesDeleted = 0;
  await db.transaction(async (tx) => {
    for (const ids of chunks(removeIds)) {
      const del = await tx
        .delete(entityEdges)
        .where(
          and(
            eq(entityEdges.ownerId, ownerId),
            or(
              and(eq(entityEdges.sourceKind, 'entity'), inArray(entityEdges.sourceId, ids)),
              and(eq(entityEdges.targetKind, 'entity'), inArray(entityEdges.targetId, ids)),
            ),
          ),
        )
        .returning({ id: entityEdges.id });
      edgesDeleted += del.length;
      // facts.entity_id is ON DELETE SET NULL: the fact text stays.
      await tx
        .delete(entities)
        .where(and(eq(entities.ownerId, ownerId), inArray(entities.id, ids)));
    }
  });
  console.log(`Removed ${removeIds.length} entities and ${edgesDeleted} edges.`);

  let merged = 0;
  for (const m of merges)
    for (const d of m.dups) if (await mergeEntities(ownerId, m.canonical.id, d.id)) merged++;
  console.log(`Merged ${merged} person duplicates.`);

  for (const p of prunes) {
    const [row] = await db.select().from(entities).where(eq(entities.id, p.id)).limit(1);
    if (!row) continue;
    const drop = new Set(p.drop);
    await db
      .update(entities)
      .set({ aliases: row.aliases.filter((a) => !drop.has(a)), updatedAt: new Date() })
      .where(eq(entities.id, p.id));
  }
  console.log(`Pruned aliases on ${prunes.length} persons.`);

  console.log('\nentities by kind (before):', before);
  console.log('entities by kind (after): ', await countsByKind(ownerId));
}

main()
  .catch((err) => {
    console.error('[entities-title-cleanup] fatal:', err);
    process.exit(1);
  })
  .finally(() => (db as unknown as { $client: { end: () => Promise<void> } }).$client.end());
