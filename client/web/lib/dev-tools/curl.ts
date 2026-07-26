/**
 * cURL interop for the API Console — the bridge between vendor API docs
 * (which universally speak cURL) and the request builder.
 *
 * `parseCurl` understands the subset that real documentation uses: method,
 * headers, the -d/--data family, --json, -u basic auth, -G, --url, quoted
 * strings and backslash line-continuations. Anything it skips is reported in
 * `warnings` rather than silently dropped — a lossy import must say so.
 *
 * `toCurl` is the inverse, with one hard rule: a `{{secret:service/label}}`
 * ref is emitted VERBATIM, never resolved — the plaintext lives server-side
 * and must not enter the clipboard. Environment `{{vars}}` (base URLs, ids)
 * do resolve, because that's what makes the copied command runnable.
 */

import type { DraftRequest, HttpMethod, KeyValueEntry } from './types';

const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type ParsedCurl = {
  method: HttpMethod;
  url: string;
  params: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  body: { mode: 'none' | 'json' | 'raw'; text: string };
  warnings: string[];
};

/** Split a shell command into words: single/double quotes, backslash escapes,
 *  and backslash-newline continuations. Good enough for doc examples — this is
 *  not a shell. */
function tokenize(src: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  const push = () => {
    if (started) out.push(cur);
    cur = '';
    started = false;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n' || (n === '\r' && src[i + 2] === '\n')) {
        // line continuation — acts as whitespace
        i += n === '\n' ? 2 : 3;
        push();
        continue;
      }
      if (n === undefined) return null;
      cur += n;
      started = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]!;
          // Inside double quotes the shell only treats these specially.
          cur += '"\\$`'.includes(n) ? n : `\\${n}`;
          i += 2;
        } else {
          cur += src[i]!;
          i++;
        }
      }
      if (i >= src.length) return null;
      started = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  push();
  return out;
}

/** True when the pasted text looks like a cURL command (possibly prefixed
 *  with a shell prompt, as docs love to do). */
export function looksLikeCurl(text: string): boolean {
  return /^\s*(?:\$\s+)?curl\s/i.test(text.trimStart());
}

