import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Public note render — markdown (GFM) in a centered prose column. */
export function NotePresenter({ view }: { view: { title: string; content: string } }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12 md:py-16">
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      <div className="prose dark:prose-invert max-w-none prose-accent">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.content}</ReactMarkdown>
      </div>
    </article>
  );
}
