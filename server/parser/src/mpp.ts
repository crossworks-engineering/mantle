/**
 * Microsoft Project files (.mpp, .mpt) to MSPDI XML, the XML Project itself
 * saves (docs/parser.md, "Project plans"). The converter is MPXJ
 * (LGPL-2.1-or-later), built as a native program in the parser image
 * (server/parser/mpp, the Dockerfile's mpxj-build stage), so no JVM runs.
 * It is a child of the job, as qpdf is: in the job's group, with its own
 * deadline, and a heap cap of its own (`-Xmx`), so one plan cannot take the
 * parser's memory. The XML then goes to the one plan reader there is (the
 * package plan-mspdi): its text, and its tabs for the file's database.
 *
 * The converter's exit code is its answer (server/parser/mpp/MppToMspdi.java):
 * 0 done; 3 a read password is set; 4 not a Project file it knows, or a
 * damaged one; anything else a failure. A refusal of the file itself is
 * for good (`final`; a timeout or a missing converter is not), and says
 * what the person can do: Project's own XML export
 * is read in full, so the words of the old `needs_export` skip stay for
 * every file the converter cannot take.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { envDynamic } from '@mantle/config';
import { MPP_EXPORT_HINT } from '@mantle/files/slug';
import { JobFailure } from './job-failure';
import { childEnv, runChild, type Ended } from './proc';

/** Where the image puts the converter; PARSER_MPP names another. */
export const MPP_CONVERTER = '/usr/local/bin/mpp-to-mspdi';
/** The converter's heap, in MB. MPXJ holds the whole plan, then writes the
 *  XML; the made-up samples peak far below this (docs/parser.md). */
export const MPP_HEAP_MB = 1024;
/** The most one conversion may take, whatever the job has left. */
export const MPP_TIMEOUT_MS = 120_000;

function converter(): string {
  return envDynamic('PARSER_MPP') || MPP_CONVERTER;
}

/** The converter's own last line on stderr: its reason, in plain words. */
function reasonOf(ended: Ended): string {
  const lines = ended.stderr.trim().split('\n');
  return (lines[lines.length - 1] ?? '').trim().slice(0, 300);
}

/** How a conversion that did not end with 0 is said. Exported for the test. */
export function mppFailure(ended: Ended): JobFailure {
  if (ended.timedOut) {
    return new JobFailure('timeout', 'converting the Project file ran past its time');
  }
  if (ended.spawnError) {
    return new JobFailure(
      'failed',
      `the Project converter is not in this parser (${ended.spawnError}). ${MPP_EXPORT_HINT}`,
    );
  }
  if (ended.code === 3) {
    return new JobFailure(
      'failed',
      'The Project file is password protected, so it cannot be read. In Project open it with its password and save it again with no password, or use File, Save As and choose XML (*.xml), then upload that',
      { final: true },
    );
  }
  if (ended.code === 4) {
    return new JobFailure(
      'failed',
      `The Project file could not be read: it is damaged, or from a Project version the reader does not know. ${MPP_EXPORT_HINT}`,
      { final: true },
    );
  }
  const why = reasonOf(ended);
  if (/OutOfMemoryError/.test(why)) {
    return new JobFailure(
      'too_large',
      `The Project file needs more memory than the converter may use (${MPP_HEAP_MB} MB). ${MPP_EXPORT_HINT}`,
      { final: true },
    );
  }
  return new JobFailure(
    'failed',
    `The Project file could not be converted (${why || `exit ${ended.code ?? ended.signal}`}). ${MPP_EXPORT_HINT}`,
    { final: true },
  );
}

/**
 * The Project file at `input` as MSPDI XML. Written in the job's folder
 * (`dir`), read back, then removed, so the job's scratch holds it only
 * while it is read. `timeoutMs`: the time left to the job's end. Throws a
 * JobFailure for every file it cannot convert.
 */
export async function mppToMspdi(input: string, dir: string, timeoutMs: number): Promise<Buffer> {
  const out = path.join(dir, 'mpp-mspdi.xml');
  const ended = await runChild(converter(), [`-Xmx${MPP_HEAP_MB}m`, input, out], {
    timeoutMs: Math.max(1_000, Math.min(timeoutMs, MPP_TIMEOUT_MS)),
    cwd: dir,
    env: childEnv(dir),
  });
  try {
    if (ended.code !== 0) throw mppFailure(ended);
    return await fs.readFile(out);
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

/** The converter's version line ("mpxj 16.11.0"), or null when it is not
 *  there. For the boot smoke and the parser's health. */
export async function mppConverterVersion(dir: string): Promise<string | null> {
  const ended = await runChild(converter(), ['--version'], {
    timeoutMs: 10_000,
    cwd: dir,
    env: childEnv(dir),
    stdout: true,
  });
  const line = ended.stdout.trim().split('\n')[0] ?? '';
  return ended.code === 0 && /^mpxj \S+$/.test(line) ? line : null;
}

/** The boot smoke's check, in the image (PARSER_MPP is named there): the
 *  converter starts and answers its version. Outside the image (a dev box,
 *  the gate) there is nothing to check. */
export async function mppConverterThere(dir: string): Promise<number> {
  if (!envDynamic('PARSER_MPP')) return 0;
  if (!(await mppConverterVersion(dir))) throw new Error('the Project converter is not there');
  return 1;
}
