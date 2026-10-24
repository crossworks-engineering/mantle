/**
 * Presents for the HTTP tier: the content layer (@mantle/content/presents)
 * plus the one step it cannot take itself, the canvas's Tailwind compile
 * (@mantle/app-build, section 6.3), done here before the save.
 */
import { buildCanvasCss } from '@mantle/app-build';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { readCanvas } from '@mantle/content/presents';

export {
  PRESENTS_ROOT_LABEL,
  EMPTY_CANVAS,
  readCanvas,
  listPresents,
  countPresents,
  getPresent,
  getPresentFrame,
  createPresent,
  savePresentSource,
  updatePresent,
  deletePresent,
  listPresentRevisions,
  setPresentPoster,
  getPresentPoster,
  getPresentRevisionSource,
  type PresentRow,
  type PresentDetail,
  type PresentSort,
  type SavePresentResult,
} from '@mantle/content/presents';

/**
 * The utilities a canvas's classes need. Read first, so a source over the
 * size limit is refused before any compile. A compile failure is never a
 * failed save: the canvas keeps the shared stylesheet only, as an app build
 * degrades to a warning.
 */
export async function compileCanvasCss(source: string): Promise<string> {
  readCanvas(source);
  try {
    return await buildCanvasCss(source);
  } catch (err) {
    log('presents').error(`canvas CSS compile failed: ${errorMessage(err)}`);
    return '';
  }
}
