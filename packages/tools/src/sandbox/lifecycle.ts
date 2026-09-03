/**
 * Sandbox lifecycle: create, exec, list, stop, remove, autostart.
 *
 * Split out of builtins-sandbox.ts; bodies moved verbatim.
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
import { diskPathForLtree, filesRoot, folderById } from '@mantle/files';
import { relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { notFound } from '../errors';
import { capOutput } from '../output-cap';
import type { BuiltinToolDef, ToolHandlerResult } from '../types';
import { env } from '@mantle/config';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, sandboxd } from './common';

export const sandbox_create: BuiltinToolDef = {
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
        description:
          'Container image reference. The default ships python3+common libs, node22+pnpm, git, ' +
          'docker CLI and claude code — only override for a specialist runtime, e.g. "golang:1.23".',
        default: 'titanwest/mantle-sandbox:24.04-v2',
      },
      network: {
        type: 'string',
        enum: ['full', 'balanced', 'none'],
        default: 'full',
        description:
          'Egress tier: "full" = internet (never the brain\'s network); "balanced" = only ' +
          'package registries, GitHub and apt mirrors via an allowlisting proxy; "none" = offline.',
      },
      inbox_folder_id: {
        type: 'string',
        format: 'uuid',
        description:
          'A Files folder to expose READ-ONLY at /mnt/inbox — from `folder_list` / `tree_list`. ' +
          'Use it when the work starts from files a colleague will keep adding: they drop them ' +
          'in that folder through the web UI and the sandbox sees them at once, with no import ' +
          'step and no shell access. The sandbox cannot write back to it.',
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
    const network =
      input.network === 'none' ? 'none' : input.network === 'balanced' ? 'balanced' : 'full';
    const image =
      typeof input.image === 'string' && input.image
        ? input.image
        : env('SANDBOX_DEFAULT_IMAGE') || 'titanwest/mantle-sandbox:24.04-v2';
    // Map the folder node to the path it occupies under the Files root, and
    // send only that RELATIVE part: sandboxd joins it onto the box's own
    // host-absolute root, which is the only path the docker daemon can resolve.
    let inboxSub: string | undefined;
    const inboxId = typeof input.inbox_folder_id === 'string' ? input.inbox_folder_id.trim() : '';
    if (inboxId) {
      const folder = await folderById({ ownerId: ctx.ownerId, folderId: inboxId });
      if (!folder) return notFound('folder', inboxId, 'folder_list / tree_list');
      const abs = diskPathForLtree(folder.path);
      const root = filesRoot();
      if (!abs) {
        return {
          ok: false,
          error: `folder ${folder.title} is not mirrored on disk, so it cannot be mounted — pick a folder under Files`,
        };
      }
      // sandboxd cannot see the file store, so the folder's existence on disk
      // is checked HERE, where it is mounted. Without this a typo'd or
      // never-mirrored folder would produce a sandbox whose /mnt/inbox is
      // simply empty, and every later step would look fine.
      try {
        const st = await stat(abs);
        if (!st.isDirectory()) {
          return { ok: false, error: `${folder.title} is not a directory on disk` };
        }
      } catch {
        return {
          ok: false,
          error: `folder ${folder.title} has no directory on disk yet — add a file to it first, then create the sandbox`,
        };
      }
      inboxSub = abs === root ? '' : relative(root, abs);
      if (!inboxSub) {
        return {
          ok: false,
          error:
            'mounting the whole Files root is refused — name a specific folder, so the sandbox sees only what it needs',
        };
      }
    }

    const created = await sandboxd('POST', '/sandboxes', {
      id,
      ownerId: ctx.ownerId,
      image,
      network,
      inbox: inboxSub,
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
      output: {
        id: row.id,
        name,
        image,
        network,
        status: 'running',
        filesDir: '/files',
        ...(created.data.inbox ? { inbox: created.data.inbox } : {}),
      },
    };
  },
};

export const sandbox_exec: BuiltinToolDef = {
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

    const out = capOutput(String(res.data.stdout ?? ''));
    const errOut = capOutput(String(res.data.stderr ?? ''));
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

export const sandbox_list: BuiltinToolDef = {
  slug: 'sandbox_list',
  readOnly: true,
  name: 'List sandboxes',
  description:
    "List this owner's sandboxes: name, status, image, network tier, description and last-used " +
    'time. Use to find an existing sandbox before creating a new one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirm: false,
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const rows = await listSandboxes(ctx.ownerId);
    // Merge live container state (idle-stop can stop a sandbox between execs;
    // the row alone would lie). sandboxd down/absent → rows as-is.
    const live = await sandboxd('GET', '/sandboxes');
    const liveState = new Map<string, string>();
    if (live.ok && Array.isArray(live.data.sandboxes)) {
      for (const s of live.data.sandboxes as Array<{ id?: string; state?: string }>) {
        if (s.id && s.state) liveState.set(s.id, s.state === 'running' ? 'running' : 'stopped');
      }
    }
    return {
      ok: true,
      output: {
        sandboxes: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          image: r.image,
          network: r.network,
          status: liveState.get(r.id) ?? r.status,
          lastUsedAt: r.lastUsedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
        ...(live.ok && live.data.disk ? { disk: live.data.disk } : {}),
      },
    };
  },
};

export const sandbox_stop: BuiltinToolDef = {
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

export const sandbox_rm: BuiltinToolDef = {
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

export const sandbox_autostart: BuiltinToolDef = {
  slug: 'sandbox_autostart',
  name: 'Set a sandbox wake command',
  description:
    'Store a command the sandbox runs every time it wakes. A sandbox idle-stops after an hour: ' +
    '/files and installed packages survive, running PROCESSES do not, so anything serving a port ' +
    'comes back deaf until someone re-runs its start script. Set that script here once and ' +
    'waking becomes self-healing. The command MUST be idempotent — it runs on every wake, so it ' +
    'should notice an already-running service and say so. Call with no command to clear it.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      command: {
        type: 'string',
        description:
          'Shell run on wake, e.g. "sh /files/start.sh". Omit or pass "" to clear the hook.',
      },
    },
    required: ['sandbox'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, cleared: !command });

    const res = await sandboxd('POST', `/sandboxes/${row.id}/autostart`, { command });
    if (!res.ok) return res;
    return {
      ok: true,
      output: command
        ? { sandbox: row.name, wakeCommand: command, script: res.data.wake }
        : { sandbox: row.name, wakeCommand: null, cleared: true },
    };
  },
};
