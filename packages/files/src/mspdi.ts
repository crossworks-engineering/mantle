/**
 * Microsoft Project MSPDI (`.xml`) → typed grids.
 *
 * MSPDI is the XML shape Project writes from File → Save As → XML. It is the
 * only Project format with a published schema; `.mpp` is an undocumented binary
 * with no JavaScript reader (see EXPORT_REQUIRED_EXTS in ./slug.ts).
 *
 * Emits `ParsedSheet[]` — the same TableDoc-free shape `sheet-to-grid.ts`
 * produces for spreadsheets — so everything downstream (`tableDocFromGrid`, the
 * auto-table pass, `table_from_file`, dedupe by `sourceFileId`) works untouched.
 * Three sheets: Tasks, Resources, Assignments.
 *
 * Streaming, and that is not a size optimisation. A real 1094-task plan runs to
 * 25 MB of which **half is `<TimephasedData>`** — per-period work curves this
 * importer discards entirely. A DOM parse would materialise all of it.
 *
 * Parser is `saxes` rather than `sax`: same streaming model, but it ships its
 * own TypeScript types, where `sax` needs a separate `@types/sax`. Pinned to 6.x
 * — `exceljs` already pulls saxes 5.0.1 transitively, and sharing that copy
 * would tie this parser's version to whatever a spreadsheet library happens to
 * need. 164 KB, no native build, no runtime dependencies of its own.
 *
 * Separate entry point (`@mantle/files/mspdi`) so the parser only loads when a
 * Project export actually arrives. The `ParsedSheet` import is type-only on
 * purpose — pulling the value would drag SheetJS in with it.
 */
import { SaxesParser } from 'saxes';
import type { InferredColumnType, ParsedColumn, ParsedSheet } from './sheet-to-grid';

/** MSPDI's namespace. Present on every genuine Project export. */
const MSPDI_NS = 'schemas.microsoft.com/project';

type Rec = Record<string, string>;
type Cell = string | number | boolean | null;

type TaskRec = {
  f: Rec;
  /** <ExtendedAttribute> — the org's own custom fields. */
  ext: Rec[];
  /** <EnterpriseExtendedAttribute> — Project Server's formula-derived fields.
   *  A genuinely separate element with a different shape, not a variant. */
  ent: Rec[];
  preds: Rec[];
  baselines: Rec[];
};

type ResourceRec = { f: Rec; ext: Rec[] };
type AssignmentRec = { f: Rec };

type Parsed = {
  header: Rec;
  /** FieldID → definition, from the project-level <ExtendedAttributes> block. */
  defs: Map<string, Rec>;
  tasks: TaskRec[];
  resources: ResourceRec[];
  assignments: AssignmentRec[];
};

/* ------------------------------------------------------------------ values */

/** Strip any namespace prefix. MSPDI uses a default namespace so tags arrive
 *  bare, but a prefixed re-serialisation is still valid XML. */
function local(tag: string): string {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

/**
 * ISO-8601 duration → hours.
 *
 * Project emits `PT{H}H{M}M{S}S`, and **the seconds carry a fraction on
 * roll-up rows** (`PT17517H11M37.17S` is real output). An integer-only pattern
 * silently drops those to null, which is worse than failing — a summary task's
 * work would read as blank rather than wrong.
 */
export function durationToHours(v: string | undefined): number | null {
  if (!v) return null;
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      v.trim(),
    );
  if (!m) return null;
  const [, d, h, min, s] = m;
  const hours =
    (d ? Number(d) * 24 : 0) +
    (h ? Number(h) : 0) +
    (min ? Number(min) / 60 : 0) +
    (s ? Number(s) / 3600 : 0);
  if (!Number.isFinite(hours)) return null;
  return Math.round(hours * 100) / 100;
}

/** MSPDI timestamps are local wall-clock with no zone (`2025-11-10T08:00:00`).
 *  Kept verbatim — stamping a UTC `Z` would invent a timezone the plan doesn't
 *  have and shift every date by the viewer's offset. `NA` marks an absent
 *  baseline and is not a date. */
function toDateTime(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t)) return null;
  return t;
}

/**
 * Slack and link lag are **not** ISO durations — Project writes them as a bare
 * integer count of *tenths of a minute*. `1878912` is 391 working days of
 * float, not a large dimensionless number, and feeding it to
 * {@link durationToHours} yields null on every row.
 */
