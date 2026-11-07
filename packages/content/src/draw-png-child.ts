/**
 * The renderer of draw-png.ts as a process of its own, because a worker on Bun
 * has no memory limit (resourceLimits does nothing there). The job comes in on
 * stdin and the answer goes out on stdout, both as one JSON text.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { errorMessage } from '@mantle/std';
import { renderJob, type RenderJob } from './draw-png-render';

/** A RenderJob, with its bytes as base64. */
export type ChildJob = Omit<RenderJob, 'fallbackFont'> & { fallbackFont: string };
export type ChildReply =
  { ok: true; png: string; width: number; height: number } | { ok: false; error: string };

async function run(): Promise<ChildReply> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChildJob;
  const file = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
  const wasm = await WebAssembly.compile(await readFile(file));
  const out = await renderJob(
    { ...job, fallbackFont: new Uint8Array(Buffer.from(job.fallbackFont, 'base64')) },
    wasm,
  );
  return {
    ok: true,
    png: Buffer.from(out.png).toString('base64'),
    width: out.width,
    height: out.height,
  };
}

const reply = await run().catch((err: unknown): ChildReply => ({
  ok: false,
  error: errorMessage(err),
}));
process.stdout.write(JSON.stringify(reply));
