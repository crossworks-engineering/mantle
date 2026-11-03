/**
 * The host's own load and memory, read from a read-only mount of its /proc
 * (MANTLE_HOST_PROC, e.g. /host/proc) when the box gives the web container
 * one. Without it every vital comes from this process's /proc, which in a
 * container is the container's view (system-health.ts `scope`).
 *
 * Only two files are read, `loadavg` and `meminfo`, so a box needs to mount
 * just those two (the whole host /proc shows every host process to the
 * container). Numbers only; a file that is missing or does not parse is no
 * answer (null), never a guess.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@mantle/config';

export type HostProcVitals = {
  loadAvg: [number, number, number];
  mem: { usedBytes: number; totalBytes: number; usedPct: number };
};

/** The three load averages of a `loadavg` file, or null (pure). */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** Used and total bytes of a `meminfo` file (MemTotal less MemAvailable), or
 *  null (pure). */
export function parseMeminfo(text: string): HostProcVitals['mem'] | null {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || available === null || available > total) return null;
  const used = total - available;
  return { usedBytes: used, totalBytes: total, usedPct: (used / total) * 100 };
}

/** The configured host /proc directory, or null when the box gives none. */
export function hostProcDir(): string | null {
  const dir = env('MANTLE_HOST_PROC')?.trim();
  return dir ? dir : null;
}

/** The host's load and memory from `dir`, or null when either file is
 *  missing or does not parse. */
export async function readHostProc(dir: string): Promise<HostProcVitals | null> {
  const [load, mem] = await Promise.all([
    readFile(path.join(dir, 'loadavg'), 'utf8').then(parseLoadavg, () => null),
    readFile(path.join(dir, 'meminfo'), 'utf8').then(parseMeminfo, () => null),
  ]);
  return load && mem ? { loadAvg: load, mem } : null;
}
