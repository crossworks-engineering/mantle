'use client';

/**
 * Open a team-mode /s/<token> share from the client-origin member surface.
 *
 * Same-origin (monolith): a plain anchor — the team-chat cookie is already on
 * this origin, so /s renders directly (today's behavior, untouched).
 *
 * Split client origin: shares render on the SERVER origin and authenticate by
 * cookie, which this origin's member (bearer in localStorage) doesn't have
 * there — and can never get via an iframe (cross-origin iframes don't receive
 * Lax cookies; third-party cookies are dying anyway). So the open goes
 * TOP-LEVEL through POST /api/team/sso: a real form navigation (new tab)
 * carrying the bearer in the BODY — never a URL — which mints the server-
 * origin cookie and 303s to the share. See server/web/lib/team-sso.ts.
 */
import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { runtimeApiBase } from '@mantle/web-ui/runtime-env';
import { teamTokenStore } from '@mantle/web-ui/team-fetch';

/**
 * Imperative twin of <OpenShare> for call sites that aren't anchors — the
 * hub app's validated `hub.nav` intents. Builds the SSO form off-DOM and
 * submits it same-tab ('_self' — no popup blocker involvement outside a
 * direct user gesture). Split mode only; same-origin callers navigate
 * /s/<token> directly.
 */
export function openShareOnServer(token: string): void {
  const base = runtimeApiBase();
  if (!base) {
    window.open(`/s/${token}`, '_self');
    return;
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = `${base}/api/team/sso`;
  form.target = '_self';
  form.style.display = 'none';
  const tb = document.createElement('input');
  tb.type = 'hidden';
  tb.name = 'tb';
  tb.value = teamTokenStore.get() ?? '';
  const next = document.createElement('input');
  next.type = 'hidden';
  next.name = 'next';
  next.value = `/s/${token}`;
  form.append(tb, next);
  document.body.append(form);
  form.submit();
  form.remove();
}

export function OpenShare({
  token,
  className,
  style,
  children,
  onPlainClick,
  ariaLabel,
  target = '_blank',
}: {
  /** The share token — the target is always /s/<token> on the server origin. */
  token: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** Same-origin only: intercept a plain (unmodified) click — the in-hub
   *  reader. Modified clicks (new tab/window) keep native anchor behavior.
   *  Ignored in split mode, where every open goes through the SSO form. */
  onPlainClick?: () => void;
  ariaLabel?: string;
  /** Split mode: where the SSO navigation lands. '_self' reads in place
   *  (browser Back returns to the app); '_blank' opens a tab. */
  target?: '_blank' | '_self';
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const tbRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const base = runtimeApiBase();

  if (!base) {
    return (
      <a
        href={`/s/${token}`}
        target={onPlainClick ? undefined : '_blank'}
        rel="noreferrer"
        className={className}
        style={style}
        aria-label={ariaLabel}
        onClick={
          onPlainClick
            ? (e: MouseEvent) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onPlainClick();
              }
            : undefined
        }
      >
        {children}
      </a>
    );
  }

  return (
    <form
      ref={formRef}
      method="post"
      action={`${base}/api/team/sso`}
      target={target}
      className="contents"
    >
      {/* Uncontrolled: both fields are stamped at SUBMIT time (not render) so
          a token refreshed in another tab is always the one that rides, the
          credential never sits in the DOM while idle, and a re-rendered
          detail pane can't submit a stale target. */}
      <input ref={tbRef} type="hidden" name="tb" defaultValue="" />
      <input ref={nextRef} type="hidden" name="next" defaultValue={`/s/${token}`} />
      <button
        type="submit"
        className={className}
        style={style}
        aria-label={ariaLabel}
        onClick={() => {
          if (tbRef.current) tbRef.current.value = teamTokenStore.get() ?? '';
          if (nextRef.current) nextRef.current.value = `/s/${token}`;
        }}
      >
        {children}
      </button>
    </form>
  );
}
