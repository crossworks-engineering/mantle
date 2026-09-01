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

/**
 * Replacing the hand-written content tools with bridged groups had to be a
 * swap, not a trade: every slug MCP exposed before must still be there, and no
 * slug may have arrived just because it happened to sit in the same group.
 */
describe('bridging the content groups changed the implementation, not the surface', () => {
  const PREVIOUSLY_EXPOSED = [
    'note_list',
    'note_get',
    'note_create',
    'note_update',
    'note_delete',
    'task_list',
    'task_get',
    'task_create',
    'task_update',
    'task_delete',
    'event_list',
    'event_get',
    'event_create',
    'event_update',
    'event_delete',
    'journal_list',
    'journal_get',
    'journal_create',
    'journal_update',
    'journal_delete',
    'peer_list',
    'peer_query',
    'peer_node_get',
    'email_list',
    'email_get',
  ];

  it('still exposes every content tool it exposed before', () => {
    const registered = surface();
    expect(PREVIOUSLY_EXPOSED.filter((slug) => !registered.has(slug))).toEqual([]);
  });

  it('does not expose the other members of the groups it bridged', () => {
    // email_send in particular: bridging EMAIL_TOOLS wholesale would hand an
    // MCP client the ability to send mail as the owner. That is a product
    // decision, not a side effect of removing duplication.
    const registered = surface();
    const notInvited = [
      'email_send',
      'email_page',
      'note_from_file',
      'note_from_page',
      'peer_search_chunks',
    ];
    expect(notInvited.filter((slug) => registered.has(slug))).toEqual([]);
  });
});

describe('CLI sandboxes are on the MCP surface', () => {
  // The contained shell is the ONE command-execution path an MCP client gets.
  // Before this it had none, and a client asked to work in a sandbox could only
  // report that no such tool existed — the brain's own coder agent held the
  // group, nothing else did. Pin the whole group so a future group edit cannot
  // silently drop one verb (an exec you can start but not stop is worse than
  // no exec at all).
  const SANDBOX_SLUGS = [
    'sandbox_create',
    'sandbox_exec',
    'sandbox_list',
    'sandbox_stop',
    'sandbox_rm',
    'sandbox_export',
    'sandbox_publish',
    'sandbox_mcp_tools',
    'sandbox_mcp_call',
  ];

  it('exposes every sandbox verb', () => {
    const registered = surface();
    expect(SANDBOX_SLUGS.filter((slug) => !registered.has(slug))).toEqual([]);
  });

  it("does not expose the server's own shell", () => {
    // run_terminal acts on the brain's container — postgres, minio, the file
    // store, the master key. `sandbox_exec` is its contained sibling and is the
    // only reason this surface can run a command at all. Bridging TERMINAL_TOOLS
    // would be a separate product decision, never a side effect.
    expect(surface().has('run_terminal')).toBe(false);
  });
});

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
