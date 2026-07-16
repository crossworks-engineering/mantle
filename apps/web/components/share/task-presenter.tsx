import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Circle } from 'lucide-react';
import { formatDateTime } from '@/lib/format-datetime';

/** Public task render — a clean status card. */
export function TaskPresenter({
  view,
}: {
  view: { title: string; body: string; status: string; priority: string; dueAt: string | null };
}) {
  const done = view.status === 'done';
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 md:py-16">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start gap-3">
          <span
            className={
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ' +
              (done
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-transparent')
            }
            aria-hidden
          >
            {done ? <Check className="size-4" /> : <Circle className="size-3" />}
          </span>
          <div className="min-w-0 flex-1">
            <h1
              className={
                'text-2xl font-bold tracking-tight ' +
                (done ? 'text-muted-foreground line-through' : '')
              }
            >
              {view.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-border px-2 py-0.5 capitalize text-muted-foreground">
                {view.status}
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 capitalize text-muted-foreground">
                {view.priority} priority
              </span>
              {view.dueAt && (
                <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                  Due {formatDateTime(view.dueAt)}
                </span>
              )}
            </div>
          </div>
        </div>
        {view.body && (
          <div className="prose prose-sm dark:prose-invert mt-5 max-w-none border-t border-border pt-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.body}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
