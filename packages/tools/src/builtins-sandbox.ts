/**
 * CLI sandboxes — persistent, isolated terminal environments for the coder
 * agent, managed by the `sandboxd` supervisor sidecar (server/sandboxd) over
 * HTTP. The sibling of `run_terminal`, with the opposite blast radius:
 * run_terminal acts on the SERVER (the brain's own container); sandbox_exec
 * acts inside a disposable Ubuntu container on an isolated network that
 * cannot reach the brain's services. Untrusted work — cloning repos, running
 * their code, `curl | bash` — belongs HERE.
 *
 * The container is disposable; the work is not: each sandbox's /files is a
 * host directory that survives `sandbox_rm` unless explicitly purged. Rows
 * live in the `sandboxes` table (owner-scoped, name-addressable); per-command
 * history is on trace steps like every tool call.
 *
 * Feature presence is a per-box choice: sandboxd runs behind the `sandboxes`
 * compose profile. When it's absent these tools fail with a clear pointer
 * instead of half-working.
 */

import {
  SANDBOX_NAME_RE,
  createSandboxRow,
  deleteSandboxRow,
  getSandboxByRef,
  listSandboxes,
  setSandboxStatus,
  touchSandbox,
} from '@mantle/content';
import { randomUUID } from 'node:crypto';
import { notFound } from './errors';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const OUTPUT_CAP = 64 * 1024; // per stream, shown to the model (matches run_terminal)

/* ── sandboxd client ──────────────────────────────────────────────────── */

const NOT_ENABLED =
  'sandboxes are not enabled on this box — the sandboxd service runs behind the `sandboxes` ' +
  'compose profile. Ask the owner to enable it; for server-side commands use `run_terminal`.';

async function sandboxd(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const base = process.env.SANDBOXD_URL;
  const token = process.env.SANDBOXD_TOKEN;
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: NOT_ENABLED };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : `sandboxd → ${res.status}`,
    };
  }
  return { ok: true, data };
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, OUTPUT_CAP)}\n…[truncated ${s.length - OUTPUT_CAP} chars]`,
    truncated: true,
  };
}

/* ── tools ────────────────────────────────────────────────────────────── */

const sandbox_create: BuiltinToolDef = {
  slug: 'sandbox_create',
  name: 'Create sandbox',
  description:
    'Create a persistent isolated Ubuntu sandbox and return its id, name and files directory. ' +
    'Use one sandbox per project/task; it keeps installed packages and state until removed. ' +
    'Work in /files (bind-mounted to the host, survives removal). The sandbox has NO access ' +
    'to the brain or its services — for commands on the server itself use `run_terminal`.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{1,31}$',
        description: 'Short handle to address the sandbox by, e.g. "mantle-repo".',
      },
      description: {
        type: 'string',
        description: 'One line on what this sandbox is for, e.g. "inspect the mantle codebase".',
      },
      image: {
        type: 'string',
        description: 'Container image reference, e.g. "python:3.12-slim".',
        default: 'ubuntu:24.04',
      },
      network: {
        type: 'string',
        enum: ['full', 'none'],
        default: 'full',
        description:
          'Egress tier: "full" = internet (never the brain\'s network), "none" = offline.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!SANDBOX_NAME_RE.test(name)) {
      return {
        ok: false,
        error: `name must match ${SANDBOX_NAME_RE} (got '${name}') — lowercase letters, digits, dashes, 2–32 chars.`,
      };
    }
    const existing = await getSandboxByRef(ctx.ownerId, name);
    if (existing) {
      return {
        ok: false,
        error: `sandbox '${name}' already exists (status ${existing.status}) — use sandbox_exec to work in it, or pick another name (sandbox_list shows what's taken).`,
      };
    }
    const id = randomUUID();
    const network = input.network === 'none' ? 'none' : 'full';
    const image = typeof input.image === 'string' && input.image ? input.image : 'ubuntu:24.04';
    const created = await sandboxd('POST', '/sandboxes', {
      id,
      ownerId: ctx.ownerId,
      image,
      network,
    });
    if (!created.ok) return created;
    const row = await createSandboxRow({
      id,
      ownerId: ctx.ownerId,
      name,
      description: typeof input.description === 'string' ? input.description : null,
      image,
      network,
      status: 'running',
      containerId: String(created.data.containerId ?? ''),
    });
    ctx.step?.setMeta({ sandboxId: id, name, image, network });
    return {
      ok: true,
      output: { id: row.id, name, image, network, status: 'running', filesDir: '/files' },
    };
  },
};

