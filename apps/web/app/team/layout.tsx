import { TeamWorkspaceShell } from '@/components/team-workspace/team-workspace-shell';

/**
 * Team Workspace shell — the EXTERNAL member surface. Deliberately outside
 * the (app) group (like /s): root layout theme/fonts, none of the owner app
 * chrome. Members are not brain users; they authenticate with a team token,
 * so this path is in PUBLIC_PATHS and every /api/team route self-authenticates.
 *
 * The shell (header wordmark, section nav, folders+Assistant footer) is a
 * client component: it resolves the member session against
 * /api/team/workspace and renders the token prompt on 401 — no server DB
 * reads here (detached-dev safe). The old curated hub moved to /hub.
 */
export default function TeamWorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    // Own scroll container: globals.css pins html/body to overflow:hidden for
    // the app shell, so this surface must manage its own height. Panes inside
    // the shell own their inner scrolling.
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <TeamWorkspaceShell>{children}</TeamWorkspaceShell>
    </div>
  );
}
