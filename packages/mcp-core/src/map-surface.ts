/**
 * The MCP tool map: a connection that asks for it (`?tools=map` on the
 * HTTP endpoint, or MANTLE_MCP_TOOL_MAP for the box) is listed a few read
 * tools in full plus `tool_help` and four call tools split by risk class
 * (@mantle/tools risk-map.ts), instead of every tool (about 330 schemas,
 * which a client pays for on every turn).
 *
 * The map lists fewer tools; it calls the same ones. The one registration
 * (gated-tools.ts) hands a tool here only when the gate lists it for the
 * connection, and every tool handed here is registered on the server by
 * its own name, as on the full list: a client that cached the full list
 * (a connector or a session that never refreshes its tools) calls a tool
 * by its old name and gets that tool's own call (the gate, the create home,
 * the guards, the argument check, the reply shape, the call log, and the
 * client's approval of that tool by its own name and hints). Only tools/list
 * is answered with the map (listOnly). A name the gate does not hand here is
 * on no list and stays "not found".
 *
 * A call tool runs a tool through that same handler. What it adds is the
 * class check (a call through the wrong call tool is refused, naming the
 * right one) and the argument check the SDK does for a call by name. A
 * call the map refuses ran nothing and, like a call by name the SDK
 * refuses on its arguments, leaves no call log row; nor does tool_help.
 *
 * A read the gate treats as a write may sit under tool_read (its
 * readOnlyHint) only by its policy's own `riskClass: 'read'`: a catalog
 * fetch that sends nothing of the caller's. The map is built per server,
 * so per HTTP request (about 13 ms over the full list's build on the
 * 2026-11-02 measure).
 *
 * The tools listed in full are reads only: a client that reads the map
 * reaches every write, delete and send through its class's call tool, so
 * its per-tool approval sees the class on every one. A client that cached
 * the full list approves each tool by its own name and hints, as it did.
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { feature } from '@mantle/config';
import {
  buildRiskMap,
  CORE_TOOL_SLUGS,
  RISK_CALL_SLUGS,
  type RiskClass,
  type RiskMapTool,
  type ToolSource,
} from '@mantle/tools';
import { jsonReply, refusalReply } from './gated-tools';
import type { ToolHints } from './tool-annotations';
import { toolInputSchema } from './register/tool-input';
export { MCP_TOOL_LISTINGS } from './tool-listings';

/** What a connection on the map is told besides the instructions every
 *  connection gets (login-surface.ts mcpInstructionsFor). */
export const MCP_MAP_INSTRUCTIONS =
  'This connection lists the tool map: search and the core reads in full, and every other ' +
  'tool through four call tools by risk class (tool_read, tool_write, tool_delete, tool_send). ' +
  "Each call tool's description names its tools in a compact map, and tool_help gives a " +
  "tool's arguments. A call through the wrong call tool is refused with the right one named.";

/** Whether a connection to `url` is listed the map: its `?tools=map` or
 *  `?tools=full` wins, else the box's switch (MANTLE_MCP_TOOL_MAP). Never a
 *  linked brain's connection (`via` peer): its peer tools list and call the
 *  brain's tools by name. */
export function wantsToolMap(url: string, via?: string): boolean {
  if (via === 'peer') return false;
  const tools = URL.canParse(url) ? new URL(url).searchParams.get('tools') : null;
  if (tools === 'map') return true;
  if (tools === 'full') return false;
  return feature('mcpToolMap');
}

const CORE: ReadonlySet<string> = new Set(CORE_TOOL_SLUGS);

/** The names the map's own tools take: a tool named so is not offered. */
const META: ReadonlySet<string> = new Set(['tool_help', ...Object.values(RISK_CALL_SLUGS)]);

/** The input schema a registration advertises and validates with. */
type InputSchema = ReturnType<typeof toolInputSchema>;

/** One tool as the registration would list it. */
export type McpMapEntry = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  annotations?: ToolHints;
  /** The registration's reply to one call: the gate, the tool, the reply
   *  shape and the call log (gated-tools.ts). */
  respond: (args: unknown, extra: unknown) => Promise<unknown>;
  cls: RiskClass;
  source: ToolSource;
};

const CALL_SHAPE = {
  name: z.string().describe('The full tool name, e.g. "contact_get".'),
  arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments."),
};
const HELP_SHAPE = {
  names: z.array(z.string()).optional().describe('Full tool names, e.g. ["event_update"].'),
  area: z.string().optional().describe('An area from the map, e.g. "page".'),
};

/** A call tool's hints, from the tools it reaches: read-only for reads,
 *  destructive or open-world when any of its tools is. */
function callHints(cls: RiskClass, entries: readonly McpMapEntry[]): ToolHints {
  const any = (k: 'destructiveHint' | 'openWorldHint') =>
    entries.some((e) => e.annotations?.[k] === true);
  return {
    title: RISK_CALL_SLUGS[cls],
    readOnlyHint: cls === 'read',
    destructiveHint: cls !== 'read' && (cls === 'delete' || any('destructiveHint')),
    idempotentHint: entries.every((e) => e.annotations?.idempotentHint === true),
    openWorldHint: cls === 'send' || any('openWorldHint'),
  };
}

/** `schema`'s JSON Schema, as tools/list would advertise it. */
function jsonSchemaOf(schema: InputSchema): Record<string, unknown> {
  return schema['~standard'].jsonSchema.input({ target: 'draft-07' }) as Record<string, unknown>;
}

/** The JSON Schema draft the SDK's tools/list writes (its
 *  JSON_SCHEMA_CONVERSION_TARGET; map-surface.test.ts pins the match). */
