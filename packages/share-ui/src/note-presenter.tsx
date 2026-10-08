import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { drawNodeId, mediaFileId } from '@mantle/content-core/markdown-refs';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';

/** Is `href` one of the app's reference schemes a note resolves itself
 *  (`media:` a file, `draw:` a drawing)? */
function isNoteRef(href: string): boolean {
  const s = href.trim();
  return mediaFileId(s) !== null || drawNodeId(s) !== null;
}

/**
 * Public note render — markdown (GFM) in a prose column.
 *
 * Embedded keeps the measure. A note is prose, and prose wants a line length
 * whoever is reading it; what it drops is the hero title the shell already
 * draws, and the standalone page's tall top padding. See `PresenterChrome`.
 *
 * A note's own pictures and file links are written in the app's reference
 * schemes: `![alt](media:<file-id>)`, `[spec.pdf](media:<file-id>)`,
 * `![alt](draw:<draw-id>)`. `assetUrl` / `drawUrl` name the surface's byte
 * route for each (the public share passes its token routes, as it does for
 * the page presenter); the route decides what it serves. Without one, a
 * picture draws its alt text and a link its text, so nothing is asked for.
 * Any other href keeps ReactMarkdown's own safety rule.
 */
export function NotePresenter({
  view,
  chrome,
  assetUrl,
  drawUrl,
}: {
  view: { title: string; content: string };
  chrome?: PresenterChrome;
  /** A `media:` file's bytes on this surface. */
  assetUrl?: (fileId: string) => string;
  /** A `draw:` drawing's snapshot on this surface. */
  drawUrl?: (drawId: string) => string;
}) {
  const embedded = isEmbedded(chrome);
  /** The URL a reference resolves to, or null when this surface has no
   *  route for it. */
  const refUrl = (href: string): string | null => {
    const s = href.trim();
    const file = mediaFileId(s);
    if (file) return assetUrl ? assetUrl(file) : null;
    const draw = drawNodeId(s);
    if (draw) return drawUrl ? drawUrl(draw) : null;
    return null;
  };
  const components: Components = {
    img: ({ node: _node, src, alt, ...rest }) => {
      if (typeof src === 'string' && isNoteRef(src)) {
        const url = refUrl(src);
        return url ? (
          // eslint-disable-next-line @next/next/no-img-element -- token-routed share bytes; next/image cannot optimise them
          <img src={url} alt={alt ?? ''} />
        ) : (
          <span className="text-muted-foreground">[{alt?.trim() || 'image'}]</span>
        );
      }
      // eslint-disable-next-line @next/next/no-img-element -- see above
      return <img src={src} alt={alt ?? ''} {...rest} />;
    },
    a: ({ node: _node, href, children, ...rest }) => {
      if (typeof href === 'string' && isNoteRef(href)) {
        const url = refUrl(href);
        return url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
      }
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    },
  };
  return (
    <article className={embedded ? 'max-w-3xl px-6 py-6' : 'mx-auto max-w-3xl px-6 py-12 md:py-16'}>
      {!embedded && (
        <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      )}
      <div className="prose dark:prose-invert max-w-none prose-accent prose-document">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={components}
          // A reference reaches the components above untouched, so it
          // resolves there; ReactMarkdown's default would turn `media:` into
          // an empty string first. Everything else keeps the default rule.
          urlTransform={(url) => (isNoteRef(url) ? url : defaultUrlTransform(url))}
        >
          {view.content}
        </ReactMarkdown>
      </div>
    </article>
  );
}
