/**
 * The browser side of a diagram canvas: read the data block, measure text in
 * this document, render, put the static SVG in the page, and expose
 * `window.diagram` for the render harness and the host:
 *
 *   window.diagram.ready       Promise of the outcome
 *   window.diagram.exportSvg() the static, self-contained SVG
 *   window.diagram.errors      data errors (empty when it drew)
 *   window.diagram.warnings    layout and budget notes for the author
 *
 * Bad data shows its errors in the page and throws one error, which the
 * Present frame reports to its host as `{v:1, kind:'error'}`.
 */
import { render, type RenderOutcome } from './index.ts';
import { domMeasurer } from './runtime/text.ts';
// A mini app draws a template inside its own React tree instead of mounting
// a page: `render(template, data, domMeasurer(document))` returns the same
// escaped, static SVG string `mount` inserts (app-libraries.ts, app-build).
export { render, domMeasurer };
export type { RenderOutcome };
import { DATA_ID } from './canvas.ts';
import { messageOf } from './runtime/validate.ts';

export type DiagramApi = {
  ready: Promise<RenderOutcome>;
  template: string;
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
  exportSvg: () => string;
};

declare global {
  interface Window {
    diagram?: DiagramApi;
  }
}

function fail(doc: Document, errors: string[]): void {
  const box = doc.getElementById('diagram-errors');
  if (box) {
    box.textContent = `This diagram's data has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n\n- ${errors.join('\n- ')}`;
    box.classList.add('show');
  }
}

export function mount(doc: Document = document): DiagramApi {
  let resolve!: (o: RenderOutcome) => void;
  const ready = new Promise<RenderOutcome>((r) => (resolve = r));
  const api: DiagramApi = {
    ready,
    template: '',
    errors: [],
    warnings: [],
    stats: {},
    exportSvg: () => {
      throw new Error('diagram: nothing to export, the data did not render');
    },
  };
  window.diagram = api;
  const run = async () => {
    let outcome: RenderOutcome;
    const block = doc.getElementById(DATA_ID);
    let data: unknown;
    try {
      data = JSON.parse(block?.textContent ?? '');
    } catch (err) {
      outcome = {
        ok: false,
        template: '',
        errors: [`data: the data block is not valid JSON (${messageOf(err)}).`],
        warnings: [],
      };
    }
    if (data !== undefined) {
      // System fonts are local, but wait for any the page declares anyway.
      if (doc.fonts?.ready) await doc.fonts.ready;
      const meta =
        doc.querySelector('meta[name="diagram:template"]')?.getAttribute('content') ?? '';
      const fromData = (data as { template?: unknown }).template;
      const template = typeof fromData === 'string' ? fromData : (meta.split('@')[0] ?? '');
      outcome = render(template, data, domMeasurer(doc));
    }
    api.template = outcome!.template;
    api.warnings = outcome!.warnings;
    if (outcome!.ok) {
      const svg = outcome!.svg;
      api.stats = outcome!.stats;
      api.exportSvg = () => svg;
      const target = doc.getElementById('diagram');
      // The SVG is built from escaped strings by the template (no markup
      // from the data reaches it unescaped), so it is safe to insert.
      if (target) target.innerHTML = svg;
    } else {
      api.errors = outcome!.errors;
      fail(doc, outcome!.errors);
    }
    resolve(outcome!);
    if (!outcome!.ok) {
      // Uncaught on purpose: the Present frame reports it to the host.
      setTimeout(() => {
        throw new Error(
          `diagram: ${outcome!.errors[0]}${outcome!.errors.length > 1 ? ` (and ${outcome!.errors.length - 1} more)` : ''}`,
        );
      });
    }
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => void run());
  else void run();
  return api;
}
