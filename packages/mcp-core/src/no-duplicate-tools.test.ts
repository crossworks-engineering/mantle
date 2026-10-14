import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { MCP_TOOL_DEFS } from './mcp-defs';

/**
 * A slug must have ONE implementation.
 *
 * build-server.ts can either hand-write an `addTool(server, ...)` or bridge the
 * in-app `BuiltinToolDef` that already implements the same slug. Doing both
 * gives the MCP client a second implementation that no one runs in development,
 * and they drift: the hand-written twins of the content tools had lost ingest
 * provenance on create, permalinks and teaching errors on read, and returned a
 * plain "not found" without `isError`, which a client reads as success.
 *
 * This test pins the remaining overlap EXACTLY, so the set can only shrink.
 * A new hand-written duplicate fails here; removing one means deleting its
 * entry below, which is a deliberate act with a reviewer attached.
 */

/**
 * Still hand-written despite a builtin of the same name.
 *
 * The page and table READS are a deliberate contract choice, not an oversight:
 * the builtins return plaintext plus block ids while these return the raw
 * ProseMirror / row shape that shipped MCP clients already parse. Changing that
 * is a product decision about the MCP read contract. Since A5 step 2 each is
 * a definition (mcp-defs.ts), and the bridge skips a builtin a definition
 * names: this list is the table's, pinned here so it can only shrink.
 *
 * The rest have no dedicated exported group in @mantle/tools yet (they all live
 * in the builtins.ts catch-all), so bridging them is a follow-up that starts by
 * giving them one.
 */
const KNOWN_UNBRIDGED = [
  // Deliberate read-shape divergence.
  'page_get',
  'page_list',
  'table_get',
  'table_list',
  'table_rows_list',
  // Schemas MCP clients already depend on: the builtins take `file_id` /
  // `folder_id` and (tree_list) optional path+limit, the hand-written twins
  // take `id` and, for the folder pair, a path as an alternative to the id.
  // Bridging them would rename arguments under shipped connectors.
  'tree_list',
  'file_get',
  'file_read',
  'file_rename',
  'folder_describe',
  'folder_rename',
].sort();

/**
 * The hand-written slugs: every definition of the table (mcp-defs.ts), and
 * any literal `addTool(server, '…')` or `registerTool('…')` call anywhere in
 * the package, so a tool hand-written outside the table cannot slip past
 * this test.
 *
 * The directory is SWEPT rather than listed, so a new module cannot carry a
 * hand-written twin past this test by not being named here.
 */
function literalAddToolSlugs(): string[] {
  const out: string[] = [];
  const sweep = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__snapshots__') {
        sweep(new URL(`${entry.name}/`, dir));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const src = readFileSync(new URL(entry.name, dir), 'utf8');
        for (const m of src.matchAll(/addTool\(\s*\w+,\s*'([a-z0-9_]+)'/g)) out.push(m[1]!);
        // The SDK's own call with a literal name (A5 step 4: the one
        // registration, gated-tools.ts, names none).
        for (const m of src.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)) out.push(m[1]!);
      }
    }
  };
  sweep(new URL('./', import.meta.url));
  return out;
}

function handWrittenSlugs(): string[] {
  return [...MCP_TOOL_DEFS.map((d) => d.slug), ...literalAddToolSlugs()];
}

describe('no slug is implemented twice', () => {
  it('every hand-written duplicate is a known, documented exception', () => {
    const builtin = new Set(BUILTIN_TOOLS.map((t) => t.slug));
    const duplicated = handWrittenSlugs()
      .filter((slug) => builtin.has(slug))
      .sort();

    expect(duplicated).toEqual(KNOWN_UNBRIDGED);
  });

  it('the exception list itself has no stale entries', () => {
    // An entry that is no longer hand-written, or no longer a builtin, is a
    // leftover — it would silently mask a future duplicate of the same name.
    const builtin = new Set(BUILTIN_TOOLS.map((t) => t.slug));
    const handWritten = new Set(handWrittenSlugs());
    for (const slug of KNOWN_UNBRIDGED) {
      expect(handWritten.has(slug), `${slug} is no longer hand-written`).toBe(true);
      expect(builtin.has(slug), `${slug} is no longer a builtin`).toBe(true);
    }
  });

  it('every hand-written tool is a definition of the table (A5 step 2)', () => {
    expect(literalAddToolSlugs()).toEqual([]);
  });

  it('registers each slug only once', () => {
    const seen = new Map<string, number>();
    for (const slug of handWrittenSlugs()) seen.set(slug, (seen.get(slug) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });
});
