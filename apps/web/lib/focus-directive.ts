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
    `block ids and leave EVERY other block byte-for-byte unchanged. Use ` +
    `page_block_get on each to read it, then page_block_update. Do not ` +
    `touch, reorder, or restyle any block not in this list:\n` +
    ids.map((bid) => `  - ${bid}`).join('\n') +
    `\n`
  );
}
