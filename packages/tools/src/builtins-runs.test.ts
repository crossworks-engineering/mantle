import { describe, expect, it } from 'vitest';
// Via the package index, NOT './builtins-runs' directly: the module cycle
// builtins-runs → dispatch → registry → builtins → builtins-runs only
// evaluates cleanly when the registry loads first (the index order).
import { BANNED_ITEM_TOOLS, RUN_TOOLS } from './index';

/**
 * The item ban list must cover every run_* tool (audit 2026-07-21: run_audit
 * was added in slice 2 without being banned, letting a queue item record an
 * audit verdict headlessly — bypassing the fresh-context audit turn). This
 * test makes the list self-maintaining: add a run tool and it fails until
 * the tool is banned as an item too.
 */
describe('runner-queue item ban list', () => {
  it('bans every run_* tool as a queue item', () => {
    for (const tool of RUN_TOOLS) {
      expect(BANNED_ITEM_TOOLS.has(tool.slug), `'${tool.slug}' must be in BANNED_ITEM_TOOLS`).toBe(
        true,
      );
    }
  });

  it('bans delegation as a queue item', () => {
    expect(BANNED_ITEM_TOOLS.has('invoke_agent')).toBe(true);
  });
});
