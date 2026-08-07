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
import type { TocEntry } from '@mantle/content/page-toc';
import type {
  FormulaSpec,
  TargetSignature,
  CoverageGap,
  DimensionIssue,
  Column,
  Row,
} from '@mantle/content';

export type ShareFolderListing = {
  /** ltree path currently being listed (the shared root or a descendant). */
  currentPath: string;
  folders: Array<{ id: string; path: string; slug: string; fileCount: number }>;
  files: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
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
      }> | null;
      legacyDoc: { columns: Column[]; rows: Row[] } | null;
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
