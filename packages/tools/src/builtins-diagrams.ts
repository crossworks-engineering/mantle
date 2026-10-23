/**
 * `diagram_types` + `diagram_guide`: the diagram design system as two reads
 * (docs/diagrams.md, 2026-10-23).
 *
 * The per-type drawing guides used to be the opt-in `diagram-guides` docs
 * collection, reached through search_chunks + read_section. A brain that never
 * enabled it (most of them) left the Draftsman searching four times for guides
 * that were not indexed, then drawing a P&ID from the short skill rules alone.
 * These tools read the guide files baked into the image (MANTLE_DOCS_ROOT,
 * /app/docs in prod) directly: no collection, no index, no model call, no
 * database.
 *
 * `docs/diagram-guides/` holds the guides vendored verbatim from the
 * MIT-licensed diagram-design project; `docs/diagram-guides/mantle/` holds
 * Mantle's own types and the medium rules, out of reach of an upstream
 * refresh. Every type in DIAGRAM_TYPES must have its file, and every type file
 * a row (builtins-diagrams.test.ts).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { docsRoot, listFiles, readFileById } from '@mantle/files';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { str } from './coerce';

export const DIAGRAM_GUIDES_DIR = 'diagram-guides';

/** Where a brain keeps its site profiles: one markdown file per type,
 *  `files/diagrams/profiles/<type>.md` (ltree below). A profile holds one
 *  site's conventions (symbol variants, service colours, line-number format,
 *  circuit naming, title-block fields). It is the owner's data, so it lives in
 *  the brain and never in the repo, and it wins over the base type guide. */
export const PROFILE_FOLDER_PATH = 'files.diagrams.profiles';
export const PROFILE_FOLDER_DISPLAY = 'files/diagrams/profiles';

/** A profile past this many characters is cut, and the reply says so. */
export const PROFILE_MAX_CHARS = 20_000;

export type DiagramType = Readonly<{
  slug: string;
  name: string;
  /** One line: what the reader must see for this type to be the right one. */
  useWhen: string;
  /** Relative to docs/diagram-guides/. */
  file: string;
  origin: 'upstream' | 'mantle';
  /** Other names a caller may use (`p&id`, `bar chart`). */
  aliases?: readonly string[];
}>;

const up = (slug: string, name: string, useWhen: string, aliases?: string[]): DiagramType => ({
  slug,
  name,
  useWhen,
  file: `type-${slug}.md`,
  origin: 'upstream',
  ...(aliases ? { aliases } : {}),
});

/** Every type, upstream's visual-type guide (SKILL.md section 3) in its order,
 *  then Mantle's own. */
