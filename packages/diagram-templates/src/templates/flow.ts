/**
 * The `flow` template: boxes and arrows. Process flows, flowcharts,
 * architecture and data-flow drawings. The agent writes nodes, edges and
 * groups; this lays them out in ranks (left to right or top to bottom), routes
 * every edge with right angles, and draws it in the house style.
 */
import { layered, type Side } from '../runtime/layered.ts';
import {
  checkKeys,
  done,
  idOf,
  isObj,
  list,
  newIssues,
  objects,
  oneOf,
  ref,
  str,
  bool,
  type Checked,
  type Obj,
} from '../runtime/validate.ts';
import { el, orthoPath, arrowHead, endDir, textEl, simplify, type Pt } from '../runtime/svg.ts';
import { lineHeight, measure, wrap, type Measurer } from '../runtime/text.ts';
import {
  EDGE_TONES,
  NODE_KINDS,
  PALETTE,
  ROLES,
  SPACE,
  gridUp,
  type EdgeTone,
  type NodeKind,
} from '../runtime/style.ts';
import {
  budgetWarnings,
  hopsFor,
  overlaps,
  qa,
  union,
  type Box,
  type QaItem,
} from '../runtime/geom.ts';
import { legendStrip, boxSwatch, lineSwatch, type LegendEntry } from '../runtime/legend.ts';
import { slugify, svgDocument } from '../runtime/export.ts';
import type { RenderResult } from '../types.ts';

export const FLOW_VERSION = 1;

const SHAPES = ['box', 'pill', 'diamond', 'cylinder'] as const;
type Shape = (typeof SHAPES)[number];
const KINDS = Object.keys(NODE_KINDS) as NodeKind[];

export type FlowNode = {
  id: string;
  label: string;
  sublabel?: string;
  tag?: string;
  kind: NodeKind;
  shape: Shape;
  group?: string;
};
export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  style: 'solid' | 'dashed';
  tone: EdgeTone;
};
export type FlowGroup = {
  id: string;
  label: string;
  parent?: string;
  kind: 'boundary' | 'security';
};
export type FlowData = {
  title: string;
  description?: string;
  direction: 'right' | 'down';
  showTitle: boolean;
  legend: boolean | Record<string, string>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: FlowGroup[];
};

/** Hard limits (errors) and the complexity budget (warnings). */
export const FLOW_LIMITS = {
  nodes: 40,
  edges: 80,
  groups: 12,
  budgetNodes: 9,
  budgetEdges: 12,
  accents: 2,
};

const TOP_KEYS = [
  'template',
  'version',
  'title',
  'description',
  'direction',
  'showTitle',
  'legend',
  'nodes',
  'edges',
  'groups',
  'view',
];
const NODE_KEYS = ['id', 'label', 'sublabel', 'tag', 'kind', 'shape', 'group'];
const EDGE_KEYS = ['id', 'from', 'to', 'label', 'style', 'tone'];
const GROUP_KEYS = ['id', 'label', 'parent', 'kind'];
const LEGEND_KEYS = [...KINDS, 'dashed', 'link', 'accent', 'boundary'];

