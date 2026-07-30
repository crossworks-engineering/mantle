export {}; // loaded as <script type="module">; makes `declare global` legal

type Profile = {
  id: string;
  origin: string;
  name: string;
  version?: string;
  lastUsedAt?: number;
};

type AddResult = { ok: true; profile: Profile } | { ok: false; error: string };

declare global {
  interface Window {
    mantleDesktop: {
      shellInfo(): Promise<{ version: string }>;
      listProfiles(): Promise<Profile[]>;
      addProfile(url: string): Promise<AddResult>;
      removeProfile(id: string): Promise<void>;
      connect(id: string): Promise<{ ok: boolean; error?: string }>;
    };
  }
}

const form = document.getElementById('add-form') as HTMLFormElement;
const input = document.getElementById('url-input') as HTMLInputElement;
const button = document.getElementById('add-button') as HTMLButtonElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;
const savedEl = document.getElementById('saved') as HTMLElement;
const listEl = document.getElementById('profile-list') as HTMLUListElement;

function showError(message: string | null): void {
  errorEl.hidden = !message;
  errorEl.textContent = message ?? '';
}

let shellVersion = '';

async function renderProfiles(): Promise<void> {
  const profiles = await window.mantleDesktop.listProfiles();
  savedEl.hidden = profiles.length === 0;
  listEl.replaceChildren(
    ...profiles
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .map((profile) => {
        const li = document.createElement('li');

        const open = document.createElement('button');
        open.className = 'profile';
        // Bundled-UI vs server skew is visible, not fatal: surface it here and
        // let per-feature degradation handle the rest (the mobile posture).
        const skew =
          profile.version && shellVersion && profile.version !== shellVersion
            ? ` · app ${shellVersion}`
            : '';
        open.append(
          Object.assign(document.createElement('span'), {
            className: 'name',
            textContent: profile.name,
          }),
          Object.assign(document.createElement('span'), {
            className: 'origin' + (skew ? ' skew' : ''),
            textContent: `${profile.origin}${profile.version ? ` · v${profile.version}` : ''}${skew}`,
          }),
        );
        open.addEventListener('click', async () => {
          const result = await window.mantleDesktop.connect(profile.id);
          if (!result.ok) showError(result.error ?? 'Could not connect.');
        });

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.title = 'Forget this brain';
        remove.textContent = '×';
        remove.addEventListener('click', async () => {
          await window.mantleDesktop.removeProfile(profile.id);
          void renderProfiles();
        });

        li.append(open, remove);
        return li;
      }),
  );
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  showError(null);
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const result = await window.mantleDesktop.addProfile(url);
    if (!result.ok) {
      showError(result.error);
      return;
    }
    await window.mantleDesktop.connect(result.profile.id);
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
  }
});

void (async () => {
  shellVersion = (await window.mantleDesktop.shellInfo()).version;
  await renderProfiles();
})();
