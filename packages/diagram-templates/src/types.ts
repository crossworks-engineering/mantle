import type { PidCheck } from './templates/pid/check.ts';

/** What every template's render returns. */
export type RenderResult = {
  /** The static, self-contained SVG (see runtime/export.ts). */
  svg: string;
  width: number;
  height: number;
  /** Layout and budget notes for the author: the drawing rendered, but these
   *  are worth fixing in the data. */
  warnings: string[];
  stats: Record<string, number>;
  /** A drawing set: each page drawn on its own, in order. `svg` above is
   *  then all of them stacked (runtime/pages.ts), the static export. */
  pages?: {
    id: string;
    title: string;
    svg: string;
    width: number;
    height: number;
    checks?: CheckEvidence[];
  }[];
  /** A set's pages whose layout failed: each is drawn as an error panel in
   *  its place, and the rest of the set still draws. A data check that
   *  must be sure the set draws treats any entry here as an error. */
  failed?: PageFailure[];
  /** The image check's evidence on the drawing (pid): one entry per item
   *  that carries a `check`, under the key its element carries in
   *  `data-check`. A set keeps each page's in `pages[].checks`. */
  checks?: CheckEvidence[];
};

/** The image checks of one drawn element as the canvas shows them on
 *  click: what it is, and each check (its state, question, answer, model
 *  and crop file ids; templates/pid/check.ts). A line's note counts one
 *  check per inferred join. */
export type CheckEvidence = { key: string; what: string; checks: PidCheck[] };

/** A page of a set that could not be drawn: its id, its data's path in the
 *  set (`pages[2].data`) and what went wrong. */
export type PageFailure = { page: string; path: string; error: string };
