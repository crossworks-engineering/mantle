/**
 * A route's params schema (A10 lows, part 2 #1; docs/request-plumbing.md,
 * "Path params"): what each dynamic segment of its path must be. The route
 * loader reads it once the handler's module is loaded and the caller is
 * answered, and a request whose segment is not what the schema says gets
 * the one 404 (`{ error: 'not found' }`) before the handler runs: an id
 * that is not a uuid names nothing, so it never reaches the database, where
 * the uuid cast refused it as an opaque 500.
 *
 * A route declares it in its own file, beside its handlers, so it moves
 * with the file:
 *
 *     export const routeParams = { id: 'uuid' } as const satisfies RouteParams;
 *
 * Every method of the file is held to it. An /api/v1 alias that re-exports
 * a base route's handlers re-exports its `routeParams` too (pinned by
 * route-params.test.ts).
 */
import { isUuid } from '@mantle/std';
import { CACHE_CONTROL } from './cache-control';

/** What a segment can be held to. */
export const ROUTE_PARAM_KINDS = { uuid: isUuid } as const;

export type RouteParamKind = keyof typeof ROUTE_PARAM_KINDS;

/** A route file's declaration: each segment name to its kind. */
export type RouteParams = Readonly<Record<string, RouteParamKind>>;

/** The name of the export a route file declares its params by. */
export const ROUTE_PARAMS_EXPORT = 'routeParams';

/** The one answer for a segment the schema refuses. */
function notFound(): Response {
  return Response.json(
    { error: 'not found' },
    { status: 404, headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}

/**
 * The answer for a request whose `params` the module's schema (`declared`,
 * the module's `routeParams`, or undefined) refuses, else null. A schema
 * that names a segment the pattern does not have, or a kind there is none
 * of, throws: a declaration that cannot hold is a bug, never a pass.
 */
export function routeParamsRefusal(
  declared: unknown,
  pattern: string,
  params: Readonly<Record<string, string | string[]>>,
): Response | null {
  if (declared === undefined) return null;
  if (!declared || typeof declared !== 'object') {
    throw new Error(`${pattern}: ${ROUTE_PARAMS_EXPORT} is not an object`);
  }
  for (const [name, kind] of Object.entries(declared)) {
    if (!pattern.split('/').includes(`:${name}`)) {
      throw new Error(`${pattern}: ${ROUTE_PARAMS_EXPORT} names ${name}, which it has not`);
    }
    const check = (ROUTE_PARAM_KINDS as Record<string, (v: unknown) => boolean>)[String(kind)];
    if (!check) throw new Error(`${pattern}: ${ROUTE_PARAMS_EXPORT}.${name} is no kind`);
    if (!check(params[name])) return notFound();
  }
  return null;
}
