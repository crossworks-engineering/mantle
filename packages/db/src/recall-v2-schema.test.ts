import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { nodeType } from './schema/nodes';
import {
  RECALL_ACTOR_KINDS,
  RECALL_REVISIONS_PER_MAP,
  recallMaps,
  recallNodes,
  recallRevisions,
} from './schema/recall';

/**
 * Recall v2 R1: the schema half of the contract, pinned where it is cheap to
 * pin. The live shape is checked by `schema-drift.db.test.ts` against a
 * migrated database; what is checked HERE is the part a reader of the plan
 * would be surprised to find missing, plus the two migration properties that
 * are only true by construction.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */
const DIR = join(import.meta.dirname, '..', 'migrations');

const sqlOf = (tag: string): string => readFileSync(join(DIR, `${tag}.sql`), 'utf8');

/** Statements of a migration, comments stripped. */
function statementsOf(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

describe('Recall v2 R1: node type', () => {
  it("adds 'recall' to node_type, at the end", () => {
    expect(nodeType.enumValues).toContain('recall');
    // Appended, never inserted: the enum's order is the DB's order, and an
    // existing value must not shift.
    expect(nodeType.enumValues.at(-1)).toBe('recall');
  });

  it('adds the enum value in a file of its own, referencing nothing', () => {
    // `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
    // references the new value (see 0136 and the 0008/0037/0067/0069/0075
    // enum-adds). A second statement in this file is the mistake that rule
    // exists to prevent, so the file is pinned to exactly one.
    const statements = statementsOf(sqlOf('0201_node_type_recall'));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/alter type "public"\."node_type" add value if not exists/i);

    // And nothing else may add it: two ADD VALUEs for one value across two
    // files would mean the second file both adds and (elsewhere) uses it.
    const adders = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => /add\s+value\s+if\s+not\s+exists\s+'recall'/i.test(sqlOf(f.slice(0, -4))));
    expect(adders).toEqual(['0201_node_type_recall.sql']);
  });
});

describe('Recall v2 R1: recall_maps', () => {
  it('carries the node linkage and the native bookkeeping', () => {
    expect(Object.keys(recallMaps)).toEqual(
      expect.arrayContaining(['nodeId', 'published', 'version', 'formerSlugs']),
    );
  });

  it('defaults every new column so a running release stays valid', () => {
    // R1 must not change behaviour: the v1 compiler names its columns
    // explicitly and never sets these, so each one has to be optional or
    // defaulted or its inserts would start failing mid-release.
    expect(recallMaps.published.hasDefault).toBe(true);
    expect(recallMaps.published.default).toBe(true);
    expect(recallMaps.version.hasDefault).toBe(true);
    expect(recallMaps.formerSlugs.hasDefault).toBe(true);
    expect(recallMaps.nodeId.notNull).toBe(false);
  });
});

describe('Recall v2 R1: recall_nodes', () => {
  it('carries card order, the pending-prompt gate and former slugs', () => {
    expect(Object.keys(recallNodes)).toEqual(
      expect.arrayContaining(['rank', 'promptPending', 'formerSlugs']),
    );
    expect(recallNodes.rank.hasDefault).toBe(true);
    expect(recallNodes.promptPending.hasDefault).toBe(true);
    expect(recallNodes.promptPending.default).toBe(false);
  });
});

describe('Recall v2 R1: recall_revisions', () => {
  it('records who changed what, per map, with the card optional', () => {
    expect(Object.keys(recallRevisions)).toEqual(
      expect.arrayContaining([
        'ownerId',
        'mapId',
        'cardId',
        'actorKind',
        'actorId',
        'before',
        'after',
        'createdAt',
      ]),
    );
    // A map-level write (title, enter-when, publish, folder) has no card.
    expect(recallRevisions.cardId.notNull).toBe(false);
    expect(recallRevisions.mapId.notNull).toBe(true);
  });

  it('names the two actors that can write, and the retention', () => {
    expect(RECALL_ACTOR_KINDS).toEqual(['owner', 'agent']);
    expect(RECALL_REVISIONS_PER_MAP).toBe(50);
  });
});

describe('Recall v2 R1: the cascades', () => {
  const sql = sqlOf('0202_recall_v2_schema');

  it('deletes a map row with its item, and its cards with the map', () => {
    // The two FKs are the whole reason a map can be deleted from the tree
    // without leaving served rows behind. Without the cascade on map_id, a
    // deleted map keeps answering recall_go from its orphaned cards.
    expect(sql).toMatch(
      /ADD CONSTRAINT "recall_maps_node_id_fk"[\s\S]*?REFERENCES "public"\."nodes"\("id"\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "recall_nodes_map_id_fk"[\s\S]*?REFERENCES "public"\."recall_maps"\("id"\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /"map_id" uuid NOT NULL REFERENCES "public"\."recall_maps"\("id"\) ON DELETE CASCADE/,
    );
  });

  it('clears orphan cards before adding the FK that would reject them', () => {
    // A FK that fails at migrate takes the roll down. The DELETE must come
    // first in the file.
    const del = sql.search(/DELETE FROM "public"\."recall_nodes"/);
    const fk = sql.search(/ADD CONSTRAINT "recall_nodes_map_id_fk"/);
    expect(del).toBeGreaterThan(-1);
    expect(fk).toBeGreaterThan(del);
  });
});
