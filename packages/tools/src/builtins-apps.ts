/**
 * App builtins — let the Appsmith agent author mini apps: real TSX bundled by
 * esbuild and rendered in a sandboxed iframe. Source is a small virtual file
 * tree (`apps.source`); edits land in `draft_source` (review/publish discipline
 * mirrors pages). `app_build` bundles the draft via @mantle/app-build and stores
 * the artifact in object storage; the iframe loads it through /api/apps/[id]/bundle.
 *
 * Apps don't author HTTP tools — they DECLARE (via app_tools_set) which existing
 * api_tools (built by the toolsmith / API Console) the host may broker for them.
 */
import {
  createApp,
  getApp,
  listApps,
  writeDraftFile,
  deleteDraftFile,
  saveDraftSource,
  setManifest,
  setDraftBuild,
  publishApp,
  deleteApp,
  workingSource,
  nodeUrl,
  CannotDeleteEntryError,
  AppSourceLimitError,
  NoGreenBuildError,
  type AppDetail,
} from '@mantle/content';
import { buildApp } from '@mantle/app-build';
import {
  assertSafeScript,
  appDbReadQuery,
  appDbSchema,
  listAppDatabaseSummaries,
} from '@mantle/content/app-broker';
import { putContent } from '@mantle/storage';
import { recordIngest } from '@mantle/tracing';
import { resolveTool } from './dispatch';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { str, strArr } from './coerce';

const APP_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'app', lookup: 'app_list' },
];
const APP_DB_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'app_id', nodeType: 'app', lookup: 'app_db_list / app_list' },
];

const SOURCE_HINT =
  'Mini-app source is TSX. Allowed imports: `react`; the kit `@/components/ui/*` (button, card, input, label, badge, separator) + `cn` from `@/lib/utils`; `lucide-react` icons; the host bridge `host` from `@host` (host.tools.call(slug,input), host.db.query/exec(sql,params)); and relative files. Theme tokens only (bg-background, text-foreground, bg-card, bg-primary+text-primary-foreground, chart-1..5) — never hardcode colours. The entry file must `export default function App()`.';

function fileList(app: AppDetail) {
  const src = workingSource(app);
  return {
    entry: src.entry,
    files: Object.entries(src.files).map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      isEntry: path === src.entry,
    })),
  };
}

