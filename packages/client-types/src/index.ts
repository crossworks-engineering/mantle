/**
 * @mantle/client-types — wire-shape (JSON) types for the HTTP API, shared by the
 * client components that consume `/api/**` (TanStack Query) and the server code
 * that produces the responses.
 *
 * Pure types: ZERO runtime, ZERO dependencies. That's the whole point — a client
 * component can name a row shape without importing `@mantle/db` (which drags
 * `postgres` into the browser bundle). This is the single source of truth for the
 * frontend/backend contract as screens move to client data-fetching (Phase 2 ·
 * Task 4); the server aliases its summary types to these so drift is a type error.
 *
 * Dates are ISO strings here — that's how they cross the wire (JSON has no Date).
 */

// ── Skills ────────────────────────────────────────────────────────────────────

/** A skill as returned by `GET /api/skills`. */
export interface SkillDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  /** Template state heartbeats inherit on create. */
  defaultState: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A heartbeat that references a skill — drives the "used by N heartbeats" badge. */
export interface HeartbeatRef {
  slug: string;
  name: string;
  status: string;
}

/** `GET /api/skills/backrefs` — heartbeat refs keyed by skill slug. */
export type SkillBackrefs = Record<string, HeartbeatRef[]>;

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Tool handler descriptor — the canonical wire shape. Mirrors @mantle/db's
 * `ToolHandler` union; kept standalone here so this package stays zero-dep (no
 * postgres type graph). Drift is caught where it matters: `@mantle/tools` aliases
 * `ToolSummary = ToolDTO`, so if db's union ever diverges from this one, that
 * package fails to compile.
 */
export type ToolHandler =
  | { kind: 'builtin'; ref: string }
  | {
      kind: 'http';
      url: string;
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string | null;
      headersRef?: string | null;
      authRef?: string | null;
      timeoutMs?: number;
    }
  | { kind: 'shell'; cmd: string };

/** A tool as returned by `GET /api/tools`. */
export interface ToolDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET/PUT /api/tools/settings` — the two owner-level tool policy toggles. */
export interface ToolSettings {
  /** Tools an agent authors (Toolsmith) start confirm-gated until cleared. */
  requireApproval: boolean;
  /** Unattended heartbeats park email/web calls for approval. */
  egressGate: boolean;
}