export const DIAGRAM_TYPES: readonly DiagramType[] = [
  up(
    'architecture',
    'Architecture',
    'Components and connections in one snapshot; nested admin vs traffic scopes.',
  ),
  up(
    'architecture-delta',
    'Architecture delta',
    'Structural change between a Before and an After topology, with a changes ledger.',
  ),
  up(
    'it-state',
    'IT current-state',
    'A legacy IT landscape by phase or department: the "before" picture.',
  ),
  up('flowchart', 'Flowchart', 'Decision logic with branches.'),
  up('sequence', 'Sequence', 'Time-ordered messages between actors.'),
  up('state', 'State machine', 'States, transitions and guards.', ['state-machine']),
  up('er', 'ER / data model', 'Entities, fields and relationships.', ['data-model', 'erd']),
  up('timeline', 'Timeline', 'Events positioned in time.'),
  up('swimlane', 'Swimlane', 'A cross-functional process with handoffs.'),
  up('quadrant', 'Quadrant', 'Two-axis positioning or prioritisation.', ['2x2']),
  up('radar', 'Radar / spider', 'Several entities scored across 3 to 5 quantitative criteria.', [
    'spider',
  ]),
  up(
    'polar',
    'Polar chart',
    'One quantitative series across cyclic categories: angle is the category, radius the magnitude.',
  ),
  up(
    'loop',
    'Loop / flywheel',
    'A reinforcing cycle: the last step feeds the first and a hub accumulates state.',
    ['flywheel'],
  ),
  up('nested', 'Nested', 'Hierarchy through containment or scope.'),
  up('tree', 'Tree', 'Parent to children relationships.'),
  up(
    'org-chart',
    'Org chart',
    'Ownership, reporting, routing and escalation between people, agents or teams.',
  ),
  up('layers', 'Layer stack', 'Stacked abstraction levels.', ['layer-stack']),
  up(
    'exploded',
    'Exploded axonometric',
    'Parts of one object pulled apart along one axis: a teardown, assembly order.',
  ),
  up(
    'axonometric-plan',
    'Axonometric plan',
    'One floor or site seen from above at an angle: rooms, buildings by phase.',
  ),
  up('venn', 'Venn', 'Overlap between sets.'),
  up('pyramid', 'Pyramid / funnel', 'A ranked hierarchy or a conversion drop-off.', ['funnel']),
  up('bar', 'Bar chart', 'Quantitative comparison across categories; dumbbell variant.', [
    'bar-chart',
    'dumbbell',
  ]),
  up('waterfall', 'Waterfall', 'A start total bridged to an end total by signed contributions.', [
    'bridge',
  ]),
  up(
    'treemap',
    'Treemap',
    'Part of a whole where the relative sizes are the story; marimekko variant.',
    ['marimekko'],
  ),
  up('heatmap', 'Heatmap', 'Cross-tabulated data where fill encodes the value per cell.'),
  up(
    'line',
    'Line chart',
    'Trends over time; slopegraph, ridgeline, streamgraph and bump variants.',
    ['line-chart', 'slopegraph', 'ridgeline', 'streamgraph', 'bump'],
  ),
  up('gantt', 'Gantt', 'Tasks and phases on a timeline.'),
  up(
    'scatter',
    'Scatter plot',
    'Correlation or distribution of two variables; bubble and beeswarm variants.',
    ['bubble', 'beeswarm'],
  ),
  up('high-level', 'High-level', 'An end-to-end data stack on a container cluster.'),
  up('process', 'Process', 'A multi-actor sequential process with data handoffs.'),
  up('medallion', 'Medallion', 'Multi-tier data storage with quality levels and access policies.'),
  up('data-flow', 'Data flow', 'Role-scoped data flow: who does what at each pipeline step.'),
  up(
    'dp-integration',
    'DP integration',
    'Integration topology of a data platform: sources, core, consumers.',
  ),
  up(
    'dp-security-matrix',
    'DP security matrix',
    'Per-role or per-component access permissions as a matrix.',
  ),
  up(
    'sankey',
    'Sankey',
    'A quantity splitting and merging across stages; band width is the amount.',
  ),
  up(
    'fishbone',
    'Fishbone',
    'Causes of one observed effect, grouped by category (root-cause analysis).',
    ['ishikawa'],
  ),
  up(
    'wardley',
    'Wardley map',
    'A value chain against evolution: what to build, buy, and what is moving.',
  ),
  up('kanban', 'Kanban', 'Work in progress by state, with WIP limits and blocked items.'),
  up(
    'journey',
    'User journey',
    'What a person does across the stages of an experience, and how it feels.',
    ['user-journey'],
  ),
  up(
    'service-blueprint',
    'Service blueprint',
    'What the customer does vs what the service hides, across stages, with a line of visibility.',
  ),
  up('deployment', 'Deployment', 'Where software runs: zones, hosts, artifacts, replicas, ports.'),
  up(
    'dependency',
    'Dependency graph',
    'What depends on what, with fan-in and cycles a tree cannot express.',
  ),
  up('uml-class', 'UML class', 'Classes with operations, inheritance and composition.'),
  up('story-map', 'Story map', 'A narrative backbone sliced into releases, with the cut line.'),
  up(
    'db-schema',
    'Database schema',
    'Physical tables: SQL types, constraints, indexes, column-level foreign keys.',
  ),
  {
    slug: 'pid',
    name: 'P&ID / process schematic',
    useWhen:
      'Process equipment, piping, valves, instruments and control loops (ISA-5.1 bubbles and tags). First draft.',
    file: 'mantle/type-pid.md',
    origin: 'mantle',
    aliases: [
      'p&id',
      'p-id',
      'pnid',
      'piping-and-instrumentation',
      'process-schematic',
      'process-flow-schematic',
    ],
  },
];