export function parseCurl(
  input: string,
): { ok: true; value: ParsedCurl } | { ok: false; error: string } {
  const cleaned = input.trim().replace(/^\$\s+/, '');
  const tokens = tokenize(cleaned);
  if (!tokens) return { ok: false, error: 'unbalanced quotes — check the pasted command' };
  if (tokens.length === 0 || tokens[0]!.toLowerCase() !== 'curl') {
    return { ok: false, error: 'not a cURL command (must start with `curl`)' };
  }

  let method: HttpMethod | null = null;
  let url = '';
  const headers: Array<{ key: string; value: string }> = [];
  const dataParts: string[] = [];
  const urlencodeParts: string[] = [];
  const warnings: string[] = [];
  let asGet = false;
  let jsonFlag = false;

  const needsValue = (flag: string, v: string | undefined): v is string => {
    if (v === undefined) {
      warnings.push(`${flag} at the end of the command has no value — ignored`);
      return false;
    }
    return true;
  };

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    switch (t) {
      case '-X':
      case '--request': {
        if (needsValue(t, next)) {
          const m = next.toUpperCase();
          if (METHODS.has(m)) method = m as HttpMethod;
          else warnings.push(`unsupported method ${next} — kept as GET/POST default`);
          i++;
        }
        break;
      }
      case '-H':
      case '--header': {
        if (needsValue(t, next)) {
          const sep = next.indexOf(':');
          if (sep > 0) {
            headers.push({ key: next.slice(0, sep).trim(), value: next.slice(sep + 1).trim() });
          } else {
            warnings.push(`header without a colon skipped: ${next}`);
          }
          i++;
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii': {
        if (needsValue(t, next)) {
          dataParts.push(next.startsWith('@') ? '' : next);
          if (next.startsWith('@'))
            warnings.push(`file body ${next} skipped — paste the content instead`);
          i++;
        }
        break;
      }
      case '--data-urlencode': {
        if (needsValue(t, next)) {
          urlencodeParts.push(next);
          i++;
        }
        break;
      }
      case '--json': {
        if (needsValue(t, next)) {
          dataParts.push(next);
          jsonFlag = true;
          i++;
        }
        break;
      }
      case '-u':
      case '--user': {
        if (needsValue(t, next)) {
          // btoa handles the ASCII creds real docs use; anything else is on the user.
          try {
            headers.push({ key: 'Authorization', value: `Basic ${btoa(next)}` });
          } catch {
            warnings.push(
              'basic-auth credentials were not ASCII — add the Authorization header yourself',
            );
          }
          i++;
        }
        break;
      }
      case '-b':
      case '--cookie': {
        if (needsValue(t, next)) {
          headers.push({ key: 'Cookie', value: next });
          i++;
        }
        break;
      }
      case '-A':
      case '--user-agent': {
        if (needsValue(t, next)) {
          headers.push({ key: 'User-Agent', value: next });
          i++;
        }
        break;
      }
      case '--url': {
        if (needsValue(t, next)) {
          url = next;
          i++;
        }
        break;
      }
      case '-G':
      case '--get':
        asGet = true;
        break;
      case '-F':
      case '--form':
        if (next !== undefined) i++;
        warnings.push('multipart -F/--form is not supported — the form field was skipped');
        break;
      // Flags that take a value we deliberately ignore.
      case '-o':
      case '--output':
      case '--connect-timeout':
      case '--max-time':
      case '-m':
      case '--retry':
      case '-e':
      case '--referer':
      case '--cacert':
      case '--capath':
        if (next !== undefined) i++;
        break;
      // Bare flags we deliberately ignore.
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-L':
      case '--location':
      case '-i':
      case '--include':
      case '-v':
      case '--verbose':
      case '--compressed':
      case '-k':
      case '--insecure':
      case '-f':
      case '--fail':
      case '-g':
      case '--globoff':
        break;
      default: {
        if (t.startsWith('-')) {
          warnings.push(`flag ${t} is not understood — skipped`);
          // Heuristic: if the next token doesn't look like a URL or flag,
          // assume it was this flag's value.
          if (next && !next.startsWith('-') && !/^https?:\/\//i.test(next) && !url) i++;
        } else if (!url) {
          url = t;
        } else {
          warnings.push(`extra argument skipped: ${t}`);
        }
      }
    }
    i++;
  }

  if (!url) return { ok: false, error: 'no URL found in the command' };

  // Pull the query string out of the URL into param rows.
  const params: Array<{ key: string; value: string }> = [];
  const qIndex = url.indexOf('?');
  if (qIndex !== -1) {
    const qs = url.slice(qIndex + 1);
    url = url.slice(0, qIndex);
    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const rawK = eq === -1 ? pair : pair.slice(0, eq);
      const rawV = eq === -1 ? '' : pair.slice(eq + 1);
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, '%20'));
        } catch {
          return s;
        }
      };
      params.push({ key: dec(rawK), value: dec(rawV) });
    }
  }

  // -G moves the data parts into the query string (curl semantics).
  if (asGet) {
    for (const part of [...dataParts, ...urlencodeParts]) {
      if (!part) continue;
      const eq = part.indexOf('=');
      params.push(
        eq === -1
          ? { key: part, value: '' }
          : { key: part.slice(0, eq), value: part.slice(eq + 1) },
      );
    }
    dataParts.length = 0;
    urlencodeParts.length = 0;
  }

  let body: ParsedCurl['body'] = { mode: 'none', text: '' };
  const joined = [...dataParts, ...urlencodeParts].filter((p) => p !== '').join('&');
  if (joined) {
    const trimmed =
      dataParts.length === 1 && urlencodeParts.length === 0 ? dataParts[0]!.trim() : joined;
    const isJson =
      jsonFlag ||
      ((trimmed.startsWith('{') || trimmed.startsWith('[')) &&
        (() => {
          try {
            JSON.parse(trimmed);
            return true;
          } catch {
            return false;
          }
        })());
    body = isJson ? { mode: 'json', text: trimmed } : { mode: 'raw', text: joined };
    if (!isJson && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
      headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    }
  }
  if (jsonFlag) {
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type'))
      headers.push({ key: 'Content-Type', value: 'application/json' });
    if (!headers.some((h) => h.key.toLowerCase() === 'accept'))
      headers.push({ key: 'Accept', value: 'application/json' });
  }

  const resolvedMethod: HttpMethod = method ?? (asGet || body.mode === 'none' ? 'GET' : 'POST');
  return {
    ok: true,
    value: { method: resolvedMethod, url, params, headers, body, warnings },
  };
}

/** Shell-quote with single quotes (the safe default for arbitrary content). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveVars(input: string, vars: Record<string, string>): string {
  // {{secret:…}} stays verbatim — the whole point. Other {{vars}} resolve.
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, name: string) =>
    name.startsWith('secret:') ? whole : (vars[name] ?? whole),
  );
}

/** Render the current http draft as a runnable multi-line cURL command. */
export function toCurl(draft: DraftRequest, vars: Record<string, string>): string {
  const fill = (s: string) =>
    resolveVars(s, vars).replace(/\{(\w[\w-]*)\}/g, (whole, p: string) =>
      draft.pathValues[p] !== undefined && draft.pathValues[p] !== ''
        ? encodeURIComponent(draft.pathValues[p]!)
        : whole,
    );

  const lines: string[] = [];
  const active = (list: KeyValueEntry[]) => list.filter((e) => e.enabled && e.key.trim() !== '');

  let url = fill(draft.url.trim());
  const qs = active(draft.params)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(resolveVars(p.value, vars))}`)
    .join('&');
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;

  lines.push(`curl -X ${draft.method} ${sq(url)}`);
  for (const h of active(draft.headers)) {
    lines.push(`-H ${sq(`${h.key}: ${resolveVars(h.value, vars)}`)}`);
  }
  if (draft.auth.mode === 'bearer' && draft.auth.token) {
    lines.push(`-H ${sq(`Authorization: Bearer ${resolveVars(draft.auth.token, vars)}`)}`);
  }
  if (draft.body.mode !== 'none' && draft.body.text.trim() !== '') {
    if (
      draft.body.mode === 'json' &&
      !active(draft.headers).some((h) => h.key.toLowerCase() === 'content-type')
    ) {
      lines.push(`-H ${sq('Content-Type: application/json')}`);
    }
    lines.push(`-d ${sq(resolveVars(draft.body.text, vars))}`);
  }
  return lines.join(' \\\n  ');
}
