/**
 * Moteur d'exercices (PRD v0.2 §4, §6.3 + itération 2) : sélection pondérée
 * par faiblesse et validation stricte normalisée. Indépendant du mode de
 * stockage : travaille sur des candidats génériques (signification de mot ou
 * phrase de la bibliothèque intégrée).
 */
import { frMatch } from './normalize.ts';
import type { Level } from './mastery.ts';

export type QuizMode = 'standard' | 'weak' | 'reinforce' | 'mixed' | 'context';
export type QuestionKind = 'meaning' | 'phrase';
export type SessionKind = 'vocab' | 'phrases' | 'mixed';

export const QUIZ_LENGTH = 15;
/** Quiz mixte (itération 2 §2.3) : exactement 8 questions de vocabulaire et 7 de phrases. */
export const MIXED_VOCAB_COUNT = 8;
export const MIXED_PHRASE_COUNT = QUIZ_LENGTH - MIXED_VOCAB_COUNT;

export interface Candidate {
  kind: QuestionKind;
  targetId: number;
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
      const chosen = new Set(weakSide.map((c) => c.targetId));
      // Les ~30 % restants viennent des acquis/nouveaux, pas des faibles restantes.
      const othersPool = all.filter((c) => !chosen.has(c.targetId) && (c.level === 'mastered' || c.level === 'new'));
      const others = weightedPick(othersPool, QUIZ_LENGTH - weakSide.length);
      others.forEach((o) => chosen.add(o.targetId));
      // Source pauvre : on complète avec les faibles non tirées.
      const leftover = tieredPick([byLevel(all, 'weak'), byLevel(all, 'reinforce')], QUIZ_LENGTH - weakSide.length - others.length)
        .filter((c) => !chosen.has(c.targetId));
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

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Quiz mixte (itération 2 §2.3) : 8 questions de vocabulaire et 7 de phrases,
 * ordre mélangé. Retourne null si l'un des deux bassins est insuffisant —
 * le quota est exact, on ne complète pas d'une catégorie par l'autre.
 */
export function selectMixedQuestions(
  vocab: Candidate[],
  phrases: Candidate[],
  mode: QuizMode,
  context: string | null
): Candidate[] | null {
  const v = selectQuestions(vocab, mode, context).slice(0, MIXED_VOCAB_COUNT);
  const p = selectQuestions(phrases, mode, context).slice(0, MIXED_PHRASE_COUNT);
  if (v.length < MIXED_VOCAB_COUNT || p.length < MIXED_PHRASE_COUNT) return null;
  return shuffle([...v, ...p]);
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

export interface PhraseForCheck {
  id: number;
  translation: string;
  alts: string[];
}

/**
 * Validation d'une traduction de phrase (itération 2 §5.2) : égalité stricte
 * normalisée avec la traduction principale ou une alternative acceptée. Pas
 * de repli multi-sens (une phrase n'a pas d'autres sens) ni de correction
 * partielle — les variantes de formulation sont couvertes par les
 * alternatives répertoriées dans la bibliothèque.
 */
export function checkPhraseAnswer(answer: string, phrase: PhraseForCheck): boolean {
  return frMatch(answer, phrase.translation) || phrase.alts.some((a) => frMatch(answer, a));
}
