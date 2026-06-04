/**
 * The first-run "get to know you" interview.
 *
 * Browser-safe leaf (NO `@mantle/db` import) so the onboarding wizard client can
 * render the questions and the server action can compose the bodies from the
 * same source. Each answer becomes a Life Log entry (`type='lifelog'`) under a
 * life-area category, which feeds the always-on identity block
 * (`identity-context.ts`) — so the assistant knows who the user is from turn one.
 *
 * Distinct from the passive `seed-get-to-know-user` heartbeat (which keeps
 * harvesting facts during normal chat): this is the deliberate, structured
 * capture at first run.
 */
import type { CategoryKey } from './lifelog-options';

export type OnboardingQuestion = {
  /** Stable key — used as the form field name + resume marker. */
  key: string;
  /** Life-area category the answer is filed under (drives the identity block grouping). */
  category: CategoryKey;
  /** The prompt shown to the user. */
  prompt: string;
  /** A short helper line / example under the prompt. */
  hint: string;
  /** Placeholder for the input. */
  placeholder: string;
  /** Optional questions can be left blank and skipped. The first two are required. */
  optional: boolean;
  /** Whether the answer wants a multi-line textarea (vs a single line). */
  multiline: boolean;
  /** A short lead-in prepended to the answer to make a natural first-person body.
   *  Empty string ⇒ the answer is stored verbatim (it's already first-person). */
  lead: string;
};

/**
 * The ~9-question set. Order matters — name first (drives the display name and
 * the assistant's sense of who it's talking to), then the people closest, then
 * the wider picture. The last is a free catch-all.
 */
export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    key: 'full_name',
    category: 'identity',
    prompt: "What's your name?",
    hint: 'First and surname — what should the system know you as.',
    placeholder: 'e.g. Jason Schoeman',
    optional: false,
    multiline: false,
    lead: 'My name is',
  },
  {
    key: 'nickname',
    category: 'identity',
    prompt: 'What do you like to be called?',
    hint: 'The name your assistant should actually use day to day.',
    placeholder: 'e.g. Jason, or Jay',
    optional: false,
    multiline: false,
    lead: 'I like to be called',
  },
  {
    key: 'partner',
    category: 'family',
    prompt: 'Do you have a partner or spouse?',
    hint: 'Their name and anything worth remembering. Leave blank if not.',
    placeholder: 'e.g. My wife, Saskia — married since 2014',
    optional: true,
    multiline: false,
    lead: 'My partner/spouse:',
  },
  {
    key: 'family',
    category: 'family',
    prompt: 'Who else is close family — children, parents, who’s at home?',
    hint: 'Names and ages help your assistant keep them straight.',
    placeholder: 'e.g. Two kids — Mia (8) and Sam (5); my mom Ann lives nearby',
    optional: true,
    multiline: true,
    lead: 'My close family:',
  },
  {
    key: 'work',
    category: 'work',
    prompt: 'What do you do?',
    hint: 'Work, role, the projects that fill your days.',
    placeholder: 'e.g. I run a small engineering firm and tinker with 3D printers',
    optional: false,
    multiline: true,
    lead: 'What I do:',
  },
  {
    key: 'faith',
    category: 'faith',
    prompt: 'Is faith or a worldview part of your life?',
    hint: 'Only if you’d like your assistant to be mindful of it. Optional.',
    placeholder: 'e.g. Christian — active in my local church',
    optional: true,
    multiline: false,
    lead: 'My faith / worldview:',
  },
  {
    key: 'health',
    category: 'health',
    prompt: 'Anything about your health worth knowing?',
    hint: 'Allergies, conditions, things to be mindful of. Optional — kept private.',
    placeholder: 'e.g. Type-2 diabetic; allergic to penicillin',
    optional: true,
    multiline: true,
    lead: 'Health worth knowing:',
  },
  {
    key: 'interests',
    category: 'reflection',
    prompt: 'What are you into — how do you spend your time?',
    hint: 'Hobbies, interests, what you care about outside work.',
    placeholder: 'e.g. 3D printing, hiking, reading theology, building things',
    optional: false,
    multiline: true,
    lead: "What I'm into:",
  },
  {
    key: 'goals',
    category: 'goal',
    prompt: 'What are you working toward right now?',
    hint: 'Goals, projects, things you want your assistant to help you push on.',
    placeholder: 'e.g. Ship Mantle, finish the gantry rebuild, get fitter',
    optional: true,
    multiline: true,
    lead: "What I'm working toward:",
  },
  {
    key: 'anything',
    category: 'identity',
    prompt: 'Anything else your assistant should always know about you?',
    hint: 'How you like to be talked to, pet peeves, context — anything.',
    placeholder: 'e.g. Be direct with me; I prefer South African spelling; no fluff',
    optional: true,
    multiline: true,
    lead: '',
  },
];

/** Compose a first-person Life Log body from a question + the user's answer.
 *  Trims, and prepends the question's lead unless the lead is empty (free-text
 *  answers are stored verbatim). Returns '' for a blank answer so the caller can
 *  skip it. */
export function composeBody(question: Pick<OnboardingQuestion, 'lead'>, answer: string): string {
  const a = (answer ?? '').trim();
  if (!a) return '';
  const lead = question.lead.trim();
  if (!lead) return a;
  return `${lead} ${a}`;
}

/** Derive a short display name (first name) from a full-name answer. Falls back
 *  to the whole trimmed string when there's no whitespace. */
export function deriveDisplayName(fullName: string): string {
  const flat = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.split(' ')[0] ?? flat;
}