const sandbox_exec: BuiltinToolDef = {
  slug: 'sandbox_exec',
  name: 'Run command in sandbox',
  description:
    'Run a bash command inside a sandbox and return stdout, stderr and exit code. Default cwd ' +
    'is /files (the persistent work dir). A stopped sandbox is started automatically. Non-zero ' +
    'exit codes are returned (not errors) so you can read the output and decide. Long jobs: ' +
    'raise `timeout_seconds`. Untrusted/project code runs HERE; server-side operations (git on ' +
    'the mantle repo, pnpm, migrations) use `run_terminal` instead.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: {
        type: 'string',
        description: 'Sandbox name or id, e.g. "mantle-repo".',
      },
      command: {
        type: 'string',
        description: 'The bash command, e.g. "git clone https://github.com/x/y && ls y".',
      },
      cwd: {
        type: 'string',
        description: 'Working directory inside the sandbox, e.g. "/files/mantle".',
        default: '/files',
      },
      timeout_seconds: {
        type: 'number',
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        default: DEFAULT_TIMEOUT_S,
        description: 'Kill the command after this many seconds.',
      },
    },
    required: ['sandbox', 'command'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim()) return { ok: false, error: 'command is required' };
    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_S,
      Math.max(
        1,
        typeof input.timeout_seconds === 'number' ? input.timeout_seconds : DEFAULT_TIMEOUT_S,
      ),
    );
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, command, timeoutSeconds });

    const res = await sandboxd('POST', `/sandboxes/${row.id}/exec`, {
      command,
      cwd: input.cwd,
      timeoutSeconds,
    });
    if (!res.ok) return res;
    await Promise.all([touchSandbox(row.id), setSandboxStatus(row.id, 'running')]);

    const out = truncate(String(res.data.stdout ?? ''));
    const errOut = truncate(String(res.data.stderr ?? ''));
    const { exitCode = null, timedOut = false, durationMs = null, cwd } = res.data;
    ctx.step?.setMeta({ exitCode, timedOut, durationMs });
    ctx.step?.setOutput({ exitCode, timedOut, durationMs });
    return {
      ok: true,
      output: {
        sandbox: row.name,
        exitCode,
        timedOut,
        durationMs,
        cwd,
        stdout: out.text,
        stderr: errOut.text,
        truncated: out.truncated || errOut.truncated,
      },
    };
  },
};

const sandbox_list: BuiltinToolDef = {
  slug: 'sandbox_list',
  name: 'List sandboxes',
  description:
    "List this owner's sandboxes: name, status, image, network tier, description and last-used " +
    'time. Use to find an existing sandbox before creating a new one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirm: false,
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const rows = await listSandboxes(ctx.ownerId);
    return {
      ok: true,
      output: {
        sandboxes: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          image: r.image,
          network: r.network,
          status: r.status,
          lastUsedAt: r.lastUsedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      },
    };
  },
};

const sandbox_stop: BuiltinToolDef = {
  slug: 'sandbox_stop',
  name: 'Stop sandbox',
  description:
    "Stop a sandbox's container to free memory/CPU. Installed packages and /files are kept; " +
    'the next `sandbox_exec` restarts it automatically. To delete it use `sandbox_rm`.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
    },
    required: ['sandbox'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const res = await sandboxd('POST', `/sandboxes/${row.id}/stop`);
    if (!res.ok) return res;
    await setSandboxStatus(row.id, 'stopped');
    return { ok: true, output: { sandbox: row.name, status: 'stopped' } };
  },
};

const sandbox_rm: BuiltinToolDef = {
  slug: 'sandbox_rm',
  name: 'Remove sandbox',
  description:
    'Remove a sandbox: deletes the container (installed packages, images) and frees the name. ' +
    '**The /files work directory is PRESERVED on the host by default** and its path is returned. ' +
    'Pass `purge_files: true` only when the owner explicitly wants the work deleted too — that ' +
    'is irreversible. To merely free memory keep the sandbox and use `sandbox_stop`.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      purge_files: {
        type: 'boolean',
        default: false,
        description: 'Also delete the /files host directory — irreversible.',
      },
    },
    required: ['sandbox'],
    additionalProperties: false,
  },
  requiresConfirm: true,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const purge = input.purge_files === true;
    const res = await sandboxd('DELETE', `/sandboxes/${row.id}${purge ? '?purge=1' : ''}`);
    if (!res.ok) return res;
    await deleteSandboxRow(row.id);
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, purge });
    return {
      ok: true,
      output: {
        removed: row.name,
        filesPreserved: res.data.filesPreserved ?? !purge,
        filesDir: res.data.filesDir ?? null,
      },
    };
  },
};

export const SANDBOX_TOOLS: BuiltinToolDef[] = [
  sandbox_create,
  sandbox_exec,
  sandbox_list,
  sandbox_stop,
  sandbox_rm,
];
export const SANDBOX_TOOL_SLUGS = SANDBOX_TOOLS.map((t) => t.slug);
