/**
 * The one rule for the path of a NEW file in a tree of files: an app's
 * source (the code tools, app_file_write) and a pipeline package
 * (docs/pipelines.md, "Own pipelines"). Pure.
 */

/** True when the text holds a C0 control character or DEL. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Why a path may not name a NEW file, or null: it must be relative, with
 *  no `..`, `.` or empty part and no backslash. `inside` names the tree in
 *  the sentence (default: the app). */
export function badNewPath(path: string, inside = 'the app'): string | null {
  if (!path) return 'path is required, e.g. App.tsx or lib/fmt.ts';
  // A control character would forge lines in search hits and diff
  // headers; `__proto__` is no plain-object key.
  if (hasControlChar(path) || path === '__proto__') {
    return `path '${JSON.stringify(path).slice(1, -1)}' has a character or name a file may not use: pick a plain name, e.g. lib/fmt.ts`;
  }
  if (path.includes('\\') || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    return `path '${path}' must be relative inside ${inside}, with no '..', '.' or empty part (e.g. lib/fmt.ts)`;
  }
  return null;
}
