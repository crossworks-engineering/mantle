/**
 * The answer of a job that succeeded (./main.ts): streamed from the job's
 * directory to the client, under the answer cap and its transfer deadline.
 */
import { createReadStream, promises as fs } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  META_HEADER,
  PARSER_ANSWER_DEADLINE_MS,
  PARSER_ANSWER_MAX_BYTES,
  type ParserJob,
} from '@mantle/files/parser-wire';
import { JobFailure } from './job-failure';

const BYTE_JOBS: ReadonlySet<ParserJob> = new Set(['extractAudio', 'thumbnail', 'visionImage']);

/**
 * Send a job's answer from its directory: the JSON (`out.json`), or the
 * bytes (`out.bin`) with their metadata in a header. It settles whatever
 * happens to the connection (finished, closed or destroyed, before or
 * during the answer): the slot is never held by an answer nobody reads.
 * Throws a JobFailure when there is no answer to send, or one past the cap.
 */
export async function sendAnswer(
  job: ParserJob,
  dir: string,
  res: http.ServerResponse,
): Promise<void> {
  const byteJob = BYTE_JOBS.has(job);
  const file = path.join(dir, byteJob ? 'out.bin' : 'out.json');
  const stat = await fs.stat(file).catch(() => null);
  // Exit 0 with no answer: the job did not do what it said.
  if (!stat) throw new JobFailure('crashed', 'the job ended without an answer');
  const { size } = stat;
  // An answer the brain would refuse is not sent: it holds every answer in
  // memory (packages/files/src/parser-client.ts).
  if (size > PARSER_ANSWER_MAX_BYTES) {
    throw new JobFailure(
      'too_large',
      `the answer is ${Math.round(size / 1024 / 1024)} MB, past the ${PARSER_ANSWER_MAX_BYTES / 1024 / 1024} MB an answer may be`,
      { final: true },
    );
  }
  // The client went away (a cut, a closed connection): nobody to answer.
  if (res.destroyed) return;
  const headers: Record<string, string> = {
    'content-type': byteJob ? 'application/octet-stream' : 'application/json',
    'content-length': String(size),
  };
  if (byteJob) {
    const meta = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}');
    headers[META_HEADER] = encodeURIComponent(meta);
  }
  res.writeHead(200, headers);
  // A client that does not read its answer gives the slot back at the
  // deadline: the connection is cut. The pipeline settles whatever happens
  // to the connection (finished, closed or destroyed): the slot is never
  // held by an answer nobody reads.
  const cut = setTimeout(() => res.destroy(), PARSER_ANSWER_DEADLINE_MS);
  try {
    await pipeline(createReadStream(file), res);
  } catch {
    // The connection closed mid-answer: the client reads a dropped
    // connection; nothing more to send.
    res.destroy();
  } finally {
    clearTimeout(cut);
  }
}
