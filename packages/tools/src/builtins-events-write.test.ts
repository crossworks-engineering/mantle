/**
 * Behavioural tests for event_create and event_update. Neither had one.
 *
 * The property worth pinning is the OMISSION contract, because the two tools
 * deliberately disagree on it and the description is the only place a model
 * is told. On create, an omitted `timezone` falls back to the owner's profile
 * zone (so the model can leave it out and the reminder still renders in the
 * right place). On update, omitted `endsAt` and `location` are CLEARED while
 * omitted `recurUntil` is KEPT: a tool that sent `null` for recurUntil would
 * silently end a series every time the user renamed an event.
 *
 * The store (`createEvent` / `updateEvent`) and the profile read are stubbed;
 * the tools' own guards, defaults and null-vs-undefined coercion are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    loadProfilePreferences: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});

import { createEvent, updateEvent, loadProfilePreferences } from '@mantle/content';
import { EVENT_TOOLS } from './builtins-events';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';
const STARTS = '2026-05-20T15:00:00Z';

const create = EVENT_TOOLS.find((t) => t.slug === 'event_create')!;
const update = EVENT_TOOLS.find((t) => t.slug === 'event_update')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const row = { id: ID, title: 'Dentist', startsAt: STARTS, timezone: 'Africa/Johannesburg' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadProfilePreferences).mockResolvedValue({
    timezone: 'Africa/Johannesburg',
    locale: 'en-ZA',
  } as never);
  vi.mocked(createEvent).mockResolvedValue(row as never);
  vi.mocked(updateEvent).mockResolvedValue(row as never);
});

describe('event_create', () => {
  it('requires title AND startsAt, and reads nothing without them', async () => {
    expect(errorOf(await create.handler({ title: 'Dentist' }, ctx))).toMatch(/startsAt/);
    expect(errorOf(await create.handler({ startsAt: STARTS, title: '  ' }, ctx))).toMatch(/title/);
    expect(createEvent).not.toHaveBeenCalled();
    // The profile read sits AFTER the guard: a half-formed call costs no query.
    expect(loadProfilePreferences).not.toHaveBeenCalled();
  });

  it('defaults the timezone from the owner profile when the caller omits it', async () => {
    const res = await create.handler({ title: 'Dentist', startsAt: STARTS }, ctx);

    expect(loadProfilePreferences).toHaveBeenCalledWith('o1');
    expect(createEvent).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        title: 'Dentist',
        startsAt: STARTS,
        timezone: 'Africa/Johannesburg',
        // Omitted optionals land as null, not as the string 'undefined'.
        endsAt: null,
        location: null,
        recurUntil: null,
        remindMinutesBefore: 0,
      }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID, url: `https://brain.test/n/${ID}` });
  });

  it('honours an explicit timezone without consulting the profile', async () => {
    await create.handler(
      { title: 'Flight', startsAt: STARTS, timezone: 'Europe/London', recur: 'weekly' },
      ctx,
    );

    expect(loadProfilePreferences).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ timezone: 'Europe/London', recur: 'weekly' }),
    );
  });

  it('drops an unknown recur value rather than passing it to the store', async () => {
    await create.handler({ title: 'X', startsAt: STARTS, recur: 'fortnightly' }, ctx);
    expect(createEvent).toHaveBeenCalledWith('o1', expect.objectContaining({ recur: undefined }));
  });

  it('surfaces a store failure as the tool error', async () => {
    vi.mocked(createEvent).mockRejectedValue(new Error('startsAt is not a valid instant'));
    expect(errorOf(await create.handler({ title: 'X', startsAt: 'tomorrow' }, ctx))).toMatch(
      /valid instant/,
    );
  });
});

describe('event_update', () => {
  it('refuses a blank id WITHOUT calling the store', async () => {
    expect(errorOf(await update.handler({ id: '', title: 'Y' }, ctx))).toMatch(/id/i);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('reports a miss as a failure that names event_list', async () => {
    vi.mocked(updateEvent).mockResolvedValue(null);
    const err = errorOf(await update.handler({ id: ID, title: 'Y' }, ctx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/event_list/);
  });

  it('clears endsAt/location when omitted but KEEPS recurUntil', async () => {
    const res = await update.handler({ id: ID, title: 'Dentist (moved)' }, ctx);

    expect(updateEvent).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({
        title: 'Dentist (moved)',
        endsAt: null,
        location: null,
        // undefined = leave unchanged. null here would end every series on
        // an unrelated edit.
        recurUntil: undefined,
        startsAt: undefined,
        timezone: undefined,
      }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID });
  });
});