const LISTED_SCHEMA_TARGET = 'draft-2020-12';

/** Answer tools/list on `server` with `listed` only. The SDK's own handler
 *  lists every registered tool, and a tool it does not list it does not
 *  call, so the map keeps every tool registered and replaces the list. Each
 *  definition is written as the SDK's handler writes it. */
function listOnly(server: McpServer, listed: ReadonlyArray<[string, RegisteredTool]>): void {
  server.server.removeRequestHandler('tools/list');
  server.server.setRequestHandler('tools/list', () => ({
    tools: listed
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => ({
        name,
        title: tool.title,
        description: tool.description,
        inputSchema: (tool.inputSchema?.['~standard'].jsonSchema.input({
          target: LISTED_SCHEMA_TARGET,
        }) ?? { type: 'object', properties: {} }) as { type: 'object' },
        annotations: tool.annotations,
        icons: tool.icons,
        execution: tool.execution,
        _meta: tool._meta,
      })),
  }));
}

/** The tools of one connection, gathered as the registration lists them,
 *  then put on the server as the map (register). A read is listed in full
 *  when it is in the core (@mantle/tools CORE_TOOL_SLUGS) or when the
 *  connection's server `instructions` name it: a tool the client is told to
 *  call (recall_match, search) is one it can call directly. */
export class McpToolMap {
  private readonly entries = new Map<string, McpMapEntry>();
  private readonly named: ReadonlySet<string>;

  constructor(instructions: string) {
    this.named = new Set(instructions.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)*/g) ?? []);
  }

  /** Take one listed tool; false for one named like the map's own tools,
   *  which is not offered. A second tool of the same name throws, as a
   *  second registerTool does. */
  add(entry: McpMapEntry): boolean {
    if (META.has(entry.name)) return false;
    if (this.entries.has(entry.name)) throw new Error(`Tool ${entry.name} is already registered`);
    this.entries.set(entry.name, entry);
    return true;
  }

  /** Put the map on `server`: every tool registered by its own name, and
   *  tools/list answered with the direct reads, tool_help and the call
   *  tools; every tool listed in full when nothing is left to map. */
  register(server: McpServer): void {
    const all = [...this.entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const isDirect = (e: McpMapEntry) =>
      e.cls === 'read' && (CORE.has(e.name) || this.named.has(e.name));
    const direct = all.filter(isDirect);
    const mapped = all.filter((e) => !isDirect(e));
    const asTool = (e: McpMapEntry): RiskMapTool => ({
      type: 'function',
      function: {
        name: e.name,
        description: e.description,
        parameters: jsonSchemaOf(e.inputSchema),
      },
      cls: e.cls,
      source: e.source,
    });
    const risk = buildRiskMap(mapped.map(asTool), direct.map(asTool));
    // Every tool by its own name, the map or not (see the module comment).
    const own = new Map<string, RegisteredTool>();
    for (const e of all) {
      own.set(
        e.name,
        server.registerTool(
          e.name,
          {
            description: e.description,
            inputSchema: e.inputSchema,
            ...(e.annotations ? { annotations: e.annotations } : {}),
          },
          e.respond as never,
        ),
      );
    }
    if (!risk) return;

    const listed: Array<[string, RegisteredTool]> = direct.map((e) => [e.name, own.get(e.name)!]);
    const [help, ...calls] = risk.calls;
    listed.push([
      help!.function.name,
      server.registerTool(
        help!.function.name,
        {
          description: help!.function.description,
          inputSchema: toolInputSchema(HELP_SHAPE),
          annotations: {
            title: help!.function.name,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        (async (args: { names?: string[]; area?: string }) => jsonReply(risk.help(args))) as never,
      ),
    ]);
    for (const call of calls) {
      const cls = (Object.keys(RISK_CALL_SLUGS) as RiskClass[]).find(
        (c) => RISK_CALL_SLUGS[c] === call.function.name,
      )!;
      listed.push([
        call.function.name,
        server.registerTool(
          call.function.name,
          {
            description: call.function.description,
            inputSchema: toolInputSchema(CALL_SHAPE),
            annotations: callHints(
              cls,
              all.filter((e) => e.cls === cls),
            ),
          },
          (async (args: { name: string; arguments?: Record<string, unknown> }, extra: unknown) =>
            this.call(risk.route, cls, args, extra)) as never,
        ),
      ]);
    }
    listOnly(server, listed);
  }

  /** One call through the call tool of `via`: the class check, the
   *  argument check, then the tool's own handler. */
  private async call(
    route: NonNullable<ReturnType<typeof buildRiskMap>>['route'],
    via: RiskClass,
    args: { name: string; arguments?: Record<string, unknown> },
    extra: unknown,
  ): Promise<unknown> {
    const routed = route(via, args.name);
    if (!routed.ok) return refusalReply(routed.error);
    const entry = this.entries.get(args.name)!;
    const checked = await entry.inputSchema['~standard'].validate(args.arguments ?? {});
    if (checked.issues) {
      const problems = checked.issues
        .map((i) => {
          const at = (i.path ?? [])
            .map((p) => (typeof p === 'object' ? String(p.key) : String(p)))
            .join('.');
          return at ? `${at}: ${i.message}` : i.message;
        })
        .join('; ');
      return refusalReply(
        `Wrong arguments for '${entry.name}': ${problems}. Retry with arguments that match its ` +
          `input schema: ${JSON.stringify(jsonSchemaOf(entry.inputSchema))}`,
      );
    }
    return entry.respond(checked.value, extra);
  }
}
