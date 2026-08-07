/**
 * Public draw render — the committed SVG snapshot, static, no JS.
 *
 * The snapshot is referenced as an IMAGE (`<img src>`), never injected into the
 * page as markup. An SVG loaded as an image is a separate, script-disabled
 * document: handlers don't fire, an inline `<style>` can't restyle the host
 * page, and external references don't load. acceptSceneSvg still validates at
 * commit, but this surface no longer depends on it being exhaustive.
 *
 * The white mat is deliberate — the snapshot is exported light-mode with its
 * own background, so it reads as a framed artwork on either page theme rather
 * than adapting (and mangling) its colours.
 */
export function DrawPresenter({
  view,
  src,
}: {
  view: { title: string; hasSvg: boolean };
  /** URL of the snapshot image (`/s/<token>/draw`). */
  src: string;
}) {
  return (
    <article className="mx-auto max-w-5xl px-6 py-12 md:py-16">
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      {view.hasSvg ? (
        <div className="overflow-hidden rounded-lg border border-border bg-white p-3">
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