function tenthsToDays(v: string | undefined, minutesPerDay: number): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.round((n / 10 / minutesPerDay) * 100) / 100;
}

function toNumber(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | undefined): boolean {
  return v === '1';
}

const TASK_TYPE: Record<string, string> = {
  '0': 'Fixed Units',
  '1': 'Fixed Duration',
  '2': 'Fixed Work',
};
const RESOURCE_TYPE: Record<string, string> = { '0': 'Material', '1': 'Work', '2': 'Cost' };
const CONSTRAINT_TYPE: Record<string, string> = {
  '0': 'As Soon As Possible',
  '1': 'As Late As Possible',
  '2': 'Must Start On',
  '3': 'Must Finish On',
  '4': 'Start No Earlier Than',
  '5': 'Start No Later Than',
  '6': 'Finish No Earlier Than',
  '7': 'Finish No Later Than',
};
/** Dependency kinds, in MSPDI's numbering (not the order a human would guess). */
const LINK_TYPE: Record<string, string> = { '0': 'FF', '1': 'FS', '2': 'SF', '3': 'SS' };

/* --------------------------------------------------------------- detection */

/**
 * Does this look like a Project export?
 *
 * `.xml` is a container, like `.zip` — most XML is not a plan, and a false
 * positive would push an unrelated document through a task-grid mapper. So two
 * signals are required: a root element named `Project`, **and** either the MSPDI
 * namespace or a `<Tasks>` element. A bare `<Project>` root is not unique to
 * Microsoft.
 *
 * Cheap and total: reads the head of the file only, and never throws.
 */
export function sniffMspdi(head: Buffer | string): boolean {
  try {
    const s = text(head);
    if (!ROOT_RE.test(s)) return false;
    return s.includes(MSPDI_NS) || TASKS_RE.test(s);
  } catch {
    return false;
  }
}

/**
 * Is the root element `Project`? A **decisive negative** — cheap to answer from
 * the first few hundred bytes, and a document whose root is not `Project` cannot
 * be MSPDI no matter what follows.
 *
 * Exists so a caller can rule a file out before paying to read it. The full
 * {@link sniffMspdi} cannot be used that way: its second signal is the MSPDI
 * namespace OR a `<Tasks>` element, and while the namespace sits on the root,
 * `<Tasks>` does not — in a real 25 MB export it appeared at byte 114,966.
 * Sniffing a head would therefore answer *false* for a namespace-less plan with
 * a long header, and the file would be skipped rather than parsed. A negative
 * here is safe to act on; a positive means "read the file and ask properly".
 */
export function mspdiRootPresent(head: Buffer | string): boolean {
  try {
    return ROOT_RE.test(text(head));
  } catch {
    return false;
  }
}

const ROOT_RE = /<([A-Za-z_][\w.-]*:)?Project(\s|>|\/)/;
const TASKS_RE = /<([A-Za-z_][\w.-]*:)?Tasks(\s|>)/;

/** Bounded decode — never walks past the head, whatever the caller passes. */
function text(head: Buffer | string): string {
  return (typeof head === 'string' ? head : head.subarray(0, 8192).toString('utf8')).slice(0, 8192);
}

/* ------------------------------------------------------------------ stream */

/**
 * Columns are an explicit allowlist rather than a map over every child element,
 * and that is deliberate. Project writes ~28 undocumented internal fields on
 * every single row (`b408001`, `c408002`, `f40800d`, …) at 100% fill. Mapping
 * children generically would hand the user two dozen columns of opaque integers
 * next to the ones they came for.
 */

