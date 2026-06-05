import { describe, it, expect } from 'vitest';
import { DEFAULT_ASSISTANT_TOOL_SLUGS, BUILTIN_TOOLS } from './index';

/**
 * The default tool grant is a vital: a freshly-provisioned assistant seeded
 * without these can't act (no search, no capture, no delegation). Guard both the
 * must-haves and the deliberate exclusions so a registry change can't silently
 * strip a capability or leak a dangerous/specialist tool into the generalist.
 */
describe('DEFAULT_ASSISTANT_TOOL_SLUGS', () => {
  const slugs = new Set(DEFAULT_ASSISTANT_TOOL_SLUGS);

  it('includes the generalist baseline', () => {
    const must = [
      'invoke_agent', // delegation to specialists
      'search_nodes',
      'node_read',
      'note_create',
      'event_create',
      'todo_create',
      'contact_create',
      'lifelog_create',
      'file_read',
      'file_create',
      'page_create',
      'synthesize_speech',
      'extract_from_image',
      'generate_image',
      'recall_window',
    ];
    expect(must.filter((s) => !slugs.has(s))).toEqual([]);
  });

  it('excludes specialist + dangerous tools', () => {
    const mustNot = [
      'run_terminal', // unrestricted shell
      'page_delete', // destructive
      'web_search', // delegate to researcher
      'find_window', // delegate to remy
      'table_create', // delegate to Ledger
      'peer_query', // federation, opt-in
    ];
    expect(mustNot.filter((s) => slugs.has(s))).toEqual([]);
  });

  it('is a non-trivial subset of the static registry', () => {
    expect(DEFAULT_ASSISTANT_TOOL_SLUGS.length).toBeGreaterThan(30);
    expect(DEFAULT_ASSISTANT_TOOL_SLUGS.length).toBeLessThan(BUILTIN_TOOLS.length);
    // every default slug is a real registry slug
    const registry = new Set(BUILTIN_TOOLS.map((t) => t.slug));
    expect(DEFAULT_ASSISTANT_TOOL_SLUGS.filter((s) => !registry.has(s))).toEqual([]);
  });
});
