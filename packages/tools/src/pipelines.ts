/**
 * The pipelines of a brain (docs/pipelines.md): the list GET /api/pipelines
 * answers and `pipeline_list` gives, from one function, and the stamp line
 * of the Data view.
 *
 * In phase 1 the rows are the built-ins (BUILTIN_PIPELINES). The counts
 * come from one look at the folder of file databases: the files with a
 * database, their rows read in the caller's scope, and each stamp. A file
 * counts when its database at its own bytes is there. Its pipeline is the
 * stamp's, or for a database built before stamps the built-in of its
 * extension. Numbers only: no file name, no id, and never a tab.
 *
 * Only an Admin with the settings area reaches it: the route's policy and
 * the tool's scope are that check, and nothing here asks again.
 */
import {
  BUILTIN_PIPELINES,
  PIPELINE_API,
  PIPELINE_STAMP_KEYS,
  builtinForExt,
  fileDataExt,
  fileDataRow,
  fileDataRows,
  fileDbSqlitePath,
  fileIdsWithDatabase,
  fileSha256Of,
  filesRootMounted,
  versionBelow,
  type PipelineManifest,
} from '@mantle/files';
import { readDocMeta } from '@mantle/tabledb';
import type { FileDatabaseReadBy, PipelineList, PipelineRow } from '@mantle/client-types';
import type { BuiltinToolDef } from './types';

/** The most files one list looks at; past it the counts are partial. */
export const PIPELINE_SCAN_MAX = 5000;

function rowOf(p: PipelineManifest): PipelineRow {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    source: 'builtin',
    start: p.start,
    reads: [...p.match.ext],
    weight: p.needs.weight,
    shapes: [...(p.produces.shapes ?? [])],
    workers: Object.keys(p.needs.workers ?? {}),
    tools: [...(p.needs.tools ?? [])],
    files: null,
    older: null,
  };
}

/** The stamp of a database on disk, or null before stamps. */
function stampAt(abs: string): { id: string; version: string } | null {
  const meta = readDocMeta(abs, PIPELINE_STAMP_KEYS);
  const id = meta?.pipeline_id;
  const version = meta?.pipeline_version;
  return id && version ? { id, version } : null;
}

/** The pipelines, with how many files each read and how many of those at
 *  an older version. No files mount in this process: no counts. */
export async function listPipelines(
  ownerId: string,
  opts: { max?: number } = {},
): Promise<PipelineList> {
  const pipelines = BUILTIN_PIPELINES.map(rowOf);
  if (!(await filesRootMounted())) {
    return { api: PIPELINE_API, pipelines, countsPartial: false };
  }
  const max = opts.max ?? PIPELINE_SCAN_MAX;
  const ids = (await fileIdsWithDatabase()).sort();
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  for (const p of pipelines) {
    p.files = 0;
    p.older = 0;
  }
  for (const row of await fileDataRows(ownerId, ids.slice(0, max), { full: false })) {
    const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
    if (!abs) continue; // a name of older bytes only
    const stamp = stampAt(abs);
    const p = byId.get(stamp?.id ?? builtinForExt(fileDataExt(row))?.id ?? '');
    if (!p) continue;
    p.files! += 1;
    if (!stamp || versionBelow(stamp.version, p.version)) p.older! += 1;
  }
  return { api: PIPELINE_API, pipelines, countsPartial: ids.length > max };
}

/** Which pipeline read a file's database, for the Data view: the file read
 *  in the caller's scope, then its stamp. Null with no database, or one
 *  built before stamps. */
export async function fileReadBy(
  ownerId: string,
  fileId: string,
): Promise<FileDatabaseReadBy | null> {
  const row = await fileDataRow(ownerId, fileId);
  const abs = row && (await fileDbSqlitePath(row.id, fileSha256Of(row)));
  const stamp = abs ? stampAt(abs) : null;
  return stamp ? { pipeline: stamp.id, version: stamp.version } : null;
}

export const pipeline_list: BuiltinToolDef = {
  slug: 'pipeline_list',
  // An Admin user's own client reads it; no agent is granted it (no tool
  // group holds it in phase 1).
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    // The route's area (GET /api/pipelines). In the caller's scope, not
    // systemWhole: the counts read the file rows.
    scope: { area: 'settings' },
    recipe: { step: 'forbidden' },
  },
  name: 'List pipelines',
  description:
    'List the pipelines that read files into their databases: id, name, version, the extensions each reads, weight, shapes, and how many files each read (`files`), with how many of those at an older version or before stamps (`older`). Numbers only, never a file. `countsPartial` says the count stopped at its cap. The same list as the Settings screen. Read-only. For the rows of one file use `file_sql`.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => ({ ok: true, output: await listPipelines(ctx.ownerId) }),
};

export const PIPELINE_TOOLS: readonly BuiltinToolDef[] = [pipeline_list];
