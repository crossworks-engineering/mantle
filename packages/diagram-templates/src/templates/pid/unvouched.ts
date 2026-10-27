/**
 * `pid` data with nothing on it anyone vouches for (DWG bones phase 6):
 * what the browser runtime draws for data it cannot trust (data-read.ts,
 * browser.ts) and what the server draws for a canvas a save refuses
 * (canvas.ts unvouchedCanvas, @mantle/content drawing-seal
 * shownCanvasSource). One function, so the two never differ.
 */
import { honestImageChecks, mapDrawings, withImageCheckSummary } from './check.ts';
import { pidLimitsProblem } from './limits.ts';

/** `pid` data with no mark the runtime can vouch for: every mark
 *  unchecked with its evidence gone, no provenance, no trust word in a
 *  label, the counts its own (what a save stores for a drawing with no
 *  sealed provenance). Data past a size the template holds a drawing to
 *  (pidLimitsProblem) is not normalized at all: its marks and provenance
 *  are dropped whole (the template's check then refuses it). */
export function unvouched(data: unknown): unknown {
  if (pidLimitsProblem(data) !== null) return withoutMarks(data);
  return withImageCheckSummary(honestImageChecks(data, () => false));
}

/** `pid` data with no mark, provenance or count left on it: each drawing's
 *  connectors', lines' and inline items' marks taken off, in one pass. */
function withoutMarks(data: unknown): unknown {
  const bare = (o: unknown, ...keys: string[]): unknown => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
    const out = { ...(o as Record<string, unknown>) };
    for (const k of keys) delete out[k];
    return out;
  };
  const list = (v: unknown, f: (x: unknown) => unknown) => (Array.isArray(v) ? v.map(f) : v);
  const top = bare(data, 'provenance', 'checks');
  return mapDrawings(top, (d) => {
    const out = bare(d, 'provenance', 'checks') as Record<string, unknown>;
    if (Array.isArray(d.offpage)) out.offpage = list(d.offpage, (o) => bare(o, 'check'));
    if (Array.isArray(d.lines))
      out.lines = list(d.lines, (l) => {
        const line = bare(l, 'checks');
        if (typeof line !== 'object' || line === null || Array.isArray(line)) return line;
        const r = line as Record<string, unknown>;
        return Array.isArray(r.inline)
          ? { ...r, inline: list(r.inline, (it) => bare(it, 'check')) }
          : r;
      });
    return out;
  });
}
