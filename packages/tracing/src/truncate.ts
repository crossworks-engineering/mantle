/**
 * Trim jsonb payloads (input/output/meta) so a 200KB email body doesn't
 * end up in trace_steps. Keep the head + a marker; the original is still
 * available via the source_node_id / message_id on the parent trace.
 */

const MAX_BYTES = 2048;
const HEAD_BYTES = 1024;

export function truncateJson<T>(value: T): T | Record<string, unknown> {
  if (value === null || value === undefined) return value;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_BYTES) return value;
    // Truncate per-string-field for objects; for everything else just stringify head.
    if (typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = truncateValue(v);
      }
      return out;
    }
    return {
      truncated: true,
      originalBytes: json.length,
      head: json.slice(0, HEAD_BYTES),
    };
  } catch {
    return { truncated: true, error: 'unserialisable' };
  }
}

function truncateValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v.length <= MAX_BYTES) return v;
    return `${v.slice(0, HEAD_BYTES)}…[truncated, ${v.length} chars]`;
  }
  if (Array.isArray(v)) {
    if (v.length <= 50) return v.map(truncateValue);
    return [...v.slice(0, 50).map(truncateValue), `…[truncated, ${v.length - 50} more items]`];
  }
  if (v && typeof v === 'object') {
    return truncateJson(v);
  }
  return v;
}
