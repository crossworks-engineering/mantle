/**
 * Shared types for the seeder. The repo bans `any` (and demo/ cannot opt out:
 * eslint.config.mjs is main-owned), so the manifest shape and the slice of the
 * postgres client we use are both declared explicitly. That is a good trade:
 * the manifest contract is exactly what the generator promises, written down.
 */

export type Json = Record<string, unknown>;
export type Row = Record<string, unknown>;

/** The four sharing levels. Private items sit in the Private folder, team and
 *  client items in the shared folders, public items at the top level with an
 *  open link (generator/content/folders.mjs). */
export type Tier = 'private' | 'team' | 'client' | 'public';

/** Where an item sits: the GENERATOR id of its folder (null = top level), and
 *  whether it gets an open link after the folder shares. */
interface Placed {
  tier?: Tier;
  folder?: string | null;
  public?: boolean;
}

export interface GenNode {
  id: string;
  kind: string;
  title: string;
  /** Pages and notes carry `media:gen:`, `page:gen:` and `mention:node:gen:`
   *  references; the seeder swaps each for the real id before the write. */
  body: string;
  offset: number;
  tags: string[];
  tier?: Tier;
  public?: boolean;
  meta: {
    /** The GENERATOR id of the folder the item sits in; null or absent is the
     *  top level. Pages do not nest on main (folder phase 7). */
    folder?: string | null;
    status?: string;
    priority?: string;
    due_offset?: number;
    start_offset?: number;
    duration_min?: number;
    location?: string;
    mood?: string;
    category?: string;
    emails?: string[];
    company?: string | null;
    role?: string;
    value?: string;
    spec?: Record<string, unknown>;
  };
}

/** The item trees the seeder writes folders into (docs/folder-tree.md). */
export type TreeKind = 'files' | 'notes' | 'pages' | 'tables' | 'draw' | 'formulas' | 'apps' | 'tasks' | 'events' | 'contacts' | 'secrets';

/** A folder of one kind's item tree, as `POST /api/tree/:kind/folders` takes
 *  it. `share` is set after the items are filed. */
export interface GenFolder {
  id: string;
  kind: TreeKind;
  parent: string | null;
  name: string;
  /** An emoji or `lucide:<name>`. */
  icon?: string;
  /** One of the app's tints (APP_TINTS in @mantle/client-types). */
  color?: string;
  share?: 'team' | 'client';
  /** On a shared folder: what the share must reach, counted by the
   *  generator. The seeder confirms a share only for exactly that count. */
  expect?: { items: number; folders: number };
}

/** An option of a Recall card: where it leads, by CARD SLUG in the same map. */
export interface GenRecallOption {
  label: string;
  target: string;
  use_when: string;
}

/** A native Recall map (v2): a `recall` item plus card rows, created through
 *  the owner Recall API. The entry card always exists (slug `start`). */
export interface GenRecallMap {
  id: string;
  slug: string;
  title: string;
  enter_when: string;
  offset: number;
  entry: { body: string; options?: GenRecallOption[] };
  cards: Array<{
    slug: string;
    kind: 'knowledge' | 'prompt';
    title: string;
    body: string;
    /** Prompts: the line recall_match compares against. Required for one. */
    use_when?: string;
    options?: GenRecallOption[];
  }>;
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

export interface GenTable extends Placed {
  id: string;
  title: string;
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

export interface GenFile extends Placed {
  id: string;
  name: string;
  title: string;
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
export interface GenDraw extends Placed {
  id: string;
  title: string;
  icon?: string;
  tags?: string[];
  scene: { elements: unknown[]; appState?: Record<string, unknown> };
  offset: number;
}

/** A mini app: its source is demo/apps/<dir>/, pushed through create, draft,
 *  build and publish exactly as an owner's Studio does. */
export interface GenApp extends Placed {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  dir: string;
  entry: string;
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
  turns: Array<{ id: string; agent: string; offset: number; prompt: string }>;
  heartbeats?: GenHeartbeat[];
  draws?: GenDraw[];
  folders?: GenFolder[];
  recall_maps?: GenRecallMap[];
  apps?: GenApp[];
}

/** The slice of the `postgres` tagged-template client this seeder touches. */
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  array(values: unknown[]): unknown;
  json(value: unknown): unknown;
  end(): Promise<void>;
}
