import type { Env } from './env';

export interface LabelCount {
  label: string;
  sites: number;
}

export interface Suggestion extends LabelCount {
  /** Jev's probability that the label fits the description. */
  probability: number;
}

export const MAX_DESCRIPTION = 500;
/** One question per label; the most used 200 keep a request far inside Jev's context. */
const MAX_CANDIDATES = 200;
const MAX_SUGGESTIONS = 5;
/** A Noul at or above this reads as yes; anything lower is not suggested. */
const YES = 0.7;

const question = (label: string) => ({
  type: 'noul',
  instructions: `A teammate filters the site list by the label "${label}". Is the site in \`site_description\` one they want to find?`,
  criteria: {
    true: `"${label}" names what the site is, what it is about, or the team or event it is for`,
    false: `"${label}" is about a different kind of site, topic, or team`,
  },
});

export class SuggestNotConfiguredError extends Error {
  constructor() {
    super('Label suggestions need TYPESAFE_API_KEY on the worker.');
  }
}

/** Existing labels that fit `description`, best first; `[]` means none does. */
export async function suggestLabels(
  env: Env,
  description: string,
  labels: LabelCount[],
): Promise<Suggestion[]> {
  if (!env.TYPESAFE_API_KEY) throw new SuggestNotConfiguredError();
  const candidates = labels.slice(0, MAX_CANDIDATES);
  if (!candidates.length) return [];

  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'jev-1.14.0',
      state: { site_description: description },
      questions: Object.fromEntries(candidates.map((c, i) => [`l${i}`, question(c.label)])),
    }),
  });
  if (!res.ok) throw new Error(`TypeSafe error ${res.status}: ${await res.text()}`);
  const { answers } = await res.json<{ answers: Record<string, { noul?: number }> }>();

  return candidates
    .map((c, i) => {
      const probability = answers[`l${i}`]?.noul;
      if (typeof probability !== 'number') throw new Error(`TypeSafe sent no answer for l${i}`);
      return { ...c, probability };
    })
    .filter((s) => s.probability >= YES)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_SUGGESTIONS);
}
