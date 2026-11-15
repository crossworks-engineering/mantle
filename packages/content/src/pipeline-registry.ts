/**
 * The pipelines of a box: the ONE place that gives them (docs/pipelines.md,
 * "The registry"). Every consumer asks boxPipelines for the box it works
 * for and reads the list, the reader of an extension, the router of a file
 * type, the `after` pipelines, the ids a person acts on and the file types
 * that get a database from the answer. A consumer with no owner in hand
 * gets the answer (or the part of it it needs) from its caller, as a
 * parameter: it has no second way to the list.
 *
 * Today the list is the built-ins only (BUILTIN_PIPELINES, @mantle/files),
 * in their order. A built-in is taken as it is: builtin.test.ts runs the
 * one manifest check (checkManifest) on each, so a release holds it, and
 * nothing checks it again at run time. The installed pipelines of a box join it later (phase 3, P3-1): built-ins
 * first, then own pipelines by id; a built-in always wins an id or an
 * extension, and an own row that clashes or fails the check is in
 * `problems` with its sentence and runs nothing.
 *
 * No cache: the answer is built on every call, as the state of a pipeline
 * is read fresh on every call (live-derived over stored).
 *
 * The parser is not a consumer: its index is the image's
 * (server/parser/src/pipeline-index.ts).
 */
import {
  BUILTIN_PIPELINES,
  dbExtsOf,
  isAfterPipeline,
  isRouter,
  readerFor,
  routerFor,
  type PipelineManifest,
  type PipelineSource,
} from '@mantle/files';

/** One pipeline of a box, with where it comes from. */
export type BoxPipeline = PipelineManifest & { source: PipelineSource };

export type BoxPipelines = {
  /** Built-ins in their order, then own pipelines by id. */
  all: readonly BoxPipeline[];
  byId(id: string): BoxPipeline | null;
  /** The reader of a file of this extension whose router named `kind`
   *  (readerFor, @mantle/files); with no kind, the reader of the
   *  extension. Null: no reader takes the file. */
  readerFor(ext: string, kind?: string): BoxPipeline | null;
  /** The router of this file type, or null. */
  routerFor(ext: string): BoxPipeline | null;
  /** The `after` pipelines, in the order of `all`: the order the chain
   *  runs them in. Built-ins only in phase 3. */
  after: readonly BoxPipeline[];
  /** The pipelines a person acts on by id (set, run, re-read, test, the
   *  `pipeline-reread` task): all but the routers, which run nothing by
   *  themselves. */
  acted: readonly BoxPipeline[];
  /** The file types that get a database: the readers' extensions. */
  dbExts: ReadonlySet<string>;
  /** Pipelines of the box that do not run, by id, with a plain sentence.
   *  Always empty while the list is the built-ins only. */
  problems: ReadonlyMap<string, string>;
};

/** The pipelines of the box of this owner. */
export async function boxPipelines(_ownerId: string): Promise<BoxPipelines> {
  const all: BoxPipeline[] = BUILTIN_PIPELINES.map((p) => ({ ...p, source: 'builtin' }));
  const byId = new Map(all.map((p) => [p.id, p]));
  return {
    all,
    byId: (id) => byId.get(id) ?? null,
    readerFor: (ext, kind) => readerFor(all, ext, kind),
    routerFor: (ext) => routerFor(all, ext),
    after: all.filter(isAfterPipeline),
    acted: all.filter((p) => !isRouter(p)),
    dbExts: dbExtsOf(all),
    problems: new Map(),
  };
}
