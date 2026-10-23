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
};
