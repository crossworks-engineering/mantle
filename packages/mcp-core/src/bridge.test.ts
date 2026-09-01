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

import { BUILTIN_TOOLS } from '@mantle/tools';

import { registerMantleTools } from './build-server';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

type Registration = { schema: Record<string, z.ZodTypeAny>; handler: Handler };

/** Register the whole surface once and index it by slug. */
function surface(transport: 'stdio' | 'http' = 'stdio'): Map<string, Registration> {
  const out = new Map<string, Registration>();
  const fakeServer = {
    tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
      out.set(name, { schema, handler });
    },
  };
  registerMantleTools(fakeServer as never, 'owner-1', { transport });
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

  it('now exposes the rest of those groups too', () => {
    // These five were held back while bridging was a pure deduplication. The
    // widening has since been made deliberately (full parity — see the header
    // of build-server.ts), so they ship. email_send is the one worth naming:
    // it can send mail as the owner, and its boundary is the contacts
    // allowlist, which applies identically on every surface.
    const registered = surface();
    const nowInvited = [
      'email_send',
      'email_page',
      'note_from_file',
      'note_from_page',
      'peer_search_chunks',
    ];
    expect(nowInvited.filter((slug) => !registered.has(slug))).toEqual([]);
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

  it('is available on both transports', () => {
    // The contained shell is never the transport-dependent one — that is
    // run_terminal's job (below). A sandbox has no route to postgres, minio or
    // the web tier, so nothing about the network changes its blast radius.
    expect(surface('stdio').has('sandbox_exec')).toBe(true);
    expect(surface('http').has('sandbox_exec')).toBe(true);
  });
});

/**
 * The parity rule, enforced.
 *
 * The MCP surface is hand-maintained, so it drifts from the in-app catalog
 * silently: a tool group added for an agent simply never appears, and the
 * client cannot report a capability it was never told about. This test turns
 * every future gap into a failing build, and makes each deliberate exception
 * cost an entry with a reason attached.
 */
describe('every in-app tool reaches the MCP surface', () => {
  /** Registered under a different name, or structurally impossible here. */
  const EXCEPTIONS: Record<string, string> = {
    // Same handler, exposed as `search` since the first MCP release; shipped
    // clients call that name. Renaming is a client-visible break for no gain.
    search_nodes: 'exposed as `search`',
    // Needs a live delivery surface (a Telegram chat / the web reply stream) to
    // play the audio into. Over MCP it could only ever error.
    synthesize_speech: 'needs a delivery surface the bridge cannot supply',
  };

  it('exposes every builtin slug over stdio, except the documented ones', () => {
    const registered = surface('stdio');
    const missing = BUILTIN_TOOLS.map((t) => t.slug)
      .filter((slug) => !registered.has(slug) && !(slug in EXCEPTIONS))
      .sort();
    expect(missing).toEqual([]);
  });

  it('keeps the exception list honest', () => {
    // An exception that IS registered is stale and would mask a real gap.
    const registered = surface('stdio');
    const stale = Object.keys(EXCEPTIONS).filter((slug) => registered.has(slug));
    expect(stale).toEqual([]);
  });

  it("differs between transports only by the brain's own shell", () => {
    const stdio = new Set(surface('stdio').keys());
    const http = new Set(surface('http').keys());
    const stdioOnly = [...stdio].filter((slug) => !http.has(slug)).sort();
    const httpOnly = [...http].filter((slug) => !stdio.has(slug)).sort();

    expect(stdioOnly).toEqual(['run_terminal']);
    expect(httpOnly).toEqual([]);
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
