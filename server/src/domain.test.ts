import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFr, frMatch } from './normalize.ts';
import { aggregateWord, levelOf, masteryScore } from './mastery.ts';
import type { Attempt } from './mastery.ts';
import { MIXED_PHRASE_COUNT, MIXED_VOCAB_COUNT, QUIZ_LENGTH, checkAnswer, checkPhraseAnswer, selectMixedQuestions, selectQuestions } from './engine.ts';
import type { Candidate } from './engine.ts';

// --- Normalisation stricte (PRD §4.2) -------------------------------------

test('normalizeFr : casse, accents, ponctuation, espaces', () => {
  assert.equal(normalizeFr("l'heure"), 'heure');
  assert.equal(normalizeFr('  École!  '), 'ecole');
  assert.equal(normalizeFr('Pomme'), 'pomme');
});

test('normalizeFr : articles de tête retirés (max 2)', () => {
  assert.equal(normalizeFr('la pomme'), 'pomme');
  assert.equal(normalizeFr('Une pomme'), 'pomme');
  assert.equal(normalizeFr('de la pomme'), 'pomme');
});

test('frMatch : pluriel et variantes acceptées, sens distincts refusés', () => {
  assert.ok(frMatch('des pommes', 'pomme'));
  assert.ok(frMatch('Excuse', 'excuses'));
  assert.ok(frMatch("L'École", 'ecole'));
  assert.ok(!frMatch('un fruit', 'pomme'));
  assert.ok(!frMatch('poire', 'pomme'));
});

// --- Maîtrise EWMA (PRD §5.3) ---------------------------------------------

const ok: Attempt = { correct: 1, hint_used: 0 };
const okHint: Attempt = { correct: 1, hint_used: 1 };
const ko: Attempt = { correct: 0, hint_used: 0 };

test('masteryScore : null sans tentative, valeurs de tentative', () => {
  assert.equal(masteryScore([]), null);
  assert.equal(masteryScore([ok]), 1);
  assert.equal(masteryScore([okHint]), 0.6);
  assert.equal(masteryScore([ko]), 0);
});

test('levelOf : niveaux et erreur isolée non pénalisante', () => {
  assert.equal(levelOf([ok, ko, ko, ok]), 'reinforce');
  assert.equal(levelOf([ko]), 'reinforce'); // 1 tentative → jamais weak (§5.3)
  assert.equal(levelOf([ko, ko]), 'weak');
  assert.equal(levelOf([ok, ok]), 'reinforce'); // < 3 tentatives : pas mastered
  assert.equal(levelOf([ok, ok, ok]), 'mastered');
  assert.equal(levelOf([okHint, okHint, okHint]), 'reinforce'); // 0.6 < 0.8
  assert.equal(levelOf([ok, ko, ok, ok]), 'mastered'); // erreur ancienne rachetée par 3 réussites récentes
});

test('masteryScore : récence pondère davantage (λ=0,6)', () => {
  const vieillesErreursPuisReussites = [ko, ko, ok, ok];
  const vieillesReussitesPuisErreurs = [ok, ok, ko, ko];
  const s1 = masteryScore(vieillesErreursPuisReussites)!;
  const s2 = masteryScore(vieillesReussitesPuisErreurs)!;
  assert.ok(s1 > 0.7, `s1=${s1}`);
  assert.ok(s2 < 0.5, `s2=${s2}`);
  assert.ok(s2 < s1, `s2=${s2} devrait être < s1`);
  assert.equal(levelOf(vieillesErreursPuisReussites), 'reinforce');
});

test('aggregateWord : agrégation §5.4', () => {
  assert.equal(aggregateWord(['mastered', 'mastered']), 'mastered');
  assert.equal(aggregateWord(['mastered', 'reinforce']), 'reinforce');
  assert.equal(aggregateWord(['mastered', 'new']), 'reinforce'); // clarifié v0.2
  assert.equal(aggregateWord(['mastered', 'reinforce', 'weak']), 'weak');
});

// --- Sélection pondérée (PRD §6.3) -----------------------------------------

function candidates(spec: Array<[number, Candidate['level'], string | null]>, kind: Candidate['kind'] = 'meaning'): Candidate[] {
  return spec.map(([targetId, level, context]) => ({ kind, targetId, level, context }));
}

test('sélection standard : 15 max, sans remise, tout le monde si moins', () => {
  const pool = candidates(Array.from({ length: 40 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null]));
  const picked = selectQuestions(pool, 'standard', null);
  assert.equal(picked.length, QUIZ_LENGTH);
  const ids = new Set(picked.map((p) => p.targetId));
  assert.equal(ids.size, QUIZ_LENGTH); // sans remise
  const small = selectQuestions(pool.slice(0, 5), 'standard', null);
  assert.equal(small.length, 5); // source pauvre → session réduite
});

test('sélection weak : priorise les non maîtrisées puis complète', () => {
  const pool = candidates([
    ...Array.from({ length: 5 }, (_, i) => [i + 1, 'weak', null] as [number, Candidate['level'], string | null]),
    ...Array.from({ length: 5 }, (_, i) => [100 + i, 'reinforce', null] as [number, Candidate['level'], string | null]),
    ...Array.from({ length: 20 }, (_, i) => [200 + i, 'mastered', null] as [number, Candidate['level'], string | null]),
  ]);
  const picked = selectQuestions(pool, 'weak', null);
  assert.equal(picked.length, QUIZ_LENGTH);
  const weakIds = picked.filter((p) => p.level === 'weak');
  const reinforceIds = picked.filter((p) => p.level === 'reinforce');
  assert.equal(weakIds.length, 5);
  assert.equal(reinforceIds.length, 5);
  assert.equal(picked.length - weakIds.length - reinforceIds.length, 5); // complétion maîtrisées
});

