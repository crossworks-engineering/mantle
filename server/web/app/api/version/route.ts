import { NextResponse } from 'next/server';
import { APP_VERSION, GIT_SHA, BUILD_TIME } from '@mantle/web-ui/version';

// Build identity for ops / uptime checks. Values are baked in at compile time
// (next.config.ts), so this is constant for the life of the build — serve it
// static and cacheable. Intentionally unauthenticated: nothing sensitive, and
// it's handy for a probe to read without a session.
export const dynamic = 'force-static';

export function GET() {
  return NextResponse.json({
    version: APP_VERSION,
    gitSha: GIT_SHA || null,
    buildTime: BUILD_TIME || null,
  });
}
