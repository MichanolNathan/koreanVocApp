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
import { loadOfficialDictionary, OFFICIAL_DICTIONARY } from './official-dictionary.ts';
import {
  answerQuestion,
  computeStats,
  createSession,
  createWord,
  deleteWord,
  getHint,
  getResults,
  getSessionView,
  listWords,
  replaceWord,
} from './repo.ts';
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

test('migration v0.3 + v0.4 : base v0.2.1 reconstruite avec sauvegarde, données et catégories conservées', async () => {
  // Base à l'ancien schéma (avant itération 2 + catégorie au niveau du mot) :
  // questions et attempt_log mono-cible, une session et une tentative existantes.
  const dir = mkdtempSync(join(tmpdir(), 'kvoc-mig-'));
  const dbPath = join(dir, 'app.db');
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY AUTOINCREMENT, korean TEXT NOT NULL UNIQUE, romanization TEXT, pos TEXT, source TEXT NOT NULL DEFAULT 'personal', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meanings (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, translation TEXT NOT NULL, hint TEXT, context TEXT, example_ko TEXT, example_fr TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meaning_translations (id INTEGER PRIMARY KEY AUTOINCREMENT, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, text TEXT NOT NULL);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, exercise_type TEXT NOT NULL DEFAULT 'translation', mode TEXT NOT NULL, context_filter TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, position INTEGER NOT NULL, hint_used INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, user_answer TEXT, correct INTEGER, expected_translation TEXT NOT NULL, matched_meaning_id INTEGER, answered_at TEXT);
    CREATE TABLE attempt_log (id INTEGER PRIMARY KEY AUTOINCREMENT, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL, user_answer TEXT, correct INTEGER NOT NULL, hint_used INTEGER NOT NULL, answered_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO words (id, korean, pos) VALUES (1, '사과', 'nom');
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
  // v0.4 : la catégorie du mot descend sur sa signification, words perd pos.
  const m = db.prepare('SELECT id, translation, pos FROM meanings').all() as { id: number; translation: string; pos: string | null }[];
  assert.deepEqual(m, [{ id: 1, translation: 'pomme', pos: 'nom' }]);
  const wordCols = db.prepare('PRAGMA table_info(words)').all() as { name: string }[];
  assert.ok(!wordCols.map((c) => c.name).includes('pos'), 'words ne doit plus porter de colonne pos');
  // La cascade words → meanings survit à la reconstruction de words.
  const sea = createWord(db, { korean: '바다', meanings: [{ translation: 'mer' }] });
  deleteWord(db, sea.id);
  const orphaned = db.prepare('SELECT COUNT(*) AS n FROM meanings WHERE word_id = ?').get(sea.id) as { n: number };
  assert.equal(orphaned.n, 0);
  // Écriture d'une question phrase puis réouverture : stable, pas de nouvelle sauvegarde.
  db.exec("INSERT INTO phrases (id, korean, translation) VALUES (7, '안녕하세요.', 'bonjour.')");
  db.prepare("INSERT INTO questions (session_id, kind, phrase_id, position, expected_translation) VALUES (1, 'phrase', 7, 2, 'bonjour.')").run();
  await openDb(dbPath);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('app.db.backup-')).length, 1);
});

