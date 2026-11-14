/**
 * The stamp of a file database, read and compared in one place. Pure.
 *
 *  - stampOfMeta: the `_meta` keys of a database (PIPELINE_STAMP_KEYS) as a
 *    stamp, or null when the four keys of phase 1 are not all there.
 *  - readerIsCurrent: the reader's stamp names this pipeline, at its
 *    version or a higher one, read with these options.
 *  - afterIsCurrent: the `pipelines_after` key holds this `after`
 *    pipeline, at its version or a higher one, with these options.
 *  - afterEntryOf and withAfterEntry: the one form of an entry of
 *    `pipelines_after`, and its one write.
 *
 * An entry of `pipelines_after` is `id@version`, with `#hash` when the
 * options are not all the defaults. Entries are joined by ','.
 */
import type { PipelineManifest, PipelineStamp } from './contract';
import { PIPELINE_STAMP_KEYS, versionBelow } from './builtin';

/** The stamp of these `_meta` values, or null before stamps. */
export function stampOfMeta(meta: Readonly<Record<string, string>> | null): PipelineStamp | null {
  if (!meta) return null;
  const [id, version, api, shapes, options, after] = PIPELINE_STAMP_KEYS.map((k) => meta[k]);
  if (id === undefined || version === undefined || api === undefined || shapes === undefined) {
    return null;
  }
  return {
    pipeline_id: id,
    pipeline_version: version,
    pipeline_api: api,
    shapes,
    ...(options ? { pipeline_options: options } : {}),
    ...(after ? { pipelines_after: after } : {}),
  };
}

/** Whether a reader's database is current: not missing, of this reader,
 *  not of a lower version, and read with the options of `optionsHash`. */
export function readerIsCurrent(
  stamp: PipelineStamp | null,
  manifest: Pick<PipelineManifest, 'id' | 'version'>,
  optionsHash: string,
): boolean {
  return (
    stamp !== null &&
    stamp.pipeline_id === manifest.id &&
    !versionBelow(stamp.pipeline_version, manifest.version) &&
    (stamp.pipeline_options ?? '') === optionsHash
  );
}

/** The entry of an `after` pipeline in `pipelines_after`. */
export function afterEntryOf(
  manifest: Pick<PipelineManifest, 'id' | 'version'>,
  optionsHash: string,
): string {
  return `${manifest.id}@${manifest.version}${optionsHash ? `#${optionsHash}` : ''}`;
}

/** The entries of `pipelines_after`, each as id, version and hash. */
function entriesOf(value: string | undefined): { id: string; version: string; hash: string }[] {
  if (!value) return [];
  return value
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('@');
      const rest = at < 0 ? '' : entry.slice(at + 1);
      const hashAt = rest.indexOf('#');
      return {
        id: at < 0 ? entry : entry.slice(0, at),
        version: hashAt < 0 ? rest : rest.slice(0, hashAt),
        hash: hashAt < 0 ? '' : rest.slice(hashAt + 1),
      };
    });
}

/** Whether an `after` pipeline's tabs are current on this database: its
 *  entry is there, not of a lower version, with the options of
 *  `optionsHash`. A database with no entry is not current. A database
 *  built before stamps may have the key: give its `pipelines_after`. */
export function afterIsCurrent(
  stamp: Pick<PipelineStamp, 'pipelines_after'> | null,
  manifest: Pick<PipelineManifest, 'id' | 'version'>,
  optionsHash: string,
): boolean {
  const entry = entriesOf(stamp?.pipelines_after).find((e) => e.id === manifest.id);
  return (
    entry !== undefined &&
    !versionBelow(entry.version, manifest.version) &&
    entry.hash === optionsHash
  );
}

/** The new `pipelines_after` value: the entries of other pipelines stay, in
 *  their place; this pipeline's own is replaced, or added at the end. */
export function withAfterEntry(
  value: string | undefined,
  manifest: Pick<PipelineManifest, 'id' | 'version'>,
  optionsHash: string,
): string {
  const own = afterEntryOf(manifest, optionsHash);
  const entries = (value ?? '').split(',').filter(Boolean);
  const at = entries.findIndex((e) => e === manifest.id || e.startsWith(`${manifest.id}@`));
  if (at < 0) return [...entries, own].join(',');
  return entries
    .filter((e, i) => i === at || !(e === manifest.id || e.startsWith(`${manifest.id}@`)))
    .map((e, i) => (i === at ? own : e))
    .join(',');
}
