// Intégration du dépôt sur base en mémoire : bibliothèque de phrases,
// sessions phrases/mixtes, validation, résultats et stats (itération 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { openDb, type DB } from './db.ts';
import { loadPhraseLibrary } from './phrase-library.ts';
import { answerQuestion, computeStats, createSession, createWord, getHint, getResults, getSessionView } from './repo.ts';
import { checkAnswer, checkPhraseAnswer, QUIZ_LENGTH } from './engine.ts';

async function freshDb(words = 20): Promise<DB> {
  const db = await openDb(':memory:');
  loadPhraseLibrary(db);
  for (let i = 0; i < words; i++) {
    createWord(db, { korean: `단어${i}`, meanings: [{ translation: `mot ${i}`, hint: `indice ${i}` }] });
  }
  return db;
}

test('bibliothèque : chargement idempotent et liens vocabulaire', async () => {
  const db = await openDb(':memory:');
  createWord(db, { korean: '사과', meanings: [{ translation: 'pomme' }] });
  const n1 = loadPhraseLibrary(db);
  const n2 = loadPhraseLibrary(db); // rechargement : upsert, pas de doublon
  assert.equal(n1, n2);
  const count = db.prepare('SELECT COUNT(*) AS n FROM phrases').get() as { n: number };
  assert.equal(count.n, n1);
  const dup = db.prepare('SELECT COUNT(*) AS n FROM (SELECT korean FROM phrases GROUP BY korean HAVING COUNT(*) > 1)').get() as { n: number };
  assert.equal(dup.n, 0);
  // « 저는 사과를 먹어요. » contient « 사과 » → lien créé (analyse seule).
  const link = db
    .prepare("SELECT COUNT(*) AS n FROM phrase_vocab pv JOIN phrases p ON p.id = pv.phrase_id WHERE p.korean LIKE '%사과%'")
    .get() as { n: number };
  assert.ok(link.n >= 1);
});

test('session phrases : 15 questions phrase, aucune traduction exposée, indice', async () => {
  const db = await freshDb();
  const session = createSession(db, 'standard', null, undefined, 'phrases');
  assert.equal(session.kind, 'phrases');
  assert.equal(session.questions.length, QUIZ_LENGTH);
  assert.ok(session.questions.every((q) => q.kind === 'phrase'));
  assert.ok(session.questions.every((q) => q.hintAvailable));

  const view = getSessionView(db, session.id)!;
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('expected'), 'la vue ne doit pas exposer les traductions attendues');

  const q1 = session.questions[0]!;
  const hint = getHint(db, session.id, q1.id);
  assert.equal(typeof hint, 'string');
  const hintTwice = getHint(db, session.id, q1.id); // déjà marquée utilisée mais question non répondue → même indice
  assert.equal(hintTwice, hint);

  const outcome = answerQuestion(db, session.id, q1.id, 'réponse hors champ', checkAnswer, checkPhraseAnswer) as {
    kind: 'phrase';
    correct: boolean;
    acceptedTranslations: string[];
  };
  assert.equal(outcome.kind, 'phrase');
  assert.equal(outcome.correct, false);
  assert.ok(Array.isArray(outcome.acceptedTranslations));
});

test('session phrases : réponse correcte avec indice journalisée (valeur 0,6)', async () => {
  const db = await freshDb();
  const session = createSession(db, 'standard', null, undefined, 'phrases');
  const q = session.questions[0]!;
  getHint(db, session.id, q.id);
  const phrase = db
    .prepare('SELECT p.translation FROM questions qq JOIN phrases p ON p.id = qq.phrase_id WHERE qq.id = ?')
    .get(q.id) as { translation: string };
  const outcome = answerQuestion(db, session.id, q.id, phrase.translation, checkAnswer, checkPhraseAnswer) as {
    kind: 'phrase';
    correct: boolean;
  };
  assert.ok(outcome.correct);
  const log = db.prepare("SELECT correct, hint_used FROM attempt_log WHERE kind = 'phrase'").all() as {
    correct: number;
    hint_used: number;
  }[];
  assert.equal(log.length, 1);
  assert.equal(log[0]!.correct, 1);
  assert.equal(log[0]!.hint_used, 1);
});

test('session mixte : exactement 8 vocabulaire et 7 phrases mélangées, ventilation résultats', async () => {
  const db = await freshDb();
  const session = createSession(db, 'standard', null, undefined, 'mixed');
  assert.equal(session.questions.length, QUIZ_LENGTH);
  assert.equal(session.questions.filter((q) => q.kind === 'vocab').length, 8);
  assert.equal(session.questions.filter((q) => q.kind === 'phrase').length, 7);
  // Mélange : les deux catégories ne sont pas groupées (7 phrases consécutives
  // puis 8 mots serait la signature d'un non-mélange) — vérifié sur l'ordre brut.
  const kinds = session.questions.map((q) => q.kind);
  const joined = kinds.join(',');
  assert.notEqual(joined, 'phrase,phrase,phrase,phrase,phrase,phrase,phrase,vocab,vocab,vocab,vocab,vocab,vocab,vocab,vocab');
  assert.notEqual(joined, 'vocab,vocab,vocab,vocab,vocab,vocab,vocab,vocab,phrase,phrase,phrase,phrase,phrase,phrase,phrase');

  // Répondre à tout : deux fois avec la bonne réponse (une de chaque catégorie),
  // le reste faux — les traductions attendues sont lues côté serveur uniquement.
  for (const q of session.questions) {
    let answer = 'xxx';
    if (q.id === session.questions[0]!.id) {
      const row = db
        .prepare(
          `SELECT COALESCE(p.translation, m.translation) AS t
           FROM questions qq
           LEFT JOIN phrases p ON p.id = qq.phrase_id
           LEFT JOIN meanings m ON m.id = qq.meaning_id
           WHERE qq.id = ?`
        )
        .get(q.id) as { t: string | null } | undefined;
      answer = row?.t ?? 'xxx';
    }
    answerQuestion(db, session.id, q.id, answer, checkAnswer, checkPhraseAnswer);
  }
  const results = getResults(db, session.id)!;
  assert.equal(results.byCategory.vocab.total, 8);
  assert.equal(results.byCategory.phrases.total, 7);
  assert.equal(results.correct, 1);
  assert.equal(results.byCategory.vocab.correct + results.byCategory.phrases.correct, 1);
  const phraseQs = results.questions.filter((q) => q.kind === 'phrase');
  assert.ok(phraseQs.every((q) => Array.isArray(q.acceptedTranslations)));
});

