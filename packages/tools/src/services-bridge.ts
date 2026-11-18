/**
 * Services bridge. `service_list` and `service_set` (Settings > Services over
 * MCP) read and switch the box's optional services, and the code that does
 * that lives in server/web (lib/services.ts: the services view, the request
 * file the updater reads), not in this package. Same shape as
 * box-status-bridge.ts: the web process installs the provider at boot; a
 * process that never installs one (the runner, the stdio MCP server, the
 * workers) gets a clear refusal instead of a crash.
 */
import type { OptionalServiceName, ServicesView, ServiceSwitchResult } from '@mantle/client-types';

export type ServicesProvider = {
  /** The Settings > Services view, as GET /api/services answers it. */
  view(ownerId: string): Promise<ServicesView>;
  /** The switch request, as POST /api/services/:name makes it. */
  set(name: OptionalServiceName, enable: boolean): Promise<ServiceSwitchResult>;
};

let provider: ServicesProvider | null = null;

export function registerServicesProvider(p: ServicesProvider | null): void {
  provider = p;
}

export function getServicesProvider(): ServicesProvider | null {
  return provider;
}

/** The refusal a process without the provider gives. */
export const SERVICES_UNAVAILABLE =
  "No services here: this box's services are read and switched by its web process. Call this tool over the box's MCP endpoint (/api/mcp), or use Settings > Services.";
