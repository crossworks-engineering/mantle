/**
 * The box-level feature flags reach the containers. Compose passes the app
 * services an explicit list of names (the `x-app-env` anchor), so a flag an
 * operator sets in the host `.env` does nothing unless it is on that list.
 * MANTLE_MEMBERS shipped without its line (v0.232.259 to .261): setting it in
 * `.env` changed nothing and member logins stayed dark.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
const anchor = compose.slice(
  compose.indexOf('x-app-env: &app-env'),
  compose.indexOf('\n\n', compose.indexOf('x-app-env: &app-env')),
);

/** Flags a box turns on in its `.env`; each must pass through the anchor. */
const BOX_FLAGS = ['MANTLE_MEMBERS', 'MANTLE_RUNS', 'MANTLE_MCP_TERMINAL'];

describe('compose passes the box flags to the app services', () => {
  for (const name of BOX_FLAGS) {
    it(name, () => {
      expect(anchor).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}$`, 'm'));
    });
  }
});
