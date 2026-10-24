/**
 * The hand kind lists (arch plan A10 #12), RECORDED as they stood on main
 * v0.300.46, before they were derived from the kind registry (./kinds).
 *
 * Record, move, compare: the first commit of A10 #12 proved RECORDED
 * against the literals in the source (git show 12b4564ec); now each list is
 * a filter over a registry field (./kind-lists), and this proves two things:
 * each consumer named in RECORDED reads the derived list (CONSUMERS: its
 * file binds the list's name, so the value it uses is the derived one), and
 * the derived list equals RECORDED with CHANGES applied, CHANGES naming
 * every cell that moved. A list the code only asks membership of is
 * compared as a set; a list whose order means something (TYPE_RANK) or that
 * CHANGES says moved in order is compared in order.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_KINDS,
  CONTEXT_REF_KINDS,
  CORPUS_MAP_KINDS,
  DOCUMENT_TITLE_KINDS,
  EMBEDDING_KINDS,
  EXPORT_FORMAT_BY_KIND,
  EXTRACT_KINDS,
  LINK_SERVE_KINDS,
  MENTION_TARGET_KINDS,
  NODE_TYPE_BY_CONTEXT_REF,
  PEER_PICK_EXCLUDED_KINDS,
  SEARCH_TOOL_KINDS,
  acceptedRank,
  forAcceptedKind,
  isAcceptedKind,
} from './kind-lists';
import { ITEM_KINDS, ITEM_KIND_NAMES } from './kinds';
import { MEMBER_ITEM_KINDS } from './member-kinds';

/** The hand lists on main v0.300.46, by name (file, then the list). */
export const RECORDED = {
  // server/api/src/agent/extract/gates.ts: the extractor's default allowlist.
  DEFAULT_EXTRACT_TYPES: [
    'note',
    'page',
    'table',
    'file',
    'email',
    'email_thread',
    'secret',
    'task',
    'event',
    'contact',
    'documentation',
    'journal',
    'location',
    'formula',
    'draw',
  ],
  // server/web/lib/integrity/landed.ts: the integrity view's kinds.
  LANDED_TYPES: [
    'note',
    'page',
    'task',
    'event',
    'contact',
    'secret',
    'file',
    'email',
    'table',
    'journal',
    'formula',
    'draw',
  ],
  // packages/runtime/src/agent/conversation.ts: the corpus map's kinds.
  CORPUS_MAP_TYPES: ['page', 'table', 'file', 'note', 'task', 'app'],
  // packages/db/src/context-ref-resolve.ts: the kinds a context ref names.
  CONTEXT_KINDS: [
    'file',
    'folder',
    'page',
    'note',
    'table',
    'journal',
    'task',
    'event',
    'app',
    'draw',
    'formula',
    'email',
    'contact',
  ],
  // packages/db/src/context-ref-resolve.ts: context kind to node type.
  NODE_TYPE_BY_KIND: {
    file: 'file',
    folder: 'branch',
    page: 'page',
    note: 'note',
    table: 'table',
    journal: 'journal',
    task: 'task',
    event: 'event',
    app: 'app',
    draw: 'draw',
    formula: 'formula',
    contact: 'contact',
  },
  // packages/content/src/embed-closure.ts: the kinds that embed items.
  EMBEDDING_KINDS: ['page', 'draw', 'note'],
  // server/web/lib/maintenance/refold-embeds.ts: KINDS and its Kind union.
  REFOLD_KINDS: ['page', 'note', 'draw'],
  // server/web/app/api/mentions/search/route.ts: what a mention may name.
  MENTION_TARGETS: ['page', 'note', 'draw'],
  // packages/content/src/link-serve.ts serveCandidates: the kinds whose
  // link serves the items they name or embed (a folder serves its own).
  LINK_SERVE_KINDS: ['page', 'note', 'task', 'event', 'draw'],
  // packages/content/src/export-node.ts: EXPORTABLE_TYPES (and ExportKind).
  EXPORTABLE_TYPES: { page: 'docx', note: 'docx', table: 'xlsx', draw: 'svg' },
  // packages/content/src/login-notices.ts: which of a bundle's items names
  // it. ORDERED: the index is the rank.
  TYPE_RANK: ['page', 'note', 'table', 'draw', 'file'],
  // The copied 5-case kind switches over an accepted item (case order).
  SWITCH_MEMBER_ACCEPTED: ['page', 'note', 'table', 'draw', 'file'],
  SWITCH_MEMBER_LIBRARY: ['page', 'note', 'table', 'draw', 'file'],
  SWITCH_MEMBER_SNAPSHOTS: ['page', 'note', 'draw', 'table', 'file'],
  SWITCH_SNAPSHOT_COPIES: ['page', 'note', 'table', 'draw', 'file'],
  // packages/tools/src/builtins-search.ts: search_nodes' `type` enum.
  SEARCH_NODES_TYPE_ENUM: [
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
    'secret',
    'formula',
    'draw',
  ],
  // packages/mcp-core/src/mcp-defs.ts: the MCP `search` tool's `type` enum.
  MCP_SEARCH_TYPE_ENUM: [
    'branch',
    'email',
    'email_thread',
    'file',
    'note',
    'page',
    'sermon',
    'contact',
    'secret',
    'task',
    'event',
    'printer_project',
    'telegram_message',
    'documentation',
    'journal',
    'formula',
    'draw',
  ],
  // server/web/app/api/peers/nodes/route.ts: the kinds the peer grant
  // picker leaves out.
  PEER_PICKER_EXCLUDED: ['branch', 'mantle_peer', 'secret'],
  // packages/content/src/entity-names.ts: kinds whose title names a document.
  DOCUMENT_NODE_TYPES: ['file', 'documentation', 'sermon'],
} as const;

