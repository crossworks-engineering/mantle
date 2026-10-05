/**
 * An outside Claude learns how a mini app knows who runs it (task 603f6970).
 *
 * Claude on claude.ai, building an app through the MCP connector, told a
 * member that "user session detail is not available in the app": nothing on
 * the MCP surface named host.me() or the :host_me_* SQL parameters. This pins
 * the three places an MCP client now meets them: the server instructions, the
 * front of the app authoring tool descriptions (what the tool-search ranker
 * reads), and the `app_authoring_guide` read tool that serves the full guide.
 */

import { describe, expect, it } from 'vitest';

import { MANTLE_MCP_INSTRUCTIONS, registerMantleTools } from './build-server';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function surface(): Map<string, { description: string; handler: Handler }> {
  const out = new Map<string, { description: string; handler: Handler }>();
  const fakeServer = {
    tool: (name: string, description: string, _schema: unknown, handler: Handler) => {
      out.set(name, { description, handler });
    },
  };
  registerMantleTools(fakeServer as never, 'owner-1', { transport: 'stdio' });
  return out;
}

const tools = surface();

describe('app authoring guidance on the MCP surface', () => {
  it('the server instructions point at the guide', () => {
    expect(MANTLE_MCP_INSTRUCTIONS).toContain('app_authoring_guide');
    expect(MANTLE_MCP_INSTRUCTIONS).toContain('host.me()');
  });

  it.each(['app_create', 'app_source_set', 'app_file_write'])(
    '%s names host.me(), the :host_me_* parameters, the bridge and the levels early',
    (slug) => {
      const d = tools.get(slug)?.description ?? '';
      // The ranker reads about the first 600 characters.
      expect(d.slice(0, 700)).toContain('host.me()');
      expect(d).toContain(':host_me_id');
      expect(d).toContain(':host_me_name');
      expect(d).toContain(':host_me_kind');
      expect(d).toContain('host.tools.call');
      expect(d).toContain('app_tools_set');
      expect(d).toContain('host.db');
      expect(d).toMatch(/team = members/);
      expect(d).toMatch(/client = clients/);
      expect(d).toContain('app_authoring_guide');
    },
  );

  it('app_db_schema_set says how to record who wrote a row', () => {
    expect(tools.get('app_db_schema_set')?.description).toContain(':host_me_id');
  });

  it('app_authoring_guide is listed and serves the whole guide', async () => {
    const t = tools.get('app_authoring_guide');
    expect(t).toBeDefined();
    const res = await t!.handler({});
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('Authoring Mantle mini-apps from an MCP client');
    expect(text).toContain('host.me()');
  });

  it('app_authoring_guide serves one section by heading', async () => {
    const res = await tools.get('app_authoring_guide')!.handler({ section: 'who is running' });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0]!.text) as { section: string[]; text: string };
    expect(out.section).toEqual(['Who is running the app']);
    expect(out.text).toContain(':host_me_id');
    expect(out.text).not.toContain('## Binding to data');
  });
});
