/**
 * The kind registry (workspaces arch A1) and the lists of this package that
 * derive from it. Each derived list is pinned to its value before the
 * registry (v0.300.2): a change to who may share, search or see a kind is a
 * reviewed edit of the pin below, never a side effect of a registry field.
 *
 * A list whose order is a contract (the tree's) is pinned in order; a list
 * the code only asks membership of is pinned as a set (it is now in schema
 * order). The parity with SQL (the enum, mantle_kind_class) is a db test:
 * packages/db/src/kind-registry.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES, kindClassOf, kindSpecOf, kindsWhere } from './kinds';
import { TREE_KIND_SPECS, TREE_KINDS } from './tree';
import { SEARCH_NODE_TYPES } from './search-query';
import { CLIENT_ITEM_KINDS, MEMBER_ITEM_KINDS } from './member-kinds';

const set = (xs: readonly string[]) => [...xs].sort();

describe('the kind registry', () => {
  it('names every node_type value once, in the schema's order', () => {
    // The enum (packages/db/src/schema/nodes.ts); the db test checks the
    // live enum_range too.
    expect(ITEM_KIND_NAMES).toEqual([
      'branch',
      'email',
      'email_thread',
      'file',
      'note',
      'sermon',
      'contact',
      'secret',
      'task',
      'event',
      'printer_project',
      'telegram_message',
      'page',
      'table',
      'mantle_peer',
      'documentation',
      'journal',
      'location',
      'app',
      'formula',
      'draw',
      'recall',
    ]);
  });

  it('classes: the workspace kinds, one conversation kind, the rest Admin only', () => {
    expect(set(kindsWhere((s) => s.class === 'workspace'))).toEqual(
      set([
        'branch',
        'file',
        'note',
        'page',
        'table',
        'app',
        'formula',
        'draw',
        'task',
        'event',
        'recall',
      ]),
    );
    expect(kindsWhere((s) => s.class === 'conversation')).toEqual(['telegram_message']);
    expect(kindClassOf('journal')).toBe('admin_only');
    expect(kindClassOf('no-such-kind')).toBe('admin_only');
    expect(kindSpecOf('no-such-kind')).toBeNull();
    expect(kindSpecOf('toString')).toBeNull();
  });

  it('an Admin-only kind is never linked, shared with a contact or a folder share', () => {
    for (const t of ITEM_KIND_NAMES) {
      const s = ITEM_KINDS[t];
      if (s.class !== 'admin_only') continue;
      expect(s.publicLink, t).toBe(false);
      expect(s.contactShare, t).toBe(false);
      expect(s.tree?.shareable ?? false, t).toBe(false);
      expect(s.library, t).toBe(false);
    }
  });

  it('tree orders are unique and dense', () => {
    const trees = ITEM_KIND_NAMES.flatMap((t) => {
      const tree = ITEM_KINDS[t].tree as { order: number; liveOrder: number } | null;
      return tree ? [tree] : [];
    });
    const n = trees.length;
    expect(set(trees.map((t) => String(t.order)))).toEqual(set([...Array(n).keys()].map(String)));
    expect(set(trees.map((t) => String(t.liveOrder)))).toEqual(
      set([...Array(n).keys()].map(String)),
    );
  });

  it('route prefixes are unique', () => {
    const content = ITEM_KIND_NAMES.map((t) => ITEM_KINDS[t].route.content).filter(Boolean);
    expect(new Set(content).size).toBe(content.length);
    const v1 = ITEM_KIND_NAMES.map((t) => ITEM_KINDS[t].route.v1).filter(Boolean);
    expect(new Set(v1).size).toBe(v1.length);
  });
});

describe('derived lists, pinned to their value before the registry', () => {
  it('TREE_KINDS keeps its order (a jackdaw contract)', () => {
    expect(TREE_KINDS).toEqual([
      'files',
      'notes',
      'pages',
      'draw',
      'tables',
      'formulas',
      'apps',
      'tasks',
      'events',
      'contacts',
      'secrets',
      'recall',
    ]);
  });

  it('TREE_KIND_SPECS: every spec as before, keyed in navigation order', () => {
    expect(Object.keys(TREE_KIND_SPECS)).toEqual([...TREE_KINDS]);
    expect(TREE_KIND_SPECS).toEqual({
      files: {
        kind: 'files',
        root: 'files',
        nodeType: 'file',
        shareable: true,
        sorts: ['name', 'updated'],
      },
      notes: {
        kind: 'notes',
        root: 'notes',
        nodeType: 'note',
        shareable: true,
        sorts: ['updated', 'name'],
      },
      pages: {
        kind: 'pages',
        root: 'pages',
        nodeType: 'page',
        shareable: true,
        sorts: ['updated', 'name'],
      },
      draw: {
        kind: 'draw',
        root: 'draw',
        nodeType: 'draw',
        shareable: true,
        sorts: ['updated', 'name'],
      },
      tables: {
        kind: 'tables',
        root: 'tables',
        nodeType: 'table',
        shareable: true,
        sorts: ['updated', 'name'],
      },
      formulas: {
        kind: 'formulas',
        root: 'formulas',
        nodeType: 'formula',
        shareable: true,
        sorts: ['name', 'updated'],
      },
      apps: {
        kind: 'apps',
        root: 'apps',
        nodeType: 'app',
        shareable: true,
        sorts: ['name', 'updated'],
      },
      tasks: {
        kind: 'tasks',
        root: 'tasks',
        nodeType: 'task',
        shareable: false,
        sorts: ['due', 'updated', 'name'],
      },
      events: {
        kind: 'events',
        root: 'events',
        nodeType: 'event',
        shareable: false,
        sorts: ['start', 'name'],
      },
      contacts: {
        kind: 'contacts',
        root: 'contacts',
        nodeType: 'contact',
        shareable: false,
        sorts: ['name', 'updated'],
      },
      secrets: {
        kind: 'secrets',
        root: 'secrets',
        nodeType: 'secret',
        shareable: false,
        sorts: ['name', 'updated'],
      },
      recall: {
        kind: 'recall',
        root: 'recall',
        nodeType: 'recall',
        shareable: false,
        sorts: ['name', 'updated'],
      },
    });
  });

  it('SEARCH_NODE_TYPES (a set)', () => {
    expect(set(SEARCH_NODE_TYPES)).toEqual(
      set([
        'branch',
        'email',
        'email_thread',
        'file',
        'note',
        'page',
        'sermon',
        'contact',
        'task',
        'event',
        'printer_project',
        'telegram_message',
        'documentation',
        'journal',
        'formula',
        'draw',
      ]),
    );
  });

  it('MEMBER_ITEM_KINDS and CLIENT_ITEM_KINDS keep their order (deprecated, one pair release)', () => {
    expect(MEMBER_ITEM_KINDS).toEqual(['page', 'note', 'draw', 'table', 'file']);
    expect(CLIENT_ITEM_KINDS).toEqual(['page', 'note', 'file']);
  });
});
