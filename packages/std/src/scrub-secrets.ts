/** Replace every resolved secret plaintext in `text` with its ref name —
 *  run over anything that can leave the vault or the dispatcher (errors,
 *  step meta, response bodies, a key test's message). Covers the common
 *  transport encodings of the secret: raw, URL-encoded, and base64 (how
 *  Basic-auth credentials travel, and a form upstreams often echo back).
 *  The one scrub: @mantle/tools re-exports it (http-template.ts), and the
 *  vault's key probe uses it (@mantle/api-keys probe.ts). */
export function scrubSecrets(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [key, plaintext] of secrets) {
    if (!plaintext) continue;
    const variants = new Set<string>([plaintext, encodeURIComponent(plaintext)]);
    try {
      variants.add(Buffer.from(plaintext, 'utf8').toString('base64'));
    } catch {
      /* non-encodable — skip */
    }
    for (const v of variants) {
      if (v && v.length > 0) out = out.split(v).join(`[secret:${key}]`);
    }
  }
  return out;
}
