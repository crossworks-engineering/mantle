/**
 * Key status on the fleet (docs/control-center.md, "Key status on the
 * fleet"): per box, one line for each provider key it holds, with when it
 * was set, whether its last test passed, and a short print to match it with
 * the provider's own dashboard. Never a key, never a hash of one.
 */

/** The pattern of a key print: at most 12 characters of the key's head,
 *  the mark `…`, then its last 4. Anything else is dropped (null). */
export const KEY_PRINT_RE = /^[A-Za-z0-9_-]{0,12}…[A-Za-z0-9_-]{4}$/;

/** One provider key as a box answers it (the `keys` part of its facts,
 *  and its `keyTest` answer). */
export type ControlKeyLine = {
  /** The service, e.g. `openrouter`: on the box's own fixed list. */
  service: string;
  /** When the box's vault last wrote the key (ISO). */
  setAt: string;
  /** e.g. `sk-or-v1-abc…wxyz`, or null (a short key, or one with other
   *  characters in the part shown). */
  print: string | null;
  /** Whether the box can test a key of this service. */
  testable: boolean;
  /** The last test of this key, by anyone (the CC, the Keys screen, an
   *  agent), or null: never tested. */
  test: { ok: boolean; at: string } | null;
};

/**
 * What a line means, worked out by the CC from the line:
 *  - `works`: the last test passed, after the key was set;
 *  - `failed`: the last test, after the key was set, did not pass (the
 *    provider refused it, or could not be reached);
 *  - `stale`: the key was set again after its last test;
 *  - `not-tested`: never tested;
 *  - `no-test`: this service has no test.
 */
export type FleetKeyState = 'works' | 'failed' | 'stale' | 'not-tested' | 'no-test';

/** One line of the key status screen. */
export type FleetKeyLine = ControlKeyLine & { state: FleetKeyState };

/**
 * One box in GET /api/fleet/keys (and POST /api/fleet/keys/test).
 * `id` is the box id, or `self` for the Control Center's own box (always
 * first).
 *
 * `keys` is null when the box sent no lines; `keysReason` says why:
 *  - `old-box`: the box is a release behind (no key status yet);
 *  - `scope`: the box refuses the CC (MANTLE_CONTROL_CENTER_SCOPE=none);
 *  - `no-facts`: the box has not answered a facts read yet;
 *  - `error`: the box could not read its keys (its other facts still came),
 *    or, on `self`, its read or test failed;
 *  - `bad-reply`: the CC refused the shape of the box's key part;
 *  - `keys-area` (`self` only): the person lacks the Admin `keys` area, which
 *    the CC's own keys need, as on its Keys screen.
 * With lines, `keysReason` is null.
 *
 * `at` is when the lines were read (the box's own time), `reason` why the
 * last read failed, if it did (`unreachable`, `bad-reply`, ...): the old
 * lines stay, with their own `at`.
 */
export type FleetKeyBox = {
  id: string;
  url: string | null;
  label: string | null;
  at: string | null;
  reason: string | null;
  keys: FleetKeyLine[] | null;
  keysReason: 'old-box' | 'scope' | 'no-facts' | 'error' | 'bad-reply' | 'keys-area' | null;
  /** The last key set from the CC on this box: service, ok or a reason,
   *  who, when (the Fleet key set's own record). Null on `self`. */
  lastSet: {
    service: string;
    ok: boolean;
    reason: string | null;
    by: string;
    at: string;
  } | null;
};

/** GET /api/fleet/keys. */
export type FleetKeyStatus = { boxes: FleetKeyBox[] };

/** POST /api/fleet/keys/test: each box asked, with its fresh lines when it
 *  answered. `tested` per box: `ok`, or a reason code (`scope`,
 *  `bad-call` from a box a release behind, `unreachable`, `http-500` when
 *  a test could not run there, `busy` when 10 calls already wait, `pending`
 *  when the box did not answer within the wait: read GET /api/fleet/keys
 *  again a little later; on `self`, `keys-area` for a person without the
 *  `keys` area, and `error` when its test failed: the other boxes' answers
 *  still come). */
export type FleetKeyTestAnswer = {
  boxes: (FleetKeyBox & { tested: 'ok' | string })[];
};
