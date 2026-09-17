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
 * Since the jackdaw-repo-split P0 this package is the CONTRACT package: subpath
 * modules (`version`, `turn-streaming`, `traces-format`, `types/*`, `lib/*`, …)
 * carry the small dependency-free constants and helpers both sides of the wire
 * share. This root index stays types-only; subpaths may hold runtime code but
 * must remain zero-dependency and browser-safe.
 *
 * Dates are ISO strings here — that's how they cross the wire (JSON has no Date).
 *
 * The 2548 lines this file used to hold are now ./dto/*, split by domain
 * (2026-09-02 audit, tier 3). It changed 102 times in 90 days as one file, so
 * every screen that added a DTO collided with every other. The re-exports below
 * are the whole file: the package's public surface is unchanged, and a new DTO
 * now touches one domain module instead of this one.
 */

export * from './dto/agent-graph';
export * from './dto/agents';
export * from './dto/comms';
export * from './dto/heartbeats';
export * from './dto/turns';
export * from './dto/rows';
export * from './dto/views';
export * from './dto/recall';
