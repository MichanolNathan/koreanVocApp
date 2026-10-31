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

export interface Stats {
  totalWords: number;
  totalMeanings: number;
  byLevel: Record<Level, number>;
  weakMeanings: { meaningId: number; korean: string; translation: string; context: string | null; score: number; attempts: number }[];
  hintDependent: { meaningId: number; korean: string; translation: string; hintRatio: number; attempts: number }[];
  weakContexts: { context: string; weak: number; total: number }[];
  contexts: string[];
}

export interface SessionQuestion {
  id: number;
  position: number;
  korean: string;
  romanization: string | null;
  pos: string | null;
  hintAvailable: boolean;
  answered: boolean;
  userAnswer: string | null;
  correct: boolean | null;
}

export interface SessionCreated {
  id: number;
  mode: string;
  contextFilter: string | null;
  questions: SessionQuestion[];
}

export interface AnswerFeedback {
  correct: boolean;
  expected: string;
  matchedMeaningId: number | null;
  targetMeaning: { id: number; translation: string; hint: string | null; context: string | null };
  otherMeanings: { id: number; translation: string; hint: string | null; context: string | null }[];
  finished: boolean;
}

export interface SessionResults {
  id: number;
  mode: string;
  context_filter: string | null;
  started_at: string;
  finished_at: string | null;
  correct: number;
  total: number;
  percent: number;
  incorrectCount: number;
  hintsUsed: number;
  correctWithoutHint: number;
  questions: {
    id: number;
    position: number;
    korean: string;
    hint_used: boolean;
    user_answer: string | null;
    correct: boolean;
    expected: string;
    matched: string | null;
    otherMeanings: { translation: string; hint: string | null; context: string | null }[];
  }[];
}

export const api = {
  listWords: (): Promise<Word[]> => req('/words', 'GET'),
  createWord: (w: unknown): Promise<Word> => req('/words', 'POST', w),
  updateWord: (id: number, w: unknown): Promise<Word> => req(`/words/${id}`, 'PUT', w),
  deleteWord: (id: number): Promise<void> => req(`/words/${id}`, 'DELETE'),
  stats: (): Promise<Stats> => req('/stats', 'GET'),
  createSession: (mode: string, context?: string): Promise<SessionCreated> =>
    req('/sessions', 'POST', { mode, ...(context ? { context } : {}) }),
  answer: (sessionId: number, questionId: number, answer: string): Promise<AnswerFeedback> =>
    req(`/sessions/${sessionId}/questions/${questionId}/answer`, 'POST', { answer }),
  hint: (sessionId: number, questionId: number): Promise<{ hint: string | null }> =>
    req(`/sessions/${sessionId}/questions/${questionId}/hint`, 'POST'),
  results: (sessionId: number): Promise<SessionResults> => req(`/sessions/${sessionId}/results`, 'GET'),
};
