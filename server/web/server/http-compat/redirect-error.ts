/**
 * Control-flow replacement for next/navigation's `redirect()` in server code
 * paths (page-nav gates like `requireOwner`). Thrown where Next would throw its
 * internal NEXT_REDIRECT signal; the Hono app's onError translates it into a
 * real 307 response.
 */
export class RedirectError extends Error {
  constructor(
    public readonly location: string,
    public readonly status: 307 | 308 | 302 | 303 = 307,
  ) {
    super(`redirect:${location}`);
    this.name = 'RedirectError';
  }
}