/** Walk the document once, collecting only what the grids need. */
function streamParse(xml: string): Parsed {
  const out: Parsed = { header: {}, defs: new Map(), tasks: [], resources: [], assignments: [] };

  const parser = new SaxesParser({ fragment: false });
  const path: string[] = [];
  let text = '';

  // Sub-record accumulators. Non-null exactly while inside their element.
  let task: TaskRec | null = null;
  let resource: ResourceRec | null = null;
  let assignment: AssignmentRec | null = null;
  let sub: Rec | null = null;
  let def: Rec | null = null;

  /** Depth at which a skipped subtree started; -1 when not skipping. Guards
   *  TimephasedData, which is ~half the bytes in a real plan. */
  let skipFrom = -1;

  const at = (...names: string[]) => names.every((n, i) => path[i] === n);

  parser.on('opentag', (node) => {
    const name = local(node.name);
    path.push(name);
    text = '';

    if (skipFrom !== -1) return;
    if (name === 'TimephasedData') {
      skipFrom = path.length;
      return;
    }

    if (at('Project', 'Tasks', 'Task') && path.length === 3) {
      task = { f: {}, ext: [], ent: [], preds: [], baselines: [] };
    } else if (at('Project', 'Resources', 'Resource') && path.length === 3) {
      resource = { f: {}, ext: [] };
    } else if (at('Project', 'Assignments', 'Assignment') && path.length === 3) {
      assignment = { f: {} };
    } else if (at('Project', 'ExtendedAttributes', 'ExtendedAttribute') && path.length === 3) {
      def = {};
    } else if (path.length === 4 && (task || resource)) {
      if (
        name === 'ExtendedAttribute' ||
        name === 'EnterpriseExtendedAttribute' ||
        name === 'PredecessorLink' ||
        name === 'Baseline'
      ) {
        sub = {};
      }
    }
  });

  parser.on('text', (t) => {
    if (skipFrom === -1) text += t;
  });

  parser.on('closetag', (node) => {
    const name = local(node.name);
    const depth = path.length;

    if (skipFrom !== -1) {
      if (depth === skipFrom) skipFrom = -1;
      path.pop();
      text = '';
      return;
    }

    const value = text.trim();
    text = '';

    // Leaf inside a sub-record (ExtendedAttribute/PredecessorLink/Baseline).
    if (sub && depth === 5) {
      sub[name] = value;
    } else if (def && depth === 4) {
      def[name] = value;
    } else if (depth === 4 && !sub) {
      // Leaf directly on a Task/Resource/Assignment.
      if (task) task.f[name] = value;
      else if (resource) resource.f[name] = value;
      else if (assignment) assignment.f[name] = value;
    } else if (depth === 2 && at('Project')) {
      out.header[name] = value;
    }

    // Closing containers.
    if (depth === 4 && sub) {
      if (task) {
        if (name === 'ExtendedAttribute') task.ext.push(sub);
        else if (name === 'EnterpriseExtendedAttribute') task.ent.push(sub);
        else if (name === 'PredecessorLink') task.preds.push(sub);
        else if (name === 'Baseline') task.baselines.push(sub);
      } else if (resource && name === 'ExtendedAttribute') {
        resource.ext.push(sub);
      }
      sub = null;
    } else if (depth === 3) {
      if (task) {
        out.tasks.push(task);
        task = null;
      } else if (resource) {
        out.resources.push(resource);
        resource = null;
      } else if (assignment) {
        out.assignments.push(assignment);
        assignment = null;
      } else if (def) {
        const id = def.FieldID;
        if (id) out.defs.set(id, def);
        def = null;
      }
    }

    path.pop();
  });

  parser.on('error', (e) => {
    throw e;
  });

  parser.write(xml).close();
  return out;
}

/* ------------------------------------------------------------------- grids */

type ColSpec = {
  name: string;
  type: InferredColumnType;
  get: (r: TaskRec | ResourceRec | AssignmentRec, ctx: Ctx) => Cell;
};

type Ctx = {
  header: Rec;
  /** Minutes in a working day, from the plan's own calendar — the only honest
   *  basis for hours→days. Defaults to Project's own default of 480. */
  minutesPerDay: number;
  taskName: Map<string, string>;
  resourceName: Map<string, string>;
};

/** Custom-field columns to emit, resolved from the definitions block.
 *
 * Only fields **actually present on a row** get a column. A real plan defined 35
 * extended attributes and used 3: mapping every definition would have produced
 * 32 permanently-empty columns, all of them Project Server boilerplate the org
 * never touched (Health, ROI, Portfolio, Skills…).
 *
 * Name from `Alias` when the org named it, else `FieldName`. A bare `Text1`
 * with no alias is Project's own placeholder and carries no meaning, so it is
 * dropped rather than shown. */
function customFieldColumns(
  defs: Map<string, Rec>,
  rows: { ext: Rec[]; ent?: Rec[] }[],
  key: 'ext' | 'ent',
): { fieldId: string; name: string }[] {
  const used = new Map<string, number>();
  for (const r of rows) {
    for (const e of (key === 'ext' ? r.ext : (r.ent ?? [])) as Rec[]) {
      if (!e.FieldID || !e.Value) continue;
      used.set(e.FieldID, (used.get(e.FieldID) ?? 0) + 1);
    }
  }
  const out: { fieldId: string; name: string }[] = [];
  for (const [fieldId] of used) {
    const d = defs.get(fieldId);
    const name = d?.Alias?.trim() || d?.FieldName?.trim();
    // No definition, or an unaliased Project placeholder → no meaningful header.
    if (!name || /^(Text|Number|Flag|Date|Duration|Cost|Start|Finish|Outline Code)\d+$/.test(name))
      continue;
    out.push({ fieldId, name });
  }
  return out;
}

