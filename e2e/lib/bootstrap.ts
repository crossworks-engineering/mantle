import { request, type APIRequestContext } from '@playwright/test';
import { OWNER_EMAIL, OWNER_PASSWORD, SERVER_URL } from './env';

/**
 * Ensure the target stack has a usable, onboarded owner.
 *
 * Existing stack (login succeeds) → nothing to do.
 * Fresh stack (first-run) → drive the REAL product paths, no DB backdoors:
 *   signup (first-run creates the anchor owner) → saveKey (a dummy OpenRouter
 *   key; the save persists regardless of the live probe result) → provision
 *   (manifest-seeded agents; the key's presence enables the persona) → finish
 *   (stamps onboardedAt — refused unless provision produced an enabled
 *   persona, which is exactly the integrity gate we want exercised).
 *
 * The dummy key means real LLM turns will fail — by design; no spec here runs
 * a model turn.
 */
export async function ensureOwner(): Promise<void> {
  const api = await request.newContext({ baseURL: SERVER_URL });
  try {
    const login = await api.post('/api/auth/login', {
      data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    if (login.ok()) {
      await ensureOnboarded(api);
      return;
    }

    const signup = await api.post('/api/auth/signup', {
      data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    if (!signup.ok()) {
      throw new Error(
        `e2e bootstrap: login failed (${login.status()}) and signup failed (${signup.status()}) — ` +
          `is the stack fresh, or are E2E_EMAIL/E2E_PASSWORD wrong for it? Server: ${SERVER_URL}`,
      );
    }
    // signup sets the session cookie on this request context.
    await ensureOnboarded(api);
  } finally {
    await api.dispose();
  }
}

async function ensureOnboarded(api: APIRequestContext): Promise<void> {
  const shell = await api.get('/api/shell');
  if (!shell.ok()) throw new Error(`e2e bootstrap: /api/shell ${shell.status()}`);
  const state = (await shell.json()) as { onboarded?: boolean };
  if (state.onboarded !== false) return; // stamped (or field absent on older builds)

  const step = async (body: Record<string, unknown>) => {
    const res = await api.post('/api/onboarding', { data: body });
    if (!res.ok())
      throw new Error(`e2e bootstrap: onboarding ${JSON.stringify(body)} → ${res.status()}`);
    return (await res.json()) as Record<string, unknown>;
  };

  await step({
    action: 'saveKey',
    service: 'openrouter',
    plaintext: 'sk-or-v1-e2e-dummy-key-never-used-for-real-turns',
  });
  await step({ action: 'provision' });
  const fin = await step({ action: 'finish' });
  if (fin.ok !== true) {
    throw new Error(`e2e bootstrap: onboarding finish refused: ${JSON.stringify(fin)}`);
  }
}