const app_create: BuiltinToolDef = {
  slug: 'app_create',
  name: 'Create a mini app',
  description:
    'Create a new mini app (an `app` node under /apps). `name` required. Starts with a trivial entry file you then flesh out with `app_file_write` + `app_build`. ' +
    SOURCE_HINT,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'app name, e.g. "Weather"' },
      description: { type: 'string', description: 'one-line summary for the app list' },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "🌤️"' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
    },
    required: ['name'],
  },
  handler: async (input, ctx) => {
    const name = str(input.name).trim();
    if (!name) return { ok: false, error: 'name is required' };
    try {
      const app = await createApp(ctx.ownerId, {
        title: name.slice(0, 200),
        ...(str(input.icon).trim() ? { icon: str(input.icon).trim() } : {}),
        ...(str(input.description).trim() ? { description: str(input.description).trim() } : {}),
        tags: strArr(input.tags),
      });
      ctx.step?.setOutput({ id: app.id, name: app.title });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: app.id,
        summary: `App created by tool: ${app.title}`,
        payload: {
          via: 'app_create_tool',
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: name,
      });
      return {
        ok: true,
        output: {
          id: app.id,
          url: nodeUrl(app.id),
          name: app.title,
          entry: app.source.entry,
          hint: `Write source with app_file_write, then app_build. Review at /apps/${app.id}.`,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_get: BuiltinToolDef = {
  slug: 'app_get',
  preconditions: APP_ID_PRE,
  name: 'Get a mini app',
  description:
    "Read one app by id: name, manifest (declared tool slugs + sqlite schema), entry file, the list of source files, and build status. Pass `include_source: true` to also return every file's full text (omitted by default to stay small).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      include_source: { type: 'boolean', description: "include each file's full text" },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const app = await getApp(ctx.ownerId, id);
    if (!app) return { ok: false, error: `app ${id} not found` };
    const src = workingSource(app);
    return {
      ok: true,
      output: {
        id: app.id,
        url: nodeUrl(app.id),
        name: app.title,
        description: app.description,
        manifest: app.manifest,
        hasDraft: app.hasDraft,
        draftBuild: app.draftBuild ? { ok: app.draftBuild.ok, bytes: app.draftBuild.bytes } : null,
        publishedBuild: app.publishedBuild ? { ok: app.publishedBuild.ok } : null,
        ...fileList(app),
        ...(input.include_source === true ? { source: src } : {}),
      },
    };
  },
};

const app_file_write: BuiltinToolDef = {
  slug: 'app_file_write',
  preconditions: APP_ID_PRE,
  name: 'Write a file in a mini app',
  description:
    "Create or replace one source file (by path) in the app's DRAFT — the published app is untouched until app_publish. After writing, call app_build to compile + see errors. " +
    SOURCE_HINT,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      path: {
        type: 'string',
        description: "file path within the app, e.g. 'App.tsx' or 'lib/fmt.ts'",
      },
      content: { type: 'string', description: 'full file contents (TSX/TS)' },
    },
    required: ['id', 'path', 'content'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    const path = str(input.path).trim();
    if (!id || !path) return { ok: false, error: 'id and path are required' };
    const content = str(input.content);
    try {
      const next = await writeDraftFile(ctx.ownerId, id, path, content);
      if (!next) return { ok: false, error: `app ${id} not found` };
      ctx.step?.setOutput({ id, path, bytes: Buffer.byteLength(content, 'utf8') });
      return {
        ok: true,
        output: {
          id,
          path,
          file_count: Object.keys(next.files).length,
          draft_saved: true,
          hint: 'Run app_build to compile this draft and surface any errors.',
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_file_delete: BuiltinToolDef = {
  slug: 'app_file_delete',
  preconditions: APP_ID_PRE,
  name: 'Delete a file from a mini app',
  description:
    'Remove one source file (by path) from the app DRAFT. Refuses to delete the entry file. Run app_build afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      path: { type: 'string', description: 'file path to delete' },
    },
    required: ['id', 'path'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    const path = str(input.path).trim();
    if (!id || !path) return { ok: false, error: 'id and path are required' };
    try {
      const next = await deleteDraftFile(ctx.ownerId, id, path);
      if (!next) return { ok: false, error: `app ${id} not found` };
      ctx.step?.setOutput({ id, path, deleted: true });
      return {
        ok: true,
        output: { id, path, deleted: true, file_count: Object.keys(next.files).length },
      };
    } catch (err) {
      if (err instanceof CannotDeleteEntryError) return { ok: false, error: err.message };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_source_set: BuiltinToolDef = {
  slug: 'app_source_set',
  preconditions: APP_ID_PRE,
  name: "Set a mini app's whole source tree",
  description:
    "Replace the app's ENTIRE draft source tree in one call, instead of many `app_file_write` calls — use it when you authored the files elsewhere and want to upload them atomically. The published app is untouched until `app_publish`; call `app_build` afterwards to compile. " +
    SOURCE_HINT,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      entry: {
        type: 'string',
        description: "entry file path, e.g. 'App.tsx' — must be a key in `files`",
      },
      files: {
        type: 'object',
        description:
          'Map of file path → full file contents (TSX/TS strings). Must include the entry file. Max 50 files, 256 KB each.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['id', 'entry', 'files'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    const entry = str(input.entry).trim();
    if (!id) return { ok: false, error: 'id is required' };
    if (!entry) return { ok: false, error: 'entry is required' };
    const filesIn = input.files;
    if (!filesIn || typeof filesIn !== 'object' || Array.isArray(filesIn)) {
      return { ok: false, error: 'files must be an object mapping path → contents' };
    }
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(filesIn as Record<string, unknown>)) {
      if (typeof content !== 'string') {
        return { ok: false, error: `file '${path}' contents must be a string` };
      }
      files[path] = content;
    }
    if (!(entry in files)) {
      return {
        ok: false,
        error: `entry '${entry}' must be one of the files (${Object.keys(files).join(', ') || 'none'})`,
      };
    }
    try {
      const ok = await saveDraftSource(ctx.ownerId, id, { entry, files });
      if (!ok) return { ok: false, error: `app ${id} not found` };
      ctx.step?.setOutput({ id, entry, file_count: Object.keys(files).length });
      return {
        ok: true,
        output: {
          id,
          entry,
          file_count: Object.keys(files).length,
          draft_saved: true,
          hint: 'Run app_build to compile this draft and surface any errors.',
        },
      };
    } catch (err) {
      if (err instanceof AppSourceLimitError) return { ok: false, error: err.message };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_build: BuiltinToolDef = {
  slug: 'app_build',
  preconditions: APP_ID_PRE,
  name: 'Build a mini app',
  description:
    "Compile the app's DRAFT source with esbuild and stage the bundle for preview. Returns `{ ok, errors[], warnings[], bytes }` — read the errors (each has file/line/column) and fix the offending file, then build again. A failed build does NOT replace the last good preview. This is your compile/feedback loop; iterate until ok=true, then tell the user to review at /apps/<id> and app_publish when they approve.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: "The app's id (UUID) — from `app_list`." } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const app = await getApp(ctx.ownerId, id);
    if (!app) return { ok: false, error: `app ${id} not found` };
    const source = workingSource(app);
    try {
      const res = await buildApp(source, { declaredToolSlugs: app.manifest.toolSlugs ?? [] });
      ctx.step?.setMeta({ ok: res.ok, errors: res.errors.length, warnings: res.warnings.length });
      if (res.ok && res.code) {
        const buf = Buffer.from(res.code, 'utf8');
        const put = await putContent(buf, 'application/javascript');
        await setDraftBuild(ctx.ownerId, id, {
          storageKey: put.key,
          sha256: put.sha256,
          builtAt: new Date().toISOString(),
          esbuildVersion: res.esbuildVersion,
          bytes: put.size,
          ok: true,
          ...(res.warnings.length ? { warnings: res.warnings.map((w) => w.text) } : {}),
        });
      }
      return {
        ok: true,
        output: {
          id,
          build_ok: res.ok,
          bytes: res.code ? Buffer.byteLength(res.code, 'utf8') : 0,
          errors: res.errors,
          warnings: res.warnings,
          ...(res.ok
            ? {
                hint: `Build succeeded. Review the live preview at /apps/${id}; app_publish when approved.`,
              }
            : {
                hint: 'Build failed — fix the files at the reported locations and run app_build again.',
              }),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_tools_set: BuiltinToolDef = {
  slug: 'app_tools_set',
  preconditions: APP_ID_PRE,
  name: "Declare a mini app's data tools",
  description:
    'Set the list of api_tool slugs this app may call through the host bridge (host.tools.call). This IS the runtime allowlist — the host refuses any slug not declared here. Each slug must be an existing tool you own (build them first via the toolsmith / API Console, or delegate to the `toolsmith` agent). Replaces the current list.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      tool_slugs: {
        type: 'array',
        items: { type: 'string' },
        description: 'api_tool slugs the app may call',
      },
    },
    required: ['id', 'tool_slugs'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const slugs = strArr(input.tool_slugs);
    // Validate each slug resolves to an owned, enabled tool.
    const missing: string[] = [];
    for (const slug of slugs) {
      const tool = await resolveTool(ctx.ownerId, slug);
      if (!tool) missing.push(slug);
    }
    if (missing.length) {
      return {
        ok: false,
        error: `unknown tool slug(s): ${missing.join(', ')}. Build them first (toolsmith / API Console) before declaring.`,
      };
    }
    const manifest = await setManifest(ctx.ownerId, id, { toolSlugs: slugs });
    if (!manifest) return { ok: false, error: `app ${id} not found` };
    ctx.step?.setOutput({ id, tool_slugs: slugs });
    return { ok: true, output: { id, tool_slugs: slugs } };
  },
};

const app_db_schema_set: BuiltinToolDef = {
  slug: 'app_db_schema_set',
  preconditions: APP_ID_PRE,
  name: "Set a mini app's SQLite schema",
  description:
    "Declare the app's per-app SQLite schema as DDL (CREATE TABLE …). Stored on the app manifest; the host provisions/migrates the app's own SQLite database from it. The app reads/writes via host.db.query(sql, params) / host.db.exec(sql, params) — each app touches only its own database. Replaces the current schema (bumps the version). The DDL is guarded: ATTACH/DETACH/VACUUM INTO/PRAGMA are refused (read-only `PRAGMA table_info(<table>)` excepted), and it only re-runs on a version bump — it will NOT reshape a table that already exists. To add columns to an app with live data, run an idempotent ALTER TABLE migration in app code at startup (pattern in the app_authoring skill).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The app's id (UUID) — from `app_list`." },
      schema_sql: {
        type: 'string',
        description: 'DDL, e.g. "CREATE TABLE IF NOT EXISTS cities (name TEXT PRIMARY KEY);"',
      },
    },
    required: ['id', 'schema_sql'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    const schemaSql = str(input.schema_sql);
    if (!id) return { ok: false, error: 'id is required' };
    if (!schemaSql.trim()) return { ok: false, error: 'schema_sql is required' };
    // Reject file-escape DDL up front so the agent gets clear feedback now,
    // rather than a runtime failure when the app first opens its database.
    try {
      assertSafeScript(schemaSql);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const app = await getApp(ctx.ownerId, id);
    if (!app) return { ok: false, error: `app ${id} not found` };
    const nextVersion = (app.manifest.sqlite?.schemaVersion ?? 0) + 1;
    const manifest = await setManifest(ctx.ownerId, id, {
      sqlite: { schemaSql, schemaVersion: nextVersion },
    });
    if (!manifest) return { ok: false, error: `app ${id} not found` };
    ctx.step?.setOutput({ id, schema_version: nextVersion });
    return {
      ok: true,
      output: {
        id,
        schema_version: nextVersion,
        hint: 'The host applies this DDL when the app first opens its database. Use host.db.query/exec at runtime.',
      },
    };
  },
};

const app_list: BuiltinToolDef = {
  slug: 'app_list',
  name: 'List mini apps',
  description:
    "List the owner's mini apps, newest first. Optional `query` substring-matches name/source/summary; `tag` filters. Source is omitted to stay small.",
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Substring matched against app name, source text, and summary, e.g. 'weather'.",
      },
      tag: {
        type: 'string',
        description: "Return only apps carrying this exact tag, e.g. 'work'.",
      },
      limit: { type: 'number', description: 'max rows (default 50)' },
    },
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim() || undefined;
    const tag = str(input.tag).trim() || undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(200, input.limit)) : 50;
    const rows = await listApps(ctx.ownerId, { query, tag, limit });
    ctx.step?.setOutput({ count: rows.length });
    return {
      ok: true,
      output: rows.map((r) => ({
        id: r.id,
        url: nodeUrl(r.id),
        name: r.title,
        description: r.description,
        toolCount: r.toolCount,
        hasBuild: r.hasBuild,
        hasDraft: r.hasDraft,
        updatedAt: r.updatedAt,
      })),
    };
  },
};

const app_publish: BuiltinToolDef = {
  slug: 'app_publish',
  preconditions: APP_ID_PRE,
  name: 'Publish a mini app',
  description:
    'Publish the app draft: promote the draft source + its build to the live app. Refuses if the draft has no successful build (run app_build until ok first). Use after the user has reviewed the preview and approved.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: "The app's id (UUID) — from `app_list`." } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const app = await publishApp(ctx.ownerId, id);
      if (!app) return { ok: false, error: `app ${id} not found` };
      ctx.step?.setOutput({ id, published: true });
      return { ok: true, output: { id, url: nodeUrl(id), name: app.title, published: true } };
    } catch (err) {
      if (err instanceof NoGreenBuildError) return { ok: false, error: err.message };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_delete: BuiltinToolDef = {
  slug: 'app_delete',
  preconditions: APP_ID_PRE,
  name: 'Delete a mini app',
  description:
    'Permanently delete a mini app by id — its source, builds, and per-app database. Irreversible; confirm with the user first.',
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: "The app's id (UUID) — from `app_list`." } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await deleteApp(ctx.ownerId, id);
      if (!ok) return { ok: false, error: `app ${id} not found` };
      ctx.step?.setOutput({ id, deleted: true });
      return { ok: true, output: { id, deleted: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ── App-data read tools (for the responder — NOT the app-authoring set) ──────
// These let the brain READ mini-app data. Read-only by construction: the broker
// opens the SQLite file read-only, so no query can mutate. Kept OUT of APP_TOOLS
// (the authoring group Appsmith gets) so the responder can be granted reads
// without create/build/publish/delete.

const app_db_list: BuiltinToolDef = {
  slug: 'app_db_list',
  name: 'List app databases',
  description:
    "List the user's mini apps that have their OWN database, each with its tables (the CREATE statements reveal the columns). Use this FIRST to discover what app data exists, then `app_db_query` to read rows. Read-only.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    try {
      const apps = await listAppDatabaseSummaries(ctx.ownerId);
      const out = [];
      for (const a of apps) {
        const tables = await appDbSchema(ctx.ownerId, a.appNodeId);
        out.push({ app_id: a.appNodeId, title: a.title, size_bytes: a.sizeBytes, tables });
      }
      ctx.step?.setOutput({ count: out.length });
      return { ok: true, output: { apps: out } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const app_db_query: BuiltinToolDef = {
  slug: 'app_db_query',
  preconditions: APP_DB_ID_PRE,
  name: 'Query an app database',
  description:
    "Run a READ-ONLY SQL query against ONE mini app's SQLite database and get rows back. Pass `app_id` (from app_db_list) and a SELECT `sql`; use `?` placeholders with `params` for values. The database is opened read-only — any write is rejected. Discover tables/columns with app_db_list first. Keep answers tight: add LIMIT or aggregate in SQL (large results are truncated).",
  inputSchema: {
    type: 'object',
    properties: {
      app_id: {
        type: 'string',
        description: "The app's id (UUID) — from `app_db_list` / `app_list`.",
      },
      sql: {
        type: 'string',
        description: 'a read-only SELECT query; use ? placeholders for values',
      },
      params: { type: 'array', description: 'values bound to the ? placeholders, in order' },
    },
    required: ['app_id', 'sql'],
  },
  handler: async (input, ctx) => {
    const appId = str(input.app_id).trim();
    const sql = str(input.sql).trim();
    if (!appId) return { ok: false, error: 'app_id is required' };
    if (!sql) return { ok: false, error: 'sql is required' };
    const params = Array.isArray(input.params) ? (input.params as unknown[]) : [];
    try {
      const { rows, empty } = await appDbReadQuery(ctx.ownerId, appId, sql, params);
      ctx.step?.setOutput({ rows: rows.length, empty });
      if (empty) {
        return {
          ok: true,
          output: {
            rows: [],
            note: 'This app has no database yet (nothing stored, or no such app).',
          },
        };
      }
      return { ok: true, output: { rows, row_count: rows.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** Read-only app-data tools for the responder (see block comment above). */
export const APP_DATA_TOOLS: BuiltinToolDef[] = [app_db_list, app_db_query];
export const APP_DATA_TOOL_SLUGS: string[] = APP_DATA_TOOLS.map((t) => t.slug);

export const APP_TOOLS: BuiltinToolDef[] = [
  app_create,
  app_get,
  app_file_write,
  app_file_delete,
  app_source_set,
  app_build,
  app_tools_set,
  app_db_schema_set,
  app_list,
  app_publish,
  app_delete,
];

export const APP_TOOL_SLUGS: string[] = APP_TOOLS.map((t) => t.slug);
