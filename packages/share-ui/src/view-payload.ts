/**
 * The JSON payload of GET /s/<token>/view — the share content door for the
 * /team inline reader (no iframe). One shape per share kind, mirroring the
 * server's ShareView except where the server must pre-compute:
 *
 *  - `page` ships pre-rendered SANITIZED html + toc (renderPageDoc runs
 *    server-side only, so escaping stays on the server and katex/lowlight
 *    stay out of the client bundle);
 *  - `folder` ships the listing for the requested `?p=` sub-path (the
 *    listing is a DB read, re-validated against the shared root per request).
 *
 * Everything else is the presenter's own props, verbatim. Consumed by the
 * client ShareReader and produced by server/web/app/s/[token]/view.
 */
import type { TocEntry } from '@mantle/content-core/page-toc';
import type { CoverageGap, FormulaSpec } from '@mantle/content-core/formula-spec';
import type { TargetSignature } from '@mantle/content-core/formula-signature';
import type { DimensionIssue } from '@mantle/content-core/formula-dimensions';
import type { AggregateKind, Column, Row } from '@mantle/content-core/table-model';

export type ShareFolderListing = {
  /** ltree path currently being listed (the shared root or a descendant). */
  currentPath: string;
  folders: Array<{ id: string; path: string; slug: string; fileCount: number }>;
  files: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    /** ISO instant of the last write, so an embedded listing can carry a
     *  Modified column. Optional because a client pinned to an older server
     *  still gets a payload without it. */
    updatedAt?: string;
  }>;
};

export type ShareViewPayload =
  | {
      kind: 'page';
      title: string;
      icon: string | null;
      width: 'narrow' | 'wide';
      /** Sanitized HTML from renderPageDoc — safe to inject as-is. */
      html: string;
      toc: TocEntry[];
    }
  | { kind: 'note'; title: string; content: string }
  | {
      kind: 'task';
      title: string;
      body: string;
      status: string;
      priority: string;
      dueAt: string | null;
      /** Read-only checklist snapshot (absent on pre-upgrade payloads). */
      todos?: { text: string; done: boolean }[];
    }
  | {
      kind: 'event';
      title: string;
      body: string;
      startsAt: string | null;
      endsAt: string | null;
      location: string | null;
    }
  | { kind: 'file'; fileId: string; filename: string; mimeType: string; size: number }
  | { kind: 'app'; appId: string; title: string }
  | {
      kind: 'table';
      tableId: string;
      title: string;
      icon: string | null;
      tabs: Array<{
        id: string;
        name: string;
        rowCount: number;
        columns: Array<{ id: string; name: string; type: string }>;
        /**
         * The owner's footer totals for this tab: colId → kind, and the VALUE
         * computed server-side over the whole tab.
         *
         * The value has to come from the server and this is the whole reason
         * the field exists. A reader holds one 200-row window at a time, so a
         * sum taken over what it happens to have loaded is not a smaller
         * number — it is a WRONG one, and wrong quietly, which is worse than
         * absent. `aggregateWindow` runs it in SQL over every row.
         *
         * Optional: an older server sends neither, and the footer simply does
         * not render.
         */
        aggregates?: Record<string, AggregateKind>;
        aggregateValues?: Record<string, number | null>;
      }> | null;
      legacyDoc: {
        columns: Column[];
        rows: Row[];
        /** Legacy tables arrive WHOLE, so the reader can compute these itself
         *  with `computeAggregate` and no endpoint is involved. Settings only. */
        aggregates?: Record<string, AggregateKind>;
      } | null;
    }
  | {
      kind: 'formula';
      title: string;
      spec: FormulaSpec;
      signature: TargetSignature[];
      coverageGaps: CoverageGap[];
      dimensionIssues: DimensionIssue[];
    }
  | { kind: 'folder'; title: string; path: string; listing: ShareFolderListing }
  // Only WHETHER a committed snapshot exists. The bytes are fetched as an
  // image from /s/<token>/draw, so they never ride in this payload and never
  // become markup on the page.
  | { kind: 'draw'; title: string; hasSvg: boolean };
