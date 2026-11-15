/**
 * Add, read and remove an own pipeline (docs/pipelines.md, "Own
 * pipelines"): the one function of each route and its tool.
 *
 *  - installPipeline (POST /api/pipelines, `pipeline_install`): the whole
 *    package in one call. Checked in this order: the curated switch, the
 *    mount, the package (checkPackage), the id and extension rules
 *    (ownCheck), the version rule (a version names one package). Then web
 *    writes the folder `<id>/<version>/` (a temporary name, one rename),
 *    then the row in one upsert, then removes the folder of the old
 *    version. It starts no run.
 *  - pipelinePackage (GET /api/pipelines/:id/package, `pipeline_get`): the
 *    package of an own pipeline, to read or change.
 *  - removePipeline (DELETE /api/pipelines/:id, `pipeline_remove`): the row
 *    first (so nothing new runs it), then its folders. A remove again finds
 *    no row and removes the folder of a half-done remove.
 *
 * The rule for a version: a higher one replaces the package; the same one
 * with the same files writes the folder again and changes nothing else (how
 * a folder lost on a restore is fixed); the same one with other files, or a
 * lower one, is refused.
 *
 * No rights check here, by design (KISS, owner 2026-11-15: pipelines are
 * an Admin feature, and the Admin check is THE rule for add, change and
 * remove): the routes' policy and the tools' scope (area `settings`) are
 * the check. No confirm, no review, no scan of the code. Not a person-only
 * act: a rights act that spends nothing and starts no run.
 */
import { CURATED_ONLY, ownPipelinesAllowed } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import {
  BUILTIN_PIPELINES,
  PIPELINE_ID,
  PIPELINE_MANIFEST_FILE,
  checkPackage,
  packageHash,
  versionBelow,
  type PackageCheck,
} from '@mantle/files';
import {
  pipelinesMounted,
  removeOtherVersions,
  removePackageFolders,
  writePackageFolder,
  NO_MOUNT,
} from '@mantle/content/pipeline-folder';
import { boxPipelines, type BoxPipelines } from '@mantle/content/pipeline-registry';
import {
  ownPackageOf,
  pipelineStateOf,
  putOwnPackage,
  removeOwnRow,
} from '@mantle/content/pipeline-state';
import type { PipelineInstallAnswer, PipelinePackage } from '@mantle/client-types';
import { CS } from './client-sourced-rule';
import { rowOf } from './pipeline-row';
import { actingLoginId } from './surface';
import type { BuiltinToolDef } from './types';

/** The one line of an install (text, not a confirm). */
export const INSTALL_NOTE =
  'This runs code on files of this box. You install it as you would a library. It reads new uploads from now on; for the files that are there, use pipeline_run on their folder.';

/** The problem of an own row whose files are not on disk (the list). */
export const NOT_ON_DISK =
  'The files of this package are not on disk. Install it again with the same files.';

type Checked = Extract<PackageCheck, { ok: true }>;

/**
 * The checks an install and a draft test share: the curated switch, the
 * mount, the package, and the rules of the box (an own id is never a
 * built-in's; an own Reader reads an extension no other reader reads).
 */
export async function ownCheck(
  raw: unknown,
  box: BoxPipelines,
): Promise<{ ok: true; checked: Checked } | { ok: false; error: string }> {
  if (!ownPipelinesAllowed()) return { ok: false, error: CURATED_ONLY };
  if (!(await pipelinesMounted())) return { ok: false, error: NO_MOUNT };
  const checked = checkPackage(raw);
  if (!checked.ok) return checked;
  const { id } = checked.manifest;
  if (BUILTIN_PIPELINES.some((b) => b.id === id)) {
    return { ok: false, error: `The id ${id} is a built-in's. Give your pipeline another id.` };
  }
  for (const ext of checked.manifest.match.ext) {
    const reader = box.readerFor(ext);
    if (reader && reader.id !== id) {
      return {
        ok: false,
        error: `.${ext} is read by the pipeline ${reader.id}. An own pipeline reads an extension no other pipeline reads.`,
      };
    }
  }
  return { ok: true, checked };
}