function valueOf(list: Rec[], fieldId: string): string | null {
  for (const e of list) if (e.FieldID === fieldId) return e.Value?.trim() || null;
  return null;
}

function buildTasks(p: Parsed, ctx: Ctx): ParsedSheet {
  const ext = customFieldColumns(p.defs, p.tasks, 'ext');
  const ent = customFieldColumns(p.defs, p.tasks, 'ent');

  const base = (t: TaskRec) => t.baselines.find((b) => b.Number === '0');

  const cols: ColSpec[] = [
    { name: 'UID', type: 'number', get: (r) => toNumber((r as TaskRec).f.UID) },
    { name: 'ID', type: 'number', get: (r) => toNumber((r as TaskRec).f.ID) },
    { name: 'WBS', type: 'text', get: (r) => (r as TaskRec).f.WBS || null },
    { name: 'Outline Level', type: 'number', get: (r) => toNumber((r as TaskRec).f.OutlineLevel) },
    { name: 'Name', type: 'text', get: (r) => (r as TaskRec).f.Name || null },
    // Summary is the double-count guard: these rows already contain their
    // children's work, duration and cost. Without the flag as a column a
    // "total work" query silently doubles.
    { name: 'Summary', type: 'checkbox', get: (r) => toBool((r as TaskRec).f.Summary) },
    { name: 'Milestone', type: 'checkbox', get: (r) => toBool((r as TaskRec).f.Milestone) },
    { name: 'Critical', type: 'checkbox', get: (r) => toBool((r as TaskRec).f.Critical) },
    { name: 'Active', type: 'checkbox', get: (r) => toBool((r as TaskRec).f.Active) },
    { name: 'Start', type: 'datetime', get: (r) => toDateTime((r as TaskRec).f.Start) },
    { name: 'Finish', type: 'datetime', get: (r) => toDateTime((r as TaskRec).f.Finish) },
    {
      name: 'Duration (days)',
      type: 'number',
      get: (r, c) => {
        const h = durationToHours((r as TaskRec).f.Duration);
        return h === null ? null : Math.round((h / (c.minutesPerDay / 60)) * 100) / 100;
      },
    },
    {
      name: 'Duration (hours)',
      type: 'number',
      get: (r) => durationToHours((r as TaskRec).f.Duration),
    },
    { name: 'Work (hours)', type: 'number', get: (r) => durationToHours((r as TaskRec).f.Work) },
    {
      name: 'Actual Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as TaskRec).f.ActualWork),
    },
    {
      name: 'Remaining Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as TaskRec).f.RemainingWork),
    },
    { name: '% Complete', type: 'number', get: (r) => toNumber((r as TaskRec).f.PercentComplete) },
    {
      name: '% Work Complete',
      type: 'number',
      get: (r) => toNumber((r as TaskRec).f.PercentWorkComplete),
    },
    { name: 'Cost', type: 'number', get: (r) => toNumber((r as TaskRec).f.Cost) },
    { name: 'Actual Cost', type: 'number', get: (r) => toNumber((r as TaskRec).f.ActualCost) },
    {
      name: 'Remaining Cost',
      type: 'number',
      get: (r) => toNumber((r as TaskRec).f.RemainingCost),
    },
    { name: 'Fixed Cost', type: 'number', get: (r) => toNumber((r as TaskRec).f.FixedCost) },
    // Days, not hours: float is discussed in days, and "zero float" is the
    // question these columns exist to answer.
    {
      name: 'Total Slack (days)',
      type: 'number',
      get: (r, c) => tenthsToDays((r as TaskRec).f.TotalSlack, c.minutesPerDay),
    },
    {
      name: 'Free Slack (days)',
      type: 'number',
      get: (r, c) => tenthsToDays((r as TaskRec).f.FreeSlack, c.minutesPerDay),
    },
    {
      name: 'Actual Start',
      type: 'datetime',
      get: (r) => toDateTime((r as TaskRec).f.ActualStart),
    },
    {
      name: 'Actual Finish',
      type: 'datetime',
      get: (r) => toDateTime((r as TaskRec).f.ActualFinish),
    },
    {
      name: 'Constraint',
      type: 'text',
      get: (r) => CONSTRAINT_TYPE[(r as TaskRec).f.ConstraintType ?? ''] ?? null,
    },
    {
      name: 'Constraint Date',
      type: 'datetime',
      get: (r) => toDateTime((r as TaskRec).f.ConstraintDate),
    },
    { name: 'Task Type', type: 'text', get: (r) => TASK_TYPE[(r as TaskRec).f.Type ?? ''] ?? null },
    { name: 'Baseline Start', type: 'datetime', get: (r) => toDateTime(base(r as TaskRec)?.Start) },
    {
      name: 'Baseline Finish',
      type: 'datetime',
      get: (r) => toDateTime(base(r as TaskRec)?.Finish),
    },
    {
      name: 'Baseline Work (hours)',
      type: 'number',
      get: (r) => durationToHours(base(r as TaskRec)?.Work),
    },
    { name: 'Baseline Cost', type: 'number', get: (r) => toNumber(base(r as TaskRec)?.Cost) },
    // Both forms of the dependency list. The UIDs are exact and machine-usable;
    // the names are what a person — or a model answering from the grid — can
    // actually read. Neither substitutes for the other.
    {
      name: 'Predecessor UIDs',
      type: 'text',
      get: (r) =>
        (r as TaskRec).preds
          .map((p2) => p2.PredecessorUID)
          .filter(Boolean)
          .join(', ') || null,
    },
    {
      name: 'Predecessors',
      type: 'text',
      get: (r, c) =>
        (r as TaskRec).preds
          .map((p2) => {
            const nm = c.taskName.get(p2.PredecessorUID ?? '') ?? `UID ${p2.PredecessorUID}`;
            const kind = LINK_TYPE[p2.Type ?? '1'] ?? 'FS';
            // Same tenths-of-a-minute unit as slack: 72000 is 15 working days.
            const lagDays = tenthsToDays(p2.LinkLag, c.minutesPerDay) ?? 0;
            const lag = lagDays ? `${lagDays > 0 ? '+' : ''}${lagDays}d` : '';
            return `${nm} (${kind}${lag})`;
          })
          .join('; ') || null,
    },
  ];

  const columns: ParsedColumn[] = [
    ...cols.map((c) => ({ name: c.name, type: c.type })),
    ...ext.map((e) => ({ name: e.name, type: 'text' as InferredColumnType })),
    ...ent.map((e) => ({ name: e.name, type: 'text' as InferredColumnType })),
  ];

  // Row order IS the plan's outline order — never sorted. `IsNull=1` marks a
  // deleted placeholder Project keeps in the file.
  const rows = p.tasks
    .filter((t) => t.f.IsNull !== '1')
    .map((t) => [
      ...cols.map((c) => c.get(t, ctx)),
      ...ext.map((e) => valueOf(t.ext, e.fieldId)),
      ...ent.map((e) => valueOf(t.ent, e.fieldId)),
    ]);

  return { name: 'Tasks', columns, rows };
}

