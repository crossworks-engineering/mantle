/**
 * The declaration's type and its one validator (route-declaration.ts, the
 * route declarations of plan v3.2). The type is checked by tsc on this
 * file (`pnpm -r typecheck`): each `@ts-expect-error` below is a shape the
 * type refuses at the line it is written, at every level (routePolicy is
 * not generic, so an excess key is an error in a method, an item and the
 * limits alike). validateMethodPolicy says the same at run time, for the
 * generator and the boot.
 */
import { describe, expect, it } from 'vitest';
import {
  DECLARED_KEYS,
  ITEM_NONE_PLACEHOLDER,
  methodEffect,
  routePolicy,
  validateMethodPolicy,
  validateRoutePolicy,
} from './route-declaration';

const none = { none: 'a test row' } as const;

/** Shapes the type takes, and shapes it refuses (tsc reads this). */
export const typed = [
  routePolicy({
    GET: { class: 'content', open: 'owner' },
    HEAD: { class: 'content' },
    POST: { class: 'content', open: 'owner', creates: true, item: none },
    PATCH: { class: 'content', item: { param: 'id', need: 'edit' }, limits: { crossSite: 'json' } },
    DELETE: { class: 'area', area: 'settings', item: none, audit: 'own' },
  }),
  routePolicy({
    GET: { class: 'area', area: 'connectors', effect: { write: 'stores tokens' }, item: none },
    POST: { class: 'content', effect: { read: 'evaluates only' } },
  }),
  routePolicy({
    // @ts-expect-error an excess key in a method
    GET: { class: 'content', wat: 1 },
  }),
  routePolicy({
    // @ts-expect-error a write says its item
    POST: { class: 'content' },
  }),
  routePolicy({
    // @ts-expect-error a read says none
    GET: { class: 'content', item: none },
  }),
  routePolicy({
    // @ts-expect-error the effect is the method's: only an exception, with its reason
    GET: { class: 'content', effect: 'read' },
  }),
  routePolicy({
    // @ts-expect-error an exception that is the method's own effect
    POST: { class: 'content', effect: { write: 'x' }, item: none },
  }),
  routePolicy({
    // @ts-expect-error an excess key in an item
    POST: { class: 'content', item: { none: 'x', param: 'id' } },
  }),
  routePolicy({
    // @ts-expect-error an excess key in the limits
    POST: { class: 'content', item: none, limits: { rateLimits: [] } },
  }),
  routePolicy({
    // @ts-expect-error a limit no RATE_LIMITS entry names
    POST: { class: 'content', item: none, limits: { rateLimit: ['bogus'] } },
  }),
  routePolicy({
    // @ts-expect-error an area on a row of another class
    GET: { class: 'content', area: 'settings' },
  }),
  routePolicy({
    // @ts-expect-error no method
    GOT: { class: 'content' },
  }),
];

describe('validateMethodPolicy: the one validator', () => {
  it('takes what the type takes', () => {
    for (const decl of typed.slice(0, 2)) {
      const methods = Object.keys(decl);
      expect(validateRoutePolicy(decl, '/api/x/:id', methods)).toBe(decl);
    }
  });

  it('refuses what the type refuses, and what it cannot say', () => {
    const refused = typed.slice(2).map((decl) => {
      try {
        validateRoutePolicy(decl, '/api/x', Object.keys(decl));
        return null;
      } catch (e) {
        return String(e);
      }
    });
    // The rate limit's name is the boot's (route-limits.ts, gatesOf): it is
    // the only one the pure validator does not refuse.
    expect(refused.map((r) => r === null)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(() => validateMethodPolicy(null, '/api/x', 'GET')).toThrow(/no object/);
    expect(() => validateMethodPolicy([], '/api/x', 'GET')).toThrow(/no object/);
    expect(() => validateRoutePolicy(null, '/api/x', ['GET'])).toThrow(/no object/);
  });

  it('the effect is the method’s; every write says an item', () => {
    expect(methodEffect('GET')).toBe('read');
    expect(methodEffect('head')).toBe('read');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
      expect(methodEffect(m)).toBe('write');
    expect(() =>
      validateMethodPolicy(
        { class: 'content', item: { none: ITEM_NONE_PLACEHOLDER } },
        '/api/x',
        'DELETE',
      ),
    ).not.toThrow();
  });

  it('knows every key the type has (the type pins the same, at compile time)', () => {
    expect([...DECLARED_KEYS].sort()).toEqual(
      [
        'aliasOf',
        'area',
        'audit',
        'base',
        'caller',
        'class',
        'creates',
        'effect',
        'item',
        'keyArea',
        'limits',
        'makesItems',
        'open',
        'public',
        'scope',
      ].sort(),
    );
  });
});
