/**
 * The login's shape (plan v3.2 section 2.2): the login type carries no
 * `kind` and no `role`; whether it is an Admin user comes from its scope
 * (adminFacts). getLoginOr401 answers the one Login of ./login.ts.
 *
 * LOGIN_SHAPE_PIN says which of the two the type has now, and the compiler
 * holds it to the type (`pnpm -r typecheck`): a change of the login type
 * that does not flip the pin fails typecheck, and so does a flip the type
 * does not back. The scoreboard reads the pin (loginTypeKindOrRole in
 * scripts/arch-scoreboard.pins.json, down only), so the step that takes
 * `kind` or `role` off flips its literal to false and lowers the pin.
 */
import type { NextResponse } from '../../server/http-compat';
import { describe, expect, it } from 'vitest';
import type { getLoginOr401 } from './session';
import type { Login as TheLogin } from './login';

/** What a signed-in request's login is (every shape of it). */
type Login = Exclude<Awaited<ReturnType<typeof getLoginOr401>>, NextResponse>;

type KeysOf<T> = T extends unknown ? keyof T : never;

/** The keys of each shape, and of the records it carries (the user or
 *  member record). The actor is left out: it is the login's binding to
 *  the database (who a statement runs as), not the shape decisions read. */
type ShapeKeys<L> = L extends unknown
  ? | keyof L
    | {
        [K in Exclude<keyof L, 'actor'>]: L[K] extends object ? KeysOf<L[K]> : never;
      }[Exclude<keyof L, 'actor'>]
  : never;

type Has<K extends string> = K extends ShapeKeys<Login> ? true : false;

/** Which of `kind` and `role` the login type has today. */
export const LOGIN_SHAPE_PIN: { kind: Has<'kind'>; role: Has<'role'> } = {
  kind: false,
  role: false,
};

/** Its keys, exactly: a key added or taken off fails typecheck. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const LOGIN_KEYS: Same<
  keyof Login,
  | 'loginId'
  | 'brainId'
  | 'email'
  | 'displayName'
  | 'contactId'
  | 'source'
  | 'sessionEpoch'
  | 'actor'
> = true;
/** getLoginOr401 answers ./login.ts's Login, one shape. */
const ONE_LOGIN: Same<Login, TheLogin> = true;

describe('the login type', () => {
  it('has the pinned shape: neither kind nor role', () => {
    expect(LOGIN_SHAPE_PIN).toEqual({ kind: false, role: false });
    expect([LOGIN_KEYS, ONE_LOGIN]).toEqual([true, true]);
  });
});
