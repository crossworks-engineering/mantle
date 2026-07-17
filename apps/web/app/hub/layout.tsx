/**
 * /hub — the Team Hub's new home. The curated hub (designated hub APP when
 * one is set, else the built-in briefing hub) moved here when /team became
 * the read-only member workspace. Same trust model as /team: outside the
 * (app) group, in PUBLIC_PATHS, token-cookie authenticated — the same cookie
 * opens both surfaces, so members switch between them freely.
 */
export default function HubLayout({ children }: { children: React.ReactNode }) {
  return (
    // Own scroll container: globals.css pins html/body to overflow:hidden for
    // the app shell, so this surface must manage its own height.
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