/** The version of a stored package, or null when its manifest has none. */
function storedVersion(pkg: PipelinePackage): string | null {
  const text = pkg.files[PIPELINE_MANIFEST_FILE];
  if (typeof text !== 'string') return null;
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export type InstallAnswer =
  { ok: true; answer: PipelineInstallAnswer } | { ok: false; error: string };

/** The row of `id` as the list shows it, after a write. */
async function rowAfter(ownerId: string, id: string, note: string): Promise<InstallAnswer> {
  const box = await boxPipelines(ownerId);
  const p = box.byId(id);
  if (!p) return { ok: true, answer: { row: null, note } };
  return { ok: true, answer: { row: rowOf(p, await pipelineStateOf(ownerId, p), box), note } };
}

/** Write the folder of a version; a failed write (it leaves no half
 *  folder) is a refusal with its reason, and nothing else is written. */
async function writeFolder(
  id: string,
  version: string,
  bytes: ReadonlyMap<string, Buffer>,
): Promise<{ ok: false; error: string } | null> {
  try {
    await writePackageFolder(id, version, bytes);
    return null;
  } catch (err) {
    return {
      ok: false,
      error: `The package could not be written to the pipelines folder (${errorMessage(err).slice(0, 200)}). Nothing was installed.`,
    };
  }
}

/** Install an own pipeline: the whole package (`{ files }`). */
export async function installPipeline(
  ownerId: string,
  loginId: string | null,
  raw: unknown,
): Promise<InstallAnswer> {
  const box = await boxPipelines(ownerId);
  const own = await ownCheck(raw, box);
  if (!own.ok) return own;
  const { manifest, bytes, pkg, hash } = own.checked;
  const { id, version } = manifest;
  const stored = await ownPackageOf(ownerId, id);
  const was = stored ? storedVersion(stored) : null;
  if (stored && was === version) {
    if (packageHash(stored) !== hash) {
      return {
        ok: false,
        error: `Version ${version} is installed with other files. Send a higher version.`,
      };
    }
    // The same package: its folder again (a folder lost on a restore), and
    // nothing else.
    const wrote = await writeFolder(id, version, bytes);
    if (wrote) return wrote;
    await removeOtherVersions(id, version);
    return rowAfter(ownerId, id, `The files of version ${version} are on disk again.`);
  }
  if (stored && was !== null && !versionBelow(was, version)) {
    return { ok: false, error: `Version ${was} is installed. Send a higher version.` };
  }
  // The folder first, then the row: a row never names a version with no
  // folder, but on a failed write, which leaves nothing.
  const wrote = await writeFolder(id, version, bytes);
  if (wrote) return wrote;
  await putOwnPackage(ownerId, loginId, id, pkg);
  await removeOtherVersions(id, version);
  return rowAfter(ownerId, id, INSTALL_NOTE);
}

/** The refusal of a built-in where an own pipeline is asked for. */
function builtinRefusal(id: string): string {
  return `${id} is a built-in. Its code is in the Mantle repo at packages/files/src/pipelines/pkg/${id}/.`;
}

/** The package of the own pipeline `id`. */
export async function pipelinePackage(
  ownerId: string,
  id: string,
): Promise<
  | { ok: true; pkg: { id: string; version: string | null } & PipelinePackage }
  | { ok: false; error: string; missing?: true }
> {
  const stored = PIPELINE_ID.test(id) ? await ownPackageOf(ownerId, id) : null;
  if (stored) return { ok: true, pkg: { id, version: storedVersion(stored), files: stored.files } };
  if (BUILTIN_PIPELINES.some((b) => b.id === id)) return { ok: false, error: builtinRefusal(id) };
  return {
    ok: false,
    error: `There is no own pipeline "${id.slice(0, 40)}". Find the id with pipeline_list.`,
    missing: true,
  };
}

/** Remove the own pipeline `id`: its row, then its folders. */
export async function removePipeline(ownerId: string, id: string): Promise<InstallAnswer> {
  if (!PIPELINE_ID.test(id)) {
    return {
      ok: false,
      error: `There is no pipeline "${id.slice(0, 40)}". Find the id with pipeline_list.`,
    };
  }
  const stored = await ownPackageOf(ownerId, id);
  if (!stored && BUILTIN_PIPELINES.some((b) => b.id === id)) {
    return { ok: false, error: `${builtinRefusal(id)} Switch it off with pipeline_set.` };
  }
  await removeOwnRow(ownerId, id);
  await removePackageFolders(id);
  return {
    ok: true,
    answer: {
      row: null,
      note: stored
        ? `Removed ${id}. The databases it wrote stay; a new upload of its file types gets none.`
        : `There was no own pipeline ${id} to remove; its folder, if any, is gone.`,
    },
  };
}

const ID_SCHEMA = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
  description: "The own pipeline's id, e.g. 'lx9-logger'.",
} as const;