function buildResources(p: Parsed, ctx: Ctx): ParsedSheet {
  const ext = customFieldColumns(p.defs, p.resources, 'ext');

  const cols: ColSpec[] = [
    { name: 'UID', type: 'number', get: (r) => toNumber((r as ResourceRec).f.UID) },
    { name: 'ID', type: 'number', get: (r) => toNumber((r as ResourceRec).f.ID) },
    { name: 'Name', type: 'text', get: (r) => (r as ResourceRec).f.Name || null },
    { name: 'Initials', type: 'text', get: (r) => (r as ResourceRec).f.Initials || null },
    {
      name: 'Type',
      type: 'text',
      get: (r) => RESOURCE_TYPE[(r as ResourceRec).f.Type ?? ''] ?? null,
    },
    { name: 'Group', type: 'text', get: (r) => (r as ResourceRec).f.Group || null },
    { name: 'Code', type: 'text', get: (r) => (r as ResourceRec).f.Code || null },
    { name: 'Cost Center', type: 'text', get: (r) => (r as ResourceRec).f.CostCenter || null },
    { name: 'Max Units', type: 'number', get: (r) => toNumber((r as ResourceRec).f.MaxUnits) },
    {
      name: 'Standard Rate',
      type: 'number',
      get: (r) => toNumber((r as ResourceRec).f.StandardRate),
    },
    {
      name: 'Overtime Rate',
      type: 'number',
      get: (r) => toNumber((r as ResourceRec).f.OvertimeRate),
    },
    { name: 'Cost Per Use', type: 'number', get: (r) => toNumber((r as ResourceRec).f.CostPerUse) },
    {
      name: 'Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as ResourceRec).f.Work),
    },
    {
      name: 'Actual Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as ResourceRec).f.ActualWork),
    },
    {
      name: 'Remaining Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as ResourceRec).f.RemainingWork),
    },
    { name: 'Cost', type: 'number', get: (r) => toNumber((r as ResourceRec).f.Cost) },
    { name: 'Actual Cost', type: 'number', get: (r) => toNumber((r as ResourceRec).f.ActualCost) },
    {
      name: '% Work Complete',
      type: 'number',
      get: (r) => toNumber((r as ResourceRec).f.PercentWorkComplete),
    },
    {
      name: 'Overallocated',
      type: 'checkbox',
      get: (r) => toBool((r as ResourceRec).f.OverAllocated),
    },
    { name: 'Generic', type: 'checkbox', get: (r) => toBool((r as ResourceRec).f.IsGeneric) },
    { name: 'Inactive', type: 'checkbox', get: (r) => toBool((r as ResourceRec).f.IsInactive) },
  ];

  const columns: ParsedColumn[] = [
    ...cols.map((c) => ({ name: c.name, type: c.type })),
    ...ext.map((e) => ({ name: e.name, type: 'text' as InferredColumnType })),
  ];

  // Resource UID 0 is Project's own unnamed placeholder, present in every
  // export and never a real resource. Dropped only when it is genuinely blank,
  // so a plan that does use UID 0 keeps it.
  const rows = p.resources
    .filter((r) => r.f.IsNull !== '1' && !(r.f.UID === '0' && !r.f.Name))
    .map((r) => [...cols.map((c) => c.get(r, ctx)), ...ext.map((e) => valueOf(r.ext, e.fieldId))]);

  return { name: 'Resources', columns, rows };
}

