export type Level = 'mastered' | 'reinforce' | 'weak' | 'new';

export const LEVEL_LABELS: Record<Level, string> = {
  mastered: 'Maîtrisé',
  reinforce: 'À renforcer',
  weak: 'Non maîtrisé',
  new: 'Non évalué',
};

export interface Meaning {
  id: number;
  translation: string;
  alts: string[];
  hint: string | null;
  context: string | null;
  example_ko: string | null;
  example_fr: string | null;
  level: Level;
  attempts: number;
  score: number | null;
}

export interface Word {
  id: number;
  korean: string;
  romanization: string | null;
  pos: string | null;
  source: string;
  created_at: string;
  level: Level;
  meanings: Meaning[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: string[]
  ) {
    super(message);
  }
}

async function req<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string; errors?: string[] } | null;
  if (!res.ok) {
    const detail = data?.errors?.length ? ` (${data.errors.join(' ')})` : '';
    throw new ApiError(`${data?.error ?? `Erreur ${res.status}`}${detail}`, res.status, data?.errors);
  }
  return data as T;
}

export const api = {
  listWords: (): Promise<Word[]> => req('/words', 'GET'),
  createWord: (w: unknown): Promise<Word> => req('/words', 'POST', w),
  updateWord: (id: number, w: unknown): Promise<Word> => req(`/words/${id}`, 'PUT', w),
  deleteWord: (id: number): Promise<void> => req(`/words/${id}`, 'DELETE'),
};
