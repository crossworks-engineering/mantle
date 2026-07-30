'use client';

import { useEffect } from 'react';
import { apiEventStream } from '@mantle/web-ui/api-fetch';

/**
 * Mantle Desktop integration. Renders nothing and does nothing in a browser —
 * it activates only when the page runs inside the desktop shell, which
 * injects `window.mantleDesktop` from its preload.
 *
 * Notifications ride the assistant's global outbound ping
 * (/api/assistant/stream — the same best-effort turn signal the mobile
 * companion's no-Google fallback subscribes to), forwarded to an OS
 * notification only while the window is hidden: a visible window already
 * shows the reply in-app. Best-effort by design — the stream has no replay,
 * so a ping during a reconnect gap is simply a missed toast, never lost data.
 */
type DesktopApi = {
  platform: string;
  notify(payload: { title: string; body?: string }): void;
  setBadge(count: number): void;
};

declare global {
  interface Window {
    mantleDesktop?: DesktopApi;
  }
}

export function DesktopBridge() {
  useEffect(() => {
    const desktop = window.mantleDesktop;
    if (!desktop) return;
    return apiEventStream('/api/assistant/stream', (data) => {
      if (document.visibilityState === 'visible') return;
      let event: { agentSlug?: string; direction?: string };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        return;
      }
      if (event.direction !== 'outbound') return;
      desktop.notify({
        title: 'Mantle',
        body: event.agentSlug ? `${event.agentSlug} replied` : 'Assistant replied',
      });
    });
  }, []);
  return null;
}