export function validateFlow(input: unknown): Checked<FlowData> {
  const issues = newIssues();
  if (!isObj(input)) return { ok: false, errors: ['data: must be a JSON object.'], warnings: [] };
  const d = input as Obj;
  checkKeys(d, TOP_KEYS, '', issues);
  // How the live canvas shows it (zoom and pan); the drawing is untouched.
  if (d.view !== undefined) {
    if (!isObj(d.view)) issues.errors.push('view: must be { zoom? }.');
    else {
      checkKeys(d.view, ['zoom'], 'view', issues);
      bool(d.view, 'zoom', 'view', issues);
    }
  }
  if (d.template !== undefined && d.template !== 'flow') {
    issues.errors.push(
      `template: this is the 'flow' template, the data says '${String(d.template)}'.`,
    );
  }
  const title = str(d, 'title', '', issues, { required: true, max: 80 }) ?? '';
  const description = str(d, 'description', '', issues, { max: 300 });
  if (!description)
    issues.warnings.push(
      'description: add one sentence on what the drawing shows (screen readers read it).',
    );
  const direction = oneOf(d, 'direction', ['right', 'down'] as const, '', issues) ?? 'right';
  const showTitle = bool(d, 'showTitle', '', issues) ?? true;
  let legend: FlowData['legend'] = true;
  if (isObj(d.legend)) {
    checkKeys(d.legend, LEGEND_KEYS, 'legend', issues);
    legend = {};
    for (const k of Object.keys(d.legend)) {
      const v = str(d.legend, k, 'legend', issues, { max: 32 });
      if (v) legend[k] = v;
    }
  } else if (d.legend !== undefined) {
    legend = bool(d, 'legend', '', issues) ?? true;
  }

  const ids = new Map<string, string>();
  const groups: FlowGroup[] = [];
  for (const [p, g] of objects(
    list(d, 'groups', '', issues, { max: FLOW_LIMITS.groups }),
    'groups',
    issues,
  )) {
    checkKeys(g, GROUP_KEYS, p, issues);
    const id = idOf(g, p, issues, ids);
    const label = str(g, 'label', p, issues, { required: true, max: 48 });
    const kind = oneOf(g, 'kind', ['boundary', 'security'] as const, p, issues) ?? 'boundary';
    const parent = str(g, 'parent', p, issues);
    if (id && label) groups.push({ id, label, kind, ...(parent ? { parent } : {}) });
  }
  const groupIds = new Map(groups.map((g, i) => [g.id, `groups[${i}]`]));
  groups.forEach((g, i) => {
    if (g.parent && !groupIds.has(g.parent)) {
      issues.errors.push(`groups[${i}].parent: no group with id '${g.parent}'.`);
    }
    // A group may not contain itself through its parents.
    const seen = new Set<string>([g.id]);
    let cur = g.parent;
    while (cur) {
      if (seen.has(cur)) {
        issues.errors.push(
          `groups[${i}].parent: the groups '${[...seen].join("' > '")}' form a loop.`,
        );
        break;
      }
      seen.add(cur);
      cur = groups.find((x) => x.id === cur)?.parent;
    }
  });

  const nodes: FlowNode[] = [];
  const nodeItems = list(d, 'nodes', '', issues, { required: true, max: FLOW_LIMITS.nodes });
  if (Array.isArray(d.nodes) && d.nodes.length === 0)
    issues.errors.push('nodes: at least one node.');
  const nodeIds = new Map<string, string>();
  for (const [p, n] of objects(nodeItems, 'nodes', issues)) {
    checkKeys(n, NODE_KEYS, p, issues);
    const id = idOf(n, p, issues, ids);
    if (id) nodeIds.set(id, p);
    const label = str(n, 'label', p, issues, { required: true, max: 60 });
    const sublabel = str(n, 'sublabel', p, issues, { max: 40 });
    const tag = str(n, 'tag', p, issues, { max: 16 });
    const kind = oneOf(n, 'kind', KINDS, p, issues) ?? 'backend';
    const shape = oneOf(n, 'shape', SHAPES, p, issues) ?? 'box';
    let group: string | undefined;
    if (n.group !== undefined) group = ref(n, 'group', p, issues, groupIds, 'group');
    if (id && label) {
      nodes.push({
        id,
        label,
        kind,
        shape,
        ...(sublabel ? { sublabel } : {}),
        ...(tag ? { tag } : {}),
        ...(group ? { group } : {}),
      });
    }
  }

  const edges: FlowEdge[] = [];
  const edgeIds = new Map<string, string>();
  objects(list(d, 'edges', '', issues, { max: FLOW_LIMITS.edges }), 'edges', issues).forEach(
    ([p, e], i) => {
      checkKeys(e, EDGE_KEYS, p, issues);
      const from = ref(e, 'from', p, issues, nodeIds);
      const to = ref(e, 'to', p, issues, nodeIds);
      const id = e.id === undefined ? `e${i + 1}` : idOf(e, p, issues, edgeIds);
      if (e.id === undefined) edgeIds.set(`e${i + 1}`, p);
      const label = str(e, 'label', p, issues, { max: 24 });
      if (label && label.length > 14) {
        issues.warnings.push(
          `${p}.label: '${label}' is over 14 characters; arrow labels read best short.`,
        );
      }
      const style = oneOf(e, 'style', ['solid', 'dashed'] as const, p, issues) ?? 'solid';
      const tone = oneOf(e, 'tone', ['muted', 'accent', 'link'] as const, p, issues) ?? 'muted';
      if (from && to && from === to)
        issues.errors.push(
          `${p}: an edge from '${from}' to itself is not drawn; remove it or add a step.`,
        );
      if (from && to && id && from !== to)
        edges.push({ id, from, to, style, tone, ...(label ? { label } : {}) });
    },
  );

  // The complexity budget: warnings, the drawing still renders.
  if (nodes.length > FLOW_LIMITS.budgetNodes) {
    issues.warnings.push(
      `budget: ${nodes.length} nodes (target at most ${FLOW_LIMITS.budgetNodes}). Consider an overview plus a detail drawing.`,
    );
  }
  if (edges.length > FLOW_LIMITS.budgetEdges) {
    issues.warnings.push(
      `budget: ${edges.length} edges (target at most ${FLOW_LIMITS.budgetEdges}).`,
    );
  }
  const accents =
    nodes.filter((n) => n.kind === 'focal').length +
    edges.filter((e) => e.tone === 'accent').length;
  if (accents > FLOW_LIMITS.accents) {
    issues.warnings.push(
      `accent: ${accents} accent elements (focal nodes and accent edges); keep it to ${FLOW_LIMITS.accents} so the focus still reads.`,
    );
  }
  return done(issues, {
    title,
    direction,
    showTitle,
    legend,
    nodes,
    edges,
    groups,
    ...(description ? { description } : {}),
  });
}

