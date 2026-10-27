/**
 * The CAD tier and the audio extract, as parser jobs: each runs a Python
 * (cad/cad.py) or ffmpeg child in the job's process group (./proc.ts
 * `runChild`), so the server's kill of the job takes them with it. Ported from the media sidecar's HTTP handlers
 * (_op_dwf_render, _op_dwg_render, _op_dwg_crop, _op_extract_audio): the
 * same child modes, the same index files, the same reply shapes, so the
 * brain's readers (packages/files/src/parser-cad.ts) did not change.
 *
 * Runs inside a job process (./job.ts), never in the server.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, envDynamic } from '@mantle/config';
import type { DwfRender, DwfRenderFn } from '@mantle/files/readers/dwf';
import { PARSER_ANSWER_MAX_BYTES, PARSER_PICTURES_BUDGET_BYTES } from '@mantle/files/parser-wire';
import { childEnv, runChild, type Ended } from './proc';
import { JobFailure } from './job-failure';

/** Where cad.py, dwg_bones.py and dwg_crop.py sit. */
const CAD_DIR =
  env('PARSER_CAD_DIR') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cad');

function python(): string {
  return env('PARSER_PYTHON') ?? 'python3';
}

/** The child's own limit sits a little inside the job's, so the job can say
 *  `timeout` itself instead of being killed with its child. */
function childTimeout(jobTimeoutMs: number): number {
  return Math.max(5_000, jobTimeoutMs - 10_000);
}

/** A child's end as the wire sees it, when it did not exit 0. */
function childFailure(ended: Ended, what: string): JobFailure {
  if (ended.timedOut)
    return new JobFailure('timeout', `${what} ran past its time limit and was killed`);
  if (ended.spawnError)
    return new JobFailure('crashed', `${what} could not start: ${ended.spawnError}`);
  if (ended.signal) {
    // SIGKILL that we did not send: the kernel's OOM kill inside the
    // container's memory limit.
    return new JobFailure(
      'crashed',
      `${what} was killed (${ended.signal}): the drawing needed more memory than the parser may use`,
    );
  }
  return new JobFailure(
    'failed',
    `${what} failed: ${ended.stderr.trim().slice(-1500) || `exit ${ended.code}`}`,
  );
}

async function runCad(
  args: string[],
  workdir: string,
  jobTimeoutMs: number,
  what: string,
): Promise<void> {
  const ended = await runChild(python(), [path.join(CAD_DIR, 'cad.py'), ...args], {
    timeoutMs: childTimeout(jobTimeoutMs),
    cwd: workdir,
    // Its own environment, nothing of the parser's; its temp files in the
    // job's directory, which goes with the job.
    env: childEnv(workdir, {
      MPLBACKEND: 'Agg',
      // matplotlib's config and font cache: the job's own (the job's
      // environment puts it in the job's directory, ./proc.ts jobEnv),
      // never one a later job would read.
      MPLCONFIGDIR: envDynamic('MPLCONFIGDIR') ?? path.join(workdir, '.mpl'),
      PYTHONDONTWRITEBYTECODE: '1',
    }),
  });
  if (ended.code !== 0) throw childFailure(ended, what);
}

async function readIndex(outdir: string, what: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(outdir, 'index.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new JobFailure('failed', `${what} produced no index`);
  }
}

function clampInt(v: unknown, dflt: number, lo: number, hi: number, name: string): number {
  if (v == null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new JobFailure('bad_request', `'${name}' must be an integer between ${lo} and ${hi}`);
  }
  return n;
}

// ── DWF ─────────────────────────────────────────────────────────────────────

/** Raw PNG bytes one DWF render may return, all sheets together. */
const DWF_PAYLOAD_CAP = 48 * 1024 * 1024;

/**
 * A {@link DwfRenderFn} for the DWF picture read (packages/files/src/dwf.ts
 * `extractDwfImages`): every sheet rendered by ezdwf in the `--dwf-render`
 * child. A failure is a value; the caller falls back to the thumbnails.
 */
