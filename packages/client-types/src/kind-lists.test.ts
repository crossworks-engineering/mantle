/**
 * The hand kind lists (arch plan A10 #12), RECORDED as they stood on main
 * v0.300.46, before they were derived from the kind registry (./kinds).
 *
 * Record, move, compare: this file first proves RECORDED against the
 * literals in the source, then (after the move) against the derived lists.
 * A list the code only asks membership of is compared as a set; a list
 * whose order means something says so.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

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

// ── reading the literals of main ────────────────────────────────────────────

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** The bracketed text from the first `open` at or after `marker`. */
function bracketAfter(text: string, marker: string, open: '[' | '{'): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const start = text.indexOf(open, at + marker.length - 1);
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced after ${marker}`);
}

const strings = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const pairs = (s: string) =>
  Object.fromEntries([...s.matchAll(/(\w+):\s*'([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
const cases = (s: string) => [...s.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);

function onMain(): Record<keyof typeof RECORDED, unknown> {
  const gates = source('server/api/src/agent/extract/gates.ts');
  const landed = source('server/web/lib/integrity/landed.ts');
  const conv = source('packages/runtime/src/agent/conversation.ts');
  const ctx = source('packages/db/src/context-ref-resolve.ts');
  const exp = source('packages/content/src/export-node.ts');
  return {
    DEFAULT_EXTRACT_TYPES: strings(bracketAfter(gates, 'const DEFAULT_EXTRACT_TYPES = [', '[')),
    LANDED_TYPES: strings(bracketAfter(landed, 'export const LANDED_TYPES = [', '[')),
    CORPUS_MAP_TYPES: strings(bracketAfter(conv, 'const CORPUS_MAP_TYPES = [', '[')),
    CONTEXT_KINDS: strings(bracketAfter(ctx, 'export const CONTEXT_KINDS = [', '[')),
    NODE_TYPE_BY_KIND: pairs(bracketAfter(ctx, 'export const NODE_TYPE_BY_KIND', '{')),
    EMBEDDING_KINDS: strings(
      bracketAfter(
        source('packages/content/src/embed-closure.ts'),
        'EMBEDDING_KINDS: readonly string[] = [',
        '[',
      ),
    ),
    REFOLD_KINDS: strings(
      bracketAfter(
        source('server/web/lib/maintenance/refold-embeds.ts'),
        'const KINDS: readonly Kind[] = [',
        '[',
      ),
    ),
    MENTION_TARGETS: strings(
      bracketAfter(
        source('server/web/app/api/mentions/search/route.ts'),
        'inArray(nodes.type, [',
        '[',
      ),
    ),
    LINK_SERVE_KINDS: strings(
      bracketAfter(source('packages/content/src/link-serve.ts'), 'if (![', '['),
    ),
    EXPORTABLE_TYPES: pairs(bracketAfter(exp, 'export const EXPORTABLE_TYPES', '{')),
    TYPE_RANK: strings(
      bracketAfter(source('packages/content/src/login-notices.ts'), 'const TYPE_RANK = [', '['),
    ),
    SWITCH_MEMBER_ACCEPTED: cases(
      bracketAfter(source('packages/content/src/member-accepted.ts'), 'switch (base.type)', '{'),
    ),
    SWITCH_MEMBER_LIBRARY: cases(
      bracketAfter(source('packages/content/src/member-library.ts'), 'switch (n.type)', '{'),
    ),
    SWITCH_MEMBER_SNAPSHOTS: cases(
      bracketAfter(source('packages/content/src/member-snapshots.ts'), 'switch (node.type)', '{'),
    ),
    SWITCH_SNAPSHOT_COPIES: cases(
      bracketAfter(source('server/web/lib/snapshot-copies.ts'), 'switch (item.type)', '{'),
    ),
    SEARCH_NODES_TYPE_ENUM: strings(
      bracketAfter(source('packages/tools/src/builtins-search.ts'), 'enum: [', '['),
    ),
    MCP_SEARCH_TYPE_ENUM: strings(
      bracketAfter(source('packages/mcp-core/src/mcp-defs.ts'), '.enum([', '['),
    ),
    PEER_PICKER_EXCLUDED: strings(
      bracketAfter(source('server/web/app/api/peers/nodes/route.ts'), 'const EXCLUDED = [', '['),
    ),
    DOCUMENT_NODE_TYPES: strings(
      bracketAfter(
        source('packages/content/src/entity-names.ts'),
        'const DOCUMENT_NODE_TYPES = new Set([',
        '[',
      ),
    ),
  };
}

describe('the hand kind lists, recorded on main v0.300.46', () => {
  it('RECORDED is every list as main writes it', () => {
    expect(onMain()).toEqual(RECORDED);
  });
});
