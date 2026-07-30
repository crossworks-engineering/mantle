/**
 * Enable the runner-queue feature on the demo brain.
 *
 * MANTLE_RUNS=1 is only HALF the switch. The `runs` tool group
 * (run_plan/run_append/run_state/run_cancel/run_audit) is deliberately not
 * attached to the persona by default — the manifest calls it responder-only
 * while the feature dogfoods — so without the grant the flag is on, the
 * worker idles, and the assistant simply has no way to create a run. Both
 * halves, or /runs stays empty and nothing says why.
 *
 * Granting is done through the REAL agent PATCH endpoint, so the demo brain
 * ends up in a state an owner could have reached from the Studio UI.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/enable-runs.ts
 */
const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';

let cookie = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!login.ok) throw new Error(`enable-runs: login failed (${login.status})`);

  const listed = await api('/api/agents');
  if (!listed.ok) throw new Error(`enable-runs: /api/agents ${listed.status}`);
  const body = (await listed.json()) as { agents?: Array<Record<string, unknown>> };
  const agents = body.agents ?? [];
  const target = agents.find((a) => a.slug === 'assistant');
  if (!target) throw new Error('enable-runs: no `assistant` agent on this brain');

  const current = Array.isArray(target.toolGroupSlugs) ? (target.toolGroupSlugs as string[]) : [];
  if (current.includes('runs')) {
    console.log('· `runs` group already granted to the assistant');
    return;
  }
  const res = await api(`/api/agents/${target.id as string}`, {
    method: 'PATCH',
    body: JSON.stringify({ toolGroupSlugs: [...current, 'runs'] }),
  });
  if (!res.ok) throw new Error(`enable-runs: PATCH ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`✓ granted the \`runs\` tool group to the assistant (${current.length} → ${current.length + 1} groups)`);
}

main().catch((err) => {
  console.error('✗ enable-runs failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