/** Every cell that moved with A10 #12, by list. `add`/`remove`: a kind
 *  that came in or went out (a behaviour change, named); `order`: the same
 *  set in registry order (the code asks membership only, or the order is
 *  only how a schema prints). */
export const CHANGES = {
  // Present (0331), a new kind: every list it joins, at once. Its corpus
  // starts empty, and a save re-extracts only after the quiet period
  // (@mantle/content presents), so joining the extract set is no burst.
  DEFAULT_EXTRACT_TYPES: {
    add: ['present'],
    why: 'Present: a canvas is indexed by its text (title, description, visible text)',
  },
  LANDED_TYPES: {
    add: ['email_thread', 'documentation', 'location', 'present'],
    why:
      'named fix: the three kinds the extractor reads that the integrity view ' +
      'could not see. Visibility only: the extract set is unchanged. Present ' +
      'joins as it joins the extract set',
  },
  SEARCH_NODES_TYPE_ENUM: {
    order: true,
    add: ['present'],
    why:
      'the same 17 kinds in registry order: the tool schema prints them so. ' + 'Present makes 18',
  },
  MCP_SEARCH_TYPE_ENUM: {
    order: true,
    add: ['present'],
    why:
      'the same 17 kinds in registry order (`page` after `telegram_message`): ' +
      'the MCP tools/list snapshots (packages/mcp-core/src/__snapshots__) moved ' +
      'by that one line, and every connection hash with it. Present makes 18',
  },
  PEER_PICKER_EXCLUDED: {
    add: ['present'],
    why: 'Present: not offered to a linked brain yet (no peer share in P1)',
  },
} as const satisfies Partial<
  Record<keyof typeof RECORDED, { add?: readonly string[]; order?: true; why: string }>
>;

/**
 * Where each recorded list is read now: the consumer file and the line that
 * binds it to the derived list (whitespace collapsed). The lists themselves
 * are not exported by most consumers (and importing server code here would
 * turn the package graph around), so the test reads the binding: a consumer
 * that went back to a literal, or to another list, fails here as well as in
 * the lint (no-hand-kind-lists).
 */