/** The semantic patterns (semantic-patterns.md): pick one first when behaviour,
 *  state, enforcement or risk carries the meaning. `heading` starts the
 *  pattern's `## ` heading in that file. */
export const DIAGRAM_PATTERNS: readonly Readonly<{
  slug: string;
  heading: string;
  trigger: string;
  nearestType: string;
}>[] = [
  {
    slug: 'fan-in-queue',
    heading: '1. Fan-in queue',
    trigger: 'Fan-in, queue depth, finite capacity, a bottleneck.',
    nearestType: 'data-flow',
  },
  {
    slug: 'stage-framework',
    heading: '2. Stage framework',
    trigger: 'Repeated question / input / governance / output slots across stages.',
    nearestType: 'process',
  },
  {
    slug: 'unstructured-to-artifact',
    heading: '3. Unstructured input',
    trigger: 'A conversation or loose input becomes a structured durable artifact.',
    nearestType: 'data-flow',
  },
  {
    slug: 'policy-traces',
    heading: '4. Paired policy-evaluation traces',
    trigger: 'Two rule traces with pass, fail, skipped, not-reached and the first divergence.',
    nearestType: 'flowchart',
  },
  {
    slug: 'secure-paved-road',
    heading: '5. Secure paved road',
    trigger: 'Trust boundaries plus permitted and forbidden ingress or deploy paths.',
    nearestType: 'architecture',
  },
  {
    slug: 'control-catalog',
    heading: '6. Governance / control catalog',
    trigger: 'Controls grouped by where they are enforced.',
    nearestType: 'layers',
  },
  {
    slug: 'compensating-layers',
    heading: '7. Compensating security layers',
    trigger: 'Defences compensate for prior gaps and residual risk propagates.',
    nearestType: 'layers',
  },
  {
    slug: 'block-decomposition',
    heading: '8. Traceable block decomposition',
    trigger:
      'Hierarchical ID-addressable decomposition with per-block I/O, constraints and a code link.',
    nearestType: 'tree',
  },
  {
    slug: 'lifecycle-phase-map',
    heading: '9. Lifecycle phase map',
    trigger:
      'One subject progresses through phases, waits, retries, cancellation and terminal outcomes.',
    nearestType: 'state',
  },
];

/** Redraw guides by source notation. */
export const DIAGRAM_IMPORTS: Readonly<Record<string, string>> = {
  mermaid: 'import-mermaid.md',
  drawio: 'import-drawio.md',
  excalidraw: 'import-excalidraw.md',
};

/** One part of a `diagram_guide` reply: a file, minus the headings that only
 *  make sense for upstream's HTML-in-a-repo medium. `intro: false` drops the
 *  text before the first `## ` (an H1 and routing prose that points at
 *  SKILL.md sections the reader does not have). */
type GuidePart = Readonly<{ file: string; label: string; drop?: readonly string[]; intro?: false }>;

