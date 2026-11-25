/**
 * The Project converter's child (./mpp.ts): how it is run and how each way
 * it ends is said. A shell script stands in for the converter here (the
 * real one runs on made-up samples in the image build, and through a real
 * parser job in packages/content/src/pipeline-runner.test.ts when PARSER_MPP
 * names it).
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Ended } from './proc';
import { MPP_HEAP_MB, mppConverterThere, mppConverterVersion, mppFailure, mppToMspdi } from './mpp';

const root = mkdtempSync(path.join(os.tmpdir(), 'mpp-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** A stand-in converter: `body` is the shell script after the #! line. */
function fakeConverter(body: string): string {
  const file = path.join(mkdtempSync(path.join(root, 'bin-')), 'mpp-to-mspdi');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  vi.stubEnv('PARSER_MPP', file);
  return file;
}

const ended = (over: Partial<Ended>): Ended => ({
  code: 1,
  signal: null,
  timedOut: false,
  stderr: '',
  stdout: '',
  spawnError: null,
  ...over,
});

describe('mppFailure: each way the converter ends, said', () => {
  it('a read password: failed for good, with what to do', () => {
    const f = mppFailure(ended({ code: 3, stderr: 'password protected\n' }));
    expect(f.code).toBe('failed');
    expect(f.final).toBe(true);
    expect(f.message).toMatch(/password protected/);
    expect(f.message).toMatch(/XML/);
  });

  it('not a plan it knows, or damaged: failed for good, naming the XML export', () => {
    const f = mppFailure(ended({ code: 4, stderr: 'not readable\n' }));
    expect(f.code).toBe('failed');
    expect(f.final).toBe(true);
    expect(f.message).toMatch(/damaged/);
    expect(f.message).toMatch(/Save As and choose XML/);
  });

  it('out of its heap: too_large for good, with the cap', () => {
    const f = mppFailure(
      ended({ stderr: 'conversion failed: java.lang.OutOfMemoryError: Java heap space\n' }),
    );
    expect(f.code).toBe('too_large');
    expect(f.final).toBe(true);
    expect(f.message).toContain(`${MPP_HEAP_MB} MB`);
  });

  it('any other end keeps the last line the converter said', () => {
    const f = mppFailure(ended({ stderr: 'noise\nconversion failed: java.lang.Oops\n' }));
    expect(f.code).toBe('failed');
    expect(f.message).toContain('conversion failed: java.lang.Oops');
    expect(f.message).not.toContain('noise');
  });

  it('past its time: timeout, which may be tried again', () => {
    const f = mppFailure(ended({ code: null, signal: 'SIGKILL', timedOut: true }));
    expect(f.code).toBe('timeout');
    expect(f.final).toBe(false);
  });

  it('no converter in this parser: failed, naming the XML export, not final (a roll brings it)', () => {
    const f = mppFailure(ended({ code: null, spawnError: 'ENOENT' }));
    expect(f.code).toBe('failed');
    expect(f.final).toBe(false);
    expect(f.message).toMatch(/not in this parser/);
  });
});

describe('mppToMspdi: the converter as a child of the job', () => {
  it('runs with the heap cap first, reads the XML back, and leaves no file in the folder', async () => {
    fakeConverter('printf "<Project>%s</Project>" "$1" > "$3"');
    const dir = mkdtempSync(path.join(root, 'job-'));
    const input = path.join(dir, 'in.bin');
    writeFileSync(input, 'made-up');
    const xml = await mppToMspdi(input, dir, 10_000);
    expect(xml.toString()).toBe(`<Project>-Xmx${MPP_HEAP_MB}m</Project>`);
    expect(readdirSync(dir)).toEqual(['in.bin']);
  });

  it('a refusal throws its JobFailure, and no file is left', async () => {
    fakeConverter('echo partial > "$3"; echo "password protected" >&2; exit 3');
    const dir = mkdtempSync(path.join(root, 'job-'));
    const input = path.join(dir, 'in.bin');
    writeFileSync(input, 'made-up');
    await expect(mppToMspdi(input, dir, 10_000)).rejects.toMatchObject({
      code: 'failed',
      final: true,
    });
    expect(readdirSync(dir)).toEqual(['in.bin']);
  });

  it('a converter that runs past the time is killed: timeout', async () => {
    fakeConverter('exec sleep 30');
    const dir = mkdtempSync(path.join(root, 'job-'));
    const started = Date.now();
    await expect(mppToMspdi(path.join(dir, 'in.bin'), dir, 1_000)).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('the boot check and the version', () => {
  it('the version line, or null when there is no converter', async () => {
    fakeConverter('[ "$1" = --version ] && echo "mpxj 16.11.0"');
    expect(await mppConverterVersion(root)).toBe('mpxj 16.11.0');
    vi.stubEnv('PARSER_MPP', path.join(root, 'no-such-converter'));
    expect(existsSync(path.join(root, 'no-such-converter'))).toBe(false);
    expect(await mppConverterVersion(root)).toBeNull();
  });

  it('checks only where PARSER_MPP is named (the image), and fails when it does not answer', async () => {
    vi.stubEnv('PARSER_MPP', '');
    expect(await mppConverterThere(root)).toBe(0);
    fakeConverter('exit 1');
    await expect(mppConverterThere(root)).rejects.toThrow(/not there/);
  });
});