// ---------------------------------------------------------------- drawing

const NAME_MAX_W = 168;
const GPAD = 16;
const GLABEL = 16;
const MIN_W = 96;
const MIN_H = 40;

type NodeLayout = {
  node: FlowNode;
  w: number;
  h: number;
  name: string[];
  sub: string[];
  warn?: string;
};

function sizeNode(m: Measurer, n: FlowNode): NodeLayout {
  const name = wrap(m, n.label, 'nodeName', NAME_MAX_W, 3);
  const sub = n.sublabel
    ? wrap(m, n.sublabel, 'sublabel', NAME_MAX_W, 2)
    : { lines: [], width: 0, overflow: false, truncated: false };
  const tagW = n.tag ? measure(m, n.tag, 'eyebrow') : 0;
  const textW = Math.max(name.width, sub.width, tagW);
  const textH =
    (n.tag ? lineHeight('eyebrow') + 4 : 0) +
    name.lines.length * lineHeight('nodeName') +
    (sub.lines.length ? 4 + sub.lines.length * lineHeight('sublabel') : 0);
  let w = Math.max(MIN_W, gridUp(textW + 2 * SPACE.pad));
  let h = Math.max(MIN_H, gridUp(textH + 2 * SPACE.pad - 4));
  if (n.shape === 'diamond') {
    // The text block must fit inside the rhombus: double each side.
    w = gridUp(Math.max(w, (textW + 2 * SPACE.pad) * 1.8));
    h = gridUp(Math.max(h * 1.6, textH * 2 + 16));
  } else if (n.shape === 'pill') {
    w = gridUp(w + h / 2);
  } else if (n.shape === 'cylinder') {
    h = gridUp(h + 12);
  }
  const warns: string[] = [];
  if (name.truncated) warns.push(`nodes '${n.id}': label cut to 3 lines; shorten it.`);
  if (name.overflow)
    warns.push(`nodes '${n.id}': a word in the label is wider than a box; the box grew to fit it.`);
  return {
    node: n,
    w,
    h,
    name: name.lines,
    sub: sub.lines,
    ...(warns.length ? { warn: warns.join(' ') } : {}),
  };
}

