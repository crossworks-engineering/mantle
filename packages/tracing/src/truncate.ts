/**
 * Trim jsonb payloads (input/output/meta) so a 1MB email body or
 * generated image doesn't end up in trace_steps. Keeps the head + a
 * marker; the original lives on its source node anyway.
 *
 * Budget choice (May 2026, after the rich-preview rollout): operators
 * want to see the full content of step inputs/outputs — note bodies,
 * extractor summaries, fact lists — for debugging. The previous
 * 2KB/1KB cap chopped useful previews mid-sentence. 64KB / 32KB
 * comfortably fits a typical 30KB markdown file's full body preview
 * while still catching runaway payloads (Telegram webhook payloads,
 * accidentally-stringified embedding vectors, etc.).
 */

const MAX_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;

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
    // Generous cap — long-form documents commonly produce 50+
    // entities/facts and the operator has explicitly chosen
    // "show me everything" over compact traces. The total jsonb
    // field is still bounded by MAX_BYTES, which catches the
    // arrays-of-arrays case.
    const cap = 200;
    if (v.length <= cap) return v.map(truncateValue);
    return [...v.slice(0, cap).map(truncateValue), `…[truncated, ${v.length - cap} more items]`];
  }
  if (v && typeof v === 'object') {
    return truncateJson(v);
  }
  return v;
}
