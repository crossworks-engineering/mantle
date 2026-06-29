'use client';

/**
 * Public presenter for a SHARED mini-app. Renders the app's published build
 * full-width in the sandboxed iframe, in PUBLIC mode (shareToken) so the bundle
 * + tool/db brokers resolve under /s/<token>/* (token-authed) — no owner session.
 */
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import type { ShareView } from '@/lib/shares';

export function AppPresenter({
  view,
  token,
}: {
  view: Extract<ShareView, { kind: 'app' }>;
  token: string;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl p-3 sm:p-6">
      <AppSandbox appId={view.appId} shareToken={token} />
    </div>
  );
}