export const CONSUMERS: Record<keyof typeof RECORDED, readonly [string, string]> = {
  DEFAULT_EXTRACT_TYPES: [
    'server/api/src/agent/extract/gates.ts',
    'const DEFAULT_EXTRACT_TYPES: readonly string[] = EXTRACT_KINDS;',
  ],
  LANDED_TYPES: [
    'server/web/lib/integrity/landed.ts',
    'export const LANDED_TYPES: readonly string[] = EXTRACT_KINDS;',
  ],
  CORPUS_MAP_TYPES: [
    'packages/runtime/src/agent/conversation.ts',
    'const CORPUS_MAP_TYPES: readonly string[] = CORPUS_MAP_KINDS;',
  ],
  CONTEXT_KINDS: [
    'packages/db/src/context-ref-resolve.ts',
    'export const CONTEXT_KINDS = CONTEXT_REF_KINDS;',
  ],
  NODE_TYPE_BY_KIND: [
    'packages/db/src/context-ref-resolve.ts',
    "Object.entries(NODE_TYPE_BY_CONTEXT_REF).filter(([kind]) => kind !== 'email'),",
  ],
  EMBEDDING_KINDS: [
    'packages/content/src/embed-closure.ts',
    'export const EMBEDDING_KINDS: readonly string[] = REGISTRY_EMBEDDING_KINDS;',
  ],
  REFOLD_KINDS: [
    'server/web/lib/maintenance/refold-embeds.ts',
    'const KINDS: readonly Kind[] = EMBEDDING_KINDS;',
  ],
  MENTION_TARGETS: [
    'server/web/app/api/mentions/search/route.ts',
    'inArray(nodes.type, [...MENTION_TARGET_KINDS]),',
  ],
  LINK_SERVE_KINDS: [
    'packages/content/src/link-serve.ts',
    'if (!(LINK_SERVE_KINDS as readonly string[]).includes(item.type)) return new Set();',
  ],
  EXPORTABLE_TYPES: [
    'packages/content/src/export-node.ts',
    'export const EXPORTABLE_TYPES: Readonly<Record<ExportKind, ExportFormat>> = EXPORT_FORMAT_BY_KIND;',
  ],
  TYPE_RANK: ['packages/content/src/login-notices.ts', 'const rank = acceptedRank;'],
  SWITCH_MEMBER_ACCEPTED: ['packages/content/src/member-accepted.ts', 'forAcceptedKind<'],
  SWITCH_MEMBER_LIBRARY: ['packages/content/src/member-library.ts', 'forAcceptedKind<'],
  SWITCH_MEMBER_SNAPSHOTS: ['packages/content/src/member-snapshots.ts', 'forAcceptedKind<'],
  SWITCH_SNAPSHOT_COPIES: ['server/web/lib/snapshot-copies.ts', 'forAcceptedKind<'],
  SEARCH_NODES_TYPE_ENUM: [
    'packages/tools/src/builtins-search.ts',
    'enum: [...SEARCH_TOOL_KINDS],',
  ],
  MCP_SEARCH_TYPE_ENUM: [
    'packages/mcp-core/src/mcp-defs.ts',
    'type: z.enum(SEARCH_TOOL_KINDS).optional(),',
  ],
  PEER_PICKER_EXCLUDED: [
    'server/web/app/api/peers/nodes/route.ts',
    'const EXCLUDED = PEER_PICK_EXCLUDED_KINDS;',
  ],
  DOCUMENT_NODE_TYPES: [
    'packages/content/src/entity-names.ts',
    'const DOCUMENT_NODE_TYPES: ReadonlySet<string> = new Set(DOCUMENT_TITLE_KINDS);',
  ],
};

const REPO = new URL('../../../', import.meta.url);
const flat = (t: string) => t.replace(/\s+/g, ' ');