/** Move an end point from the box side onto the shape's outline. */
function onOutline(shape: Shape, b: Box, side: Side, p: Pt): Pt {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (shape === 'diamond') {
    if (side === 'top' || side === 'bottom') {
      const dy = (b.h / 2) * (1 - Math.min(1, Math.abs(p.x - cx) / (b.w / 2)));
      return { x: p.x, y: side === 'top' ? cy - dy : cy + dy };
    }
    const dx = (b.w / 2) * (1 - Math.min(1, Math.abs(p.y - cy) / (b.h / 2)));
    return { x: side === 'left' ? cx - dx : cx + dx, y: p.y };
  }
  if (shape === 'pill' && (side === 'left' || side === 'right')) {
    const r = b.h / 2;
    const off = Math.min(r, Math.abs(p.y - cy));
    const dx = b.w / 2 - r + Math.sqrt(r * r - off * off);
    return { x: side === 'left' ? cx - dx : cx + dx, y: p.y };
  }
  if (shape === 'cylinder' && side === 'top') {
    const rx = b.w / 2;
    const ry = 6;
    const t = Math.min(1, Math.abs(p.x - cx) / rx);
    return { x: p.x, y: b.y + ry - ry * Math.sqrt(1 - t * t) };
  }
  if (shape === 'cylinder' && side === 'bottom') {
    const rx = b.w / 2;
    const ry = 6;
    const t = Math.min(1, Math.abs(p.x - cx) / rx);
    return { x: p.x, y: b.y + b.h - ry + ry * Math.sqrt(1 - t * t) };
  }
  return p;
}

function drawNode(nl: NodeLayout, b: Box): string {
  const t = NODE_KINDS[nl.node.kind];
  const common = {
    fill: t.fill,
    stroke: t.stroke,
    'stroke-width': 1.2,
    'stroke-dasharray': t.dash,
  };
  const parts: string[] = [];
  const cx = b.x + b.w / 2;
  if (nl.node.shape === 'diamond') {
    parts.push(
      el('path', {
        d: `M${cx} ${b.y}L${b.x + b.w} ${b.y + b.h / 2}L${cx} ${b.y + b.h}L${b.x} ${b.y + b.h / 2}Z`,
        ...common,
      }),
    );
  } else if (nl.node.shape === 'cylinder') {
    const ry = 6;
    parts.push(
      el('path', {
        d: `M${b.x} ${b.y + ry}A${b.w / 2} ${ry} 0 0 1 ${b.x + b.w} ${b.y + ry}V${b.y + b.h - ry}A${b.w / 2} ${ry} 0 0 1 ${b.x} ${b.y + b.h - ry}Z`,
        ...common,
      }),
      el('path', {
        d: `M${b.x} ${b.y + ry}A${b.w / 2} ${ry} 0 0 0 ${b.x + b.w} ${b.y + ry}`,
        fill: 'none',
        stroke: t.stroke,
        'stroke-width': 1.2,
      }),
    );
  } else {
    const rx = nl.node.shape === 'pill' ? b.h / 2 : SPACE.radius;
    parts.push(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx, ...common }));
  }
  // Text block, centred.
  const blockH =
    (nl.node.tag ? lineHeight('eyebrow') + 4 : 0) +
    nl.name.length * lineHeight('nodeName') +
    (nl.sub.length ? 4 + nl.sub.length * lineHeight('sublabel') : 0);
  let y = b.y + b.h / 2 - blockH / 2 + (nl.node.shape === 'cylinder' ? 4 : 0);
  const mid = { 'text-anchor': 'middle' };
  if (nl.node.tag) {
    y += lineHeight('eyebrow');
    parts.push(
      textEl('eyebrow', cx, y - 2, nl.node.tag, {
        ...mid,
        fill: nl.node.kind === 'focal' ? PALETTE.accent : PALETTE.muted,
      }),
    );
    y += 4;
  }
  for (const line of nl.name) {
    y += lineHeight('nodeName');
    parts.push(textEl('nodeName', cx, y - 4, line, { ...mid, fill: PALETTE.ink }));
  }
  if (nl.sub.length) y += 4;
  for (const line of nl.sub) {
    y += lineHeight('sublabel');
    parts.push(textEl('sublabel', cx, y - 3, line, { ...mid, fill: PALETTE.soft }));
  }
  return el('g', { 'data-node': nl.node.id }, parts);
}

