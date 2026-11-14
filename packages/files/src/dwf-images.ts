/**
 * Autodesk DWF plot set → its sheet pictures: the picture read of a DWF,
 * which stays on its route (the parser job `images`, through
 * ./embedded-images-read.ts). The container reader is the package
 * `plot-dwf` (./pipelines/pkg/plot-dwf/dwf.ts), which gives the database read
 * and the text; this file only adds the pictures, so the package keeps to
 * the kit (it does not import ./embedded-images.ts or the config).
 *
 * One raster per published sheet, shaped for the shared embedded-image
 * pipeline (`extractEmbeddedImages` → gate → file nodes) and stamped with
 * its `provenance` tier:
 *
 *   - **sidecar_render**: the CAD tier's ezdwf raster of the sheet's
 *     vector content (300 dpi, engineering-legible), rendered in the parser
 *     service (the value is the stored provenance name, kept from the days
 *     of the media sidecar). Taken only when the
 *     render set is COMPLETE: no sheet skipped, nothing lost to the payload
 *     cap. A partial render never silently replaces the full set below.
 *     Sheet identity comes from the container MANIFEST (mapped by the
 *     render's sheet index), so titles do not depend on which tier ran.
 *   - **embedded_thumbnail** — the container's own 262×170 preview, the
 *     fallback for every failure mode (a render error, a timeout, a partial
 *     render). The fallback is logged with the failure code, and the
 *     provenance stamp is what lets `extract-images-backfill --upgrade-dwf`
 *     re-render this cohort later.
 *
 * Every image is `essential`: the format guarantees one content raster per
 * sheet, so the decoration size floors don't apply (thumbnails are under
 * the generic 200 px floor); renderability and dedupe still do.
 * `location.sheet` carries the sheet title so the naming cascade yields
 * "… (90-10-01)"-style node titles.
 */
import { envNum } from '@mantle/config';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import { declaredSize, openDwf, parseDwfStructured, sniffDwf } from './pipelines/pkg/plot-dwf/dwf';

/** Ceiling on an inflated sheet thumbnail (real ones are ~5-10 KB). */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Render resolution for CAD-tier sheet rasters: a PER-BOX dial via the
 *  `DWF_RENDER_DPI` env (clamped to the renderer's 50–600 range; default
 *  300). The brain reads it and passes it to the parser with the request.
 *
 *  Since v0.232.141 the renderer draws each sheet on a FIXED 33-inch page
 *  (`RENDER_PAGE_INCHES`) rather than ezdwf's own small figure, so this dial
 *  no longer sets the pixel count on its own: the renderer clamps the
 *  effective dpi to whatever keeps the output under its 30 MP cap, which
 *  lands around 165 dpi ≈ 5400 px on the long edge. Anything above that
 *  saturates — the value is a ceiling now, not a multiplier. The page size,
 *  not the dpi, is what made small text legible: ezdwf floors every stroke at
 *  0.5 POINTS, and on its default page that floor was ~5× a real pen width,
 *  so line numbers and title-block dates filled in solid. Tune DOWN (150 ≈
 *  4950 px) on a box whose vision worker downscales anyway — pixels are
 *  vision tokens. */
export function renderDpi(): number {
  return envNum('DWF_RENDER_DPI');
}

function sheetImage(
  png: Buffer,
  sheet: string,
  ordinal: number,
  provenance: 'sidecar_render' | 'embedded_thumbnail',
): EmbeddedImage {
  return {
    bytes: png,
    ordinal,
    location: { sheet },
    altText: `Sheet ${sheet}`,
    essential: true,
    provenance,
    ...describeImageBytes(png, 'png'),
  };
}

/** One sheet of a CAD-tier DWF render. */
export type DwfSheetRender = {
  /** Sheet title as published ("90-10-01 Rev 2" style). */
  name: string;
  /** The sheet's true index in the plot set (failed sheets leave gaps). */
  index: number;
  png: Buffer;
};

/** A CAD-tier render of every sheet of a plot set. */
export type DwfRender = {
  /** How many 2D sheets the container holds. */
  sheetCount: number;
  /** Sheets that errored in the render worker (counted, never renamed over). */
  skipped: number;
  /** A sheet-count or payload cap bit. */
  capped: boolean;
  /** Anything at all is missing from `sheets`: cap, error, or otherwise. */
  truncated: boolean;
  sheets: DwfSheetRender[];
};

/** The CAD tier's renderer, handed in by the parser service (its Python
 *  ezdwf child, server/parser/src/cad.ts). A failure is a value, never a
 *  throw: the thumbnails are the fallback. */
export type DwfRenderFn = (
  bytes: Buffer,
  opts: { dpi: number; maxSheets?: number },
) => Promise<{ ok: true; value: DwfRender } | { ok: false; code: string; message: string }>;

export async function extractDwfImages(
  bytes: Buffer,
  opts?: { maxSheets?: number; render?: DwfRenderFn; dpi?: number },
): Promise<EmbeddedImage[]> {
  if (!sniffDwf(bytes)) return [];

  if (opts?.render) {
    const render = await opts.render(bytes, {
      dpi: opts.dpi ?? renderDpi(),
      ...(opts.maxSheets ? { maxSheets: opts.maxSheets } : {}),
    });
    if (render.ok) {
      const { sheetCount, skipped, sheets } = render.value;
      // Complete = every sheet we ASKED for came back. A shortfall from a
      // skipped sheet or the payload cap falls through to the thumbnails,
      // which cover the whole set; a shortfall only from our own maxSheets
      // request is exactly what the caller's cap would keep anyway.
      const wanted = Math.min(sheetCount, opts.maxSheets ?? Number.POSITIVE_INFINITY);
      if (skipped === 0 && sheets.length >= wanted && sheets.length > 0) {
        // Titles from the manifest, mapped by the render's sheet index, so
        // node identity is the same whichever tier produced the pixels.
        let titles: string[] = [];
        try {
          titles = (await parseDwfStructured(bytes)).sheets.map((sheet) => sheet.title);
        } catch {
          /* renders still ship under their wire names */
        }
        return sheets.map((s, i) =>
          sheetImage(s.png, titles[s.index] ?? s.name, i + 1, 'sidecar_render'),
        );
      }
      console.warn(
        `[dwf] CAD render incomplete (${sheets.length}/${sheetCount}, skipped ${skipped}); using embedded thumbnails`,
      );
    } else {
      console.warn(
        `[dwf] CAD render unavailable (${render.code}: ${render.message}); using embedded thumbnails`,
      );
    }
  }

  const { entries, sectionEntries, sections } = await openDwf(bytes);
  const images: EmbeddedImage[] = [];
  for (const { name, title } of sections) {
    const pngPath = sectionEntries.get(name)?.png;
    const entry = pngPath ? entries.get(pngPath) : undefined;
    if (!entry) continue;
    const size = declaredSize(entry);
    if (size < 0 || size > MAX_THUMBNAIL_BYTES) continue;
    const png = await entry.async('nodebuffer');
    images.push(sheetImage(png, title, images.length + 1, 'embedded_thumbnail'));
  }
  return images;
}
