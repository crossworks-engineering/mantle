/**
 * Shared types for the seeder. The repo bans `any` (and demo/ cannot opt out —
 * eslint.config.mjs is main-owned), so the manifest shape and the slice of the
 * postgres client we use are both declared explicitly. That is a good trade:
 * the manifest contract is exactly what the generator promises, written down.
 */

export type Json = Record<string, unknown>;
export type Row = Record<string, unknown>;

export interface GenNode {
  id: string;
  kind: string;
  title: string;
  body: string;
  offset: number;
  tags: string[];
  branch?: string;
  meta: {
    status?: string;
    priority?: string;
    due_offset?: number;
    start_offset?: number;
    duration_min?: number;
    location?: string;
    mood?: string;
    category?: string;
    parent_id?: string | null;
    family?: string;
    rev?: string;
    supersedes?: string | null;
    emails?: string[];
    company?: string | null;
    role?: string;
    value?: string;
    spec?: Record<string, unknown>;
    path?: string;
  };
}

export interface GenColumn {
  name: string;
  type: string;
  options?: string[];
  formula?: string;
}

export interface GenTable {
  id: string;
  title: string;
  branch: string;
  columns: GenColumn[];
  rows: Array<Array<string | number | null>>;
  aggregates?: Record<string, string>;
  offset: number;
}

export interface GenEmail {
  id: string;
  thread: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  offset: number;
  body: string;
}

export interface GenFile {
  id: string;
  name: string;
  title: string;
  branch: string;
  kind: string;
  offset: number;
  bytes: number;
  sha256: string;
  text: string[] | null;
}

export interface Manifest {
  seed: number;
  span: [number, number];
  nodes: GenNode[];
  tables: GenTable[];
  emails: GenEmail[];
  files: GenFile[];
  docs: Array<{ collection: string; relpath: string; title: string }>;
  turns: Array<{ id: string; agent: string; offset: number; prompt: string }>;
}

/** The slice of the `postgres` tagged-template client this seeder touches. */
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  array(values: unknown[]): unknown;
  json(value: unknown): unknown;
  end(): Promise<void>;
}