const set = (xs: readonly string[]) => [...xs].sort();
/** `xs` in registry order (the order kindsWhere gives). */
const inRegistryOrder = (xs: readonly string[]) =>
  ITEM_KIND_NAMES.filter((t) => (xs as readonly string[]).includes(t));
/** The lists CHANGES says moved in order: compared in order. */
const ORDER_MOVED = new Set(
  Object.entries(CHANGES)
    .filter(([, c]) => 'order' in c)
    .map(([name]) => name),
);
const omit = <T extends Record<string, unknown>>(o: T, k: string) =>
  Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

/** Each list as the code derives it now. */
function derived(): Record<keyof typeof RECORDED, unknown> {
  const accepted = set(ACCEPTED_KINDS);
  return {
    DEFAULT_EXTRACT_TYPES: set(EXTRACT_KINDS),
    LANDED_TYPES: set(EXTRACT_KINDS),
    CORPUS_MAP_TYPES: set(CORPUS_MAP_KINDS),
    CONTEXT_KINDS: set(CONTEXT_REF_KINDS),
    NODE_TYPE_BY_KIND: omit(NODE_TYPE_BY_CONTEXT_REF, 'email'),
    EMBEDDING_KINDS: set(EMBEDDING_KINDS),
    REFOLD_KINDS: set(EMBEDDING_KINDS),
    MENTION_TARGETS: set(MENTION_TARGET_KINDS),
    LINK_SERVE_KINDS: set(LINK_SERVE_KINDS),
    EXPORTABLE_TYPES: { ...EXPORT_FORMAT_BY_KIND },
    TYPE_RANK: [...ACCEPTED_KINDS].sort((a, b) => acceptedRank(a) - acceptedRank(b)),
    SWITCH_MEMBER_ACCEPTED: accepted,
    SWITCH_MEMBER_LIBRARY: accepted,
    SWITCH_MEMBER_SNAPSHOTS: accepted,
    SWITCH_SNAPSHOT_COPIES: accepted,
    // In order: CHANGES says these moved to registry order.
    SEARCH_NODES_TYPE_ENUM: [...SEARCH_TOOL_KINDS],
    MCP_SEARCH_TYPE_ENUM: [...SEARCH_TOOL_KINDS],
    PEER_PICKER_EXCLUDED: set(PEER_PICK_EXCLUDED_KINDS),
    DOCUMENT_NODE_TYPES: set(DOCUMENT_TITLE_KINDS),
  };
}

/** RECORDED with CHANGES applied, in the shape derived() gives. */
function expected(): Record<keyof typeof RECORDED, unknown> {
  const out = {} as Record<keyof typeof RECORDED, unknown>;
  for (const [name, value] of Object.entries(RECORDED) as [keyof typeof RECORDED, unknown][]) {
    const change = (CHANGES as Partial<Record<string, { add?: readonly string[] }>>)[name];
    if (Array.isArray(value)) {
      const list = [...(value as string[]), ...(change?.add ?? [])];
      out[name] =
        name === 'TYPE_RANK' ? list : ORDER_MOVED.has(name) ? inRegistryOrder(list) : set(list);
    } else out[name] = value;
  }
  return out;
}

