/**
 * The picture process: `bun --no-env-file pictures-child.ts <input.pdf>
 * <windows.json> <out dir>`, started by a job (./pictures.ts) for the
 * pictures of ONE PDF, then gone.
 *
 * A pdfjs render cannot be stopped from inside its own process: it draws a
 * page in long steps that no timer gets between. So the pictures are drawn
 * here, in a process the job kills at its deadline. A page that takes too
 * long to draw then costs its own picture and the ones after it, not the
 * job's whole answer.
 *
 * Each window is written as soon as it is drawn: `<i>.png`, then `<i>.json`
 * with its size. The json is written last and by a rename, so the job takes
 * a picture only when both files are whole. A window that cannot be drawn
 * has no files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renderPdfWindows, type PageWindow } from '@mantle/files/readers/rasterize';

async function main(): Promise<number> {
  const [input, windowsJson, outDir] = process.argv.slice(2);
  if (!input || !windowsJson || !outDir) {
    process.stderr.write('usage: pictures-child.ts <input.pdf> <windows.json> <out dir>\n');
    return 2;
  }
  const windows = JSON.parse(await fs.readFile(windowsJson, 'utf8')) as PageWindow[];
  await renderPdfWindows(await fs.readFile(input), windows, {
    each: async ({ png, ...size }, i) => {
      await fs.writeFile(path.join(outDir, `${i}.png`), png);
      const tmp = path.join(outDir, `${i}.json.tmp`);
      await fs.writeFile(tmp, JSON.stringify(size));
      await fs.rename(tmp, path.join(outDir, `${i}.json`));
    },
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[parser pictures] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
