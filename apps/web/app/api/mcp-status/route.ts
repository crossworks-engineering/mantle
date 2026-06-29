/**
 * Health check for Settings → MCP "Check" button. Does a loopback handshake to
 * the box's OWN public connector URL (no token) and reports what it sees — this
 * exercises the real external path (through the proxy / TLS), not just an
 * in-process call, so it catches a misconfigured MANTLE_PUBLIC_URL or a proxy
 * that doesn't route /api/mcp. Owner-only.
 *
 * Expected healthy result when enabled: 401 + WWW-Authenticate (the endpoint is
 * live and correctly OAuth-gated). 404 means the connector is disabled.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { connectorUrl } from '@/lib/mcp-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const url = connectorUrl();
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mantle-status', version: '0' },
    },
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: initialize,
      signal: AbortSignal.timeout(5000),
    });
    const hasChallenge = !!res.headers.get('www-authenticate');
    if (res.status === 401 && hasChallenge) {
      return NextResponse.json({ ok: true, status: res.status, message: 'Live and OAuth-gated — ready to connect.' });
    }
    if (res.status === 404) {
      return NextResponse.json({ ok: false, status: 404, message: 'The connector is disabled — enable it first.' });
    }
    if (res.status === 429) {
      return NextResponse.json({ ok: false, status: 429, message: 'Rate-limited right now — try again in a moment.' });
    }
    return NextResponse.json({ ok: false, status: res.status, message: `Unexpected response (HTTP ${res.status}).` });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ ok: false, status: 0, message: `Could not reach ${url} — ${reason}` });
  }
}
