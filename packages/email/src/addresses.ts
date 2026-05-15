/**
 * RFC 5322 address parsing — just enough to extract the email + display
 * name from a From header. Provider adapters all normalize to this shape.
 */

const BRACKETED_RE =
  /^(?:"(?<qname>[^"]*)"|(?<uname>[^<]*?))\s*<(?<addr>[^<>\s,]+@[^<>\s,]+)>$/;
const BARE_RE = /^[^<>\s,]+@[^<>\s,]+$/;

export interface ParsedAddress {
  address: string; // lowercased
  name?: string;
}

export function parseAddress(raw: string): ParsedAddress | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const bracket = trimmed.match(BRACKETED_RE);
  if (bracket?.groups) {
    const name = (bracket.groups['qname'] ?? bracket.groups['uname'] ?? '').trim();
    const out: ParsedAddress = { address: bracket.groups['addr']!.toLowerCase() };
    if (name) out.name = name;
    return out;
  }

  if (BARE_RE.test(trimmed)) {
    return { address: trimmed.toLowerCase() };
  }

  return undefined;
}

/**
 * Split a header value into individual address entries, honouring quotes
 * (`"Last, First" <addr>` is one entry, not two). The pattern matches a
 * run of either a quoted string or any non-comma character, so commas
 * inside `"…"` don't split.
 */
const ENTRY_RE = /(?:"[^"]*"|[^,])+/g;

export function parseAddressList(raw: string | string[] | undefined): ParsedAddress[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : Array.from(raw.matchAll(ENTRY_RE), (m) => m[0]);
  return items
    .map((s) => parseAddress(s))
    .filter((x): x is ParsedAddress => !!x);
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}
