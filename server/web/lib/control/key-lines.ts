/**
 * The Control Center's hold on a box's key lines (docs/control-center.md,
 * "Key status on the fleet"), for the facts read (run.ts) and the key test
 * call (tool-calls.ts). CC code: only the control service loads it.
 */
import { z } from 'zod';
import { CONTROL_MAX_KEY_LINES, type ControlFacts } from '@mantle/db';
import { isFleetKeyService } from '@mantle/api-keys';
import { KEY_PRINT_RE, type ControlKeyLine } from '@mantle/client-types';

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** A key service as the box's list spells one. */
const KEY_SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/**
 * A box's key lines (key status on the fleet), held to their shape (else a
 * bad reply) and every string to a pattern: a line whose service or set
 * time does not fit is dropped, and so is one whose service is not on this
 * Control Center's own fixed list (isFleetKeyService: a box's free text
 * never passes as a service), a print that does not fit
 * (KEY_PRINT_RE: at most 12 of [A-Za-z0-9_-], the mark, then 4) is null,
 * a test with a bad time is null. At most CONTROL_MAX_KEY_LINES kept.
 */
export const KeyLines = z
  .array(
    z
      .object({
        service: z.string(),
        setAt: z.string(),
        print: z.string().nullable(),
        testable: z.boolean(),
        test: z.object({ ok: z.boolean(), at: z.string() }).strip().nullable(),
      })
      // A field a later box adds is dropped, not a bad reply.
      .strip(),
  )
  .transform((lines): ControlKeyLine[] =>
    lines
      .filter(
        (l) =>
          KEY_SERVICE.test(l.service) && isFleetKeyService(l.service) && STAMP_RE.test(l.setAt),
      )
      .slice(0, CONTROL_MAX_KEY_LINES)
      .map((l) => ({
        service: l.service,
        setAt: l.setAt,
        print: l.print !== null && KEY_PRINT_RE.test(l.print) ? l.print : null,
        testable: l.testable,
        test: l.test && STAMP_RE.test(l.test.at) ? { ok: l.test.ok, at: l.test.at } : null,
      })),
  );

/** The key part of a facts reply as the CC keeps it: absent stays absent (a
 *  box a release behind); null keeps the box's reason (`scope`, else
 *  `error`); lines that do not hold to KeyLines are `bad-reply` for the key
 *  part only, so the rest of the facts are kept. */
export function keyPart(keys: unknown, reason: unknown): Pick<ControlFacts, 'keys' | 'keysReason'> {
  if (keys === undefined) return {};
  if (keys === null) return { keys: null, keysReason: reason === 'scope' ? 'scope' : 'error' };
  const r = KeyLines.safeParse(keys);
  return r.success ? { keys: r.data } : { keys: null, keysReason: 'bad-reply' };
}
