'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, Sparkles, X } from 'lucide-react';
// Import the browser-safe LEAVES directly, NOT the @mantle/content barrel —
// the barrel pulls identity-context → @mantle/db (postgres) into the client
// bundle. Same discipline as contacts-format / journal-options.
import { PURPOSE_ARCHETYPES, type PurposeArchetype } from '@mantle/content/onboarding-questions';
import {
  PERSONA_PRESETS,
  DEFAULT_PERSONA_NAMES,
  type PersonaGender,
  type PersonaPresetKey,
} from '@mantle/content/persona-bank';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { Textarea } from '@mantle/web-ui/ui/textarea';
import { Label } from '@mantle/web-ui/ui/label';
import { Slider } from '@mantle/web-ui/ui/slider';
import { RadioGroup, RadioGroupItem } from '@mantle/web-ui/ui/radio-group';
import { ToastProvider, useToast } from '@mantle/web-ui/ui/toast';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';

type SanityCheck = { label: string; ok: boolean; detail: string };

type OnboardingState = {
  onboarded: boolean;
  step: string;
  timezone: string;
  locale: string;
  savedServices: string[];
  assistantAgentId: string | null;
};

/** POST one wizard step to the consolidated dispatcher. */
function onboardingPost<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  return apiSend<T>('/api/onboarding', 'POST', { action, ...(payload ?? {}) });
}
import type { TestApiKeyResult } from '@/lib/api-key-test';
import type { ProvisionResult } from '@/lib/onboarding-provision';
import {
  ASSISTANT_MODEL_CHOICES,
  WORKER_MODEL_CHOICES,
  type ModelChoice,
} from '@/lib/system-manifest/model-choices';
import { TelegramBotSection } from '@/components/telegram/telegram-bot-section';

type StepKey =
  | 'profile'
  | 'openrouter'
  | 'models'
  | 'voice'
  | 'embedding'
  | 'provision'
  | 'sanity'
  | 'purpose'
  | 'personality'
  | 'telegram'
  | 'done';

const STEPS: { key: StepKey; title: string }[] = [
  { key: 'profile', title: 'Welcome' },
  { key: 'openrouter', title: 'Your key' },
  { key: 'models', title: 'Models' },
  { key: 'voice', title: 'Voice' },
  { key: 'embedding', title: 'Memory' },
  { key: 'provision', title: 'Set up' },
  { key: 'sanity', title: 'Check' },
  { key: 'purpose', title: 'Purpose' },
  { key: 'personality', title: 'Personality' },
  { key: 'telegram', title: 'Telegram' },
  { key: 'done', title: 'Done' },
];

function tempWord(t: number): string {
  if (t <= 0.3) return 'Precise';
  if (t <= 0.7) return 'Grounded';
  if (t <= 1.0) return 'Balanced';
  return 'Creative';
}

export function OnboardingClient() {
  return (
    <ToastProvider>
      <OnboardingGate />
    </ToastProvider>
  );
}

/** Data-free gate: fetches the resume state over HTTP, honours the
 *  already-onboarded redirect (with ?force bypass) client-side, then seeds the
 *  wizard. Replaces the props the server page used to pass. */
function OnboardingGate() {
  const router = useRouter();
  const force = useSearchParams().get('force') === '1';
  const stateQuery = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => apiFetch<OnboardingState>('/api/onboarding'),
  });
  useEffect(() => {
    if (stateQuery.data?.onboarded && !force) router.replace('/');
  }, [stateQuery.data, force, router]);

  if (stateQuery.isPending || (stateQuery.data?.onboarded && !force)) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (stateQuery.isError && !stateQuery.data) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t start onboarding.</p>
        <button type="button" onClick={() => stateQuery.refetch()} className="underline">
          Retry
        </button>
      </div>
    );
  }
  const d = stateQuery.data;
  return (
    <Wizard
      initialStep={d.step}
      initialTimezone={d.timezone}
      initialLocale={d.locale}
      savedServices={d.savedServices}
      assistantAgentId={d.assistantAgentId}
    />
  );
}

