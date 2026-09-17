/**
 * A turn's media must land on the DURABLE row, not only on the live wire.
 *
 * `show_image` built a correct ToolArtifact on every call and the picture still
 * never appeared: artifacts ride the response body, which only the LEGACY
 * BLOCKING path returns. With streaming on, the route answers 202 with a turn
 * id and the client reconciles to `assistant_messages` — where `attachments`
 * was never written, so it stayed `[]`. Four successful tool calls, nothing on
 * screen, nothing failed.
 *
 * Same chain-capturing shape as conversation.supersede.test.ts: `@mantle/db` is
 * mocked so the SET payload can be inspected directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        h.updates.push(payload);
        return {
          where: () => ({ returning: () => Promise.resolve([{ id: 'out-1' }]) }),
        };
      },
    }),
  },
}));

import { updateAssistantMessageOutcome } from './conversation';

const base = { ownerId: 'o-1', id: 'out-1', status: 'complete' as const, text: 'here it is' };

beforeEach(() => {
  h.updates.length = 0;
});

describe('updateAssistantMessageOutcome — durable media', () => {
  it('writes the attachments a turn produced', async () => {
    await updateAssistantMessageOutcome({
      ...base,
      attachments: [
        { kind: 'image', nodeId: 'file-9', mime: 'image/png', caption: 'The APN settings screen' },
      ],
    });
    expect(h.updates[0]!.attachments).toEqual([
      { kind: 'image', nodeId: 'file-9', mime: 'image/png', caption: 'The APN settings screen' },
    ]);
  });

  it('leaves the column ALONE when the turn produced none', async () => {
    // Not the same as writing []: the insert may already have recorded the
    // user's own upload, and a blind overwrite would erase it.
    await updateAssistantMessageOutcome(base);
    expect(h.updates[0]).not.toHaveProperty('attachments');
  });

  it('leaves it alone for an empty list too', async () => {
    await updateAssistantMessageOutcome({ ...base, attachments: [] });
    expect(h.updates[0]).not.toHaveProperty('attachments');
  });

  it('still persists the reply and status alongside the media', async () => {
    await updateAssistantMessageOutcome({
      ...base,
      attachments: [{ kind: 'image', nodeId: 'file-9' }],
    });
    expect(h.updates[0]).toMatchObject({ status: 'complete', text: 'here it is' });
  });
});
