/**
 * Every builtin whose handler reads `input.confirm` declares `confirm` in its
 * input schema.
 *
 * The MCP bridge builds a zod object from each tool's JSON schema, and zod
 * drops keys the schema does not name. A handler that reads `input.confirm`
 * from an undeclared key never sees it over MCP, so a tool that answers "ask
 * the user, then call again with confirm: true" (the folder system's
 * visibility confirm) could never go ahead. tree_folder_update shipped that
 * way (folder audit 2026-09-30, T4); this sweep keeps the next one from
 * landing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from './builtins';
import { handlerBodyFor, stripNonCode } from './test-support';

function sources(dir = new URL('./', import.meta.url)): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...sources(new URL(`${e.name}/`, dir)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(readFileSync(new URL(e.name, dir), 'utf8'));
    }
  }
  return out;
}

const SRC = sources();

describe('confirm is declared wherever a handler reads it', () => {
  const readers = BUILTIN_TOOLS.filter((t) =>
    /\binput\.confirm\b/.test(stripNonCode(handlerBodyFor(t.slug, SRC) ?? '')),
  );

  it('finds the tools that read it (the sweep is not vacuous)', () => {
    const slugs = readers.map((t) => t.slug);
    for (const s of ['tree_folder_update', 'tree_item_move', 'file_move', 'folder_move']) {
      expect(slugs).toContain(s);
    }
  });

  it.each(readers.map((t) => [t.slug, t] as const))('%s declares confirm', (_slug, t) => {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('confirm');
  });
});
