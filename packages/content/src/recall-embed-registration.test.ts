import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every process that can reach a page write must register a Recall embedder.
 *
 * This is the failure the injection was designed around, and it is the reason
 * this file exists rather than a comment. `recallAfterPageWrite` calls
 * `embedPendingRecallPrompts` fire-and-forget, so a process that forgets to
 * register still saves pages, still compiles maps, and still answers every
 * request correctly. The only symptom is that prompt rows keep a null
 * embedding and `recall_match` returns nothing — which reads as "Recall found
 * no prompt for this task", not as a broken deploy.
 *
 * Adding a fourth process that writes pages is therefore a silent regression
 * unless something fails. That something is this test.
 *
 * It is deliberately a SOURCE check, not a runtime one: proving it at runtime
 * would mean booting three servers (DBOS, Hono, an MCP stdio transport), and a
 * test that expensive would be skipped in CI, which is worse than a grep that
 * always runs. What it pins is the call being present and reachable at boot,
 * which is exactly the mistake being guarded against.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The three process entrypoints that can reach a page write. */
const ENTRYPOINTS = [
  {
    file: 'server/web/server/main.ts',
    why: 'the editor commits Recall maps; this is the main authoring path',
  },
  {
    file: 'server/api/src/main.ts',
    why: 'agent page tools, forum and telegram turns write pages',
  },
  {
    file: 'server/mcp/src/server.ts',
    why: 'the stdio transport exposes the same page tools',
  },
];

describe('Recall embedder is registered at every entrypoint', () => {
  for (const { file, why } of ENTRYPOINTS) {
    it(`${file} registers one (${why})`, () => {
      const src = readFileSync(join(repoRoot, file), 'utf8');

      // The call itself, with an argument — `registerRecallEmbedder` merely
      // being imported would satisfy a substring match while doing nothing.
      expect(src, `${file} must call registerRecallEmbedder(...) at boot`).toMatch(
        /registerRecallEmbedder\(\s*\w/,
      );

      // And it must actually have an embedder to pass: static import or the
      // awaited form server/web needs so env loads first.
      expect(src, `${file} must obtain embedBatch from @mantle/embeddings`).toMatch(
        /embedBatch\s*\}\s*=?\s*(await\s+import\(|from\s*)['"]@mantle\/embeddings['"]/,
      );
    });
  }

  it('lists every entrypoint that depends on @mantle/content', () => {
    // A new process that imports @mantle/content can reach a page write, so it
    // belongs in ENTRYPOINTS above. This catches the addition at the package
    // boundary rather than waiting for someone to notice missing embeddings.
    const packages = ['server/web', 'server/api', 'server/mcp'];
    const dependants = packages.filter((pkg) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, pkg, 'package.json'), 'utf8'),
      ) as Record<string, Record<string, string> | undefined>;
      return Boolean(manifest.dependencies?.['@mantle/content']);
    });
    const covered = ENTRYPOINTS.map((e) => e.file.split('/').slice(0, 2).join('/'));
    expect(dependants.sort()).toEqual(covered.sort());
  });
});
