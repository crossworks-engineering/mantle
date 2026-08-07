/**
 * Public draw render — the committed SVG snapshot, static, no JS.
 *
 * The snapshot was validated by acceptSceneSvg at commit (no scripts,
 * handlers, foreignObject or js: URLs can be stored), so inline injection is
 * the design: the drawing renders with zero client script, fonts inlined by
 * exportToSvg. The white mat is deliberate — the snapshot is exported
 * light-mode with its own background, so it reads as a framed artwork on
 * either page theme rather than adapting (and mangling) its colours.
 */
export function DrawPresenter({ view }: { view: { title: string; svg: string | null } }) {
  return (
    <article className="mx-auto max-w-5xl px-6 py-12 md:py-16">
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      {view.svg ? (
        <div
          className="overflow-hidden rounded-lg border border-border bg-white p-3 [&_svg]:h-auto [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: view.svg }}
        />
      ) : (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nothing committed here yet.
        </p>
      )}
    </article>
  );
}
