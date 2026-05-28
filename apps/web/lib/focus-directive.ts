/**
 * Builds the "focus set" directive injected into the Pages delegation prompt
 * when the user has marked blocks via the gutter focus marker. Pure + isolated
 * so the safety contract — operate ONLY on the marked blocks, leave the rest
 * byte-for-byte — is unit-testable without spinning up an agent run.
 *
 * Pages already edits by block id (Phase 2b tools), so this is a prompt
 * directive, not a new tool: naming the exact ids makes "the marked sections"
 * unambiguous and the byte-for-byte instruction reinforces the persona's
 * HARD RULE for everything outside the set.
 */
export function buildFocusDirective(focusBlockIds: readonly string[] | undefined): string {
  const ids = (focusBlockIds ?? []).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return '';
  return (
    `\nFOCUS SET — the user marked specific blocks. Operate ONLY on these ` +
    `block ids and leave EVERY other block byte-for-byte unchanged. You ` +
    `ALREADY have the exact target id(s) below, so do NOT call ` +
    `page_blocks_list — go straight to page_block_get on each id to read it, ` +
    `then page_block_update (only fall back to page_blocks_list if an id is ` +
    `reported not-found). Do not touch, reorder, or restyle any block not in ` +
    `this list:\n` +
    ids.map((bid) => `  - ${bid}`).join('\n') +
    `\n`
  );
}
