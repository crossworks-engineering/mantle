/**
 * Public share shell — deliberately outside the (app) group, so shared links
 * get the root layout (theme, fonts, KaTeX CSS) but NONE of the app chrome
 * (sidebar, nav, live column). Just a clean, centered surface and a quiet
 * footer. Theme follows the visitor's system light/dark via next-themes.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border/60 py-6">
        <p className="text-center text-xs text-muted-foreground">
          Shared via <span className="font-logo lowercase">mantle</span>
        </p>
      </footer>
    </div>
  );
}
