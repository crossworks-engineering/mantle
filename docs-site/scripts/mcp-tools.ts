// Writes the MCP tool list (name + description) the Mantle server registers,
// for the "MCP tools" reference page. It registers the real surface onto a
// capturing fake server, so the list can never drift from the code. Needs the
// mantle workspace installed (run `pnpm install` at the repo root); touches
// no database.
//
//   ../node_modules/.bin/tsx scripts/mcp-tools.ts   (from docs-site/)
import { writeFileSync } from 'node:fs';
import { registerMantleTools } from '../../packages/mcp-core/src/build-server';

type Tool = { name: string; description: string };
const tools = new Map<string, Tool>();
const capture = (name: unknown, ...rest: unknown[]) => {
  if (typeof name !== 'string') return;
  const first = rest[0];
  const description =
    typeof first === 'string'
      ? first
      : typeof (first as { description?: unknown })?.description === 'string'
        ? (first as { description: string }).description
        : '';
  tools.set(name, { name, description });
};
const fake = { tool: capture, registerTool: capture };
registerMantleTools(fake as never, '00000000-0000-0000-0000-000000000000', { transport: 'http' });

const list = [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(new URL('../src/data/mcp-tools.json', import.meta.url), JSON.stringify(list, null, 1) + '\n');
console.log(`mcp-tools: ${list.length} tools`);
