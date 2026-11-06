/**
 * A tool group's tool list as the routes take it (POST /api/tool-groups,
 * PATCH /api/tool-groups/:id): never an agent UI tool (docs/agent-ui.md).
 * No database.
 */
import { describe, expect, it } from 'vitest';
import { ToolSlugList } from './tool-groups';

describe('ToolSlugList', () => {
  it('refuses a ui tool, takes every other slug', () => {
    expect(ToolSlugList.safeParse(['page_get', 'note_create']).success).toBe(true);
    const bad = ToolSlugList.safeParse(['page_get', 'ui_type']);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain('agent UI tools');
  });
});
