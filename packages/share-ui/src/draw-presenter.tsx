import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';
import { cn } from './lib/utils';

/**
 * Public draw render — the committed SVG snapshot, static, no JS.
 *
 * The snapshot is referenced as an IMAGE (`<img src>`), never injected into the
 * page as markup. An SVG loaded as an image is a separate, script-disabled
 * document: handlers don't fire, an inline `<style>` can't restyle the host
 * page, and external references don't load. acceptSceneSvg still validates at
 * commit, but this surface no longer depends on it being exhaustive.
 *
 * Theme: the snapshot is exported light-mode with its own background. On the
 * STANDALONE page the white mat stays on either theme — a framed artwork on a
 * page that leaves the brain. EMBEDDED (the /team reader is a themed app
 * surface), dark mode applies Excalidraw's own theme filter
 * (invert + hue-rotate, the exact transform the editor uses) over the whole
 * mat, so strokes and canvas read dark natively — UNLESS the scene contains a
 * raster image (`hasImage`), which one flat filter would render as a negative;
 * those keep the light mat, same veto the owner previews apply.
 */
export function DrawPresenter({
  view,
  src,
  chrome,
}: {
  view: { title: string; hasSvg: boolean; hasImage?: boolean };
  /** URL of the snapshot image (`/s/<token>/draw`). */
  src: string;
  chrome?: PresenterChrome;
}) {
  const embedded = isEmbedded(chrome);
  const invertible = embedded && view.hasImage !== true;
  return (
    <article className={embedded ? 'w-full px-6 py-6' : 'mx-auto max-w-5xl px-6 py-12 md:py-16'}>
      {!embedded && (
        <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      )}
      {view.hasSvg ? (
        <div
          className={cn(
            'overflow-hidden rounded-lg border border-border bg-white p-3',
            invertible && 'dark:[filter:invert(93%)_hue-rotate(180deg)]',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a drawing
              snapshot is not a next/image candidate: it's an owner-generated
              SVG of unknown dimensions served from our own share route. */}
          <img src={src} alt={view.title} className="h-auto w-full" />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nothing committed here yet.
        </p>
      )}
    </article>
  );
}
