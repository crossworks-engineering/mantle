/**
 * The last line `pnpm maintain` prints after a task (scripts/maintain.ts).
 * Pure, so it is testable without spawning anything.
 */
import { constants } from 'node:os';

/** The runner's last line: the result, the time, and the signal when the
 *  task was killed (SIGKILL is most often the kernel's out-of-memory killer,
 *  SIGABRT a Node heap limit). */
export function finalLine(
  slug: string,
  live: boolean,
  status: number | null,
  signal: NodeJS.Signals | null,
  ms: number,
): string {
  const took = ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
  const mode = live ? 'LIVE' : 'dry-run';
  if (status === 0) return `maintain: ${slug} (${mode}) finished OK in ${took}`;
  // tsx (like a shell) reports a child killed by signal N as exit 128 + N.
  signal ??= status !== null && status > 128 ? signalName(status - 128) : null;
  if (signal) {
    const why =
      signal === 'SIGKILL'
        ? ' (often out of memory: check the container memory limit)'
        : signal === 'SIGABRT'
          ? ' (often the Node heap limit: check stderr)'
          : '';
    return `maintain: ${slug} (${mode}) FAILED after ${took}: killed by ${signal}${why}`;
  }
  return `maintain: ${slug} (${mode}) FAILED after ${took}: exit ${status ?? 1}`;
}

function signalName(n: number): NodeJS.Signals | null {
  const hit = Object.entries(constants.signals).find(([, v]) => v === n);
  return hit ? (hit[0] as NodeJS.Signals) : null;
}
