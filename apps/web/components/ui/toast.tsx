'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';

type Toast = {
  id: number;
  kind: Kind;
  message: string;
  /** ms to auto-dismiss; 0 = sticky. Default 5000. */
  durationMs: number;
  /** Optional one-tap follow-through — "Answer" on a blocked-run question,
   *  "Open" on a finished job. Clicking it also dismisses the toast: the
   *  action IS the acknowledgement. */
  action?: { label: string; onClick: () => void };
};

type ToastApi = {
  push: (t: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Most toasts the stack will show at once (oldest are dropped past this). */
const MAX_VISIBLE = 4;

/**
 * Lightweight toast queue. No deps; bottom-right stack; auto-dismiss
 * with manual close. Drops into the app shell once and is used via
 * `const toast = useToast(); toast.error('Save failed')`.
 *
 * Why home-grown: every alternative we'd pull in (sonner, radix-toast)
 * is heavier than 80 LOC of state machine. The surface stays small so
 * we can swap it later without rewiring callers.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi['push']>(
    (t) => {
      const id = Date.now() + Math.random();
      const durationMs = t.durationMs ?? 5000;
      // Cap the stack. Sticky toasts (durationMs: 0) never self-dismiss, so a
      // burst — a run fanning out several questions at once — would otherwise
      // paper over the lower-right corner permanently, each one swallowing
      // clicks. Oldest drop off; the surfaces they point at still hold them.
      setToasts((prev) => [...prev, { ...t, id, durationMs }].slice(-MAX_VISIBLE));
      if (durationMs > 0) {
        setTimeout(() => remove(id), durationMs);
      }
    },
    [remove],
  );

  // Stable identity: consumers hold `toast` in useCallback/useEffect deps, so
  // a fresh object every render turns "toast on fetch error" into a re-fetch
  // loop (each toast re-renders the provider → new api → new callback →
  // effect re-runs). Memoized, the context value only changes with `push`.
  const api: ToastApi = useMemo(
    () => ({
      push,
      success: (message) => push({ kind: 'success', message }),
      error: (message) => push({ kind: 'error', message, durationMs: 8000 }),
      info: (message) => push({ kind: 'info', message }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // aria-live: SR users hear the message without focus changing.
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-3 pb-3 sm:items-end sm:px-4 sm:pb-4"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  // Tiny enter animation: mount with opacity-0, flip to opacity-100
  // on the next paint. Cheaper than framer-motion for this.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const palette =
    toast.kind === 'success'
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100'
      : toast.kind === 'error'
        ? 'border-destructive/50 bg-destructive/10 text-destructive'
        : 'border-border bg-card text-foreground';
  const Icon =
    toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertCircle : Info;

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={
        'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg backdrop-blur transition-all duration-150 ' +
        palette +
        (visible ? ' translate-y-0 opacity-100' : ' translate-y-1 opacity-0')
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 break-words">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onClose();
          }}
          className="shrink-0 self-center rounded-sm px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-foreground/10"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}
