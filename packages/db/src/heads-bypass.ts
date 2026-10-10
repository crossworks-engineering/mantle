/**
 * The named heads-check bypass of a migration (workspaces plan V5, migration
 * 0244): a migration that writes nodes, chunks, windows, facts or grants in
 * bulk calls `SELECT mantle_heads_bypass('<its name>');` first. The database
 * signs it and logs one row; the runner prints the names it finds, so every
 * bypass shows in the migration output too. Pure.
 */
const CALL = /\bmantle_heads_bypass\s*\(\s*'((?:[^']|'')*)'\s*\)/gi;

/** The bypass names a migration's statements declare, in order. */
export function headsBypassesIn(statements: readonly string[]): string[] {
  const out: string[] = [];
  for (const stmt of statements) {
    // Comments do not count: only a call that runs.
    const code = stmt.replace(/--[^\n]*/g, '');
    for (const m of code.matchAll(CALL)) out.push(m[1]!.replace(/''/g, "'"));
  }
  return out;
}
