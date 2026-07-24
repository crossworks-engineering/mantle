/**
 * Reflect a master-detail selection in the URL bar WITHOUT a Next navigation.
 *
 * Surfaces like notes / tasks / journal hold the whole item in client state, so
 * selecting one is a pure state change — no server round-trip needed. But we
 * still want the address bar to point at the current item, so the URL is
 * copy-/bookmark-/share-able and lines up with the `?selected=<id>` deep link
 * the `/n/<id>` permalink redirects to.
 *
 * `history.replaceState` does exactly that: it rewrites the URL with no fetch,
 * no scroll reset, and no extra back-stack entry (so Back still leaves the
 * surface rather than stepping through every item you clicked). Surfaces whose
 * detail is loaded server-side on select (tables, contacts) should keep using
 * `useListNav().go` instead — they genuinely need the navigation.
 */
export function syncSelectionParam(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', url.toString());
}