/** The shared rules every type needs, in reading order. */
export const SHARED_PARTS: readonly GuidePart[] = [
  { file: 'mantle/medium.md', label: 'Mantle medium rules' },
  {
    file: 'style-guide.md',
    label: 'Style guide',
    intro: false,
    drop: [
      'Inversion rule',
      'Terminal skin',
      'Font source',
      'Korean labels',
      'Traditional Chinese labels',
      'Cyrillic labels',
      'Customizing the skin',
    ],
  },
  {
    file: 'layout-budget.md',
    label: 'Layout and budget',
    intro: false,
    drop: ['Page layout', 'Summary Card Pattern'],
  },
  { file: 'primitives-core.md', label: 'Core SVG primitives', intro: false },
  {
    file: 'output-spec.md',
    label: 'Output sizes, detail and wording',
    intro: false,
    drop: [
      '1. Format',
      'Holding the canvas on a narrow screen',
      'Registered legacy sizes',
      'Non-Latin labels',
      '5. Fidelity ledger',
      '6. Checklist',
    ],
  },
];

/** Headings dropped from every type guide: `## Examples` lists upstream's
 *  HTML asset files only. */
const TYPE_DROP = ['Examples'];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

/** Drop the sections whose heading starts with one of `drop` (case and
 *  punctuation ignored), each up to the next heading of the same or a higher
 *  level. Fenced code never counts as a heading. Pure; exported for tests. */
export function dropSections(md: string, drop: readonly string[], keepIntro = true): string {
  const wanted = drop.map(norm);
  const out: string[] = [];
  let inFence = false;
  let dropLevel = 0;
  let seenH2 = keepIntro;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && !/^\s*(```|~~~)/.test(line) ? /^(#{1,6}) (.+)$/.exec(line) : null;
    if (h) {
      const level = h[1]!.length;
      if (level >= 2) seenH2 = true;
      if (dropLevel && level <= dropLevel) dropLevel = 0;
      if (!dropLevel && wanted.some((w) => norm(h[2]!).startsWith(w))) dropLevel = level;
    }
    if (!dropLevel && seenH2) out.push(line);
  }
  return out.join('\n').trim();
}

/** The one `## ` section whose heading starts with `heading`, up to the next
 *  `## `. Pure; exported for tests. */
export function onlySection(md: string, heading: string): string {
  const others = dropSections(md, [], false)
    .split('\n')
    .filter((l) => /^## /.test(l) && !norm(l.slice(3)).startsWith(norm(heading)))
    .map((l) => l.slice(3));
  return dropSections(md, others, false);
}

/** Where the guides may be: the docs root first (prod: /app/docs), then the
 *  repo's docs/ seen from a dev process's cwd (server/web, server/api) or a
 *  package's tests. */
function candidateDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(docsRoot(), DIAGRAM_GUIDES_DIR),
    path.resolve(cwd, 'docs', DIAGRAM_GUIDES_DIR),
    path.resolve(cwd, '..', 'docs', DIAGRAM_GUIDES_DIR),
    path.resolve(cwd, '..', '..', 'docs', DIAGRAM_GUIDES_DIR),
  ];
}

async function readGuideFile(rel: string): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      return await readFile(path.join(dir, rel), 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
}

const slugKey = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/\.md$/, '')
    .replace(/^type-/, '')
    .replace(/[^a-z0-9&]+/g, '-')
    .replace(/^-|-$/g, '');

/** The type a caller named: slug, alias, display name or file stem, case and
 *  punctuation ignored. Pure; exported for tests. */
export function resolveDiagramType(name: string): DiagramType | null {
  const k = slugKey(name);
  if (!k) return null;
  return (
    DIAGRAM_TYPES.find(
      (t) =>
        t.slug === k ||
        slugKey(t.name) === k ||
        (t.aliases ?? []).some((a) => slugKey(a) === k) ||
        slugKey(t.name.split(' / ')[0]!) === k,
    ) ?? null
  );
}

function unknownTypeError(given: string): string {
  return `No diagram type '${given}'. Valid types: ${DIAGRAM_TYPES.map((t) => t.slug).join(', ')}. Call \`diagram_types\` for what each one is for.`;
}

