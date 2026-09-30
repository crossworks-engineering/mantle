import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every process that can run a Recall tool or route must register a Recall
 * embedder.
 *
 * This is the failure the injection was designed around, and it is the reason
 * this file exists rather than a comment. A native card write, a prompt
 * confirm and `recall_match` all call `embedPendingRecallPrompts`
 * fire-and-forget, so a process that forgets to register still writes cards
 * and still answers every request correctly. The only symptom is that prompt
 * rows keep a null embedding and `recall_match` returns nothing — which reads
 * as "Recall found no prompt for this task", not as a broken deploy.
 *
 * (Until R5 the trigger was a page write into a `recall` tree. The processes
 * are the same ones: wherever tools run, the Recall tools run.)
 *
 * Adding another process that runs tools is therefore a silent regression
 * unless something fails. That something is this test.
 *
 * The 2026-09-03 audit found two it had missed, both inside server/web, whose
 * package-level check below said "covered" because the SERVER registers one:
 * the runs worker (run items dispatch tools, page_create among them) and the
 * telegram poller (an Approve tap runs the parked tool in that process). The
 * worker sweep at the bottom is what would have caught them.
 *
 * It is deliberately a SOURCE check, not a runtime one: proving it at runtime
 * would mean booting three servers (DBOS, Hono, an MCP stdio transport), and a
 * test that expensive would be skipped in CI, which is worse than a grep that
 * always runs. What it pins is the call being present and reachable at boot,
 * which is exactly the mistake being guarded against.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every process entrypoint that can reach a Recall write. A worker is its own
 *  PROCESS: sharing server/web's package.json buys it nothing. */
const ENTRYPOINTS = [
  {
    file: 'server/web/server/main.ts',
    why: 'the owner Recall routes; this is the main authoring path',
  },
  {
    file: 'server/api/src/main.ts',
    why: 'agent Recall tools in forum and telegram turns',
  },
  {
    file: 'server/mcp/src/server.ts',
    why: 'the stdio transport exposes the same Recall tools',
  },
  {
    file: 'server/web/workers/runs.ts',
    why: 'run items dispatch tools in-process, the Recall tools among them',
  },
  {
    file: 'server/web/workers/telegram-poll.ts',
    why: 'an Approve tap runs the parked tool in this process',
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

  it('lists every package that depends on @mantle/content', () => {
    // The coarse half: a new SERVER package that imports @mantle/content can
    // reach a Recall write, so it belongs in ENTRYPOINTS above. Necessary, and on
    // its own not sufficient — see the worker sweep below, which is the half
    // that would have caught the two misses of 2026-09-03.
    const packages = ['server/web', 'server/api', 'server/mcp'];
    const dependants = packages.filter((pkg) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, pkg, 'package.json'), 'utf8'),
      ) as Record<string, Record<string, string> | undefined>;
      return Boolean(manifest.dependencies?.['@mantle/content']);
    });
    const covered = [...new Set(ENTRYPOINTS.map((e) => e.file.split('/').slice(0, 2).join('/')))];
    expect(dependants.sort()).toEqual(covered.sort());
  });

  it('covers every worker that can dispatch a tool', () => {
    // The fine half. Each server/web worker is a separate process with its own
    // module graph, so "server/web registers one" says nothing about it. A
    // worker that can run a tool can run `recall_card_put`; if it can, it needs
    // an embedder, and if it needs one it belongs in ENTRYPOINTS.
    //
    // "Can dispatch a tool" is read off the imports rather than guessed: these
    // three are every way a tool actually executes outside the agent runtime.
    const DISPATCHERS = /\b(dispatchTool|approvePendingCall|executeRunItem)\b/;
    const workerDir = join(repoRoot, 'server/web/workers');
    const dispatching = readdirSync(workerDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_'))
      .filter((f) => DISPATCHERS.test(readFileSync(join(workerDir, f), 'utf8')))
      .map((f) => `server/web/workers/${f}`);

    // Positive control: if this ever comes back empty the assertion below
    // passes for the wrong reason.
    expect(dispatching.length).toBeGreaterThan(0);
    const listed = ENTRYPOINTS.map((e) => e.file);
    for (const file of dispatching) {
      expect(
        listed,
        `${file} can dispatch a tool, so it can write Recall — add it to ENTRYPOINTS ` +
          `and call registerRecallEmbedder(embedBatch) at its top level`,
      ).toContain(file);
    }
  });
});
