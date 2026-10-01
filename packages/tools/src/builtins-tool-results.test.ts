/**
 * read_result binds a client's or member's turn to its own spills (client
 * logins C4): which callers are bound, and to which trace. The binding's
 * effect on the stored rows is tool-results.viewer.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ trace: { id: 'trace-1' } as { id: string } | null }));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentTrace: () => h.trace,
}));

describe('resultBindingFor', () => {
  it('binds a client and a team turn to the current trace', async () => {
    const { resultBindingFor } = await import('./builtins-tool-results');
    expect(resultBindingFor({ ownerId: 'o', surface: { kind: 'client', loginId: 'l' } })).toEqual({
      traceId: 'trace-1',
    });
    expect(resultBindingFor({ ownerId: 'o', surface: { kind: 'team', loginId: 'l' } })).toEqual({
      traceId: 'trace-1',
    });
  });

  it('a client turn with no trace is bound to nothing (reads no spill)', async () => {
    const { resultBindingFor } = await import('./builtins-tool-results');
    h.trace = null;
    expect(resultBindingFor({ ownerId: 'o', surface: { kind: 'client', loginId: 'l' } })).toEqual({
      traceId: null,
    });
    h.trace = { id: 'trace-1' };
  });

  it('owner paths are not bound', async () => {
    const { resultBindingFor } = await import('./builtins-tool-results');
    expect(resultBindingFor({ ownerId: 'o', surface: { kind: 'web' } })).toBeUndefined();
    expect(
      resultBindingFor({ ownerId: 'o', surface: { kind: 'owner', via: 'run' } }),
    ).toBeUndefined();
  });
});
