/**
 * Switch the seeded brain to the serve-time embedder and re-embed it, through
 * the owner API (the same two calls the Embedding settings screen makes).
 *
 * The serve box runs no Ollama, so the brain must embed online when it is
 * served (demo/deploy/README-embedder.md). Two steps, never one:
 *   1. save the embedding config (OpenRouter, text-embedding-3-large, 768)
 *   2. re-embed every stored vector with it (POST /api/embedding/rebuild)
 * Only the first would put questions and passages in two vector spaces:
 * search would answer, confidently and wrongly. The Recall prompt vectors
 * are not part of the rebuild; reembed-recall.ts does those next.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/switch-embedder.ts
 */
import { ownerPassword } from "./lib/secrets.ts";

const SERVER = process.env.DEMO_SERVER_URL ?? "http://127.0.0.1:3902";
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? "alex@harbourlabs.example.com";
const MODEL = process.env.DEMO_EMBED_MODEL ?? "openai/text-embedding-3-large";

let cookie = "";
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  return res;
}
async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || out.ok === false) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

async function main() {
  await call("POST", "/api/auth/login", { email: OWNER_EMAIL, password: ownerPassword() });
  const keys = ((await call("GET", "/api/keys")).keys ?? []) as Array<{ id: string; service: string }>;
  const key = keys.find((k) => k.service === "openrouter");
  if (!key) throw new Error("no OpenRouter key in the vault: the seed saves one at onboarding");
  await call("POST", "/api/embedding", { model: MODEL, primary_provider: "openrouter", primary_api_key_id: key.id });
  const saved = await call("GET", "/api/embedding");
  console.log(`· embedding config: ${JSON.stringify(saved).slice(0, 200)}`);
  const t0 = Date.now();
  const r = await call("POST", "/api/embedding/rebuild", { repopulate: true });
  console.log(`· re-embedded with ${String(r.model)} in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(r.result).slice(0, 400)}`);
  if (r.model !== MODEL) throw new Error(`the rebuild used ${String(r.model)}, not ${MODEL}`);
}

main().catch((err) => {
  console.error("✗ switch-embedder failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
