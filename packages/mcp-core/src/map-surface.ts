/**
 * The MCP tool map: a connection that asks for it (`?tools=map` on the
 * HTTP endpoint, or MANTLE_MCP_TOOL_MAP for the box) is listed a few read
 * tools in full plus `tool_help` and four call tools split by risk class
 * (@mantle/tools risk-map.ts), instead of every tool (about 330 schemas,
 * which a client pays for on every turn).
 *
 * Listing still equals calling: the one registration (gated-tools.ts)
 * hands a tool here only when the gate lists it for the connection, and a
 * call tool runs it through that same tool's handler, so the gate, the
 * create home, the guards, the reply shape and the call log are the ones a
 * listed tool has. What this adds is the class check (a call through the
 * wrong call tool is refused, naming the right one) and the argument check
 * the SDK does for a listed tool.
 *
 * The tools listed in full are reads only: every write, delete and send
 * goes through its class's call tool, so a client's per-tool approval sees
 * the class on every one.
 */
import type { McpServer } from '@modelcontextprotocol/server';
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

/** The reads listed in full besides the core's: the hand-written `search`
 *  (search_nodes's MCP name) and Recall's three, which the server
 *  instructions name. */
const DIRECT_EXTRA: readonly string[] = ['search', 'recall_match', 'recall_index', 'recall_open'];
const DIRECT: ReadonlySet<string> = new Set([...CORE_TOOL_SLUGS, ...DIRECT_EXTRA]);

/** Whether a connection to `url` is listed the map: its `?tools=map` or
 *  `?tools=full` wins, else the box's switch (MANTLE_MCP_TOOL_MAP). */
export function wantsToolMap(url: string): boolean {
  const tools = URL.canParse(url) ? new URL(url).searchParams.get('tools') : null;
  if (tools === 'map') return true;
  if (tools === 'full') return false;
  return feature('mcpToolMap');
}

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
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
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

/** The tools of one connection, gathered as the registration lists them,
 *  then put on the server as the map (register). */
export class McpToolMap {
  private readonly entries = new Map<string, McpMapEntry>();

  /** Take one listed tool. A later tool of the same name replaces it, as a
   *  second registerTool would have failed: none does today. */
  add(entry: McpMapEntry): void {
    if (META.has(entry.name)) return;
    this.entries.set(entry.name, entry);
  }

  /** Put the map on `server`: the direct reads, tool_help and the call
   *  tools; every tool in full when nothing is left to map. */
  register(server: McpServer): void {
    const all = [...this.entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const isDirect = (e: McpMapEntry) => e.cls === 'read' && DIRECT.has(e.name);
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
    const listed = risk ? direct : all;
    for (const e of listed) {
      server.registerTool(
        e.name,
        {
          description: e.description,
          inputSchema: e.inputSchema,
          ...(e.annotations ? { annotations: e.annotations } : {}),
        },
        e.handler as never,
      );
    }
    if (!risk) return;

    const [help, ...calls] = risk.calls;
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
    );
    for (const call of calls) {
      const cls = (Object.keys(RISK_CALL_SLUGS) as RiskClass[]).find(
        (c) => RISK_CALL_SLUGS[c] === call.function.name,
      )!;
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
      );
    }
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
    return entry.handler(checked.value, extra);
  }
}