function missingFile(rel: string): ToolHandlerResult {
  return {
    ok: false,
    error: `The diagram guide file ${DIAGRAM_GUIDES_DIR}/${rel} is not on this server. Check MANTLE_DOCS_ROOT; meanwhile draw from the diagram_design skill rules alone.`,
  };
}

type SiteProfile = { file: string; found: boolean; text?: string; truncated?: boolean };

/** This brain's site profile for a type, if it keeps one. Reads in the
 *  caller's scope like `file_list` / `file_read`: a file the caller cannot
 *  read is not there for it. */
async function readSiteProfile(ownerId: string, typeSlug: string): Promise<SiteProfile> {
  const filename = `${typeSlug}.md`;
  const file = `${PROFILE_FOLDER_DISPLAY}/${filename}`;
  const rows = await listFiles({ ownerId, parentPath: PROFILE_FOLDER_PATH });
  const row = rows.find((r) => r.filename.toLowerCase() === filename);
  if (!row) return { file, found: false };
  const res = await readFileById({ ownerId, fileId: row.id });
  if (!res) return { file, found: false };
  const text = res.bytes.toString('utf8').trim();
  if (text.length <= PROFILE_MAX_CHARS) return { file, found: true, text };
  return { file, found: true, text: text.slice(0, PROFILE_MAX_CHARS), truncated: true };
}

function profileNote(p: SiteProfile): string {
  if (!p.found) {
    return `None: this brain has no ${p.file}, so the base guide applies as written. To record a site convention, write it to that file with file_create (parent_path '${PROFILE_FOLDER_PATH}', overwrite true, keeping what is already there) when the owner asks.`;
  }
  return p.truncated
    ? `Found ${p.file}; only its first ${PROFILE_MAX_CHARS} characters are included. Ask the owner to shorten it.`
    : `Found ${p.file}; it is appended last and wins over the base type guide.`;
}

export async function diagramTypesHandler(): Promise<ToolHandlerResult> {
  return {
    ok: true,
    output: {
      types: DIAGRAM_TYPES.map((t) => ({
        type: t.slug,
        name: t.name,
        use_when: t.useWhen,
        origin: t.origin,
      })),
      patterns: DIAGRAM_PATTERNS.map((p) => ({
        pattern: p.slug,
        use_when: p.trigger,
        nearest_type: p.nearestType,
      })),
      imports: Object.keys(DIAGRAM_IMPORTS),
      next: 'Pick ONE type (and, when behaviour carries the meaning, one pattern first), then call diagram_guide with it.',
    },
  };
}

