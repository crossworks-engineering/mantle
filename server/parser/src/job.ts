/**
 * The job process: `node <tsx loader> job.ts <job> <dir>`, started by the
 * server (./main.ts) in its own process group for ONE job, then gone.
 *
 * One process per job is what makes the parser's limits real. A reader that
 * loops or blocks cannot be stopped from inside its own process, and a
 * reader's native memory (pdfjs, anydoc, canvas) is not the JavaScript
 * heap's: the server kills this process's group at the job's deadline, and
 * the kernel's OOM kill inside the container's memory limit lands on this
 * process (the largest), not on the server. The exit is the cleanup: no
 * reader's state outlives its document.
 *
 * Exit 0: the answer is in the directory. Exit 3: `error.json` holds the
 * typed failure. Anything else (a signal, an abort) is read by the server as
 * `crashed`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PARSER_ROUTES, type ParserJob } from '@mantle/files/parser-wire';
import { failureOf, jobPaths, runJob } from './jobs';

async function main(): Promise<number> {
  const [job, dir] = process.argv.slice(2);
  if (!job || !dir || !(job in PARSER_ROUTES)) {
    process.stderr.write('usage: job.ts <job> <dir>\n');
    return 2;
  }
  const paths = jobPaths(dir);
  try {
    const raw = await fs.readFile(path.join(dir, 'opts.json'), 'utf8').catch(() => '{}');
    const opts = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
    await runJob(job as ParserJob, opts, paths);
    return 0;
  } catch (err) {
    const failure = failureOf(err);
    await fs.writeFile(
      path.join(dir, 'error.json'),
      JSON.stringify({ code: failure.code, message: failure.message, final: failure.final }),
    );
    return 3;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[parser job] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
