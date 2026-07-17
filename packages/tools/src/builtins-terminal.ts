/**
 * Free-form terminal tool — gives an agent the ability to run shell commands
 * on the server and read back stdout/stderr/exit code, so a technical operator
 * can ask the AI to do real work on the box (git, pnpm, migrations, restarts,
 * scaffolding an API + screen, …).
 *
 * Deliberately UNRESTRICTED: no command allowlist, no per-call approval gate
 * (`requiresConfirm: false`). This is a power-user capability — grant it only
 * to an agent you reach on purpose (e.g. a dedicated `coder` agent), NOT to the
 * agent that auto-replies to untrusted email/Telegram, because an unrestricted
 * shell on an injection-exposed agent is the one real footgun. The operator can
 * still flip `requiresConfirm` on per-row at /settings/tools if they want a gate.
 *
 * The two bounds here are runtime hygiene, not restrictions on what you can run:
 *   - a timeout (default 120s, max 1800s) so a hung command can't wedge the
 *     agent's tool loop forever — a long job just passes a bigger timeout;
 *   - output truncation (64KB/stream into the model + trace) so `cat huge.log`
 *     doesn't blow the prompt. The full process still runs; only the captured
 *     text shown to the model is capped.
 *
 * Every call is traced: the command, cwd, exit code and duration land on the
 * tool's `trace_step` — a clean audit trail at /traces and /debug.
 *
 * PROD NOTE: in docker this runs INSIDE the agent/web container, not on the VPS
 * host. Host-level actions ("restart the server") need a deliberate hatch
 * (docker socket, ssh-to-host, or running that agent on the host). Dev (single
 * machine) acts on the host directly.
 */

import type { BuiltinToolDef, ToolHandlerResult } from './types';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const OUTPUT_CAP = 64 * 1024; // per stream, shown to the model
const MAX_BUFFER = 16 * 1024 * 1024; // raw capture ceiling before truncation

/** Default working directory: MANTLE_TERMINAL_CWD if set, else the process cwd
 *  (the running stack's repo root). Override per call via the `cwd` arg. */
function resolveCwd(override?: unknown): string {
  if (typeof override === 'string' && override.trim()) return override;
  return process.env.MANTLE_TERMINAL_CWD || process.cwd();
}

/**
 * Env passed to the child shell. This tool feeds stdout/stderr straight back to
 * the model, so a single `env`/`printenv` would otherwise exfiltrate the at-rest
 * encryption key (and every API key) in one call — collapsing the whole
 * encryption story to "don't grant this tool". We drop the crypto/session/db
 * roots by exact name and anything whose name looks secret-shaped, while
 * keeping PATH, HOME, NODE_*, PNPM_*, etc. so git/pnpm/builds still run. An
 * allowlist was rejected — it breaks too many legit toolchains; this denylist
 * closes the exfil path without changing what commands work.
 *
 * Env names are UPPER_SNAKE, so we match secret words as whole `_`-delimited
 * SEGMENTS: this catches S3_ACCESS_KEY / S3_SECRET_KEY / GITHUB_TOKEN / any
 * *_KEY without the substring false-positives a bare /key/ would cause
 * (MONKEY_BUSINESS, KEYCLOAK_URL both stay). */
const SECRET_ENV_EXACT = new Set([
  'MANTLE_MASTER_KEY',
  'MANTLE_MASTER_KEY_NEXT',
  'SESSION_SECRET',
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
]);
const SECRET_ENV_SEGMENT =
  /(^|_)(secret|secrets|token|tokens|password|passwd|passwords|passphrase|credential|credentials|key|keys|apikey|privatekey)(_|$)/i;
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const k of Object.keys(out)) {
    if (SECRET_ENV_EXACT.has(k) || SECRET_ENV_SEGMENT.test(k)) delete out[k];
  }
  return out;
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, OUTPUT_CAP)}\n…[truncated ${s.length - OUTPUT_CAP} chars]`,
    truncated: true,
  };
}

const run_terminal: BuiltinToolDef = {
  slug: 'run_terminal',
  name: 'Run terminal command',
  description:
    'Run a shell command on the server and return its stdout, stderr and exit code. ' +
    'Free-form — use it for git, pnpm, builds, database migrations, restarting services, ' +
    'inspecting files, scaffolding code, etc. Runs via bash in the configured working ' +
    'directory (override with `cwd`). A non-zero exit code is returned (not an error) so ' +
    'you can read the output and decide what to do next. Long jobs: raise `timeout_seconds`.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The shell command to run, e.g. "git -C . status" or "pnpm -C apps/web build".',
      },
      cwd: {
        type: 'string',
        description: "Absolute working directory. Defaults to the server's MANTLE_TERMINAL_CWD.",
      },
      timeout_seconds: {
        type: 'number',
        description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim()) return { ok: false, error: 'command is required' };
    const cwd = resolveCwd(input.cwd);
    const timeoutS = Math.min(
      MAX_TIMEOUT_S,
      Math.max(
        1,
        typeof input.timeout_seconds === 'number' ? input.timeout_seconds : DEFAULT_TIMEOUT_S,
      ),
    );
    ctx.step?.setMeta({ command, cwd, timeoutSeconds: timeoutS });

    const { exec } = await import('node:child_process');
    const started = Date.now();
    return await new Promise<ToolHandlerResult>((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutS * 1000,
          maxBuffer: MAX_BUFFER,
          shell: '/bin/bash',
          env: sanitizedEnv(),
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const out = truncate(String(stdout));
          const errOut = truncate(String(stderr));
          const e = err as
            | (NodeJS.ErrnoException & {
                code?: number | string;
                killed?: boolean;
                signal?: string;
              })
            | null;

          // Spawn failure (bad cwd / shell missing) — a real tool error.
          if (e && typeof e.code === 'string') {
            ctx.step?.setMeta({ spawnError: e.code, durationMs });
            return resolve({ ok: false, error: `failed to run command (${e.code}): ${e.message}` });
          }

          const timedOut = !!e?.killed;
          const exitCode = timedOut ? null : e ? (typeof e.code === 'number' ? e.code : 1) : 0;
          ctx.step?.setMeta({
            exitCode,
            timedOut,
            durationMs,
            stdoutBytes: String(stdout).length,
            stderrBytes: String(stderr).length,
          });
          ctx.step?.setOutput({ exitCode, timedOut, durationMs });
          resolve({
            ok: true,
            output: {
              exitCode,
              timedOut,
              durationMs,
              cwd,
              stdout: out.text,
              stderr: errOut.text,
              truncated: out.truncated || errOut.truncated,
            },
          });
        },
      );
    });
  },
};

export const TERMINAL_TOOLS: BuiltinToolDef[] = [run_terminal];
export const TERMINAL_TOOL_SLUGS = TERMINAL_TOOLS.map((t) => t.slug);
