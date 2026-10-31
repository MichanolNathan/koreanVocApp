/**
 * Moteur d'exercices (PRD v0.2 §4, §6.3) : sélection pondérée par faiblesse
 * et validation stricte normalisée. Indépendant de la source : travaille sur
 * des candidats génériques.
 */
import { frMatch } from './normalize.ts';
import type { Level } from './mastery.ts';

export type QuizMode = 'standard' | 'weak' | 'reinforce' | 'mixed' | 'context';

export const QUIZ_LENGTH = 15;

export interface Candidate {
  meaningId: number;
  level: Level;
  context: string | null;
}

const WEIGHTS: Record<Level, number> = { weak: 5, reinforce: 3, new: 2, mastered: 1 };

function weightedPick(pool: Candidate[], count: number): Candidate[] {
  const remaining = [...pool];
  const picked: Candidate[] = [];
  while (remaining.length > 0 && picked.length < count) {
    const total = remaining.reduce((s, c) => s + WEIGHTS[c.level], 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= WEIGHTS[remaining[idx]!.level];
      if (r <= 0) break;
    }
    picked.push(remaining.splice(Math.min(idx, remaining.length - 1), 1)[0]!);
  }
  return picked;
}

/** Pioche dans des paliers de priorité, pondéré au sein de chaque palier. */
function tieredPick(tiers: Candidate[][], count: number): Candidate[] {
  const picked: Candidate[] = [];
  for (const tier of tiers) {
    if (picked.length >= count) break;
    picked.push(...weightedPick(tier, count - picked.length));
  }
  return picked;
}

const byLevel = (c: Candidate[], level: Level) => c.filter((x) => x.level === level);

export function selectQuestions(all: Candidate[], mode: QuizMode, context: string | null): Candidate[] {
  if (all.length === 0) return [];
  switch (mode) {
    case 'weak':
      return tieredPick([byLevel(all, 'weak'), byLevel(all, 'reinforce'), byLevel(all, 'new'), byLevel(all, 'mastered')], QUIZ_LENGTH);
    case 'reinforce':
      return tieredPick([byLevel(all, 'reinforce'), byLevel(all, 'weak'), byLevel(all, 'new'), byLevel(all, 'mastered')], QUIZ_LENGTH);
    case 'mixed': {
      const weakSide = tieredPick([byLevel(all, 'weak'), byLevel(all, 'reinforce')], Math.round(QUIZ_LENGTH * 0.7));
      const chosen = new Set(weakSide.map((c) => c.meaningId));
      // Les ~30 % restants viennent des acquis/nouveaux, pas des faibles restantes.
      const othersPool = all.filter((c) => !chosen.has(c.meaningId) && (c.level === 'mastered' || c.level === 'new'));
      const others = weightedPick(othersPool, QUIZ_LENGTH - weakSide.length);
      others.forEach((o) => chosen.add(o.meaningId));
      // Source pauvre : on complète avec les faibles non tirées.
      const leftover = tieredPick([byLevel(all, 'weak'), byLevel(all, 'reinforce')], QUIZ_LENGTH - weakSide.length - others.length)
        .filter((c) => !chosen.has(c.meaningId));
      return [...weakSide, ...others, ...leftover];
    }
    case 'context': {
      if (!context) return weightedPick(all, QUIZ_LENGTH);
      const wanted = context.trim().toLowerCase();
      const inContext = all.filter((c) => (c.context ?? '').trim().toLowerCase() === wanted);
      const others = all.filter((c) => (c.context ?? '').trim().toLowerCase() !== wanted);
      return tieredPick([inContext, others], QUIZ_LENGTH);
    }
    case 'standard':
    default:
      return weightedPick(all, QUIZ_LENGTH);
  }
}

export interface MeaningForCheck {
  id: number;
  translation: string;
  alts: string[];
}

export interface CheckResult {
  correct: boolean;
  /** Signification dont une traduction a été reconnue (≠ cible si autre sens). */
  matchedMeaningId: number | null;
}

/**
 * Validation stricte : la réponse doit égaler (normalisée) la traduction
 * principale ou une alternative de la signification cible, ou d'une autre
 * signification du même mot (comptée correcte, PRD §4.2 multi-significations).
 */
export function checkAnswer(answer: string, target: MeaningForCheck, wordMeanings: MeaningForCheck[]): CheckResult {
  const matches = (m: MeaningForCheck) => frMatch(answer, m.translation) || m.alts.some((a) => frMatch(answer, a));
  if (matches(target)) return { correct: true, matchedMeaningId: target.id };
  const other = wordMeanings.find((m) => m.id !== target.id && matches(m));
  if (other) return { correct: true, matchedMeaningId: other.id };
  return { correct: false, matchedMeaningId: null };
}