export function dwfRenderer(workdir: string, jobTimeoutMs: number): DwfRenderFn {
  return async (bytes, opts) => {
    try {
      const dpi = clampInt(opts.dpi, 300, 50, 600, 'dpi');
      const maxSheets = clampInt(opts.maxSheets, 64, 1, 256, 'maxSheets');
      const dir = await fs.mkdtemp(path.join(workdir, 'dwf-'));
      const src = path.join(dir, 'in.dwf');
      const outdir = path.join(dir, 'out');
      await fs.writeFile(src, bytes);
      await fs.mkdir(outdir);
      await runCad(
        ['--dwf-render', src, outdir, String(dpi), String(maxSheets)],
        dir,
        jobTimeoutMs,
        'the DWF render',
      );
      const index = await readIndex(outdir, 'the DWF render');
      const sheets: DwfRender['sheets'] = [];
      let total = 0;
      let capped = false;
      for (const raw of Array.isArray(index.sheets) ? index.sheets : []) {
        const e = raw as { file?: string; name?: string; index?: number };
        if (!e.file) continue;
        let png: Buffer;
        try {
          png = await fs.readFile(path.join(outdir, path.basename(e.file)));
        } catch {
          continue;
        }
        if (total + png.length > DWF_PAYLOAD_CAP) {
          capped = true;
          continue; // a later, smaller sheet may still fit
        }
        total += png.length;
        sheets.push({
          name: e.name || `sheet ${(e.index ?? sheets.length) + 1}`,
          index: typeof e.index === 'number' ? e.index : sheets.length,
          png,
        });
      }
      const sheetCount = typeof index.sheet_count === 'number' ? index.sheet_count : sheets.length;
      const skipped = typeof index.skipped === 'number' ? index.skipped : 0;
      return {
        ok: true,
        value: {
          sheetCount,
          skipped,
          capped: capped || index.capped === true,
          truncated: capped || index.capped === true || skipped > 0 || sheets.length < sheetCount,
          sheets,
        },
      };
    } catch (err) {
      const f = err instanceof JobFailure ? err : new JobFailure('failed', String(err));
      return { ok: false, code: f.code, message: f.message };
    }
  };
}

// ── DWG / DXF ───────────────────────────────────────────────────────────────

/** Write `{...index, "png_base64": "..."}` without holding the reply as one
 *  string: the registry JSON once, then the PNG's base64 streamed in. */
async function writeJsonWithPng(out: string, index: Record<string, unknown>, png: Buffer | null) {
  const head = JSON.stringify(index);
  const stream = createWriteStream(out);
  const write = (s: string | Buffer) =>
    new Promise<void>((resolve, reject) =>
      stream.write(s, (err) => (err ? reject(err) : resolve())),
    );
  await write(head.slice(0, -1));
  await write(',"png_base64":"');
  if (png) await write(png.toString('base64'));
  await write('"}');
  await new Promise<void>((resolve, reject) =>
    stream.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
}

/** POST /dwg/render: the registry, the bones and model.png of one drawing. */
export async function dwgRender(
  input: string,
  opts: Record<string, unknown>,
  workdir: string,
  out: string,
  jobTimeoutMs: number,
): Promise<void> {
  const dpi = clampInt(opts.dpi, 300, 50, 600, 'dpi');
  const outdir = path.join(workdir, 'cad-out');
  await fs.mkdir(outdir, { recursive: true });
  await runCad(
    ['--dwg-render', input, outdir, String(dpi)],
    workdir,
    jobTimeoutMs,
    'the DWG render',
  );
  const index = await readIndex(outdir, 'the DWG render');
  let png: Buffer | null = null;
  try {
    png = await fs.readFile(path.join(outdir, 'model.png'));
  } catch {
    /* registry without pixels is still an answer */
  }
  index.ok = true;
  index.dpi = dpi;
  if (!('render_error' in index)) index.render_error = null;
  await writeJsonWithPng(out, index, png);
}

/** POST /dwg/crop: close-up crops of one drawing for the image check. */
export async function dwgCrop(
  input: string,
  opts: Record<string, unknown>,
  workdir: string,
  out: string,
  jobTimeoutMs: number,
): Promise<void> {
  if (!opts.spec || typeof opts.spec !== 'object') {
    throw new JobFailure('bad_request', 'the crop spec is missing');
  }
  const specPath = path.join(workdir, 'spec.json');
  await fs.writeFile(specPath, JSON.stringify(opts.spec));
  const outdir = path.join(workdir, 'cad-out');
  await fs.mkdir(outdir, { recursive: true });
  await runCad(['--dwg-crop', input, outdir, specPath], workdir, jobTimeoutMs, 'the DWG crops');
  const index = await readIndex(outdir, 'the DWG crops');
  const read = (name: unknown) => fs.readFile(path.join(outdir, path.basename(String(name))));
  // The answer's budget: the overview first, then the crops in order until
  // it is spent; a crop past it is left out and named in `capped`.
  let total = 0;
  const ov = index.overview as Record<string, unknown> | null | undefined;
  if (ov && typeof ov === 'object') {
    const png = await read(ov.file);
    total += png.length;
    ov.png_base64 = png.toString('base64');
    delete ov.file;
  }
  const kept: Record<string, unknown>[] = [];
  let leftOut = 0;
  for (const c of Array.isArray(index.crops) ? index.crops : []) {
    const crop = c as Record<string, unknown>;
    const png = await read(crop.file);
    delete crop.file;
    if (total + png.length > PARSER_PICTURES_BUDGET_BYTES) {
      leftOut++;
      continue;
    }
    total += png.length;
    crop.png_base64 = png.toString('base64');
    kept.push(crop);
  }
  index.crops = kept;
  if (leftOut > 0) {
    const capped = Array.isArray(index.capped) ? index.capped : [];
    index.capped = [...capped, `${leftOut} crops left out: the answer's picture budget is spent`];
  }
  index.ok = true;
  await fs.writeFile(out, JSON.stringify(index));
}

// ── audio ───────────────────────────────────────────────────────────────────

/**
 * What ffmpeg and ffprobe may open: local files only (no network protocol,
 * a no-op behind the parser's network anyway), read by the demuxers of the
 * media formats the brain stores (MEDIA_EXTS in packages/files/src/slug.ts).
 * Never a playlist or concat demuxer, which would read other files named
 * inside the upload.
 */
const MEDIA_INPUT_GUARDS = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,matroska,webm,avi,mp3,wav,ogg,flac,aac',
];

