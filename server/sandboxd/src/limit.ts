/**
 * The cap on sandboxes counts the RUNNING ones only (owner, 2026-11-18). A
 * stopped sandbox holds disk, which the disk budget bounds, and no memory or
 * CPU, so it never blocks a new one. Kept free of imports so a test reads it
 * without the server.
 */

/** Why a new sandbox may not start now, or null. `containers`: every
 *  sandbox container, as docker lists them (`State` is 'running',
 *  'exited', ...). */
export function sandboxLimitRefusal(
  containers: readonly { State: string }[],
  max: number,
): string | null {
  const running = containers.filter((c) => c.State === 'running').length;
  if (running < max) return null;
  return `sandbox limit reached (${max} running): stop one with sandbox_stop, or remove one with sandbox_rm, before creating another`;
}
