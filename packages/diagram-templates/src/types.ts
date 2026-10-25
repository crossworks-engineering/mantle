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
  pages?: { id: string; title: string; svg: string; width: number; height: number }[];
  /** A set's pages whose layout failed: each is drawn as an error panel in
   *  its place, and the rest of the set still draws. A data check that
   *  must be sure the set draws treats any entry here as an error. */
  failed?: PageFailure[];
};

/** A page of a set that could not be drawn: its id, its data's path in the
 *  set (`pages[2].data`) and what went wrong. */
export type PageFailure = { page: string; path: string; error: string };