async function ffprobeDuration(input: string, workdir: string): Promise<number | null> {
  const ended = await runChild(
    'ffprobe',
    [
      '-hide_banner',
      '-v',
      'error',
      ...MEDIA_INPUT_GUARDS,
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      input,
    ],
    { timeoutMs: 60_000, stdout: true, cwd: workdir, env: childEnv(workdir) },
  );
  if (ended.code !== 0) return null;
  const n = Number(ended.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/** POST /extract-audio: speech-grade mono mp3 out of a video or audio file,
 *  the smallest thing every speech-to-text adapter accepts. */
export async function extractAudio(
  input: string,
  opts: Record<string, unknown>,
  workdir: string,
  out: string,
  jobTimeoutMs: number,
): Promise<Record<string, unknown>> {
  const maxDuration = clampInt(opts.maxDurationSeconds, 3600, 1, 86_400, 'maxDurationSeconds');
  // The track comes back in the answer, so it is bounded by the answer's cap.
  const maxAudio = Math.min(
    clampInt(opts.maxAudioBytes, 20_000_000, 1, 2 * 1024 ** 3, 'maxAudioBytes'),
    PARSER_ANSWER_MAX_BYTES - 1024,
  );
  const duration = await ffprobeDuration(input, workdir);
  if (duration != null && duration > maxDuration) {
    throw new JobFailure(
      'too_large',
      `the recording is ${Math.round(duration)} s, over the ${maxDuration} s limit`,
      { final: true },
    );
  }
  const mp3 = path.join(workdir, 'out.mp3');
  const ended = await runChild(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      ...MEDIA_INPUT_GUARDS,
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-b:a',
      '32k',
      // Bounded whatever the input claims: the duration limit, and one byte
      // past the size limit (so a track that reaches it is refused below,
      // never cut short silently).
      '-t',
      String(maxDuration),
      '-fs',
      String(maxAudio + 1),
      '-f',
      'mp3',
      mp3,
    ],
    { timeoutMs: childTimeout(jobTimeoutMs), cwd: workdir, env: childEnv(workdir) },
  );
  if (ended.code !== 0) throw childFailure(ended, 'ffmpeg');
  const size = (await fs.stat(mp3)).size;
  if (size > maxAudio) {
    throw new JobFailure(
      'too_large',
      `the extracted audio is ${size} bytes, over the ${maxAudio}-byte limit`,
      { final: true },
    );
  }
  await fs.rename(mp3, out);
  return { durationSeconds: duration };
}