test('session mixte : bassins insuffisants → erreur explicite', async () => {
  const db = await freshDb(3); // 3 significations < 8 requises
  assert.throws(() => createSession(db, 'standard', null, undefined, 'mixed'), /8 significations/);
});

test('stats : maîtrise des phrases indépendante des mots', async () => {
  const db = await freshDb(2);
  // Deux échecs sur la phrase 1 (tentatives directes) → non maîtrisée ;
  // les mots, eux, restent non évalués (itération 2 §7.2).
  const ins = db.prepare("INSERT INTO attempt_log (kind, phrase_id, correct, hint_used) VALUES ('phrase', 1, 0, 0)");
  ins.run();
  ins.run();
  const stats = computeStats(db);
  assert.equal(stats.phrases.total, 80);
  assert.ok(stats.phrases.weakPhrases.some((p) => p.phraseId === 1));
  assert.equal(stats.byLevel.new, stats.totalMeanings); // aucun mot évalué
  assert.equal(stats.phrases.byLevel.weak, 1);
});

test('non-régression : session vocabulaire inchangée (15, kind vocab)', async () => {
  const db = await freshDb();
  const session = createSession(db, 'standard', null, undefined, 'vocab');
  assert.equal(session.kind, 'vocab');
  assert.equal(session.questions.length, QUIZ_LENGTH);
  assert.ok(session.questions.every((q) => q.kind === 'vocab'));
});

test('migration v0.3 : base v0.2.1 reconstruite avec sauvegarde du fichier, données conservées', async () => {
  // Base à l'ancien schéma (avant itération 2) : questions et attempt_log
  // mono-cible, avec une session et une tentative existantes.
  const dir = mkdtempSync(join(tmpdir(), 'kvoc-mig-'));
  const dbPath = join(dir, 'app.db');
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY AUTOINCREMENT, korean TEXT NOT NULL UNIQUE, romanization TEXT, pos TEXT, source TEXT NOT NULL DEFAULT 'personal', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meanings (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, translation TEXT NOT NULL, hint TEXT, context TEXT, example_ko TEXT, example_fr TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meaning_translations (id INTEGER PRIMARY KEY AUTOINCREMENT, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, text TEXT NOT NULL);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, exercise_type TEXT NOT NULL DEFAULT 'translation', mode TEXT NOT NULL, context_filter TEXT, source_filter TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, position INTEGER NOT NULL, hint_used INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, user_answer TEXT, correct INTEGER, expected_translation TEXT NOT NULL, matched_meaning_id INTEGER, answered_at TEXT);
    CREATE TABLE attempt_log (id INTEGER PRIMARY KEY AUTOINCREMENT, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL, user_answer TEXT, correct INTEGER NOT NULL, hint_used INTEGER NOT NULL, answered_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO words (id, korean) VALUES (1, '사과');
    INSERT INTO meanings (id, word_id, translation) VALUES (1, 1, 'pomme');
    INSERT INTO sessions (id, mode) VALUES (1, 'standard');
    INSERT INTO questions (id, session_id, meaning_id, position, answered, correct, expected_translation) VALUES (1, 1, 1, 1, 1, 1, 'pomme');
    INSERT INTO attempt_log (id, meaning_id, session_id, correct, hint_used) VALUES (1, 1, 1, 1, 0);
  `);
  writeFileSync(dbPath, Buffer.from(raw.export()));

  const db = await openDb(dbPath);
  const backups = readdirSync(dir).filter((f) => f.startsWith('app.db.backup-'));
  assert.equal(backups.length, 1, 'une sauvegarde horodatée doit exister avant migration');
  const q = db.prepare('SELECT kind, meaning_id, correct FROM questions').all() as { kind: string; meaning_id: number; correct: number }[];
  assert.deepEqual(q, [{ kind: 'meaning', meaning_id: 1, correct: 1 }]);
  const a = db.prepare('SELECT kind, meaning_id FROM attempt_log').all() as { kind: string; meaning_id: number }[];
  assert.deepEqual(a, [{ kind: 'meaning', meaning_id: 1 }]);
  const s = db.prepare('SELECT kind FROM sessions').get() as { kind: string };
  assert.equal(s.kind, 'vocab');
  // Écriture d'une question phrase puis réouverture : stable, pas de nouvelle sauvegarde.
  db.exec("INSERT INTO phrases (id, korean, translation) VALUES (7, '안녕하세요.', 'bonjour.')");
  db.prepare("INSERT INTO questions (session_id, kind, phrase_id, position, expected_translation) VALUES (1, 'phrase', 7, 2, 'bonjour.')").run();
  await openDb(dbPath);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('app.db.backup-')).length, 1);
});
