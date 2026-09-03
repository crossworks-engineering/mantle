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
  diskPathForLtree,
  ensureFilesRootBranch,
  filesRoot,
  folderById,
  folderByPath,
  readFileById,
  upsertFile,
} from '@mantle/files';
import { relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { setApiKey } from '@mantle/api-keys';
import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroupIntegration } from '@mantle/db';
import { randomUUID } from 'node:crypto';
import { notFound } from './errors';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { env } from '@mantle/config';

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
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
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

/**
 * Binary sibling of `sandboxd()` for the IMPORT stream — bytes up, JSON back.
 * The file is the body, so the destination path rides the query string.
 */
async function sandboxdUpload(
  path: string,
  bytes: Buffer,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
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
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
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
    'inside the sandbox use `sandbox_exec` (cat/ls) instead. Pass `raw: true` to bring ONE ' +
    'file out under its own name and type rather than inside an archive.',
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
      raw: {
        type: 'boolean',
        description:
          'Export ONE file as itself instead of wrapping it in a .tgz — the right choice when ' +
          'the artifact is the deliverable (a report, a drawing, a spreadsheet) and a person ' +
          'will open it. Requires `path` to name a file, not a directory. Default false.',
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

    const raw = input.raw === true;
    if (raw && (relPath === '.' || relPath.endsWith('/'))) {
      return {
        ok: false,
        error: 'raw export needs `path` to name a single file, e.g. "out/report.pdf"',
      };
    }
    const res = await sandboxdBinary(`/sandboxes/${row.id}/export`, { path: relPath, raw });
    if (!res.ok) return res;
    await touchSandbox(row.id);

    // Raw keeps the artifact's own name (and therefore its type), so the person
    // who asked for the report receives the report.
    const fallback = raw
      ? (relPath.split('/').pop() ?? relPath)
      : `${row.name}-${relPath === '.' ? 'files' : relPath.replace(/[/\\]+/g, '-')}.tgz`;
    const rawName =
      typeof input.filename === 'string' && input.filename.trim()
        ? input.filename.trim()
        : fallback;
    const filename = raw
      ? rawName
      : rawName.endsWith('.tgz') || rawName.endsWith('.tar.gz')
        ? rawName
        : `${rawName}.tgz`;

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

const sandbox_import: BuiltinToolDef = {
  slug: 'sandbox_import',
  name: 'Import a file into a sandbox',
  description:
    "Copy a file from the Files workspace into a sandbox's /files, byte for byte. The mirror of " +
    '`sandbox_export`, and how work that STARTS from a file gets in: a colleague uploads through ' +
    'the web UI, this puts it where the sandbox can open it, and nobody needs shell access to ' +
    'the server. Safe for binaries; never pipe one through `sandbox_exec` and base64, which is ' +
    'slower, larger, and corrupts silently. Works on a stopped sandbox, since /files outlives ' +
    'the container. When the file is only a payload and its text is worthless in the index, set ' +
    'its folder to metadata-only with `folder_set_indexing` first.',
  preconditions: [
    { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      path: {
        type: 'string',
        description:
          'Destination under /files, e.g. "data/register.accdb". Defaults to the file\'s own ' +
          'name at the top of /files. Directories are created as needed.',
      },
    },
    required: ['sandbox', 'file_id'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');

    const fileId = typeof input.file_id === 'string' ? input.file_id : '';
    const found = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!found) return notFound('file', fileId, 'file_list');

    // Default to the file's own name, so the common case needs no path at all.
    const wanted = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '';
    const dest = wanted || found.row.filename;
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, path: dest, fileId });

    const res = await sandboxdUpload(
      `/sandboxes/${row.id}/import?path=${encodeURIComponent(dest)}`,
      found.bytes,
    );
    if (!res.ok) return res;
    await touchSandbox(row.id);

    const sizeBytes = Number(res.data.sizeBytes ?? found.bytes.length);
    ctx.step?.setOutput({ path: res.data.path, sizeBytes });
    return {
      ok: true,
      output: {
        imported: found.row.filename,
        path: res.data.path,
        sizeBytes,
        sandbox: row.name,
      },
    };
  },
};

const sandbox_ls: BuiltinToolDef = {
  slug: 'sandbox_ls',
  readOnly: true,
  name: 'List sandbox files',
  description:
    "List a directory under a sandbox's /files as structured rows (name, type, size, modified) " +
    'rather than text you have to parse. Prefer this over `sandbox_exec ls`: `ls` output shifts ' +
    'with flags and locale, so parsing it is a guess. Works while the sandbox is STOPPED, so ' +
    'checking what is there costs nothing and does not wake the container.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      path: {
        type: 'string',
        description: 'Directory under /files, e.g. "data" or "out/reports". Defaults to /files.',
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
    const relPath = typeof input.path === 'string' ? input.path.trim() : '';
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, path: relPath || '/files' });

    const res = await sandboxd(
      'GET',
      `/sandboxes/${row.id}/ls?path=${encodeURIComponent(relPath)}`,
    );
    if (!res.ok) return res;
    // Deliberately no touchSandbox: looking is not use, and refreshing the
    // idle clock on a read would keep an abandoned sandbox alive forever.
    return { ok: true, output: res.data };
  },
};

