import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';

/**
 * A slug must have ONE implementation.
 *
 * build-server.ts can either hand-write a `server.tool(...)` or bridge the
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
 * is a product decision about the MCP read contract — see the skip lists in
 * build-server.ts, which name the same slugs.
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

/** Slugs registered by a literal `server.tool('…')` call in build-server.ts. */
function handWrittenSlugs(): string[] {
  const src = readFileSync(new URL('./build-server.ts', import.meta.url), 'utf8');
  return [...src.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!);
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

  it('registers each slug only once', () => {
    const seen = new Map<string, number>();
    for (const slug of handWrittenSlugs()) seen.set(slug, (seen.get(slug) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });
});
