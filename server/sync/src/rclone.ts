/**
 * The rclone binary the Sync image carries (Dockerfile target `sync`,
 * copied from the pinned official image). M0 of the Sync plan: no rclone
 * daemon. A file job runs one short `rclone` command and ends, so rclone
 * holds no memory between jobs. M1 only checks that the binary runs.
 */
import { spawn } from 'node:child_process';

/** The version from `rclone version`'s first line ("rclone v1.76.0"), or
 *  null when the text is not that. */
export function parseRcloneVersion(text: string): string | null {
  const m = /^rclone (v\d+\.\d+\.\d+\S*)/.exec(text.trim());
  return m?.[1] ?? null;
}

/** Run `rclone version` once. Null when the binary is missing, fails, or
 *  takes longer than `timeoutMs`. */
export function rcloneVersion(timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn('rclone', ['version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < 4096) out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? parseRcloneVersion(out) : null));
  });
}
