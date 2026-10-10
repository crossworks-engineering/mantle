/**
 * Cost-safety for "needs you" (migration 0186): the `needs_you_changed`
 * event may reach exactly two listeners, the owner live stream (realtime.ts,
 * admin sessions) and the push worker (admin devices). Neither can start LLM
 * work. Any new file that names the channel fails here (one sender is
 * listed too: the extract queue's parked-job notice), so a new listener is
 * a reviewed decision, never an accident (no trigger may start LLM work).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'migrations']);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('needs_you_changed listeners', () => {
  it('only the live stream and the push worker use the channel', () => {
    const hits = [...sources(path.join(ROOT, 'packages')), ...sources(path.join(ROOT, 'server'))]
      .filter((f) => /NEEDS_YOU_CHANGED_CHANNEL|needs_you_changed/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .sort();
    expect(hits).toEqual([
      'packages/content/src/index-team.ts',
      'packages/content/src/needs-you.ts',
      // A sender, not a listener: a parked extraction raises the event so
      // the push worker can tell an admin (W1 audit, LOW 4).
      'server/api/src/agent/extract-heads-park.ts',
      'server/web/lib/realtime.ts',
      'server/web/workers/push-notify.ts',
    ]);
  });
});
