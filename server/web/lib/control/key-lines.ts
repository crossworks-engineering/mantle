/**
 * The Control Center's hold on a box's key lines (docs/control-center.md,
 * "Key status on the fleet"), for the facts read (run.ts) and the key test
 * call (tool-calls.ts). CC code: only the control service loads it.
 */
import { z } from 'zod';
import { CONTROL_MAX_KEY_LINES } from '@mantle/db';
import { KEY_PRINT_RE, type ControlKeyLine } from '@mantle/client-types';

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** A key service as the box's list spells one. */
const KEY_SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/**
 * A box's key lines (key status on the fleet), held to their shape (else a
 * bad reply) and every string to a pattern: a line whose service or set
 * time does not fit is dropped, a print that does not fit
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
      .filter((l) => KEY_SERVICE.test(l.service) && STAMP_RE.test(l.setAt))
      .slice(0, CONTROL_MAX_KEY_LINES)
      .map((l) => ({
        service: l.service,
        setAt: l.setAt,
        print: l.print !== null && KEY_PRINT_RE.test(l.print) ? l.print : null,
        testable: l.testable,
        test: l.test && STAMP_RE.test(l.test.at) ? { ok: l.test.ok, at: l.test.at } : null,
      })),
  );
