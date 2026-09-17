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
    /** Recall map index nodes: the Options list, by GENERATOR page id; the
     *  seeder resolves targets to real ids after the tree exists. */
    recall_options?: Array<{ label: string; target: string; use_when: string }>;
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
  /** Select labels; the seeder mints the option ids the app would. */
  options?: string[];
  /** Formula columns reference other columns by NAME, e.g. "{Cost} * {Qty}". */
  formula?: string;
  /** Currency code / decimals, as the app's ColumnFormat. */
  format?: { currency?: string; decimals?: number };
}

/** A saved view, keyed by column name; the seeder resolves ids. */
export interface GenView {
  name: string;
  sort?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  filters?: Array<{ column: string; op: string; value?: string | number | boolean | null }>;
}

export interface GenTable {
  id: string;
  title: string;
  branch: string;
  icon?: string;
  columns: GenColumn[];
  /** Positional rows aligned to `columns`; formula columns carry null. */
  rows: Array<Array<string | number | boolean | null>>;
  /** Footer aggregates keyed by column NAME. */
  aggregates?: Record<string, string>;
  views?: GenView[];
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

/** A scheduled skill→agent trigger, as `POST /api/heartbeats` takes it; the
 *  seeder resolves `earliest_offset` (days) against seed time. */
export interface GenHeartbeat {
  id: string;
  slug: string;
  name: string;
  agent: string;
  skill: string;
  schedule:
    | { kind: 'interval'; every_minutes: number; jitter_minutes?: number }
    | { kind: 'once'; at: string }
    | { kind: 'manual' };
  surface: { kind: 'web' } | { kind: 'telegram'; chat_id: string };
  description?: string;
  quiet_hours?: { from: string; to: string; tz?: string | null } | null;
  cooldown_minutes?: number | null;
  min_idle_minutes?: number | null;
  earliest_offset?: number;
  offset: number;
}

/** An Excalidraw scene, as `POST /api/draws` takes it. */
export interface GenDraw {
  id: string;
  title: string;
  branch: string;
  icon?: string;
  tags?: string[];
  scene: { elements: unknown[]; appState?: Record<string, unknown> };
  offset: number;
}

export interface Manifest {
  seed: number;
  span: [number, number];
  nodes: GenNode[];
  tables: GenTable[];
  emails: GenEmail[];
  files: GenFile[];
  docs: Array<{ collection: string; relpath: string; title: string }>;
  turns: Array<{ id: string; agent: string; offset: number; prompt: string; wantsRun?: boolean; followUp?: boolean }>;
  heartbeats?: GenHeartbeat[];
  draws?: GenDraw[];
}

/** The slice of the `postgres` tagged-template client this seeder touches. */
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  array(values: unknown[]): unknown;
  json(value: unknown): unknown;
  end(): Promise<void>;
}