describe('the hand kind lists, derived from the registry', () => {
  it('each derived list is RECORDED with CHANGES applied, and nothing else moved', () => {
    expect(derived()).toEqual(expected());
  });

  it('each recorded list is read from the derived list by its consumer', () => {
    for (const [name, [file, binding]] of Object.entries(CONSUMERS)) {
      const text = flat(readFileSync(new URL(file, REPO), 'utf8'));
      expect(text.includes("from '@mantle/client-types/kind-lists'"), `${name}: ${file}`).toBe(
        true,
      );
      expect(text.includes(flat(binding)), `${name}: ${file} binds ${binding}`).toBe(true);
    }
  });

  it('CHANGES names only lists that moved: an order entry moved its order and kept its set', () => {
    for (const name of Object.keys(CHANGES) as (keyof typeof CHANGES)[]) {
      const was = RECORDED[name] as readonly string[];
      const now = derived()[name] as readonly string[];
      const change: { add?: readonly string[]; order?: true } = CHANGES[name];
      if (change.order) {
        expect(now.join(), `${name}: the order moved`).not.toBe(was.join());
        // The same set, but for the kinds added since (a new kind).
        expect(set(now), `${name}: the same set`).toEqual(set([...was, ...(change.add ?? [])]));
      } else {
        expect(set(now).join(), `${name}: the set moved`).not.toBe(set(was).join());
      }
    }
  });

  it('the derived lists are frozen: one shared list cannot be changed through a name (F4)', () => {
    for (const list of [EXTRACT_KINDS, SEARCH_TOOL_KINDS, ACCEPTED_KINDS, EMBEDDING_KINDS]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => (list as unknown as string[]).push('x')).toThrow(TypeError);
    }
  });

  it('the search enums keep their 18 kinds: searchable plus secret (Present made 18)', () => {
    expect(set(SEARCH_TOOL_KINDS)).toEqual(set(expected().SEARCH_NODES_TYPE_ENUM as string[]));
    expect(set(SEARCH_TOOL_KINDS)).toEqual(set(expected().MCP_SEARCH_TYPE_ENUM as string[]));
    expect(SEARCH_TOOL_KINDS).toHaveLength(18);
    const searchable = ITEM_KIND_NAMES.filter((t) => ITEM_KINDS[t].searchable);
    expect(set(SEARCH_TOOL_KINDS)).toEqual(set([...searchable, 'secret']));
  });

  it('the extract set is not widened but by a CHANGES entry (Present, a new kind)', () => {
    expect(set(EXTRACT_KINDS)).toEqual(set(expected().DEFAULT_EXTRACT_TYPES as string[]));
    expect(CHANGES.DEFAULT_EXTRACT_TYPES.add).toEqual(['present']);
  });

  it('the accepted kinds are the Library kinds (one list until library goes)', () => {
    expect(set(ACCEPTED_KINDS)).toEqual(set(MEMBER_ITEM_KINDS));
  });

  it('every context ref kind names a kind (folder is a branch)', () => {
    expect(NODE_TYPE_BY_CONTEXT_REF.folder).toBe('branch');
    for (const [ref, t] of Object.entries(NODE_TYPE_BY_CONTEXT_REF)) {
      if (ref !== 'folder') expect(t, ref).toBe(ref);
    }
  });
});

describe('forAcceptedKind', () => {
  type Item = { type: 'page'; doc: string } | { type: 'note'; content: string };
  const cases = {
    page: (i: { type: string; doc?: string }) => `page:${i.doc}`,
    note: (i: { type: string; content?: string }) => `note:${i.content}`,
    table: () => 'table',
    draw: () => 'draw',
    file: () => 'file',
  };

  it('runs the case of the item kind', () => {
    const page: Item = { type: 'page', doc: 'd' };
    expect(forAcceptedKind(page, cases)).toBe('page:d');
    expect(forAcceptedKind({ type: 'file' }, cases)).toBe('file');
  });

  it('answers null for a kind that is not accepted', () => {
    expect(forAcceptedKind({ type: 'task' }, cases)).toBeNull();
    expect(forAcceptedKind({ type: 'toString' }, cases)).toBeNull();
    expect(isAcceptedKind('branch')).toBe(false);
    expect(acceptedRank('task')).toBe(ACCEPTED_KINDS.length);
  });

  it('narrows a union item to the case kind', () => {
    const note: Item = { type: 'note', content: 'c' };
    const got = forAcceptedKind<Item, string>(note, {
      page: (i) => i.doc,
      note: (i) => i.content,
      table: () => '',
      draw: () => '',
      file: () => '',
    });
    expect(got).toBe('c');
  });
});
