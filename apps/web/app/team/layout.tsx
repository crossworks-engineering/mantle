/**
 * Team Chat shell — the EXTERNAL member surface. Deliberately outside the
 * (app) group (like /s): root layout theme/fonts, none of the app chrome.
 * Members are not brain users; they authenticate with a team token, so this
 * path is in PUBLIC_PATHS and every /api/team route self-authenticates.
 */
export default function TeamChatLayout({ children }: { children: React.ReactNode }) {
  return (
    // Own scroll container: globals.css pins html/body to overflow:hidden for
    // the app shell, so this surface must manage its own height. The chat
    // client owns inner scrolling (thread pane), so no outer overflow here.
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
