/**
 * Moving work in and out of a sandbox: export, import, ls, publish.
 *
 * Split out of builtins-sandbox.ts; bodies moved verbatim.
 */

import { getSandboxByRef, touchSandbox } from '@mantle/content';
import { readFileById, upsertFile } from '@mantle/files';
import { setApiKey } from '@mantle/api-keys';
import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroupIntegration } from '@mantle/db';
import { notFound } from '../errors';
import type { BuiltinToolDef, ToolHandlerResult } from '../types';
import { env } from '@mantle/config';
import {
  EXPORTS_FOLDER_PATH,
  ensureExportsFolder,
  sandboxd,
  sandboxdBinary,
  sandboxdUpload,
} from './common';

export const sandbox_export: BuiltinToolDef = {
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

export const sandbox_import: BuiltinToolDef = {
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

export const sandbox_ls: BuiltinToolDef = {
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

export const sandbox_publish: BuiltinToolDef = {
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
