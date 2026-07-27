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
import {
  createFolder,
  dashToLtree,
  ensureFilesRootBranch,
  folderByPath,
  upsertFile,
} from '@mantle/files';
import { setApiKey } from '@mantle/api-keys';
import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroupIntegration } from '@mantle/db';
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

/** Binary sibling of `sandboxd()` for the export stream. */
async function sandboxdBinary(
  path: string,
  body: unknown,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const base = process.env.SANDBOXD_URL;
  const token = process.env.SANDBOXD_TOKEN;
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: NOT_ENABLED };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : `sandboxd → ${res.status}`,
    };
  }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
}

const EXPORTS_FOLDER_SLUG = 'sandbox-exports';
const EXPORTS_FOLDER_PATH = `files.${dashToLtree(EXPORTS_FOLDER_SLUG)}`;

/** Lazy-create `files/sandbox-exports`, tolerating the concurrent-create race
 *  the same way the api-docs folder does. */
async function ensureExportsFolder(ownerId: string): Promise<void> {
  await ensureFilesRootBranch(ownerId);
  const existing = await folderByPath({ ownerId, path: EXPORTS_FOLDER_PATH });
  if (existing) return;
  try {
    await createFolder({
      ownerId,
      parentPath: 'files',
      slug: EXPORTS_FOLDER_SLUG,
      description:
        'Work exported from CLI sandboxes (sandbox_export): tar.gz snapshots of /files paths, one per export.',
    });
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
  }
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

const sandbox_export: BuiltinToolDef = {
  slug: 'sandbox_export',
  name: 'Export sandbox files',
  description:
    "Snapshot a path under a sandbox's /files into the brain as a .tgz in the Files workspace " +
    '(`files/sandbox-exports/`) and return the file node. Use when work should outlive the ' +
    'sandbox or reach the owner — build outputs, reports, generated code. Export a specific ' +
    'subpath, not all of /files, when repos are cloned (size cap applies). For ad-hoc reads ' +
    'inside the sandbox use `sandbox_exec` (cat/ls) instead.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      path: {
        type: 'string',
        description: 'Path under /files to export, e.g. "myapi" or "report/out.pdf".',
        default: '.',
      },
      filename: {
        type: 'string',
        description: 'Archive filename, e.g. "myapi-v1.tgz". Defaults to <sandbox>-<path>.tgz.',
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
    const relPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.';
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, path: relPath });

    const res = await sandboxdBinary(`/sandboxes/${row.id}/export`, { path: relPath });
    if (!res.ok) return res;
    await touchSandbox(row.id);

    const fallback = `${row.name}-${relPath === '.' ? 'files' : relPath.replace(/[/\\]+/g, '-')}.tgz`;
    const rawName =
      typeof input.filename === 'string' && input.filename.trim()
        ? input.filename.trim()
        : fallback;
    const filename =
      rawName.endsWith('.tgz') || rawName.endsWith('.tar.gz') ? rawName : `${rawName}.tgz`;

    await ensureExportsFolder(ctx.ownerId);
    const file = await upsertFile({
      ownerId: ctx.ownerId,
      parentPath: EXPORTS_FOLDER_PATH,
      filename,
      bytes: res.bytes,
      overwrite: true,
    });
    ctx.step?.setOutput({ nodeId: file.id, sizeBytes: res.bytes.length });
    return {
      ok: true,
      output: {
        exported: relPath,
        file: `files/sandbox-exports/${filename}`,
        nodeId: file.id,
        sizeBytes: res.bytes.length,
      },
    };
  },
};

const sandbox_publish: BuiltinToolDef = {
  slug: 'sandbox_publish',
  name: 'Publish sandbox service',
  description:
    'Make a service running inside a sandbox callable by the brain: declares the port to the ' +
    'supervisor proxy and creates/updates an integration tool group bound to it. Returns the ' +
    'group slug and base URL. The service must already be listening (bind 0.0.0.0, background ' +
    'it with `nohup … &` via `sandbox_exec`). Next steps: author endpoints into the group with ' +
    '`api_tool_create` (relative paths join the base URL), grant with `agent_grant_tool_group`. ' +
    'For one-off reads of files use `sandbox_export` instead.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      port: {
        type: 'number',
        minimum: 1,
        maximum: 65535,
        description: 'Port the service listens on inside the sandbox, e.g. 8000.',
      },
      group_slug: {
        type: 'string',
        description: 'Integration tool-group slug to create/update. Defaults to sbx-<sandbox>.',
      },
      description: {
        type: 'string',
        description: 'One line on what the service does, e.g. "python calculation API".',
      },
    },
    required: ['sandbox', 'port'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const port = Number(input.port);
    const rawSlug =
      typeof input.group_slug === 'string' && input.group_slug.trim()
        ? input.group_slug.trim()
        : `sbx-${row.name}`;
    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(rawSlug)) {
      return {
        ok: false,
        error: `group_slug '${rawSlug}' is invalid — lowercase letters/digits/dash/underscore, 2–48 chars.`,
      };
    }

    const published = await sandboxd('POST', `/sandboxes/${row.id}/publish`, { port });
    if (!published.ok) return published;
    await touchSandbox(row.id);

    // Vault the proxy token under a stable ref so the authored tools' auth
    // template resolves through the normal secret machinery (the token is
    // stripped by the proxy before reaching the sandbox service).
    const token = process.env.SANDBOXD_TOKEN!;
    await setApiKey(ctx.ownerId, 'sandboxd', 'proxy', token);

    const baseUrl = `${process.env.SANDBOXD_URL}/svc/${row.id}/${port}`;
    const integration: ToolGroupIntegration = {
      service: `sandbox-${row.name}`,
      baseUrl,
      secretRef: 'sandboxd/proxy',
      authTemplate: { headers: { Authorization: 'Bearer {{secret:sandboxd/proxy}}' } },
    };
    const description =
      typeof input.description === 'string' && input.description.trim()
        ? input.description.trim()
        : `Service published from sandbox '${row.name}' (port ${port}), reached via the sandboxd proxy.`;

    const [existing] = await db
      .select({ id: toolGroups.id })
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, rawSlug)))
      .limit(1);
    if (existing) {
      await db
        .update(toolGroups)
        .set({ integration, description, updatedAt: new Date() })
        .where(eq(toolGroups.id, existing.id));
    } else {
      await db.insert(toolGroups).values({
        ownerId: ctx.ownerId,
        slug: rawSlug,
        name: `Sandbox: ${row.name}`,
        description,
        toolSlugs: [],
        integration,
      });
    }
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, port, group: rawSlug });
    return {
      ok: true,
      output: {
        sandbox: row.name,
        port,
        group: rawSlug,
        baseUrl,
        next: 'author endpoint tools into this group with api_tool_create (relative paths join baseUrl; auth is inherited from the group integration), then grant it to an agent with agent_grant_tool_group',
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
  sandbox_export,
  sandbox_publish,
];
export const SANDBOX_TOOL_SLUGS = SANDBOX_TOOLS.map((t) => t.slug);
