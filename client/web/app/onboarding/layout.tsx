/**
 * Onboarding shell — deliberately OUTSIDE the (app) group: no sidebar, no
 * activity column, no onboarded-gate (that gate redirects here). Just a
 * centered, full-height canvas for the first-run wizard. Requires a logged-in
 * user (you sign up first), nothing more.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-dvh overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 py-8 sm:py-12">
        {children}
      </div>
    </main>
  );
}
