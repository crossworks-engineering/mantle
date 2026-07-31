/**
 * The builtin bridge — the path that exposes in-app `BuiltinToolDef`s over MCP.
 *
 * Its whole reason to exist is that the two surfaces run ONE implementation, so
 * these tests pin the two places where the bridge used to quietly do less than
 * the in-app dispatcher did: declared preconditions were never checked, and the
 * JSON-Schema → zod conversion dropped every size bound, leaving MCP the only
 * surface that would accept an out-of-range argument.
 *
 * Both are driven through the real registration path against a capturing fake
 * server; nothing here touches the database or a model.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerMantleTools } from './build-server';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

type Registration = { schema: Record<string, z.ZodTypeAny>; handler: Handler };

/** Register the whole surface once and index it by slug. */
function surface(): Map<string, Registration> {
  const out = new Map<string, Registration>();
  const fakeServer = {
    tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
      out.set(name, { schema, handler });
    },
  };
  registerMantleTools(fakeServer as never, 'owner-1');
  return out;
}

function registrationFor(slug: string): Registration {
  const found = surface().get(slug);
  if (!found) throw new Error(`tool ${slug} not registered`);
  return found;
}

describe('bridged tools run their declared preconditions', () => {
  it('answers a non-id argument with the teaching error, not a bare not-found', async () => {
    // contact_get declares an `id` precondition of nodeType 'contact'. A
    // malformed id is refused before any lookup, so this exercises the bridge
    // without a database.
    const { handler } = registrationFor('contact_get');
    const res = await handler({ id: 'Jane Smith' });

    expect(res.isError).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toContain('must be a contact id (UUID)');
    expect(text).toContain('Jane Smith');
    // The point of the teaching error: it says what to do next.
    expect(text).toContain('contact_find');
  });

  it('lets a well-formed argument through to the handler', async () => {
    // A syntactically valid id passes the precondition and reaches the handler,
    // which is where a genuine "no such contact" is decided. Any outcome other
    // than the malformed-id refusal proves the gate did not over-reach.
    const { handler } = registrationFor('contact_get');
    const res = await handler({ id: '00000000-0000-4000-8000-000000000000' }).catch(
      (err: unknown) => ({ content: [{ type: 'text', text: String(err) }], isError: true }),
    );
    expect(res.content[0]!.text).not.toContain('must be a contact id (UUID)');
  });
});

describe('bridged schemas keep the bounds their definitions declare', () => {
  it('enforces numeric minimum/maximum', () => {
    const { schema } = registrationFor('contact_find');
    const limit = schema.limit;
    expect(limit, 'contact_find should expose a `limit`').toBeDefined();

    expect(limit!.safeParse(10).success).toBe(true);
    // Declared as minimum 1 / maximum 25 — both ends must be live.
    expect(limit!.safeParse(0).success).toBe(false);
    expect(limit!.safeParse(26).success).toBe(false);
  });

  it('enforces bounds on a second tool, so the fix is in the converter not one def', () => {
    const { schema } = registrationFor('contact_list');
    expect(schema.limit!.safeParse(500).success).toBe(false); // maximum 200
    expect(schema.offset!.safeParse(-1).success).toBe(false); // minimum 0
    expect(schema.limit!.safeParse(50).success).toBe(true);
  });

  it('still accepts an unbounded field of the same type', () => {
    const { schema } = registrationFor('contact_find');
    expect(schema.query!.safeParse('anything at all').success).toBe(true);
  });
});
