/**
 * A kind's root folder (a branch at the top: notes, pages, tables ...): the
 * brain's structure, homed in Admin by mantle_default_home whoever's create
 * made it first (0267). Made on the system pool as system(repair:kind-root),
 * the named read-path write (READ_PATH_WRITES), never as the caller: on the
 * write role a login's scope reads no Admin-homed row, so
 * the root's insert, a no-op when it exists, would fail its row rule and,
 * for a login that is not a Moderator of Admin, its write check. Every
 * kind's ensureRoot comes through here: the one place a root is made.
 */
import { runReadPathWrite } from '@mantle/db';

/** Run `fn` (a kind's root insert, on conflict nothing) as
 *  system(repair:kind-root). */
export function asKindRootRepair<T>(fn: () => Promise<T>): Promise<T> {
  return runReadPathWrite('repair:kind-root', fn);
}
