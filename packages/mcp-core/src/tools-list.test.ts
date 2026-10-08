/**
 * The tool list a real MCP client receives, over the real SDK.
 *
 * The other tests here capture registrations on a fake server, so none of them
 * sees what the SDK makes of a schema. That conversion is the SDK's to change:
 * 2.x would advertise every tool in draft-2020-12 unless told otherwise
 * (register/tool-input.ts). This pins the advertised shape at the boundary,
 * so an SDK upgrade cannot change what the assistant sees without a red test.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { BUILTIN_TOOLS } from '@mantle/tools';

import { registerMantleTools } from './build-server';

async function listedTools() {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  registerMantleTools(server, 'owner-1', { transport: 'stdio' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'tools-list-test', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tools/list over the SDK', () => {
  it('advertises every input schema as the draft-07 object SDK 1.x did', async () => {
    const tools = await listedTools();
    expect(tools.length).toBeGreaterThan(200);
    for (const t of tools) {
      expect(t.inputSchema.$schema, t.name).toBe('http://json-schema.org/draft-07/schema#');
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema, t.name).not.toHaveProperty('additionalProperties');
    }
  });

  it('a hand-written tool keeps its exact schema', async () => {
    const tableGet = (await listedTools()).find((t) => t.name === 'table_get');
    expect(tableGet?.inputSchema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['id'],
    });
  });

  it('a bridged builtin advertises the arguments its definition declares', async () => {
    const tools = await listedTools();
    const bySlug = new Map(BUILTIN_TOOLS.map((d) => [d.slug, d]));
    let checked = 0;
    for (const t of tools) {
      const def = bySlug.get(t.name);
      // Bridged = registered from the def, description and all; the
      // hand-written twins (no-duplicate-tools.test.ts) keep their own.
      if (!def || t.description !== def.description) continue;
      const props = (def.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(t.inputSchema.properties ?? {}).sort(), t.name).toEqual(
        Object.keys(props).sort(),
      );
      expect([...(t.inputSchema.required ?? [])].sort(), t.name).toEqual(
        [...((def.inputSchema.required as string[] | undefined) ?? [])].sort(),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