export function renderFlow(data: FlowData, m: Measurer): RenderResult {
  const warnings: string[] = [];
  const sized = new Map(data.nodes.map((n) => [n.id, sizeNode(m, n)]));
  for (const s of sized.values()) if (s.warn) warnings.push(s.warn);

  const labelSize = new Map<string, { w: number; h: number }>();
  for (const e of data.edges) {
    if (!e.label) continue;
    const w = gridUp(measure(m, e.label, 'arrowLabel') + 2 * SPACE.labelPadX);
    const h = gridUp(ROLES.arrowLabel.size * 1.35 + 2 * SPACE.labelPadY);
    labelSize.set(e.id, { w, h });
  }
  const hasGroups = data.groups.length > 0;
  const lay = layered({
    direction: data.direction,
    nodes: data.nodes.map((n) => {
      const s = sized.get(n.id)!;
      return {
        id: n.id,
        w: s.w,
        h: s.h,
        ...(n.group ? { parent: n.group } : {}),
        // Edges meet a diamond near its tips.
        ...(n.shape === 'diamond'
          ? { portSpan: data.direction === 'right' ? s.h / 2 : s.w / 2 }
          : {}),
      };
    }),
    groups: data.groups.map((g) => ({ id: g.id, ...(g.parent ? { parent: g.parent } : {}) })),
    // Label boxes get a margin so a neighbouring line never touches them.
    edges: data.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      ...(labelSize.has(e.id)
        ? { label: { w: labelSize.get(e.id)!.w + 16, h: labelSize.get(e.id)!.h + 8 } }
        : {}),
    })),
    groupPad:
      data.direction === 'down'
        ? { before: GPAD + GLABEL, after: GPAD }
        : { before: GPAD, after: GPAD },
    nodeGap: hasGroups ? 56 : SPACE.nodeGap,
    rankGap: hasGroups ? 64 : SPACE.rankGap,
  });

  // Group boxes: members plus padding, label band on top, innermost first.
  const groupBox = new Map<string, Box>();
  const depth = (id: string): number => {
    const g = data.groups.find((x) => x.id === id);
    return g?.parent ? 1 + depth(g.parent) : 0;
  };
  const membersOf = (gid: string): Box[] => {
    const boxes: Box[] = [];
    for (const n of data.nodes) if (n.group === gid) boxes.push(lay.nodes.get(n.id)!);
    for (const g of data.groups) if (g.parent === gid) boxes.push(groupBoxOf(g.id));
    return boxes;
  };
  const groupBoxOf = (gid: string): Box => {
    const hit = groupBox.get(gid);
    if (hit) return hit;
    const members = membersOf(gid);
    const u = members.length ? union(members) : { x: 0, y: 0, w: 0, h: 0 };
    const b = {
      x: u.x - GPAD,
      y: u.y - GPAD - GLABEL,
      w: u.w + 2 * GPAD,
      h: u.h + 2 * GPAD + GLABEL,
    };
    groupBox.set(gid, b);
    return b;
  };
  for (const g of [...data.groups].sort((a, b) => depth(b.id) - depth(a.id))) groupBoxOf(g.id);
  for (const g of data.groups) {
    if (!membersOf(g.id).length)
      warnings.push(`groups '${g.id}': has no members and is not drawn.`);
  }

  // Everything drawn so far, to find the extent.
  const nodeBoxes = [...lay.nodes.values()];
  const extent = union([
    ...nodeBoxes,
    ...[...groupBox.values()],
    ...[...lay.edges.values()].flatMap((e) =>
      e.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })),
    ),
    // Labels too: a label on an outer run must not fall off the edge.
    ...data.edges.flatMap((e) => {
      const c = lay.edges.get(e.id)?.label;
      const sz = labelSize.get(e.id);
      return c && sz ? [{ x: c.x - sz.w / 2, y: c.y - sz.h / 2, w: sz.w, h: sz.h }] : [];
    }),
  ]);
  const titleH = data.showTitle ? 48 : 0;
  const ox = SPACE.margin - extent.x;
  const oy = SPACE.margin + titleH - extent.y;
  const mv = (b: Box): Box => ({ x: b.x + ox, y: b.y + oy, w: b.w, h: b.h });
  const mvp = (p: Pt): Pt => ({ x: p.x + ox, y: p.y + oy });

  // Edges: route points onto shape outlines, then hops over earlier edges.
  const edgeLines = data.edges.map((e) => {
    const le = lay.edges.get(e.id)!;
    const pts = le.points.map(mvp);
    const fromN = sized.get(e.from)!.node;
    const toN = sized.get(e.to)!.node;
    pts[0] = onOutline(fromN.shape, mv(lay.nodes.get(e.from)!), le.fromSide, pts[0]!);
    pts[pts.length - 1] = onOutline(
      toN.shape,
      mv(lay.nodes.get(e.to)!),
      le.toSide,
      pts[pts.length - 1]!,
    );
    return { e, pts: simplify(pts), label: le.label ? mvp(le.label) : undefined };
  });
  const hops = hopsFor(edgeLines.map((l) => l.pts));

  const layerGroups: string[] = [];
  for (const g of [...data.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
    if (!membersOf(g.id).length) continue;
    const b = mv(groupBox.get(g.id)!);
    const sec = g.kind === 'security';
    layerGroups.push(
      el('g', { 'data-group': g.id }, [
        el('rect', {
          x: b.x,
          y: b.y,
          width: b.w,
          height: b.h,
          rx: 8,
          fill: sec ? NODE_KINDS.security.fill : 'none',
          stroke: sec ? NODE_KINDS.security.stroke : PALETTE.soft,
          'stroke-width': 1,
          'stroke-dasharray': '4,4',
        }),
        textEl('eyebrow', b.x + 12, b.y + 16, g.label, {
          fill: sec ? PALETTE.accent : PALETTE.soft,
        }),
      ]),
    );
  }

  const layerEdges: string[] = [];
  const layerLabels: string[] = [];
  const qaItems: QaItem[] = [];
  edgeLines.forEach((l, i) => {
    const colour = EDGE_TONES[l.e.tone];
    const dir = endDir(l.pts);
    const tip = l.pts[l.pts.length - 1]!;
    // Stop the stroke inside the arrowhead so it never pokes past the tip.
    const linePts = [...l.pts.slice(0, -1), { x: tip.x - dir.x * 6, y: tip.y - dir.y * 6 }];
    layerEdges.push(
      el('g', { 'data-edge': l.e.id }, [
        el('path', {
          d: orthoPath(linePts, SPACE.elbow, hops[i]),
          fill: 'none',
          stroke: colour,
          'stroke-width': 1.2,
          'stroke-dasharray': l.e.style === 'dashed' ? '5,4' : undefined,
        }),
        arrowHead(tip, dir, colour),
      ]),
    );
    if (l.e.label && l.label) {
      const s = labelSize.get(l.e.id)!;
      const box = { x: l.label.x - s.w / 2, y: l.label.y - s.h / 2, w: s.w, h: s.h };
      qaItems.push({ kind: 'label', id: l.e.id, box });
      layerLabels.push(
        el('g', { 'data-label': l.e.id }, [
          el('rect', {
            x: box.x,
            y: box.y,
            width: box.w,
            height: box.h,
            rx: 2,
            fill: PALETTE.paper,
          }),
          textEl('arrowLabel', l.label.x, l.label.y + ROLES.arrowLabel.size * 0.35, l.e.label, {
            'text-anchor': 'middle',
            fill: l.e.tone === 'muted' ? PALETTE.muted : colour,
          }),
        ]),
      );
    }
  });

  const layerNodes = data.nodes.map((n) => {
    const b = mv(lay.nodes.get(n.id)!);
    qaItems.push({ kind: 'box', id: n.id, box: b });
    return drawNode(sized.get(n.id)!, b);
  });

  // Self-check.
  warnings.push(
    ...qa(
      qaItems,
      edgeLines.map((l) => ({ id: l.e.id, points: l.pts, ends: [l.e.from, l.e.to] })),
    ),
  );
  const inGroup = (nodeGroup: string | undefined, gid: string): boolean => {
    let cur = nodeGroup;
    while (cur) {
      if (cur === gid) return true;
      cur = data.groups.find((g) => g.id === cur)?.parent;
    }
    return false;
  };
  for (const g of data.groups) {
    const gb = groupBox.get(g.id);
    if (!gb) continue;
    for (const n of data.nodes) {
      if (!inGroup(n.group, g.id) && overlaps(gb, lay.nodes.get(n.id)!, 1)) {
        warnings.push(`layout: '${n.id}' sits inside group '${g.id}' but is not a member.`);
      }
    }
  }

  // Legend: only what is used.
  const legendEntries: LegendEntry[] = [];
  if (data.legend !== false) {
    const names = typeof data.legend === 'object' ? data.legend : {};
    const used = new Set(data.nodes.map((n) => n.kind));
    for (const k of KINDS) {
      if (k === 'backend' || !used.has(k)) continue;
      const t = NODE_KINDS[k];
      legendEntries.push({
        label: names[k] ?? t.legend,
        swatch: boxSwatch(t.fill, t.stroke, t.dash),
      });
    }
    if (data.groups.some((g) => g.kind === 'boundary')) {
      legendEntries.push({
        label: names.boundary ?? 'Group',
        swatch: boxSwatch('none', PALETTE.soft, '4,4'),
      });
    }
    if (data.edges.some((e) => e.style === 'dashed')) {
      legendEntries.push({
        label: names.dashed ?? 'Optional or async',
        swatch: lineSwatch(PALETTE.muted, 1.2, '5,4'),
      });
    }
    if (data.edges.some((e) => e.tone === 'link')) {
      legendEntries.push({ label: names.link ?? 'API call', swatch: lineSwatch(PALETTE.link) });
    }
    if (data.edges.some((e) => e.tone === 'accent')) {
      legendEntries.push({
        label: names.accent ?? 'Main path',
        swatch: lineSwatch(PALETTE.accent),
      });
    }
    // One legend entry tells nothing a reader cannot see; still drawn if
    // asked for by name.
  }

  const contentW = gridUp(extent.w + 2 * SPACE.margin);
  const titleW = data.showTitle ? gridUp(measure(m, data.title, 'title') + 2 * SPACE.margin) : 0;
  const width = Math.max(contentW, titleW, 320);
  const legendTop = gridUp(SPACE.margin + titleH + extent.h + 24);
  const legend = legendStrip(m, legendEntries, SPACE.margin, legendTop, width - 2 * SPACE.margin);
  const height = gridUp(
    legend.height ? legendTop + legend.height + 8 : SPACE.margin + titleH + extent.h + SPACE.margin,
  );

  const body = [
    data.showTitle
      ? textEl('title', SPACE.margin, SPACE.margin + 20, data.title, { fill: PALETTE.ink })
      : '',
    el('g', { 'data-layer': 'groups' }, layerGroups),
    el('g', { 'data-layer': 'edges' }, layerEdges),
    el('g', { 'data-layer': 'nodes' }, layerNodes),
    el('g', { 'data-layer': 'labels' }, layerLabels),
    legend.svg,
  ].join('');
  const desc =
    data.description ??
    `${data.title}: ${data.nodes
      .slice(0, 8)
      .map((n) => n.label)
      .join(', ')}${data.nodes.length > 8 ? ' and more' : ''}.`;
  const svg = svgDocument({
    width,
    height,
    title: data.title,
    desc,
    idPrefix: slugify(data.title),
    generator: `mantle-diagram flow@${FLOW_VERSION}`,
    body,
  });
  const crossings = hops.reduce((s, h) => s + h.length, 0);
  warnings.push(...budgetWarnings(width, crossings, 4));
  return {
    svg,
    width,
    height,
    warnings: [...new Set(warnings)],
    stats: { nodes: data.nodes.length, edges: data.edges.length, crossings },
  };
}
