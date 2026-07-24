import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deterministic replacement for Next's automatic env-file loading.
 * Precedence contract (asserted by env.test.ts, relied on by e2e/run-local.sh):
 * explicit process env ALWAYS wins over file values; files load in order
 * .env.local then .env, first definition wins between them.
 *
 * Deliberately minimal dotenv dialect: KEY=VALUE lines, optional `export `
 * prefix, single/double quotes stripped, `#` comments. No multiline, no
 * interpolation — matching what the app's .env files actually use.
 */
export function loadEnvFiles(dir: string, files: string[] = ['.env.local', '.env']): void {
  for (const name of files) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      if (process.env[key] !== undefined) continue; // explicit env wins
      let value = m[2]!;
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) {
        value = value.slice(1, -1);
      } else {
        // Unquoted values may carry trailing comments.
        const hash = value.indexOf(' #');
        if (hash >= 0) value = value.slice(0, hash);
        value = value.trim();
      }
      process.env[key] = value;
    }
  }
}
