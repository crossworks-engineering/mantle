/**
 * @mantle/client-types · present checks
 *
 * The image check overview of a traced P&ID canvas (DWG bones phase 6):
 * GET /api/presents/:id/checks. The brain reads the circuit and drawing
 * tables the canvas's data names (circuit_trace writes them) and returns
 * the latest sealed answer of each guess from those tables' Checks tabs.
 * The app shows it beside the canvas, outside its frame. An image check is
 * a help, not a guarantee: `note` says so in one line, and the panel shows
 * it. Crops are ordinary Files ids, opened with the viewer's own rights;
 * no image bytes are inlined.
 */

/** One answered guess: the latest sealed Checks row of its key. */
export type PresentCheckItemDTO = {
  kind: 'join' | 'end' | 'link' | 'valve';
  /** The drawing table it was asked on (its title is the sheet's). */
  tableId: string;
  sheet: string;
  question: string;
  answer: 'yes' | 'no' | 'unsure';
  /** After a no: what the image named instead (a valve type, a tag, a
   *  word like "break"). */
  alternative?: string;
  reason: string;
  model: string;
  /** ISO time the check ran. */
  checkedAt: string;
  /** File ids of the close-up crops, in order. */
  crops: string[];
  /** File id of the sheet overview the model saw with them. */
  overview?: string;
};

/** One circuit's image checks. */
export type PresentCircuitChecksDTO = {
  circuit: string;
  counts: { checked: number; no: number; unsure: number };
  items: PresentCheckItemDTO[];
  /** More answers than `items` carries (the rest are in the Checks tabs). */
  more?: number;
};

export type PresentChecksDTO = {
  /** Whether the canvas is a traced P&ID: false hides the panel. */
  traced: boolean;
  /** "Image checks help; they are not a guarantee. Verify on the drawing." */
  note: string;
  circuits: PresentCircuitChecksDTO[];
  /** What could not be read or is left out, in plain words. */
  limits: string[];
};
