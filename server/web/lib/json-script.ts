/**
 * Embed a JSON value inside an HTML `<script>` tag safely.
 *
 * JSON.stringify alone is NOT safe here. The HTML tokenizer does not parse the
 * contents of a script element as JSON: it scans for `</script` to end the
 * element, and for `<!--` to enter a comment-like state. A string value
 * containing either sequence therefore breaks out of the script, and from
 * there anything is possible. U+2028/U+2029 are escaped too: they are literal
 * line terminators to a JS parser but pass through JSON.stringify unescaped.
 *
 * This is the same class of bug as the SVG one in docs/draw-audit-findings.md
 * §2 — data becoming code — so it gets the same treatment: one helper, one
 * test, no caller left to remember it.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
