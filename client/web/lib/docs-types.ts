/**
 * Wire DTOs for the docs reader — mirrors the server's lib/docs-reader.ts
 * types, delivered by GET /api/docs/reader (nav) and /api/docs/reader/doc
 * (one doc). The client renders; the disk lives on the server.
 */
export type ReaderCollection = {
  key: string;
  label: string;
  origin: string;
  enabled: boolean; // = "indexed" (drives the badge); reading works regardless
  files: string[]; // collection-relative .md paths, nested-root-subtracted, sorted
};

export type ReaderNav = ReaderCollection[];

export type ReaderDocLink = { collectionKey: string; relPath: string; label: string };

export type ReaderDoc = {
  collectionKey: string;
  collectionLabel: string;
  enabled: boolean;
  relPath: string;
  content: string;
  prev: ReaderDocLink | null;
  next: ReaderDocLink | null;
};
