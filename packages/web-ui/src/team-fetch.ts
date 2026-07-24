/**
 * Client-side transport for the team-member surface (/team, /hub → /api/team/*
 * and the /s app brokers).
 *
 * Mirrors api-fetch's split-awareness with the MEMBER credential: same-origin
 * (empty runtime base) sends a plain relative request with cookies — byte-
 * identical to the raw `fetch` these surfaces used pre-split, so a monolith
 * topology can't regress. Cross-origin (split client app) it targets the
 * server origin and attaches the signed team-chat bearer from localStorage
 * (minted by POST /api/team/auth {mode:'bearer'}), `credentials: 'omit'` —
 * the server's CORS deliberately never allows credentials.
 *
 * Deliberately Response-level (no JSON-throwing wrapper): the member screens
 * branch on `res.status` themselves — 401 flips them to the token gate, not
 * to /login, which is why this is not api-fetch with a different key.
 *
 * The storage key is contract with e2e/lib/contract.ts — the split suite
 * seeds it directly.
 */

import { runtimeApiBase } from './runtime-env';
import { eventStreamCore } from './api-fetch';

const TEAM_TOKEN_STORAGE_KEY = 'mantle_team_token';

function canStore(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Browser-side store for the member's signed team-chat bearer. localStorage
 *  by design (see token-store.ts — the zero-secret client never holds auth
 *  server-side; enforcement is the server origin's 401s + per-request
 *  membership liveness). */
export const teamTokenStore = {
  get(): string | null {
    if (!canStore()) return null;
    try {
      return window.localStorage.getItem(TEAM_TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    if (!canStore()) return;
    try {
      window.localStorage.setItem(TEAM_TOKEN_STORAGE_KEY, token);
    } catch {
      /* storage unavailable (private mode etc.) — the session just won't persist */
    }
  },
  clear(): void {
    if (!canStore()) return;
    try {
      window.localStorage.removeItem(TEAM_TOKEN_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

/** Resolve a path against the runtime API base — the server origin in the
 *  split client, same-origin (empty base) otherwise. */
export function teamUrl(path: string): string {
  return `${runtimeApiBase()}${path}`;
}

/** Build a `RequestInit` carrying the member credential: cookies same-origin,
 *  the team bearer (no credentials) cross-origin — the exact mirror of
 *  api-fetch's `withAuth`. */
export function withTeamAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = teamTokenStore.get();
  if (runtimeApiBase() && token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return {
    credentials: runtimeApiBase() ? 'omit' : 'include',
    ...init,
    headers,
  };
}

/** Fetch with the member credential, returning the raw `Response` — callers
 *  own status handling (401 → token gate). FormData bodies pass through
 *  untouched (forum uploads). */
export function teamFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(teamUrl(path), withTeamAuth(init));
}

/**
 * SSE for the member surface — the EventSource replacement (EventSource can't
 * set an Authorization header, so it could never follow the credential across
 * origins). Same reader as the owner's `apiEventStream` (frame parsing,
 * Last-Event-ID resume, backoff+jitter, 404-silent-fallback); on auth failure
 * it clears the stored bearer and calls `onUnauthorized` (the caller shows
 * the token gate) instead of bouncing to /login.
 */
export function teamEventStream(
  path: string,
  onMessage: (data: string) => void,
  opts?: {
    onError?: (err: unknown) => void;
    onUnauthorized?: () => void;
    /** Bound CONSECUTIVE failed reconnects — after this many, `onExhausted`
     *  fires instead of retrying forever. Turn-stream consumers use it to
     *  reconcile against the durable reply so an outage can't strand a
     *  spinner (the server's replay buffer lives 15 min — a reconnect inside
     *  that window replays the missed `done`). */
    maxAttempts?: number;
    onExhausted?: () => void;
  },
): () => void {
  return eventStreamCore(
    (headers, signal) => teamFetch(path, { signal, headers }),
    () => {
      teamTokenStore.clear();
      opts?.onUnauthorized?.();
    },
    onMessage,
    {
      onError: opts?.onError,
      maxAttempts: opts?.maxAttempts,
      onExhausted: opts?.onExhausted,
    },
  );
}