test('sélection mixed : ~70% de faibles', () => {
  const pool = candidates([
    ...Array.from({ length: 15 }, (_, i) => [i + 1, 'weak', null] as [number, Candidate['level'], string | null]),
    ...Array.from({ length: 15 }, (_, i) => [100 + i, 'mastered', null] as [number, Candidate['level'], string | null]),
  ]);
  const picked = selectQuestions(pool, 'mixed', null);
  assert.equal(picked.length, QUIZ_LENGTH);
  const weak = picked.filter((p) => p.level === 'weak').length;
  assert.equal(weak, Math.round(QUIZ_LENGTH * 0.7));
});

test('sélection context : cible le contexte puis complète', () => {
  const pool = candidates([
    [1, 'mastered', 'Alimentation'],
    [2, 'mastered', 'Alimentation'],
    [3, 'weak', 'Relations sociales'],
    [4, 'new', 'Alimentation'],
    ...Array.from({ length: 20 }, (_, i) => [100 + i, 'new', 'Autre'] as [number, Candidate['level'], string | null]),
  ]);
  const picked = selectQuestions(pool, 'context', 'alimentation'); // insensible à la casse
  const inCtx = picked.filter((p) => [1, 2, 4].includes(p.targetId));
  assert.equal(inCtx.length, 3); // les 3 du contexte d'abord
  assert.equal(picked.length, QUIZ_LENGTH);
});

// --- Quiz mixte mots + phrases (itération 2 §2.3) ---------------------------

test('sélection mixte : exactement 8 vocabulaire et 7 phrases, sans doublon', () => {
  const vocab = candidates(Array.from({ length: 20 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null]));
  const phrases = candidates(
    Array.from({ length: 20 }, (_, i) => [100 + i, 'new', null] as [number, Candidate['level'], string | null]),
    'phrase'
  );
  const picked = selectMixedQuestions(vocab, phrases, 'standard', null)!;
  assert.equal(picked.length, QUIZ_LENGTH);
  assert.equal(picked.filter((p) => p.kind === 'meaning').length, MIXED_VOCAB_COUNT);
  assert.equal(picked.filter((p) => p.kind === 'phrase').length, MIXED_PHRASE_COUNT);
  assert.equal(new Set(picked.map((p) => `${p.kind}:${p.targetId}`)).size, QUIZ_LENGTH); // sans remise
});

test('sélection mixte : bassin insuffisant → null (quota exact, pas de complétion croisée)', () => {
  const vocab7 = candidates(Array.from({ length: 7 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null]));
  const phrases6 = candidates(
    Array.from({ length: 6 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null]),
    'phrase'
  );
  const phrases7 = candidates(
    Array.from({ length: 7 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null]),
    'phrase'
  );
  assert.equal(selectMixedQuestions(vocab7, phrases7, 'standard', null), null);
  assert.equal(selectMixedQuestions(candidates(Array.from({ length: 20 }, (_, i) => [i + 1, 'new', null] as [number, Candidate['level'], string | null])), phrases6, 'standard', null), null);
});

// --- Validation des réponses (PRD §4.2) -------------------------------------

const target = { id: 1, translation: 'pomme' };
const other = { id: 2, translation: 'excuses' };
const third = { id: 3, translation: 'regrets' };

test('checkAnswer : traduction de la cible, normalisée', () => {
  assert.deepEqual(checkAnswer('Pomme', target, [target, other, third]), { correct: true, matchedMeaningId: 1 });
  assert.deepEqual(checkAnswer('une pomme', target, [target, other, third]), { correct: true, matchedMeaningId: 1 });
  assert.deepEqual(checkAnswer('des pommes', target, [target, other, third]), { correct: true, matchedMeaningId: 1 });
});

test('checkAnswer : autre signification du mot = correcte, attribuée à ce sens', () => {
  assert.deepEqual(checkAnswer('excuses', target, [target, other, third]), { correct: true, matchedMeaningId: 2 });
  assert.deepEqual(checkAnswer('des regrets', target, [target, other, third]), { correct: true, matchedMeaningId: 3 });
});

test('checkAnswer : réponse hors champ = incorrecte', () => {
  assert.deepEqual(checkAnswer('poire', target, [target, other, third]), { correct: false, matchedMeaningId: null });
  assert.deepEqual(checkAnswer('', target, [target, other, third]), { correct: false, matchedMeaningId: null });
});

// --- Validation des phrases (itération 2 §5.2) -------------------------------

const phrase = { id: 1, translation: 'Je mange une pomme.', alts: ['Je mange des pommes'] };

test('checkPhraseAnswer : principale et alternative, normalisées', () => {
  assert.ok(checkPhraseAnswer('je mange une pomme', phrase)); // casse + ponctuation
  assert.ok(checkPhraseAnswer('Je mange des pommes', phrase)); // alternative
  assert.ok(checkPhraseAnswer('JE MANGE UNE POMME !!', phrase));
});

test('checkPhraseAnswer : pas de correction partielle ni de repli', () => {
  assert.ok(!checkPhraseAnswer('je mange une poire', phrase)); // mot erroné
  assert.ok(!checkPhraseAnswer('mange pomme', phrase)); // partiel
  assert.ok(!checkPhraseAnswer('', phrase));
});
