/**
 * @mantle/diagram-templates: the agent writes DATA, a template lays it out
 * and draws it, the result exports as a static SVG.
 *
 *   validate(template, data)          errors an agent can act on, or the typed data
 *   render(template, data, measurer)  { ok, svg, warnings, stats } or { ok:false, errors }
 *   buildCanvas(...)                  the template as a self-contained Present canvas
 *   checkStaticSvg(svg)               proof the export is static and self-contained
 *
 * Pure: no DOM, no network. In a browser pass `domMeasurer(document)`; in
 * Node, `estimateMeasurer` (good enough for tests, not for the final picture).
 */
import { validateFlow, renderFlow, FLOW_VERSION } from './templates/flow.ts';
import { validatePid, renderPid, PID_VERSION } from './templates/pid/index.ts';
import { messageOf, type Checked } from './runtime/validate.ts';
import type { Measurer } from './runtime/text.ts';
import type { RenderResult } from './types.ts';

export type TemplateName = 'flow' | 'pid';

type Template<T> = {
  name: TemplateName;
  version: number;
  summary: string;
  validate: (data: unknown) => Checked<T>;
  render: (data: T, m: Measurer) => RenderResult;
};

export const TEMPLATES = {
  flow: {
    name: 'flow',
    version: FLOW_VERSION,
    summary:
      'Boxes and arrows: process flows, flowcharts, architecture, data flow. Layered, right-angle routes, groups.',
    validate: validateFlow,
    render: renderFlow,
  } satisfies Template<ReturnType<typeof validateFlow> extends Checked<infer T> ? T : never>,
  pid: {
    name: 'pid',
    version: PID_VERSION,
    summary:
      'P&ID first draft: equipment, process lines with line numbers, valves, ISA-5.1 instruments, signals, circuits, off-page connectors, a site profile.',
    validate: validatePid,
    render: renderPid,
  } satisfies Template<ReturnType<typeof validatePid> extends Checked<infer T> ? T : never>,
} as const;

export function isTemplateName(v: unknown): v is TemplateName {
  return typeof v === 'string' && v in TEMPLATES;
}

export type RenderOutcome =
  | ({ ok: true; template: TemplateName; version: number } & RenderResult)
  | { ok: false; template: string; errors: string[]; warnings: string[] };

/** Validate, then render. Never throws on bad data: errors come back as a
 *  list. A crash inside a template comes back as one error too. */
export function render(template: string, data: unknown, m: Measurer): RenderOutcome {
  if (!isTemplateName(template)) {
    return {
      ok: false,
      template,
      errors: [
        `template: '${template}' is not a template. Known: ${Object.keys(TEMPLATES).join(', ')}.`,
      ],
      warnings: [],
    };
  }
  const t = TEMPLATES[template];
  const checked = t.validate(data);
  if (!checked.ok)
    return { ok: false, template, errors: checked.errors, warnings: checked.warnings };
  try {
    // The registry pairs each validate with its own render.
    const out = (t.render as (d: unknown, m: Measurer) => RenderResult)(checked.data, m);
    return {
      ok: true,
      template,
      version: t.version,
      ...out,
      warnings: [...checked.warnings, ...out.warnings],
    };
  } catch (err) {
    return {
      ok: false,
      template,
      errors: [
        `render: the template failed (${messageOf(err)}). This is a template bug; report it with the data.`,
      ],
      warnings: checked.warnings,
    };
  }
}

export function validate(template: string, data: unknown): Checked<unknown> {
  if (!isTemplateName(template)) {
    return { ok: false, errors: [`template: '${template}' is not a template.`], warnings: [] };
  }
  return TEMPLATES[template].validate(data);
}

export { checkStaticSvg, svgDocument, slugify } from './runtime/export.ts';
export { estimateMeasurer, domMeasurer, type Measurer } from './runtime/text.ts';
export { buildCanvas, readCanvasData, replaceCanvasData, type CanvasMode } from './canvas.ts';
export type { RenderResult } from './types.ts';
export type { FlowData } from './templates/flow.ts';
export type { PidData, SiteProfile } from './templates/pid/index.ts';
