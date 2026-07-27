'use client';

/**
 * API Console shell — library sidebar | request builder | response viewer.
 * Builder + response sit side-by-side on xl screens and stack vertically below
 * that; the sidebar collapses into the page flow on mobile.
 *
 * Tool-authoring help comes from the GLOBAL assistant (⌘I / the Assist button
 * in the builder), same as every other screen: the responder keeps its
 * conversation context and delegates to Toolsmith via invoke_agent. The old
 * docked panel that invoked Toolsmith directly is gone — it was the last
 * surface with a pre-selected specialist, and switching to it discarded
 * everything the responder knew. The one property the panel had that the dock
 * doesn't is the post-reply tools refresh; the turn listener below restores it.
 */

import { useEffect } from 'react';
import { useAssistantDock } from '@/components/assistant/assistant-dock';
import { DevToolsProvider, useDevTools } from './context';
import { DevToolsSidebar } from './sidebar';
import { RequestBuilder } from './request-builder';
import { ResponseViewer } from './response-viewer';
import type { AgentToolInfo } from '@/lib/dev-tools/types';

function ShellInner() {
  const { refreshAgentTools } = useDevTools();
  const { registerTurnListener } = useAssistantDock();

  // A delegated Toolsmith run may have created/updated/deleted tools — reflect
  // it in the console's Agent-tools list when any turn settles while this
  // screen is mounted. Console-wide (no single node to pin), so unlike the
  // page/table editors this can't filter by nodeId; an occasional refresh for
  // an unrelated turn is one cheap list GET.
  useEffect(() => {
    return registerTurnListener((detail) => {
      if (detail.status === 'done') void refreshAgentTools();
    });
  }, [registerTurnListener, refreshAgentTools]);

  return (
    <div className="md:grid md:h-full md:grid-cols-[300px_minmax(0,1fr)] md:overflow-hidden">
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
