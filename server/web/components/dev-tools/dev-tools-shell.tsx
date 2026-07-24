'use client';

/**
 * API Console shell — library sidebar | request builder | response viewer,
 * plus the Toolsmith Assist panel docked on the right when open. Builder +
 * response sit side-by-side on xl screens and stack vertically below that;
 * the sidebar collapses into the page flow on mobile.
 */

import { DevToolsProvider, useDevTools } from './context';
import { DevToolsSidebar } from './sidebar';
import { RequestBuilder } from './request-builder';
import { ResponseViewer } from './response-viewer';
import { DevToolsAssistPanel } from './assist-panel';
import type { AgentToolInfo } from '@/lib/dev-tools/types';

function ShellInner() {
  const { assistOpen, setAssistOpen } = useDevTools();
  return (
    <div
      className={
        assistOpen
          ? 'md:grid md:h-full md:grid-cols-[300px_minmax(0,1fr)_auto] md:overflow-hidden'
          : 'md:grid md:h-full md:grid-cols-[300px_minmax(0,1fr)] md:overflow-hidden'
      }
    >
      <aside className="border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <DevToolsSidebar />
      </aside>
      <section className="grid min-h-0 md:h-full xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-xl:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-hidden border-b border-border xl:border-b-0 xl:border-r">
          <RequestBuilder />
        </div>
        <div className="min-h-0 overflow-hidden">
          <ResponseViewer />
        </div>
      </section>
      {assistOpen && (
        <div className="max-md:hidden md:h-full md:min-h-0">
          <DevToolsAssistPanel onClose={() => setAssistOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function DevToolsShell({ initialAgentTools }: { initialAgentTools: AgentToolInfo[] }) {
  return (
    <DevToolsProvider initialAgentTools={initialAgentTools}>
      <ShellInner />
    </DevToolsProvider>
  );
}
