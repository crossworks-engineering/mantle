/**
 * Pictures of a PDF's pages for a job, drawn in a child process the job can
 * kill (./pictures-child.ts says why). The child is in the job's own process
 * group (`runChild`), so the server's kill of the job takes it too.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderFn } from '@mantle/files/readers/pdf-drawing';
import type { RenderedWindow } from '@mantle/files/readers/rasterize';
import { tsCommand } from '@mantle/std/self-spawn';
import { runChild } from './proc';

const CHILD_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pictures-child.ts');

/** Time kept back from the job's end for the job's answer: nothing a job
 *  starts for a picture (the child that draws, the look at each) runs into
 *  it. */
export const PICTURES_RESERVE_MS = 20_000;

/**
 * When the server kills this job: its time limit from the start of the job
 * PROCESS, which is when the server's own clock started. Taken from the
 * process's age, not from "now": a job has already spent time on its start
 * and on reading its input when it asks.
 */
export function jobEndOf(jobTimeoutMs: number): number {
  return Date.now() - process.uptime() * 1000 + jobTimeoutMs;
}
/** Under this much time, no child is started. */
const PICTURES_MIN_MS = 3_000;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * A {@link RenderFn} for one job: the windows of `input`, drawn by one
 * child. The child gets the time left to the caller's deadline, and never
 * past `jobEnd` ({@link jobEndOf}) less {@link PICTURES_RESERVE_MS}. When it
 * is killed, the pictures it finished are kept and the others are null.
 */
export function pdfPictures(input: string, workdir: string, jobEnd: number): RenderFn {
  let n = 0;
  return async (windows, deadline) => {
    const none = windows.map(() => null);
    const timeoutMs = Math.min(deadline, jobEnd - PICTURES_RESERVE_MS) - Date.now();
    if (windows.length === 0 || timeoutMs < PICTURES_MIN_MS) return none;
    const dir = path.join(workdir, `pictures-${++n}`);
    try {
      await fs.mkdir(dir);
      const list = path.join(dir, 'windows.json');
      await fs.writeFile(list, JSON.stringify(windows));
      const start = tsCommand(CHILD_ENTRY, [input, list, dir]);
      // The job's own environment: the server already took the token out of
      // it and put every cache inside the job's directory (proc.ts jobEnv).
      await runChild(start.command, start.args, { timeoutMs, cwd: workdir, env: process.env });
      // How the child ended does not matter: what it finished is on disk.
      return await picturesIn(dir, windows.length);
    } catch {
      return none;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/** The pictures a child left in `dir` for windows 0 to `count` - 1, null
 *  where it left none: it was killed first, or the window cannot be drawn. */
export async function picturesIn(dir: string, count: number): Promise<(RenderedWindow | null)[]> {
  const out: (RenderedWindow | null)[] = [];
  for (let i = 0; i < count; i++) out.push(await pictureOf(dir, i));
  return out;
}

/** One finished picture, or null: no files, or files that are not whole. */
async function pictureOf(dir: string, i: number): Promise<RenderedWindow | null> {
  try {
    const size = JSON.parse(await fs.readFile(path.join(dir, `${i}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    const { widthPx, heightPx, scale, widthMm, heightMm } = size;
    if (![widthPx, heightPx, scale, widthMm, heightMm].every(positive)) return null;
    const png = await fs.readFile(path.join(dir, `${i}.png`));
    return {
      png,
      widthPx: widthPx as number,
      heightPx: heightPx as number,
      scale: scale as number,
      widthMm: widthMm as number,
      heightMm: heightMm as number,
    };
  } catch {
    return null;
  }
}
