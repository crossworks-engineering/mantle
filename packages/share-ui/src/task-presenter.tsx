import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Circle } from 'lucide-react';
import { formatDateTime } from '@mantle/client-types/lib/format-datetime';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';
import { cn } from './lib/utils';

/** Human label per lifecycle status (raw value falls through for forward
 *  compatibility — never render a snake_case token to a reader). */
const STATUS_LABEL: Record<string, string> = {
  open: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

/**
 * Public task render — a status card standalone, laid out on the pane when
 * embedded.
 *
 * The status/priority/due chips survive both shells: they are the task's
 * metadata, not decoration, and the pane header carries only the title. What
 * embedded drops is the card frame, the hero title, and the done-tick beside it
 * (the "Done" chip already says the same thing without a 24px glyph claiming
 * the leftmost column). See `PresenterChrome`.
 */
export function TaskPresenter({
  view,
  chrome,
}: {
  view: {
    title: string;
    body: string;
    status: string;
    priority: string;
    dueAt: string | null;
    todos?: { text: string; done: boolean }[];
  };
  chrome?: PresenterChrome;
}) {
  const done = view.status === 'done';
  const todos = view.todos ?? [];
  const embedded = isEmbedded(chrome);
  const chips = (
    <div className={cn('flex flex-wrap items-center gap-2 text-xs', !embedded && 'mt-3')}>
      <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
        {/* Guarded like `todos` above: a payload from an older brain may omit
            status, and an unguarded deref here took down the whole /team
            workspace (no boundary caught it). */}
        {STATUS_LABEL[view.status ?? 'open'] ?? (view.status ?? 'open').replace(/_/g, ' ')}
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
  );

  return (
    <div className={embedded ? 'w-full px-6 py-6' : 'mx-auto max-w-2xl px-6 py-12 md:py-16'}>
      <div className={cn(!embedded && 'rounded-xl border border-border bg-card p-6')}>
        {embedded ? (
          chips
        ) : (
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
              {chips}
            </div>
          </div>
        )}
        {view.body && (
          <div className="prose prose-sm dark:prose-invert mt-5 max-w-none border-t border-border pt-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.body}</ReactMarkdown>
          </div>
        )}
        {todos.length > 0 && (
          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Checklist · {todos.filter((t) => t.done).length}/{todos.length} done
            </p>
            <ul className="space-y-1">
              {todos.map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ' +
                      (t.done
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-transparent')
                    }
                    aria-hidden
                  >
                    {t.done && <Check className="size-3" />}
                  </span>
                  <span className={t.done ? 'text-muted-foreground line-through' : ''}>
                    {t.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
