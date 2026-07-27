/**
 * dispatchShell runs an operator-authored command and feeds stdout straight
 * back to the model, so — exactly like run_terminal — its child env must be
 * scrubbed of secrets: without the `env` option, exec inherits the full
 * process.env and a single `printenv` exfiltrates MANTLE_MASTER_KEY. The
 * invariant under test: the shell child sees the sanitized env, not the raw
 * one (the filter itself is unit-tested in builtins-terminal.test.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// dispatch.ts (via registry → builtins) imports @mantle/db at module scope;
// the shell path under test never touches it. Spread the REAL module (its
// `db` export is a lazy proxy — importing it opens no connection) so
// transitive schema imports keep resolving; only `db` and `tools` stay
// stubbed. @mantle/api-keys is http-path only — stub it entirely.
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  tools: {},
}));
vi.mock('@mantle/api-keys', () => ({ getApiKey: async () => null }));

import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import type { ToolHandlerContext } from './types';

const CTX = { ownerId: 'o1' } as ToolHandlerContext;

function shellTool(cmd: string): Tool {
  return { slug: 'test_shell', handler: { kind: 'shell', cmd } } as unknown as Tool;
}

afterEach(() => {
  delete process.env.MANTLE_MASTER_KEY;
});

describe('dispatchShell env scrub', () => {
  it('never exposes MANTLE_MASTER_KEY to the child shell (but keeps PATH)', async () => {
    process.env.MANTLE_MASTER_KEY = 'supersecret-at-rest-key';

    // ${MANTLE_MASTER_KEY:-ABSENT} is not an ${input.*} placeholder, so it
    // reaches /bin/sh verbatim and expands from the CHILD's env.
    const res = await dispatchTool(
      shellTool('echo "master=${MANTLE_MASTER_KEY:-ABSENT} path=${PATH:+set}"'),
      {},
      CTX,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      const { stdout } = res.output as { stdout: string };
      expect(stdout).toContain('master=ABSENT');
      expect(stdout).not.toContain('supersecret');
      expect(stdout).toContain('path=set');
    }
  });
});
