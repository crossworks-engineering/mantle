import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';

/**
 * Public note render — markdown (GFM) in a prose column.
 *
 * Embedded keeps the measure. A note is prose, and prose wants a line length
 * whoever is reading it; what it drops is the hero title the shell already
 * draws, and the standalone page's tall top padding. See `PresenterChrome`.
 */
export function NotePresenter({
  view,
  chrome,
}: {
  view: { title: string; content: string };
  chrome?: PresenterChrome;
}) {
  const embedded = isEmbedded(chrome);
  return (
    <article className={embedded ? 'max-w-3xl px-6 py-6' : 'mx-auto max-w-3xl px-6 py-12 md:py-16'}>
      {!embedded && (
        <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      )}
      <div className="prose dark:prose-invert max-w-none prose-accent prose-document">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.content}</ReactMarkdown>
      </div>
    </article>
  );
}