/** Project's sentinel for "no resource assigned". There is no `<Resource>` row
 *  with this UID, so an unguarded UID→name lookup yields a blank cell and the
 *  reader cannot tell unassigned work from a lookup bug. */
const UNASSIGNED_UID = '-65535';

function buildAssignments(p: Parsed, ctx: Ctx): ParsedSheet {
  const cols: ColSpec[] = [
    { name: 'UID', type: 'number', get: (r) => toNumber((r as AssignmentRec).f.UID) },
    { name: 'Task UID', type: 'number', get: (r) => toNumber((r as AssignmentRec).f.TaskUID) },
    {
      name: 'Task',
      type: 'text',
      get: (r, c) => c.taskName.get((r as AssignmentRec).f.TaskUID ?? '') ?? null,
    },
    {
      name: 'Resource UID',
      type: 'number',
      get: (r) => toNumber((r as AssignmentRec).f.ResourceUID),
    },
    {
      name: 'Resource',
      type: 'text',
      get: (r, c) => {
        const uid = (r as AssignmentRec).f.ResourceUID ?? '';
        if (uid === UNASSIGNED_UID) return '(unassigned)';
        return c.resourceName.get(uid) ?? null;
      },
    },
    { name: 'Units', type: 'number', get: (r) => toNumber((r as AssignmentRec).f.Units) },
    {
      name: 'Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as AssignmentRec).f.Work),
    },
    {
      name: 'Actual Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as AssignmentRec).f.ActualWork),
    },
    {
      name: 'Remaining Work (hours)',
      type: 'number',
      get: (r) => durationToHours((r as AssignmentRec).f.RemainingWork),
    },
    { name: 'Cost', type: 'number', get: (r) => toNumber((r as AssignmentRec).f.Cost) },
    {
      name: 'Actual Cost',
      type: 'number',
      get: (r) => toNumber((r as AssignmentRec).f.ActualCost),
    },
    {
      name: '% Work Complete',
      type: 'number',
      get: (r) => toNumber((r as AssignmentRec).f.PercentWorkComplete),
    },
    { name: 'Start', type: 'datetime', get: (r) => toDateTime((r as AssignmentRec).f.Start) },
    { name: 'Finish', type: 'datetime', get: (r) => toDateTime((r as AssignmentRec).f.Finish) },
  ];

  return {
    name: 'Assignments',
    columns: cols.map((c) => ({ name: c.name, type: c.type })),
    rows: p.assignments.map((a) => cols.map((c) => c.get(a, ctx))),
  };
}

