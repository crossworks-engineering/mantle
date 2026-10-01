/**
 * A ViewerLevelConflictError (packages/db/src/viewer.ts) that reaches the
 * HTTP layer: a client scope asked to run public-level work, or the reverse.
 * Client and public read different items, so the work is refused, never
 * widened. The answer is a 403 with a reason code, not the opaque 500 of an
 * unhandled error. Matched by its code, not `instanceof`: a second copy of
 * the db module (a bundler split) must not turn the refusal back into a 500.
 */
export function isLevelConflict(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: unknown }).code === 'viewer-level-conflict'
  );
}

export function levelConflictResponse(err: unknown, path: string): Response | null {
  if (!isLevelConflict(err)) return null;
  const message = 'This is not available at your access level.';
  if (path === '/api' || path.startsWith('/api/')) {
    return Response.json(
      { error: 'forbidden', reason: 'level-conflict', message },
      { status: 403 },
    );
  }
  return new Response(message, { status: 403, headers: { 'content-type': 'text/plain' } });
}
