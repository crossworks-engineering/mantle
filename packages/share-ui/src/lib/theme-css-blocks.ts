/**
 * Parse a generated theme stylesheet into token blocks, indexed by EACH
 * selector in a block's selector list — the shared lookup behind the theme
 * audits (themes.test.ts, ink-audit.test.ts).
 *
 * Exact-selector indexing matters more than it looks: the audits used to find
 * blocks by `indexOf('<selector> {')`, and once the light blocks grew the
 * `.light` island (`:root, .light { … }`, see themes/generate.mjs) that
 * substring stopped matching the light block — and for the per-theme form,
 * `[data-color-theme="x"] {` matched INSIDE `.dark[data-color-theme="x"] {`,
 * silently auditing dark values as light. Indexing every selector of every
 * block makes the lookup exact and both failure modes structural.
 */
export function parseThemeBlocks(css: string): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  // Comments out first, or the file's header comment glues itself onto the
  // first block's selector list and `:root` never gets keyed.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const t of m[3]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[t[1]!] = t[2]!.trim();
    if (Object.keys(tokens).length === 0) continue;
    for (const sel of m[2]!.split(',')) map.set(sel.trim(), tokens);
  }
  return map;
}