test('migration v0.5 : les autres traductions deviennent des significations du mot', async () => {
  // Base au schéma v0.4 : le champ « autres traductions » existe encore
  // (meaning_translations) et deux mots l'utilisent — dont un doublon
  // normalisé (« Pomme » ≈ « pomme ») qui doit être écarté.
  const dir = mkdtempSync(join(tmpdir(), 'kvoc-alts-'));
  const dbPath = join(dir, 'app.db');
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY AUTOINCREMENT, korean TEXT NOT NULL UNIQUE, romanization TEXT, source TEXT NOT NULL DEFAULT 'personal', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meanings (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, translation TEXT NOT NULL, pos TEXT, hint TEXT, context TEXT, example_ko TEXT, example_fr TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meaning_translations (id INTEGER PRIMARY KEY AUTOINCREMENT, meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE, text TEXT NOT NULL);
    INSERT INTO words (id, korean) VALUES (1, '사과'), (2, '바다');
    INSERT INTO meanings (id, word_id, translation, pos, hint, context) VALUES (1, 1, 'pomme', 'nom', 'fruit rond', 'Alimentation');
    INSERT INTO meanings (id, word_id, translation, pos, context) VALUES (2, 2, 'mer', 'nom', 'Nature');
    INSERT INTO meaning_translations (meaning_id, text) VALUES (1, 'fruit'), (1, 'Pomme'), (2, 'océan');
  `);
  writeFileSync(dbPath, Buffer.from(raw.export()));

  const db = await openDb(dbPath);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('app.db.backup-')).length, 1, 'sauvegarde avant conversion');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meaning_translations'").get()!.n,
    0,
    'la table meaning_translations doit disparaître'
  );

  // Catégorie et contexte hérités ; pas l'indice (il décrivait la
  // traduction principale et pourrait divulguer la réponse) ; doublon écarté.
  const sagwa = listWords(db).find((w) => w.korean === '사과')!;
  assert.deepEqual(
    sagwa.meanings.map((m) => ({ translation: m.translation, pos: m.pos, hint: m.hint, context: m.context })),
    [
      { translation: 'pomme', pos: 'nom', hint: 'fruit rond', context: 'Alimentation' },
      { translation: 'fruit', pos: 'nom', hint: null, context: 'Alimentation' },
    ]
  );
  const sea = listWords(db).find((w) => w.korean === '바다')!;
  assert.deepEqual(sea.meanings.map((m) => m.translation), ['mer', 'océan']);

  // L'ancienne alternative reste acceptée en quiz : elle est désormais une
  // autre signification du même mot (PRD §4.2).
  const judges = sagwa.meanings.map((m) => ({ id: m.id, translation: m.translation }));
  assert.deepEqual(checkAnswer('fruit', judges[0]!, judges), { correct: true, matchedMeaningId: sagwa.meanings[1]!.id });

  // Réouverture : idempotent, pas de nouvelle sauvegarde ni de doublon.
  await openDb(dbPath);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('app.db.backup-')).length, 1);
  assert.equal(listWords(db).find((w) => w.korean === '사과')!.meanings.length, 2);
});

test('catégorie grammaticale par signification : création, édition en place, quiz', async () => {
  const db = await openDb(':memory:');
  const created = createWord(db, {
    korean: '반짝',
    romanization: 'banjjak',
    meanings: [
      { translation: 'scintillement', pos: 'nom' },
      { translation: 'en scintillant', pos: 'adverbe' },
    ],
  });
  assert.deepEqual(created.meanings.map((m) => m.pos), ['nom', 'adverbe']);

  // Remplacement : la 1re signification garde son id (historique conservé),
  // la 2e est recréée avec sa propre catégorie.
  const updated = replaceWord(db, created.id, {
    korean: '반짝',
    meanings: [
      { id: created.meanings[0]!.id, translation: 'éclat', pos: 'nom' },
      { translation: 'en scintillant', pos: 'adverbe' },
    ],
  })!;
  assert.equal(updated.meanings[0]!.id, created.meanings[0]!.id);
  assert.deepEqual(updated.meanings.map((m) => m.pos), ['nom', 'adverbe']);

  // Quiz : chaque question affiche la catégorie de la signification visée.
  const session = createSession(db, 'standard', null, undefined, 'vocab');
  const posList = session.questions.map((q) => q.pos).sort();
  assert.deepEqual(posList, ['adverbe', 'nom']);

  // Dictionnaire officiel : la catégorie descend aussi sur la signification.
  loadOfficialDictionary(db);
  const hoesawon = listWords(db, 'official').find((w) => w.korean === '회사원')!;
  assert.equal(hoesawon.meanings[0]!.pos, 'nom');
});

// --- Dictionnaire officiel livré (v1.1.1) ------------------------------------

test('dictionnaire officiel : livraison idempotente, source official', async () => {
  const db = await openDb(':memory:');
  const first = loadOfficialDictionary(db);
  assert.equal(first, OFFICIAL_DICTIONARY.length);
  assert.equal(loadOfficialDictionary(db), 0, 'rechargement : rien à ajouter');
  assert.equal(listWords(db, 'official').length, OFFICIAL_DICTIONARY.length);
  const dup = db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT korean FROM words GROUP BY korean HAVING COUNT(*) > 1)')
    .get() as { n: number };
  assert.equal(dup.n, 0);
});

test('dictionnaire officiel : suppression définitive (tombstone) et éditions préservées', async () => {
  const db = await openDb(':memory:');
  loadOfficialDictionary(db);

  // Suppression utilisateur : pas de réinjection au démarrage suivant.
  const victim = listWords(db).find((w) => w.korean === '주말')!;
  assert.ok(deleteWord(db, victim.id));
  assert.equal(loadOfficialDictionary(db), 0);
  assert.ok(!listWords(db).some((w) => w.korean === '주말'), 'le mot supprimé ne doit pas revenir');

  // Édition utilisateur : jamais écrasée par un redémarrage.
  const coffee = listWords(db).find((w) => w.korean === '커피')!;
  replaceWord(db, coffee.id, { korean: '커피', meanings: [{ translation: 'boisson caféinée' }] });
  assert.equal(loadOfficialDictionary(db), 0);
  const after = listWords(db).find((w) => w.korean === '커피')!;
  assert.equal(after.meanings[0]!.translation, 'boisson caféinée');
});

test('dictionnaire officiel : un mot personnel homonyme prime et n’est pas converti', async () => {
  const db = await openDb(':memory:');
  createWord(db, { korean: '차', meanings: [{ translation: 'voiture' }], source: 'personal' });
  assert.equal(loadOfficialDictionary(db), OFFICIAL_DICTIONARY.length - 1, '차 est déjà présent → ignoré');
  const tea = listWords(db).find((w) => w.korean === '차')!;
  assert.equal(tea.source, 'personal');
  assert.equal(tea.meanings[0]!.translation, 'voiture');
});
