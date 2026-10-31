/**
 * Calcul de maîtrise par signification (PRD v0.2 §5.3) :
 * EWMA sur les 10 dernières tentatives, λ = 0,6 (récence pondérée).
 * Valeur d'une tentative : 1,0 correcte sans indice, 0,6 correcte avec
 * indice, 0 incorrecte.
 */

export type Level = 'mastered' | 'reinforce' | 'weak' | 'new';

export interface Attempt {
  correct: number;
  hint_used: number;
}

export const MASTERY_WINDOW = 10;
export const MASTERY_LAMBDA = 0.6;
export const MASTERED_THRESHOLD = 0.8;
export const REINFORCE_THRESHOLD = 0.4;

export function attemptValue(a: Attempt): number {
  if (!a.correct) return 0;
  return a.hint_used ? 0.6 : 1;
}

/** Score EWMA ; null si aucune tentative. */
export function masteryScore(attempts: Attempt[], window = MASTERY_WINDOW, lambda = MASTERY_LAMBDA): number | null {
  if (attempts.length === 0) return null;
  const recent = attempts.slice(-window);
  let num = 0;
  let den = 0;
  for (let i = 0; i < recent.length; i++) {
    const w = Math.pow(lambda, recent.length - 1 - i);
    num += w * attemptValue(recent[i]!);
    den += w;
  }
  return num / den;
}

export function levelOf(attempts: Attempt[]): Level {
  if (attempts.length === 0) return 'new';
  const s = masteryScore(attempts);
  if (s !== null && s >= MASTERED_THRESHOLD && attempts.length >= 3) return 'mastered';
  // Une seule tentative, même incorrecte : erreur isolée non pénalisante.
  if (attempts.length < 2) return 'reinforce';
  if (s !== null && s >= REINFORCE_THRESHOLD) return 'reinforce';
  return 'weak';
}

/** Agrégation mot (PRD v0.2 §5.4). */
export function aggregateWord(levels: Level[]): Level {
  if (levels.length === 0) return 'new';
  if (levels.some((l) => l === 'weak')) return 'weak';
  if (levels.some((l) => l === 'reinforce' || l === 'new')) return 'reinforce';
  return 'mastered';
}

/** Niveau de maîtrise affichable en français. */
export const LEVEL_LABELS: Record<Level, string> = {
  mastered: 'Maîtrisé',
  reinforce: 'À renforcer',
  weak: 'Non maîtrisé',
  new: 'Non évalué',
};