/** The `files` of a package, in a tool's schema. */
export const FILES_SCHEMA = {
  type: 'object',
  // The paths are the package's own: checkPackage checks each.
  additionalProperties: {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: { base64: { type: 'string' } },
        required: ['base64'],
        additionalProperties: false,
      },
    ],
  },
  description:
    'The package: path -> text, or {"base64": "..."} for a binary file. pipeline.json is its manifest, e.g. {"pipeline.json": "{...}", "step.ts": "export const step = ..."}.',
} as const;

export const pipeline_install: BuiltinToolDef = {
  slug: 'pipeline_install',
  // An Admin, or the Admin's agent: no tool group holds it.
  mcpOnly: true,
  policy: {
    matrix: { none: 'a pipeline is not an item' },
    effect: 'write',
    spends: 'none',
    // The route's area. systemWhole: it reads and writes pipeline_state and
    // the folder of packages only, and takes no item id.
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    idempotent: true, // the same files again write the same folder
    clientSourced: CS.always('installs code that reads files on this box'),
  },
  name: 'Install a pipeline',
  description:
    "Install an own pipeline: a package of files that reads a file type no other pipeline reads, and gives its file's database. `files` is the whole package; `pipeline.json` is its manifest (runtime `bun` or `python`, its `entry`, `match.ext`). A higher version replaces the one installed; the same version with the same files writes its folder again. It starts no run: new uploads use it; for files there, use `pipeline_run`. Test a draft first with `pipeline_test` and `files`. To read a package use `pipeline_get`; to remove one, `pipeline_remove`.",
  inputSchema: {
    type: 'object',
    properties: { files: FILES_SCHEMA },
    required: ['files'],
  },
  handler: async (input, ctx) => {
    const res = await installPipeline(ctx.ownerId, actingLoginId(ctx.surface), {
      files: input.files,
    });
    return res.ok ? { ok: true, output: res.answer } : { ok: false, error: res.error };
  },
};

export const pipeline_get: BuiltinToolDef = {
  slug: 'pipeline_get',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a pipeline is not an item' },
    effect: 'read',
    spends: 'none',
    // The route's area. systemWhole: it reads and writes pipeline_state and
    // the folder of packages only, and takes no item id.
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
  },
  name: 'Get a pipeline package',
  description:
    'Give the package of an own pipeline: its id, version and `files` (path -> text, or {"base64"} for a binary file), to read or change it and install it again with a higher version. A built-in is refused: its code is in the Mantle repo. For the pipelines and their ids use `pipeline_list`.',
  inputSchema: { type: 'object', properties: { id: ID_SCHEMA }, required: ['id'] },
  handler: async (input, ctx) => {
    const res = await pipelinePackage(ctx.ownerId, String(input.id ?? ''));
    return res.ok ? { ok: true, output: res.pkg } : { ok: false, error: res.error };
  },
};

export const pipeline_remove: BuiltinToolDef = {
  slug: 'pipeline_remove',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a pipeline is not an item' },
    // A delete with no item cell; not destructive: the databases stay, and
    // the package installs again from its source.
    riskClass: 'delete',
    effect: 'write',
    spends: 'none',
    // The route's area. systemWhole: it reads and writes pipeline_state and
    // the folder of packages only, and takes no item id.
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    idempotent: true,
    clientSourced: CS.always('removes a pipeline from this box'),
  },
  name: 'Remove a pipeline',
  description:
    'Remove an own pipeline: its package, options, off list and count go, and nothing new runs it. The databases it wrote stay, with their stamp. A built-in cannot be removed: switch it off with `pipeline_set`. For the ids use `pipeline_list`.',
  inputSchema: { type: 'object', properties: { id: ID_SCHEMA }, required: ['id'] },
  handler: async (input, ctx) => {
    const res = await removePipeline(ctx.ownerId, String(input.id ?? ''));
    return res.ok ? { ok: true, output: res.answer } : { ok: false, error: res.error };
  },
};

export const PIPELINE_INSTALL_TOOLS: readonly BuiltinToolDef[] = [
  pipeline_install,
  pipeline_get,
  pipeline_remove,
];