export async function diagramGuideHandler(
  input: Record<string, unknown>,
  ownerId: string,
): Promise<ToolHandlerResult> {
  const typeArg = str(input.type).trim();
  const type = resolveDiagramType(typeArg);
  if (!type) return { ok: false, error: unknownTypeError(typeArg) };

  const patternArg = str(input.pattern).trim();
  const pattern = patternArg
    ? DIAGRAM_PATTERNS.find(
        (p) => p.slug === slugKey(patternArg) || norm(p.heading).includes(norm(patternArg)),
      )
    : undefined;
  if (patternArg && !pattern) {
    return {
      ok: false,
      error: `No semantic pattern '${patternArg}'. Valid patterns: ${DIAGRAM_PATTERNS.map((p) => p.slug).join(', ')}; or omit pattern.`,
    };
  }
  const importArg = str(input.import).trim().toLowerCase();
  if (importArg && !DIAGRAM_IMPORTS[importArg]) {
    return {
      ok: false,
      error: `No import guide for '${importArg}'. Valid: ${Object.keys(DIAGRAM_IMPORTS).join(', ')}; or omit import.`,
    };
  }
  const shared = input.shared !== false;

  const parts: string[] = [];
  const add = async (rel: string, label: string, body: (md: string) => string) => {
    const md = await readGuideFile(rel);
    if (md === null) return false;
    parts.push(`<!-- ${label} (${rel}) -->\n${body(md)}`);
    return true;
  };

  if (shared) {
    for (const p of SHARED_PARTS) {
      if (
        !(await add(p.file, p.label, (md) => dropSections(md, p.drop ?? [], p.intro !== false)))
      ) {
        return missingFile(p.file);
      }
    }
  }
  if (pattern) {
    const ok = await add('semantic-patterns.md', `Semantic pattern: ${pattern.slug}`, (md) => {
      const keep = DIAGRAM_PATTERNS.filter((p) => p !== pattern).map((p) => p.heading);
      return dropSections(md, ['Routing table', ...keep], false);
    });
    if (!ok) return missingFile('semantic-patterns.md');
  }
  if (importArg) {
    const rel = DIAGRAM_IMPORTS[importArg]!;
    if (!(await add(rel, `Import from ${importArg}`, (md) => md.trim()))) return missingFile(rel);
    const ok = await add('output-spec.md', 'Fidelity ledger', (md) =>
      onlySection(md, '5. Fidelity ledger'),
    );
    if (!ok) return missingFile('output-spec.md');
  }
  if (!(await add(type.file, `Type guide: ${type.name}`, (md) => dropSections(md, TYPE_DROP)))) {
    return missingFile(type.file);
  }
  const profile = await readSiteProfile(ownerId, type.slug);
  if (profile.found) {
    parts.push(
      `<!-- Site profile (${profile.file}): this brain's own conventions for this type. Where it differs from the guide above, follow the profile. -->\n${profile.text}`,
    );
  }

  return {
    ok: true,
    output: {
      type: type.slug,
      name: type.name,
      ...(pattern ? { pattern: pattern.slug } : {}),
      ...(importArg ? { import: importArg } : {}),
      shared_rules: shared,
      site_profile: profileNote(profile),
      guide: parts.join('\n\n---\n\n'),
    },
  };
}

const diagram_types: BuiltinToolDef = {
  slug: 'diagram_types',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  name: 'List diagram types',
  description:
    'List every diagram and chart type the design system can draw, each with one line on when to use it, plus the semantic patterns (behaviour-first routing) and the import notations. Call it first when drawing, pick ONE type, then call `diagram_guide` for that type. Reads static guide files; changes nothing.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => diagramTypesHandler(),
};

const diagram_guide: BuiltinToolDef = {
  slug: 'diagram_guide',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  name: 'Read a diagram type guide',
  description:
    "Return the drawing instructions for one diagram type: the Mantle medium rules (static SVG, system fonts), the shared style guide, layout budget, core SVG primitives and output sizes, then the type's own guide, then this brain's site profile for the type when it keeps one (`files/diagrams/profiles/<type>.md`, which wins over the base guide). Call it after `diagram_types` and before drawing. Draw several types in one task? Pass `shared: false` after the first call to skip the shared rules you already hold. Reads only; changes nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: "The diagram type from `diagram_types`, e.g. 'architecture', 'bar', 'pid'.",
      },
      pattern: {
        type: 'string',
        description:
          "A semantic pattern from `diagram_types` when behaviour carries the meaning, e.g. 'fan-in-queue'. Adds that pattern's rules.",
      },
      import: {
        type: 'string',
        enum: ['mermaid', 'drawio', 'excalidraw'],
        description:
          'Redrawing a diagram from another notation: adds its import guide and the fidelity ledger.',
      },
      shared: {
        type: 'boolean',
        default: true,
        description:
          'Include the shared rules. False when an earlier call in this task already returned them.',
      },
    },
    required: ['type'],
  },
  handler: (input, ctx) => diagramGuideHandler(input, ctx.ownerId),
};

export const DIAGRAM_TOOLS: BuiltinToolDef[] = [diagram_types, diagram_guide];
export const DIAGRAM_TOOL_SLUGS: readonly string[] = DIAGRAM_TOOLS.map((t) => t.slug);
