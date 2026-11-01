import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { DRAW_PNG_CHILD_MEMORY_MB, renderDrawSvgPng } from './draw-png';

const spawned = vi.hoisted(() => [] as { command: string; args: string[]; env: unknown }[]);
vi.mock('node:child_process', async (load) => {
  const real = await load<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (command: string, args: string[], opts: { env?: unknown }) => {
      spawned.push({ command, args, env: opts.env });
      return real.spawn(command, args, opts as never);
    },
  };
});

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="50" height="50" fill="#f00"/></svg>';

/** A red PNG of this size. */
function redPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const line = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) line.set([255, 0, 0, 255], 1 + x * 4);
  const raw = Buffer.alloc(line.length * h);
  for (let y = 0; y < h; y++) line.copy(raw, y * line.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('the largest job the bounds allow', () => {
  it('two pictures, to the 40 MP budget, render inside the limit', async () => {
    const href = `data:image/png;base64,${redPng(4400, 4400).toString('base64')}`;
    const image = `<image width="50" height="100" href="${href}"/>`;
    const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${image}${image}</svg>`;
    const png = await renderDrawSvgPng(big, { timeoutMs: 60_000 });
    expect(png.width).toBe(2000);
  }, 90_000);
});

describe('where a render runs', () => {
  it('Node: a worker with its limit. Bun: a process with no env, under a kernel limit', async () => {
    const png = await renderDrawSvgPng(svg, { longEdge: 200 });
    expect(png.width).toBe(200);
    if (!process.versions.bun) {
      expect(spawned).toEqual([]);
      return;
    }
    const call = spawned.at(-1)!;
    expect(call.env).toEqual({});
    expect(call.args.at(-1)).toMatch(/draw-png-child\.ts$/);
    if (process.platform === 'linux') {
      expect(call.command).toBe('/bin/sh');
      expect(call.args).toContain(String(DRAW_PNG_CHILD_MEMORY_MB * 1024));
    }
  });
});
