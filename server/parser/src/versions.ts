/**
 * What the parser can read with, for GET /healthz and the brain's health
 * screen: the reader and tool versions this image carries. Probed once (the
 * image does not change under a running container), each with a short
 * deadline, never throwing.
 */
import { createRequire } from 'node:module';
import { env } from '@mantle/config';
import { runGroup } from './proc';

let probed: Promise<Record<string, string>> | null = null;

/** A package's version as the readers resolve it (from @mantle/files). */
function packageVersion(name: string): string | null {
  try {
    const fromFiles = createRequire(import.meta.resolve('@mantle/files/parser-wire'));
    return (fromFiles(`${name}/package.json`) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

const PY_VERSIONS = [
  'import sys, importlib.metadata as m',
  "print('python', sys.version.split()[0])",
  "for p in ('ezdxf', 'ezdwf', 'ezdwg', 'matplotlib'):",
  '    try: print(p, m.version(p))',
  '    except Exception: pass',
].join('\n');

async function probe(): Promise<Record<string, string>> {
  const out: Record<string, string> = { node: process.versions.node };
  for (const name of ['@firecrawl/anydoc', 'pdfjs-dist', 'exceljs', 'mammoth']) {
    const v = packageVersion(name);
    if (v) out[name.replace(/^@[^/]+\//, '')] = v;
  }
  const py = await runGroup(env('PARSER_PYTHON') ?? 'python3', ['-c', PY_VERSIONS], {
    timeoutMs: 15_000,
    stdout: true,
  });
  for (const line of py.stdout.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v) out[k] = v;
  }
  const ff = await runGroup('ffmpeg', ['-version'], { timeoutMs: 10_000, stdout: true });
  // "ffmpeg version 7.1.1-1 Copyright ..." -> "7.1.1-1"
  const ffv = ff.code === 0 ? ff.stdout.split('\n')[0]?.split(/\s+/)[2] : undefined;
  if (ffv) out.ffmpeg = ffv;
  const dw = await runGroup('dwg2dxf', ['--version'], { timeoutMs: 10_000, stdout: true });
  const dv =
    dw.code === 0 ? (dw.stdout || dw.stderr).trim().split('\n')[0]?.split(/\s+/).pop() : undefined;
  if (dv && /^\d+\.\d+/.test(dv)) out.dwg2dxf = dv;
  return out;
}

/** The versions, probed on first use and kept. */
export function probeVersions(): Promise<Record<string, string>> {
  probed ??= probe();
  return probed;
}
