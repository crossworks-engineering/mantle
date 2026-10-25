/**
 * circuit_trace: one piping circuit across the uploaded DWG/DXF drawings,
 * from their bones tabs (Segments, Nodes, Inserts, Blocks, Texts, Circuits).
 * Read-only. The walk is ./circuit-trace/walk.ts (pure), the read
 * ./circuit-trace/read.ts (the caller's own scope, table by table).
 *
 * The output carries drawing text (labels, attribute values, layer names)
 * that whoever uploaded the drawing wrote, so the policy marks it
 * `outside.untrusted`: the tool loop fences every result as data before a
 * model reads it, as it does a web page's. The rights are the read's own.
 */
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';
import { dwgTables, readSheet } from './circuit-trace/read';
import { traceCircuit, type RegisterInput, type SheetInput } from './circuit-trace/walk';

/** The register input, read loosely: the agent fills it from a site tool. */
function registerOf(raw: unknown): RegisterInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const lines = Array.isArray(r.lines)
    ? r.lines
        .map((l) => {
          if (typeof l === 'string') return { number: l };
          if (!l || typeof l !== 'object') return null;
          const o = l as Record<string, unknown>;
          const number = str(o.number).trim();
          if (!number) return null;
          return {
            number,
            ...(str(o.sheet).trim() ? { sheet: str(o.sheet).trim() } : {}),
            ...(typeof o.deadleg === 'boolean' ? { deadleg: o.deadleg } : {}),
          };
        })
        .filter((l): l is NonNullable<typeof l> => l !== null)
    : [];
  const sheets = Array.isArray(r.sheets) ? r.sheets.map((s) => str(s).trim()).filter(Boolean) : [];
  return {
    ...(str(r.source).trim() ? { source: str(r.source).trim() } : {}),
    lines,
    sheets,
    ...(typeof r.deadlegs === 'number' ? { deadlegs: r.deadlegs } : {}),
  };
}

export async function circuitTraceHandler(
  input: Record<string, unknown>,
  ownerId: string,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  const circuit = str(input.circuit).trim();
  if (!circuit) {
    return {
      ok: false,
      error:
        "circuit is required: the circuit's name as the drawings write it, e.g. '10000-001-01' (the part after 'Circuit ' in the layer name).",
    };
  }
  const register = registerOf(input.register);
  try {
    const { tables, more } = await dwgTables(ownerId);
    const sheets: SheetInput[] = [];
    const preBones: string[] = [];
    const unreadable: string[] = [];
    for (const t of tables) {
      // One table that cannot be opened (its workbook file missing, a store
      // refusal) is skipped and named, never the end of the whole trace.
      const r = await readSheet(ownerId, t, circuit).catch(() => null);
      if (!r) unreadable.push(t.title);
      else if (r.kind === 'sheet') sheets.push(r.sheet);
      else if (r.kind === 'no-bones') preBones.push(r.title);
    }
    const result = traceCircuit(circuit, sheets, register);
    if (more) {
      result.limits.push(
        `only the ${tables.length} most recently changed drawing tables were looked at; older sheets of this circuit may be missing.`,
      );
    }
    for (const title of unreadable) {
      result.limits.push(
        `${title}: its table could not be opened, so it was skipped; if it carries this circuit, the trace is missing that sheet.`,
      );
    }
    for (const title of preBones) {
      result.limits.push(
        `${title}: has the circuit's layers but its table predates the geometry tabs; an owner can rebuild it with the dwg-reindex maintenance task.`,
      );
    }
    const { validate } = await import('@mantle/diagram-templates');
    const checked = validate('pid', result.pid);
    return {
      ok: true,
      output: {
        summary: result.summary,
        circuit: result.circuit,
        sheets: result.sheets,
        links: result.links,
        pid: result.pid,
        pid_check: {
          ok: checked.ok,
          ...(checked.ok ? {} : { errors: checked.errors }),
          warnings: checked.warnings,
        },
        ...(result.register ? { register: result.register } : {}),
        guesses: result.guesses,
        limits: result.limits,
        ...(result.sheets.length === 0
          ? {
              hint: `No readable drawing has geometry on 'Circuit ${circuit}' layers. Check the name with table_sql on a DWG table's Circuits tab, or search_nodes for the drawing.`,
            }
          : {
              next: `Draw it: diagram_render with template "pid" and the pid object as data (label every guessed link and check pid_check first).`,
            }),
      },
    };
  } catch (err) {
    return { ok: false, error: `circuit_trace failed: ${errorMessage(err)}` };
  }
}

const circuit_trace: BuiltinToolDef = {
  slug: 'circuit_trace',
  policy: {
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'tables',
    // Drawing text is the uploader's: fenced as data (the header says why).
    outside: { untrusted: true },
  },
  name: 'Trace a piping circuit',
  description:
    "Trace one piping circuit across every uploaded DWG/DXF drawing you can read, from the geometry on its `Circuit <name>` layers: per sheet the runs as ordered chains, tees, ends and what each end meets, deadlegs, valves on the path, line numbers with their DWG handles and equipment tags near the ends; links between sheets (a guess is marked `guessed`); a ready `pid` template input to draw with `diagram_render`; and, with `register`, every difference against that register. Reads only. For one drawing's raw tabs use `table_sql` instead.",
  inputSchema: {
    type: 'object',
    properties: {
      circuit: {
        type: 'string',
        description:
          "The circuit's name exactly as the layer writes it after 'Circuit ', e.g. '10000-001-01'.",
      },
      register: {
        type: 'object',
        description:
          'What an outside register says belongs to the circuit, from a site register tool when the brain has one; the trace reports every difference. Leave it out when there is none.',
        properties: {
          source: { type: 'string', description: "Where it came from, e.g. 'site register tool'." },
          lines: {
            type: 'array',
            description: 'The line numbers on the circuit.',
            items: {
              type: 'object',
              properties: {
                number: { type: 'string', description: "A line number, e.g. '2\"-P-0001-A1'." },
                sheet: {
                  type: 'string',
                  description: 'The drawing it is on, e.g. a sheet number.',
                },
                deadleg: { type: 'boolean', description: 'The register marks it a deadleg.' },
              },
              required: ['number'],
              additionalProperties: false,
            },
          },
          sheets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Drawings the register lists for the circuit.',
          },
          deadlegs: {
            type: 'integer',
            minimum: 0,
            description: 'How many deadlegs the register lists.',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['circuit'],
  },
  handler: (input, ctx) => circuitTraceHandler(input, ctx.ownerId),
};

export const CIRCUIT_TOOLS: BuiltinToolDef[] = [circuit_trace];
export const CIRCUIT_TOOL_SLUGS: readonly string[] = CIRCUIT_TOOLS.map((t) => t.slug);