function Wizard({
  initialStep,
  initialTimezone,
  initialLocale,
  savedServices,
  assistantAgentId,
}: {
  initialStep: string;
  initialTimezone: string;
  initialLocale: string;
  savedServices: string[];
  assistantAgentId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();

  // Back-compat: a wizard resumed mid-flight may carry the old 'interview' step
  // marker — land it on the renamed 'purpose' step.
  const resumeStep = initialStep === 'interview' ? 'purpose' : initialStep;
  const startIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.key === resumeStep),
  );
  const [index, setIndex] = useState(startIndex === -1 ? 0 : startIndex);
  const step = STEPS[index]!.key;
  const [busy, setBusy] = useState(false);

  // Step 1 — profile
  const [timezone, setTimezone] = useState(initialTimezone);
  const [locale, setLocale] = useState(initialLocale);
  // Optional "what should the assistant call you" — replaces the old interview's
  // name questions; drives the displayName preference.
  const [userName, setUserName] = useState('');
  useEffect(() => {
    // Prefill from the browser when still on defaults.
    try {
      if (initialTimezone === 'UTC') {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) setTimezone(tz);
      }
      if (initialLocale === 'en-GB' && navigator.language) setLocale(navigator.language);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Infra pre-flight — probed on mount so a half-started stack (a container
  // that never came up, a missing bucket, a dead job queue) surfaces on step 1,
  // BEFORE any time is invested in the wizard. Blocks Continue while red.
  const [infra, setInfra] = useState<SanityCheck[] | null>(null);
  const [infraBusy, setInfraBusy] = useState(false);
  async function checkInfra() {
    setInfraBusy(true);
    try {
      setInfra(await onboardingPost<SanityCheck[]>('infra'));
    } catch {
      /* stays null — the panel keeps its checking state */
    } finally {
      setInfraBusy(false);
    }
  }
  useEffect(() => {
    void checkInfra();
  }, []);
  const infraDown = infra !== null && infra.some((c) => !c.ok);

  // OpenRouter (required) + an optional dedicated xAI key for voice.
  const [saved, setSaved] = useState<Set<string>>(new Set(savedServices));
  const [orKey, setOrKey] = useState('');
  const [xaiKey, setXaiKey] = useState('');
  const [results, setResults] = useState<Record<string, TestApiKeyResult>>({});

  // Models step — assistant + worker picks (defaults = the manifest defaults,
  // flagged `recommended` in the curated lists) and the route they run on.
  const [mAssistant, setMAssistant] = useState<string>(
    ASSISTANT_MODEL_CHOICES.find((m) => m.recommended)?.id ?? ASSISTANT_MODEL_CHOICES[0]!.id,
  );
  const [mWorker, setMWorker] = useState<string>(
    WORKER_MODEL_CHOICES.find((m) => m.recommended)?.id ?? WORKER_MODEL_CHOICES[0]!.id,
  );
  const [mRoute, setMRoute] = useState<'openrouter' | 'azure'>('openrouter');
  const [azureBaseUrl, setAzureBaseUrl] = useState('');
  const [azureKey, setAzureKey] = useState('');
  const [modelsSaved, setModelsSaved] = useState(false);

  // Memory step — model + route choices. OpenRouter is pre-selected when its
  // key was saved a step earlier (it gets reused — no second signup).
  const [embProvider, setEmbProvider] = useState<'openrouter' | 'openai'>(
    savedServices.includes('openrouter') ? 'openrouter' : 'openai',
  );
  const [embModel, setEmbModel] = useState<'text-embedding-3-large' | 'text-embedding-3-small'>(
    'text-embedding-3-large',
  );
  const [embKey, setEmbKey] = useState('');
  const [embResult, setEmbResult] = useState<TestApiKeyResult | undefined>(undefined);
  const [embConfigured, setEmbConfigured] = useState(false);

  // Step 5 — provision
  const [provision, setProvision] = useState<ProvisionResult | null>(null);
  // The assistant's agent id when provisioning ran THIS session — the
  // `assistantAgentId` prop is a mount-time snapshot (null on a fresh brain)
  // and only covers the resume-after-reload path.
  const [provisionedAgentId, setProvisionedAgentId] = useState<string | null>(null);

  // Step 6 — sanity
  const [sanity, setSanity] = useState<SanityCheck[] | null>(null);

  // Step 7 — purpose: the brain's speciality + a free-text description.
  const [archetype, setArchetype] = useState<string>(PURPOSE_ARCHETYPES[0]!.key);
  const [purposeText, setPurposeText] = useState('');

  // Step 8 — personality
  const [presetKey, setPresetKey] = useState<PersonaPresetKey>('warm');
  const [gender, setGender] = useState<PersonaGender>('female');
  const [assistantName, setAssistantName] = useState(DEFAULT_PERSONA_NAMES.female);
  const [nameEdited, setNameEdited] = useState(false);
  const [temperature, setTemperature] = useState(0.7);

  // Step 9 — telegram: the bot binding + pairing is handled by the shared
  // <TelegramBotSection> against the assistant agent; no local token state.

  function go(toIndex: number) {
    const next = Math.min(STEPS.length - 1, Math.max(0, toIndex));
    setIndex(next);
    void onboardingPost('step', { step: STEPS[next]!.key });
  }

  // ── key step (shared by openrouter / voice / openai) ──────────────────────
  async function onSaveKey(service: string, value: string) {
    setBusy(true);
    try {
      const res = await onboardingPost<{ saved: boolean; test: TestApiKeyResult }>('saveKey', {
        service,
        plaintext: value,
      });
      if (res.saved) setSaved((s) => new Set(s).add(service));
      setResults((r) => ({ ...r, [service]: res.test }));
      if (res.test.ok) toast.success(`${res.test.provider} key works.`);
      else toast.error(res.test.message);
    } catch (err) {
      // A thrown request (500 etc.) used to vanish silently — always surface it.
      toast.error(err instanceof Error ? err.message : 'Saving the key failed.');
    } finally {
      setBusy(false);
    }
  }
  async function onRetest(service: string) {
    setBusy(true);
    try {
      const t = await onboardingPost<TestApiKeyResult>('testKey', { service });
      setResults((r) => ({ ...r, [service]: t }));
      t.ok ? toast.success(`${t.provider} key works.`) : toast.error(t.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Testing the key failed.');
    } finally {
      setBusy(false);
    }
  }
  // Models step: persist the picks (provision applies them). On the Azure route
  // the server live-probes the endpoint + key before accepting. Returns success
  // so the footer only advances on a clean save.
  async function onSaveModels(): Promise<boolean> {
    setBusy(true);
    try {
      const res = await onboardingPost<{ ok: boolean; message?: string }>('models', {
        assistantModel: mAssistant,
        workerModel: mWorker,
        route: mRoute,
        azureBaseUrl,
        azureKey,
      });
      if (!res.ok) {
        toast.error(res.message ?? 'Could not save model choices.');
        return false;
      }
      setModelsSaved(true);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Saving model choices failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Embedder step: point the brain's embedding config at the chosen model +
  // route. A pasted key is saved first; with OpenRouter selected and its key
  // already saved, no key is needed — the server reuses it. The server probes
  // the route at 768 dims before configuring anything.
  async function onSaveEmbedding() {
    setBusy(true);
    try {
      const res = await onboardingPost<{
        saved: boolean;
        configured: boolean;
        test: TestApiKeyResult;
      }>('embedding', { provider: embProvider, model: embModel, plaintext: embKey });
      if (res.saved && embKey.trim()) setSaved((s) => new Set(s).add(embProvider));
      setEmbResult(res.test);
      setEmbConfigured(res.configured);
      if (res.configured) toast.success('Memory search enabled.');
      else if (!res.test.ok) toast.error(res.test.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Configuring embeddings failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onProvision() {
    setBusy(true);
    try {
      const res = await onboardingPost<ProvisionResult & { assistantAgentId?: string | null }>(
        'provision',
      );
      setProvision(res);
      setProvisionedAgentId(res.assistantAgentId ?? null);
      toast.success('Your assistant and workers are set up.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Provisioning failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onRunSanity() {
    setBusy(true);
    try {
      setSanity(await onboardingPost<SanityCheck[]>('sanity'));
    } finally {
      setBusy(false);
    }
  }

  async function onSavePurpose() {
    if (!purposeText.trim()) {
      toast.error('Tell your assistant what this brain is for.');
      return;
    }
    setBusy(true);
    try {
      const res = await onboardingPost<{ ok: boolean; error?: string }>('purpose', {
        archetype,
        purpose: purposeText,
      });
      if (!res.ok) return toast.error(res.error ?? 'Could not save.');
      toast.success('Purpose saved.');
      go(index + 1);
    } finally {
      setBusy(false);
    }
  }

  async function onSavePersona() {
    setBusy(true);
    try {
      const res = await onboardingPost<{ ok: boolean; error?: string }>('persona', {
        presetKey,
        assistantName,
        gender,
        temperature,
      });
      if (!res.ok) return toast.error(res.error ?? 'Could not save.');
      toast.success(`${assistantName} is ready.`);
      go(index + 1);
    } finally {
      setBusy(false);
    }
  }

  async function onFinish() {
    setBusy(true);
    try {
      // The server refuses to finish if there's no enabled assistant yet (no
      // OpenRouter key / provisioning didn't run). Surface that and keep the
      // user in the wizard rather than dropping them into a dead app.
      const res = await onboardingPost<{ ok: boolean; error?: string }>('finish');
      if (!res.ok) {
        toast.error(res.error ?? 'Finish the setup step first.');
        return;
      }
      router.push('/assistant');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Sync default assistant name to gender unless the user typed their own.
  function onGender(g: PersonaGender) {
    setGender(g);
    if (!nameEdited) setAssistantName(DEFAULT_PERSONA_NAMES[g]);
  }
  function onPreset(k: PersonaPresetKey) {
    setPresetKey(k);
    const p = PERSONA_PRESETS.find((x) => x.key === k);
    if (p) setTemperature(p.temperature);
  }

  const orSaved = saved.has('openrouter');

  return (
    <div className="flex w-full flex-col gap-6">
      <Header index={index} />

      <div className="min-h-[18rem]">
        {step === 'profile' && (
          <StepShell
            title="Welcome to Mantle"
            blurb="This is your own AI brain — private, self-hosted, and it remembers. A few quick steps and it’s yours."
          >
            <div className="space-y-4">
              {/* Infra pre-flight — if the stack is half-up there's no point
                  continuing; failures block the footer's Continue. */}
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">System status</p>
                  <Button variant="ghost" size="sm" onClick={checkInfra} disabled={infraBusy}>
                    {infraBusy ? <Loader2 className="animate-spin" /> : null} Re-check
                  </Button>
                </div>
                {infra === null ? (
                  <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Checking that all services are
                    running…
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {infra.map((c) => (
                      <div key={c.label} className="flex items-start gap-2 text-sm">
                        {c.ok ? (
                          <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                        ) : (
                          <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                        )}
                        <span>
                          <span className="font-medium">{c.label}</span>{' '}
                          <span className="text-muted-foreground">— {c.detail}</span>
                        </span>
                      </div>
                    ))}
                    {infraDown && (
                      <p className="pt-1 text-sm text-destructive">
                        Some services aren’t running — there’s no point continuing until the stack
                        is healthy. On the server, run <code>scripts/sanity.sh</code> (or{' '}
                        <code>docker compose ps</code>) to see what’s down, then Re-check.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <Field label="Your name" hint="Optional — what your assistant should call you.">
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="e.g. Alex"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Timezone" hint="So “tomorrow at 3pm” means the right thing.">
                  <Input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="Africa/Johannesburg"
                  />
                </Field>
                <Field label="Locale" hint="How dates and numbers are formatted.">
                  <Input
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                    placeholder="en-GB"
                  />
                </Field>
              </div>
            </div>
          </StepShell>
        )}

        {step === 'openrouter' && (
          <KeyStep
            title="Add your OpenRouter key"
            blurb="OpenRouter powers the assistant's thinking, the background indexing of everything you add, reading + generating images, and even voice. This one key is all you need — a dedicated xAI voice key is an optional upgrade in the next step."
            service="openrouter"
            label="OpenRouter API key"
            link="https://openrouter.ai/keys"
            value={orKey}
            onChange={setOrKey}
            saved={saved.has('openrouter')}
            result={results['openrouter']}
            onSave={() => onSaveKey('openrouter', orKey)}
            onRetest={() => onRetest('openrouter')}
            busy={busy}
          />
        )}

        {step === 'models' && (
          <StepShell
            title="Choose your models"
            blurb="Two engines power your brain: a top-tier model for the assistant you talk to, and a fast model for the background workers that read and index everything you add. The defaults are excellent — and everything here can be changed later in Settings."
          >
            <div className="space-y-6">
              <ModelChoiceCards
                label="Assistant — the mind you talk to"
                choices={ASSISTANT_MODEL_CHOICES}
                value={mAssistant}
                onChange={setMAssistant}
                azureOnly={mRoute === 'azure'}
              />
              <ModelChoiceCards
                label="Workers — fast indexing of everything you add"
                choices={WORKER_MODEL_CHOICES}
                value={mWorker}
                onChange={setMWorker}
                azureOnly={mRoute === 'azure'}
              />

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Runs via</p>
                <RadioGroup
                  value={mRoute}
                  onValueChange={(v) => {
                    const r = v as 'openrouter' | 'azure';
                    setMRoute(r);
                    setModelsSaved(false);
                    if (r === 'azure') {
                      // Azure serves OpenAI-family models only — snap any
                      // non-eligible pick to the first Azure-capable card.
                      if (!ASSISTANT_MODEL_CHOICES.find((m) => m.id === mAssistant)?.azure) {
                        setMAssistant(ASSISTANT_MODEL_CHOICES.find((m) => m.azure)!.id);
                      }
                      if (!WORKER_MODEL_CHOICES.find((m) => m.id === mWorker)?.azure) {
                        setMWorker(WORKER_MODEL_CHOICES.find((m) => m.azure)!.id);
                      }
                    }
                  }}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="openrouter" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">OpenRouter</span>
                      <span className="block text-xs text-muted-foreground">
                        Every model above on the key you just added — one key, one bill, automatic
                        failover between hosts.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="azure" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">Azure OpenAI</span>
                      <span className="block text-xs text-muted-foreground">
                        Run OpenAI models from your own Azure tenant — prompts stay inside your
                        Microsoft boundary. OpenAI-family models only.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </div>

              {mRoute === 'azure' && (
                <div className="space-y-3">
                  <Field
                    label="Azure OpenAI endpoint"
                    hint="The OpenAI-compatible v1 endpoint — deployments must be named after the model (e.g. gpt-5.4)."
                  >
                    <Input
                      value={azureBaseUrl}
                      onChange={(e) => setAzureBaseUrl(e.target.value)}
                      placeholder="https://your-resource.openai.azure.com/openai/v1"
                    />
                  </Field>
                  <Field label="Azure OpenAI API key" hint={undefined}>
                    <Input
                      type="text"
                      autoComplete="off"
                      placeholder="Paste your Azure key"
                      value={azureKey}
                      onChange={(e) => setAzureKey(e.target.value)}
                    />
                  </Field>
                </div>
              )}

              {modelsSaved && (
                <p className="flex items-center gap-2 text-sm text-primary">
                  <Check className="size-4" /> Model choices saved — applied when your assistant is
                  set up.
                </p>
              )}
            </div>
          </StepShell>
        )}

        {step === 'voice' && (
          <StepShell
            title="Voice"
            blurb="Your assistant speaks its replies and transcribes voice notes out of the box on your OpenRouter key (grok voice “ara”). Optionally add a dedicated xAI key for a smoother, dedicated voice route — same grok voices (ara/rex). Skip to keep voice on OpenRouter; you can add xAI later in Settings."
          >
            <KeyFields
              service="xai"
              label="xAI (Grok) API key — for voice"
              link="https://console.x.ai"
              value={xaiKey}
              onChange={setXaiKey}
              saved={saved.has('xai')}
              result={results['xai']}
              onSave={() => onSaveKey('xai', xaiKey)}
              onRetest={() => onRetest('xai')}
              busy={busy}
            />
            <ul className="mt-3 space-y-1 pl-1 text-xs text-muted-foreground">
              <li>🗣️ Spoken replies (text-to-speech)</li>
              <li>🎙️ Transcribe voice notes (speech-to-text)</li>
            </ul>
          </StepShell>
        )}

        {step === 'embedding' && (
          <StepShell
            title="Memory search (embeddings)"
            blurb="Everything you add is indexed into searchable memory by an embedding model. Pick the model and where it runs — only thin slices of text are sent per request. Changing the model later means re-indexing everything, so it's worth choosing deliberately."
          >
            <div className="space-y-5">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Model</p>
                <RadioGroup
                  value={embModel}
                  onValueChange={(v) => setEmbModel(v as typeof embModel)}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="text-embedding-3-large" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">
                        text-embedding-3-large · recommended
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        OpenAI’s strongest embedder — noticeably better recall on technical and
                        multilingual content. ~$0.13 per million tokens; indexing a large document
                        library costs cents.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="text-embedding-3-small" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">
                        text-embedding-3-small · budget
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        ~6× cheaper (~$0.02 per million tokens) and faster, with somewhat lower
                        recall. Fine for lighter, personal use.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </div>

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Runs via</p>
                <RadioGroup
                  value={embProvider}
                  onValueChange={(v) => {
                    setEmbProvider(v as typeof embProvider);
                    setEmbResult(undefined);
                    setEmbConfigured(false);
                  }}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="openrouter" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">
                        OpenRouter{saved.has('openrouter') ? ' · uses your saved key' : ''}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {saved.has('openrouter')
                          ? 'Reuses the OpenRouter key you added a step ago — nothing new to sign up for. One bill for chat and embeddings.'
                          : 'One key and one bill for chat and embeddings.'}
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]">
                    <RadioGroupItem value="openai" className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">
                        OpenAI (direct){saved.has('openai') ? ' · uses your saved key' : ''}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Straight to OpenAI with an OpenAI API key. Pick this if you already run on
                        OpenAI billing.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </div>

              {!saved.has(embProvider) && (
                <Field
                  label={embProvider === 'openrouter' ? 'OpenRouter API key' : 'OpenAI API key'}
                  hint={undefined}
                >
                  <Input
                    type="text"
                    autoComplete="off"
                    placeholder="Paste your key"
                    value={embKey}
                    onChange={(e) => setEmbKey(e.target.value)}
                  />
                </Field>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={onSaveEmbedding}
                  disabled={busy || (!saved.has(embProvider) && !embKey.trim())}
                  size="sm"
                >
                  {busy ? <Loader2 className="animate-spin" /> : null} Enable memory search
                </Button>
                {!saved.has(embProvider) && (
                  <a
                    className="ml-auto flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                    href={
                      embProvider === 'openrouter'
                        ? 'https://openrouter.ai/keys'
                        : 'https://platform.openai.com/api-keys'
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get a key <ExternalLink className="size-3" />
                  </a>
                )}
              </div>

              {embResult && (
                <p
                  className={
                    'flex items-center gap-2 text-sm ' +
                    (embConfigured ? 'text-primary' : 'text-destructive')
                  }
                >
                  {embConfigured ? <Check className="size-4" /> : <X className="size-4" />}
                  {embConfigured
                    ? `Memory search enabled — ${embModel} via ${embProvider === 'openrouter' ? 'OpenRouter' : 'OpenAI'}.`
                    : embResult.message}
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                Skip to leave semantic search off for now — the self-hosted local embedder is an
                advanced option in Settings → Embedding.
              </p>
            </div>
          </StepShell>
        )}

        {step === 'provision' && (
          <StepShell
            title="Set up your assistant"
            blurb="We’ll create your assistant and the background workers that read, summarise, and remember everything you add — using the keys you provided (voice on xAI if you added it)."
          >
            {!provision ? (
              <Button onClick={onProvision} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Set up my assistant
              </Button>
            ) : (
              <div className="space-y-3 text-sm">
                <ul className="space-y-1.5">
                  {provision.createdAgent && (
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-primary" /> Assistant “
                      {provision.createdAgent.name}” created
                    </li>
                  )}
                  {provision.createdWorkers.map((w) => (
                    <li key={w.kind} className="flex items-center gap-2">
                      <Check className="size-4 text-primary" /> {w.name}{' '}
                      <span className="text-muted-foreground">
                        ({w.provider} · {w.model})
                      </span>
                    </li>
                  ))}
                  {provision.seededSpecialists.length > 0 && (
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-primary" /> Specialists wired up:{' '}
                      <span className="text-muted-foreground">
                        {provision.seededSpecialists.join(' · ')}
                      </span>
                    </li>
                  )}
                </ul>
                {provision.skipped.length > 0 && (
                  <ul className="space-y-1 text-muted-foreground">
                    {provision.skipped.map((s) => (
                      <li key={s} className="flex items-center gap-2">
                        <X className="size-3.5" /> Skipped: {s}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Re-run is safe (idempotent) — picks up any keys you added since. */}
                <Button variant="ghost" size="sm" onClick={onProvision} disabled={busy}>
                  Run setup again
                </Button>
              </div>
            )}
          </StepShell>
        )}

        {step === 'sanity' && (
          <StepShell
            title="Make sure it all works"
            blurb="A quick check of everything you set up, so you can move on with confidence."
          >
            {sanity === null ? (
              <Button onClick={onRunSanity} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />} Run the checks
              </Button>
            ) : (
              <div className="space-y-2">
                {sanity.map((c) => (
                  <div key={c.label} className="flex items-start gap-2 text-sm">
                    {c.ok ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <span>
                      <span className="font-medium">{c.label}</span>{' '}
                      <span className="text-muted-foreground">— {c.detail}</span>
                    </span>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={onRunSanity} disabled={busy}>
                  Re-run
                </Button>
              </div>
            )}
          </StepShell>
        )}

        {step === 'purpose' && (
          <StepShell
            title="What is this brain for?"
            blurb="Pick the speciality that fits best, then describe what it’s mainly going to be used for. This grounds your assistant in the brain’s purpose from the first message."
          >
            <div className="space-y-5">
              <RadioGroup
                value={archetype}
                onValueChange={setArchetype}
                className="grid gap-2 sm:grid-cols-2"
              >
                {PURPOSE_ARCHETYPES.map((a: PurposeArchetype) => (
                  <label
                    key={a.key}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]"
                  >
                    <RadioGroupItem value={a.key} className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">{a.label}</span>
                      <span className="block text-xs text-muted-foreground">{a.blurb}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>

              <Field
                label="Description *"
                hint="A sentence or two on what this brain is mainly going to do."
              >
                <Textarea
                  rows={3}
                  placeholder="e.g. Analyse RBI inspection reports and answer questions about asset integrity for a refinery."
                  value={purposeText}
                  onChange={(e) => setPurposeText(e.target.value)}
                />
              </Field>
            </div>
          </StepShell>
        )}

        {step === 'personality' && (
          <StepShell
            title="Shape your assistant’s character"
            blurb="Pick a personality, give it a name and a voice, and tune how creative it is. You can change all of this later."
          >
            <div className="space-y-5">
              <RadioGroup
                value={presetKey}
                onValueChange={(v) => onPreset(v as PersonaPresetKey)}
                className="grid gap-2 sm:grid-cols-2"
              >
                {PERSONA_PRESETS.map((p) => (
                  <label
                    key={p.key}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]"
                  >
                    <RadioGroupItem value={p.key} className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">{p.label}</span>
                      <span className="block text-xs text-muted-foreground">{p.blurb}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" hint="What your assistant is called.">
                  <Input
                    value={assistantName}
                    onChange={(e) => {
                      setAssistantName(e.target.value);
                      setNameEdited(true);
                    }}
                  />
                </Field>
                <Field
                  label="Gender"
                  hint={
                    saved.has('xai')
                      ? 'Shapes the persona and picks the spoken voice.'
                      : 'Shapes the persona (and the voice, once you add voice).'
                  }
                >
                  <RadioGroup
                    value={gender}
                    onValueChange={(v) => onGender(v as PersonaGender)}
                    className="flex gap-4 pt-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="female" /> Female
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="male" /> Male
                    </label>
                  </RadioGroup>
                </Field>
              </div>

              <Field
                label="Creativity"
                hint="Lower is more precise and consistent; higher is more varied."
              >
                <div className="flex items-center gap-3">
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    value={[temperature]}
                    onValueChange={([v]) => setTemperature(v ?? 0)}
                    className="flex-1 py-1.5"
                    aria-label="Creativity"
                  />
                  <span className="w-24 text-right text-xs">
                    <span className="font-medium">{tempWord(temperature)}</span>
                    <span className="ml-1 tabular-nums text-muted-foreground">
                      {temperature.toFixed(1)}
                    </span>
                  </span>
                </div>
              </Field>

              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                💬 Channels are set up per-assistant, not here. Next you can reach this assistant on{' '}
                <span className="font-medium">Telegram</span> (by text or voice note) — it’s
                optional, and you can always connect or change it later in{' '}
                <span className="font-medium">Settings → Agents</span>.
              </p>
            </div>
          </StepShell>
        )}

        {step === 'telegram' && (
          <StepShell
            title="Reach your assistant on Telegram"
            blurb="Optional. Talk to your assistant from your phone — by text or voice note. You can do this later in Settings."
          >
            <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                In Telegram, message{' '}
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                >
                  @BotFather
                </a>{' '}
                and send <code>/newbot</code>.
              </li>
              <li>Pick a name and username, then copy the token it gives you.</li>
              <li>
                Paste the token below and connect — then DM your new bot and approve the pairing
                request that appears here.
              </li>
            </ol>
            {(provisionedAgentId ?? assistantAgentId) ? (
              // Same connect → pair → manage flow as /settings/agents, bound to
              // the assistant. The bot starts polling on connect, so a DM shows
              // up as a pending pairing request (this section polls every 10s).
              <TelegramBotSection agentId={(provisionedAgentId ?? assistantAgentId)!} />
            ) : (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                Finish the setup step first — your assistant needs to exist before a bot can be
                linked to it. You can always add Telegram later in Settings → Agents.
              </p>
            )}
          </StepShell>
        )}

        {step === 'done' && (
          <StepShell
            title="You’re all set 🌿"
            blurb="Your assistant knows who you are and is ready to remember everything you give it. Say hello."
          >
            <Button onClick={onFinish} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Talk to your assistant
            </Button>
          </StepShell>
        )}
      </div>

      {/* ── footer nav ───────────────────────────────────────────────── */}
      <Footer
        index={index}
        busy={busy}
        canBack={index > 0 && step !== 'done'}
        onBack={() => go(index - 1)}
        primary={(() => {
          switch (step) {
            case 'profile':
              return {
                label: 'Continue',
                // A red infra panel means the stack is half-up — onboarding
                // would fail later in confusing ways, so don't let it start.
                disabled: infraDown,
                onClick: async () => {
                  setBusy(true);
                  const res = await onboardingPost<{ ok: boolean; error?: string }>('profile', {
                    timezone,
                    locale,
                    displayName: userName,
                  });
                  setBusy(false);
                  if (!res.ok) return toast.error(res.error ?? 'Could not save.');
                  go(index + 1);
                },
              };
            case 'openrouter': {
              // Require a saved key, and if it's been tested, require a PASS —
              // so a saved-but-invalid key can't slip through. (An untested but
              // saved key still proceeds; the sanity step will catch a dud.)
              const t = results['openrouter'];
              return {
                label: 'Continue',
                disabled: !orSaved || (t !== undefined && !t.ok),
                onClick: () => go(index + 1),
              };
            }
            case 'models':
              return {
                label: 'Save & continue',
                disabled: mRoute === 'azure' && !azureBaseUrl.trim(),
                onClick: async () => {
                  if (await onSaveModels()) go(index + 1);
                },
              };
            case 'voice':
              return { label: 'Continue', onClick: () => go(index + 1) };
            case 'embedding':
              return { label: 'Continue', onClick: () => go(index + 1) };
            case 'provision':
              return { label: 'Continue', disabled: !provision, onClick: () => go(index + 1) };
            case 'sanity':
              return { label: 'Continue', onClick: () => go(index + 1) };
            case 'purpose':
              return { label: 'Save & continue', onClick: onSavePurpose };
            case 'personality':
              return { label: 'Save & continue', onClick: onSavePersona };
            case 'telegram':
              // Connecting + pairing happen inline in <TelegramBotSection>; this
              // step is optional, so the footer just advances.
              return { label: 'Continue', onClick: () => go(index + 1) };
            case 'done':
              return null;
          }
        })()}
      />
    </div>
  );
}

// ── presentational helpers ──────────────────────────────────────────────────

/** Curated model cards for the Models step — radio cards with name, price
 *  class, honest blurb, and Recommended / Azure-capable badges. When the Azure
 *  route is active, non-eligible cards dim out with a "Not on Azure" badge. */
function ModelChoiceCards({
  label,
  choices,
  value,
  onChange,
  azureOnly,
}: {
  label: string;
  choices: readonly ModelChoice[];
  value: string;
  onChange: (id: string) => void;
  azureOnly: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <RadioGroup value={value} onValueChange={onChange} className="grid gap-2 sm:grid-cols-2">
        {choices.map((m) => {
          const blocked = azureOnly && !m.azure;
          return (
            <label
              key={m.id}
              className={
                'flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-foreground/[0.04]' +
                (blocked ? ' pointer-events-none opacity-45' : '')
              }
            >
              <RadioGroupItem value={m.id} className="mt-0.5" disabled={blocked} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{m.price}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{m.blurb}</span>
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.recommended && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                      Recommended
                    </span>
                  )}
                  {m.azure && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                      Azure-capable
                    </span>
                  )}
                  {blocked && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                      Not on Azure
                    </span>
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function Header({ index }: { index: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-logo text-3xl leading-none text-primary">mantle</span>
        <span className="text-xs text-muted-foreground">
          Step {index + 1} of {STEPS.length} · {STEPS[index]!.title}
        </span>
      </div>
      <div className="flex gap-1">
        {STEPS.map((s, i) => (
          <span
            key={s.key}
            className={
              'h-1 flex-1 rounded-full ' + (i <= index ? 'bg-primary' : 'bg-foreground/[0.12]')
            }
          />
        ))}
      </div>
    </div>
  );
}

function StepShell({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function KeyFields({
  label,
  link,
  value,
  onChange,
  saved,
  result,
  onSave,
  onRetest,
  busy,
}: {
  service: string;
  label: string;
  link: string;
  value: string;
  onChange: (v: string) => void;
  saved: boolean;
  result?: TestApiKeyResult;
  onSave: () => void;
  onRetest: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label={label} hint={undefined}>
        <Input
          type="text"
          autoComplete="off"
          placeholder={saved ? '•••••••• (saved)' : 'Paste your key'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {/* With a saved key and an empty field, the primary action IS the test
            — a disabled "Save & test" here just looked broken (you had to spot
            the ghost "Test again" instead). */}
        {saved && !value.trim() ? (
          <Button onClick={onRetest} disabled={busy} size="sm">
            {busy ? <Loader2 className="animate-spin" /> : null} Test saved key
          </Button>
        ) : (
          <Button onClick={onSave} disabled={busy || !value.trim()} size="sm">
            {busy ? <Loader2 className="animate-spin" /> : null} Save &amp; test
          </Button>
        )}
        <a
          className="ml-auto flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          Get a key <ExternalLink className="size-3" />
        </a>
      </div>
      {result && (
        <p
          className={
            'flex items-center gap-2 text-sm ' + (result.ok ? 'text-primary' : 'text-destructive')
          }
        >
          {result.ok ? <Check className="size-4" /> : <X className="size-4" />}
          {result.message}
        </p>
      )}
      {!result && saved && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="size-4" /> Saved — “Test saved key” to verify.
        </p>
      )}
    </div>
  );
}

function KeyStep(props: {
  title: string;
  blurb: string;
  service: string;
  label: string;
  link: string;
  value: string;
  onChange: (v: string) => void;
  saved: boolean;
  result?: TestApiKeyResult;
  onSave: () => void;
  onRetest: () => void;
  busy: boolean;
}) {
  return (
    <StepShell title={props.title} blurb={props.blurb}>
      <KeyFields {...props} />
    </StepShell>
  );
}

function Footer({
  busy,
  canBack,
  onBack,
  primary,
}: {
  index: number;
  busy: boolean;
  canBack: boolean;
  onBack: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean } | null;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border pt-4">
      <Button variant="ghost" onClick={onBack} disabled={!canBack || busy}>
        <ArrowLeft /> Back
      </Button>
      {primary && (
        <Button onClick={primary.onClick} disabled={busy || primary.disabled}>
          {primary.label} <ArrowRight />
        </Button>
      )}
    </div>
  );
}
