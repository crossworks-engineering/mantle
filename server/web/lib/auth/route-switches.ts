/**
 * The switches a route can be served under: a route whose switch is
 * answered FIRST, before any login's answer, so while the switch is off
 * every credential that reaches it gets the route's off answer. The gate
 * answers that switch before the login's answer (route-policy.ts
 * routeSwitchedOff), and the handler reads the caller first.
 *
 * A route declares its switch in its own file, beside its handler, so the
 * declaration moves with the file (a rename cannot drop it):
 *
 *     export const routeSwitches = { POST: 'not-production' } as const satisfies RouteSwitches;
 *
 * The route manifest generator reads it (scripts/route-callers.ts
 * handlerSwitches) into the manifest (`switches`), and the route's rows
 * carry it (RouteRow.switch). Only the names: no dependency here, so the
 * generator can read them without loading the app.
 */

/** Every switch a route can declare; route-policy.ts SWITCHES holds each
 *  one's check and its off answer. */
export const ROUTE_SWITCH_NAMES = ['turn-streaming', 'not-production', 'telegram-policy'] as const;

export type RouteSwitch = (typeof ROUTE_SWITCH_NAMES)[number];

/** The name of the export a route file declares its switches by. */
export const ROUTE_SWITCHES_EXPORT = 'routeSwitches';

/** A route file's declaration: each method it exports to its switch (a
 *  HEAD answered by the GET handler takes its GET's). */
export type RouteSwitches = Readonly<
  Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS', RouteSwitch>>
>;

/** Whether `name` is a switch a route can declare. */
export function isRouteSwitch(name: string): name is RouteSwitch {
  return (ROUTE_SWITCH_NAMES as readonly string[]).includes(name);
}