const sandbox_autostart: BuiltinToolDef = {
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
    const token = env('SANDBOXD_TOKEN')!;
    await setApiKey(ctx.ownerId, 'sandboxd', 'proxy', token);

    const baseUrl = `${env('SANDBOXD_URL')}/svc/${row.id}/${port}`;
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

const sandbox_mcp_tools: BuiltinToolDef = {
  slug: 'sandbox_mcp_tools',
  readOnly: true,
  name: 'List sandbox toolbelt',
  description:
    "List the tools of the sandbox's embedded Claude Code MCP server (Read, Grep, Glob, Edit, " +
    'Write, Bash, …) — name and a short description each; pass `tool` for one full input ' +
    'schema. The serve process starts on first use (no API key involved). Prefer the toolbelt ' +
    'over raw `sandbox_exec` for file work: its Read/Edit/Grep are structured and validated.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      tool: {
        type: 'string',
        description:
          'Return the full definition (with input schema) of this one tool, e.g. "Bash".',
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
    const res = await sandboxd('POST', `/sandboxes/${row.id}/mcp`, { method: 'tools/list' });
    if (!res.ok) return res;
    await touchSandbox(row.id);
    const tools = Array.isArray((res.data.result as Record<string, unknown>)?.tools)
      ? ((res.data.result as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      : [];
    const want = typeof input.tool === 'string' ? input.tool : null;
    if (want) {
      const t = tools.find((x) => x.name === want);
      if (!t) {
        return {
          ok: false,
          error: `toolbelt has no tool '${want}' — list the real names with sandbox_mcp_tools (no \`tool\` arg)`,
        };
      }
      return { ok: true, output: { tool: t } };
    }
    return {
      ok: true,
      output: {
        tools: tools.map((t) => ({
          name: t.name,
          description: String(t.description ?? '').slice(0, 160),
        })),
      },
    };
  },
};

const sandbox_mcp_call: BuiltinToolDef = {
  slug: 'sandbox_mcp_call',
  name: 'Call sandbox toolbelt',
  description:
    "Invoke one tool of the sandbox's Claude Code toolbelt (names + schemas from " +
    '`sandbox_mcp_tools`) and return its content. Runs INSIDE the sandbox — same blast radius ' +
    'as `sandbox_exec`, richer ergonomics: `Read` returns numbered lines, `Edit` validates its ' +
    'match, `Grep`/`Glob` search structurally. For plain shell commands `sandbox_exec` is ' +
    'equivalent and simpler. Long operations: raise `timeout_seconds`.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      tool: { type: 'string', description: 'Toolbelt tool name, e.g. "Read" or "Bash".' },
      arguments: {
        type: 'object',
        description: 'Arguments per the tool\'s schema, e.g. {"file_path": "/files/x.py"}.',
        additionalProperties: true,
      },
      timeout_seconds: {
        type: 'number',
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        default: DEFAULT_TIMEOUT_S,
        description: 'Fail the call after this many seconds.',
      },
    },
    required: ['sandbox', 'tool'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const tool = typeof input.tool === 'string' ? input.tool : '';
    if (!tool) return { ok: false, error: 'tool is required — list names with sandbox_mcp_tools' };
    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_S,
      Math.max(
        1,
        typeof input.timeout_seconds === 'number' ? input.timeout_seconds : DEFAULT_TIMEOUT_S,
      ),
    );
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, mcpTool: tool, timeoutSeconds });

    const res = await sandboxd('POST', `/sandboxes/${row.id}/mcp`, {
      method: 'tools/call',
      params: { name: tool, arguments: input.arguments ?? {} },
      timeoutSeconds,
    });
    if (!res.ok) return res;
    await touchSandbox(row.id);

    const result = (res.data.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    const out = truncate(text);
    ctx.step?.setOutput({ isError: result.isError === true, bytes: text.length });
    return {
      ok: true,
      output: {
        sandbox: row.name,
        tool,
        isError: result.isError === true,
        content: out.text,
        truncated: out.truncated,
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
  sandbox_import,
  sandbox_ls,
  sandbox_autostart,
  sandbox_publish,
  sandbox_mcp_tools,
  sandbox_mcp_call,
];
export const SANDBOX_TOOL_SLUGS = SANDBOX_TOOLS.map((t) => t.slug);