/* -------------------------------------------------------------------- api */

export type MspdiResult = {
  sheets: ParsedSheet[];
  /** Plan-level facts worth surfacing in the table description. */
  meta: {
    title: string | null;
    minutesPerDay: number;
    taskCount: number;
    summaryCount: number;
    resourceCount: number;
    assignmentCount: number;
  };
};

/**
 * Parse an MSPDI export into Tasks / Resources / Assignments grids.
 *
 * Never throws: a file that sniffs as MSPDI but is truncated or malformed
 * returns `null`, and the caller falls through to the generic text path. Worst
 * case the upload is a searchable document; it is never silently nothing.
 */
export function parseMspdi(bytes: Buffer | string): MspdiResult | null {
  try {
    const xml = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
    const p = streamParse(xml);
    if (p.tasks.length === 0 && p.resources.length === 0) return null;

    const minutesPerDay = toNumber(p.header.MinutesPerDay) || 480;
    const ctx: Ctx = {
      header: p.header,
      minutesPerDay,
      taskName: new Map(p.tasks.map((t) => [t.f.UID ?? '', t.f.Name ?? ''])),
      resourceName: new Map(p.resources.map((r) => [r.f.UID ?? '', r.f.Name ?? ''])),
    };

    const sheets = [buildTasks(p, ctx), buildResources(p, ctx), buildAssignments(p, ctx)].filter(
      (s) => s.rows.length > 0,
    );
    if (sheets.length === 0) return null;

    return {
      sheets,
      meta: {
        title: p.header.Title || p.header.Name || null,
        minutesPerDay,
        taskCount: p.tasks.length,
        summaryCount: p.tasks.filter((t) => t.f.Summary === '1').length,
        resourceCount: p.resources.length,
        assignmentCount: p.assignments.length,
      },
    };
  } catch {
    return null;
  }
}

/** Grids only — the `ParsedSheet[]` contract the auto-table pass consumes. */
export function parseMspdiToGrids(bytes: Buffer | string): ParsedSheet[] {
  return parseMspdi(bytes)?.sheets ?? [];
}

/**
 * A readable rendering of the plan for the brain's text index.
 *
 * Without this a plan is reachable only by grid query: `search_chunks` would
 * never see a task name or a milestone, so "when does commissioning start"
 * finds nothing even though the data is right there.
 */
export function renderMspdiText(bytes: Buffer | string): string {
  const r = parseMspdi(bytes);
  if (!r) return '';
  const tasks = r.sheets.find((s) => s.name === 'Tasks');
  if (!tasks) return '';

  const idx = (n: string) => tasks.columns.findIndex((c) => c.name === n);
  const [wbs, name, start, finish, ms] = [
    idx('WBS'),
    idx('Name'),
    idx('Start'),
    idx('Finish'),
    idx('Milestone'),
  ];

  const lines = [
    r.meta.title ? `Project plan: ${r.meta.title}` : 'Project plan',
    `${r.meta.taskCount} tasks, ${r.meta.resourceCount} resources, ${r.meta.assignmentCount} assignments.`,
  ];
  // Stated in prose because the machine-readable guard (the Summary column) only
  // helps a reader who already knows to look for it. Summary rows carry the
  // totals of everything beneath them, so adding up every row counts the same
  // work once per outline level — on a five-level plan that overstates by ~5x,
  // and it looks entirely plausible.
  if (r.meta.summaryCount > 0) {
    lines.push(
      `${r.meta.summaryCount} of these are summary (roll-up) rows whose work, duration and cost` +
        ` already include their child tasks. Totals must exclude rows where Summary is true,` +
        ` or the same work is counted once per outline level.`,
    );
  }
  lines.push('');
  for (const row of tasks.rows) {
    const d = (i: number) => (i >= 0 && row[i] != null ? String(row[i]).slice(0, 10) : '');
    const parts = [row[wbs], row[name]].filter(Boolean).join(' ');
    const when = [d(start), d(finish)].filter(Boolean).join(' → ');
    lines.push(`${parts}${when ? ` · ${when}` : ''}${row[ms] === true ? ' · milestone' : ''}`);
  }
  return lines.join('\n');
}
