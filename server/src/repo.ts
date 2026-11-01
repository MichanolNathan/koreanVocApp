import type { DB } from './db.ts';
import type { Attempt, Level } from './mastery.ts';
import { aggregateWord, levelOf, masteryScore } from './mastery.ts';
import type { Candidate, QuizMode, SessionKind } from './engine.ts';
import { MIXED_PHRASE_COUNT, MIXED_VOCAB_COUNT, QUIZ_LENGTH, selectMixedQuestions, selectQuestions } from './engine.ts';

export interface MeaningDTO {
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

export interface WordDTO {
  id: number;
  korean: string;
  romanization: string | null;
  pos: string | null;
  source: string;
  created_at: string;
  level: Level;
  meanings: MeaningDTO[];
}

export interface MeaningInput {
  id?: number;
  translation: string;
  alts?: string[];
  hint?: string | null;
  context?: string | null;
  example_ko?: string | null;
  example_fr?: string | null;
}

export type WordSource = 'personal' | 'official';

export interface WordInput {
  korean: string;
  romanization?: string | null;
  pos?: string | null;
  source?: WordSource;
  meanings: MeaningInput[];
}

export interface SessionQuestionView {
  id: number;
  position: number;
  kind: 'vocab' | 'phrase';
  korean: string;
  romanization: string | null;
  pos: string | null;
  hintAvailable: boolean;
  answered: boolean;
  userAnswer: string | null;
  correct: boolean | null;
}

interface WordRow {
  id: number;
  korean: string;
  romanization: string | null;
  pos: string | null;
  source: string;
  created_at: string;
}

interface MeaningRow {
  id: number;
  word_id: number;
  translation: string;
  hint: string | null;
  context: string | null;
  example_ko: string | null;
  example_fr: string | null;
}

export interface PhraseRow {
  id: number;
  korean: string;
  translation: string;
  romanization: string | null;
  difficulty: string;
  hint: string | null;
  theme: string | null;
  grammar_point: string | null;
}

interface AttemptRow {
  correct: number;
  hint_used: number;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

interface LogRow extends AttemptRow {
  kind: string;
  meaning_id: number | null;
  phrase_id: number | null;
}

/** Journal des tentatives indexé par cible : mots et phrases (itération 2 §7). */
function attemptsIndex(db: DB): { meanings: Map<number, AttemptRow[]>; phrases: Map<number, AttemptRow[]> } {
  const meanings = new Map<number, AttemptRow[]>();
  const phrases = new Map<number, AttemptRow[]>();
  const rows = db
    .prepare('SELECT kind, meaning_id, phrase_id, correct, hint_used FROM attempt_log ORDER BY id')
    .all() as LogRow[];
  for (const row of rows) {
    if (row.kind === 'phrase' && row.phrase_id !== null) {
      const list = phrases.get(row.phrase_id) ?? [];
      list.push(row);
      phrases.set(row.phrase_id, list);
    } else if (row.meaning_id !== null) {
      const list = meanings.get(row.meaning_id) ?? [];
      list.push(row);
      meanings.set(row.meaning_id, list);
    }
  }
  return { meanings, phrases };
}

function levelsOf(attempts: Map<number, AttemptRow[]>): Map<number, { level: Level; attempts: number; score: number | null }> {
  const out = new Map<number, { level: Level; attempts: number; score: number | null }>();
  for (const [id, list] of attempts) {
    out.set(id, { level: levelOf(list), attempts: list.length, score: masteryScore(list) });
  }
  return out;
}

function levelsFor(db: DB): Map<number, { level: Level; attempts: number; score: number | null }> {
  return levelsOf(attemptsIndex(db).meanings);
}

function phraseLevelsFor(db: DB): Map<number, { level: Level; attempts: number; score: number | null }> {
  return levelsOf(attemptsIndex(db).phrases);
}

function altsByMeaning(db: DB): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of db.prepare('SELECT meaning_id, text FROM meaning_translations ORDER BY id').all() as { meaning_id: number; text: string }[]) {
    const list = map.get(row.meaning_id) ?? [];
    list.push(row.text);
    map.set(row.meaning_id, list);
  }
  return map;
}

function assembleWord(db: DB, word: WordRow, meanings: MeaningRow[]): WordDTO {
  const alts = altsByMeaning(db);
  const levels = levelsFor(db);
  const meaningDTOs: MeaningDTO[] = meanings.map((m) => {
    const l = levels.get(m.id);
    return {
      id: m.id,
      translation: m.translation,
      alts: alts.get(m.id) ?? [],
      hint: m.hint,
      context: m.context,
      example_ko: m.example_ko,
      example_fr: m.example_fr,
      level: l?.level ?? 'new',
      attempts: l?.attempts ?? 0,
      score: l?.score ?? null,
    };
  });
  return {
    id: word.id,
    korean: word.korean,
    romanization: word.romanization,
    pos: word.pos,
    source: word.source,
    created_at: word.created_at,
    level: aggregateWord(meaningDTOs.map((m) => m.level)),
    meanings: meaningDTOs,
  };
}

function wordById(db: DB, id: number): WordDTO | null {
  const word = db.prepare('SELECT * FROM words WHERE id = ?').get(id) as WordRow | undefined;
  if (!word) return null;
  const meanings = db.prepare('SELECT * FROM meanings WHERE word_id = ? ORDER BY id').all(id) as MeaningRow[];
  return assembleWord(db, word, meanings);
}

export function listWords(db: DB, source?: 'personal' | 'official'): WordDTO[] {
  const rows =
    source === undefined
      ? (db.prepare('SELECT * FROM words ORDER BY korean').all() as WordRow[])
      : (db.prepare('SELECT * FROM words WHERE source = ? ORDER BY korean').all(source) as WordRow[]);
  return rows.map((w) => wordById(db, w.id)!);
}

export function getWord(db: DB, id: number): WordDTO | null {
  return wordById(db, id);
}

function insertMeanings(db: DB, wordId: number, meanings: MeaningInput[]): void {
  const insMeaning = db.prepare(
    'INSERT INTO meanings (word_id, translation, hint, context, example_ko, example_fr) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insAlt = db.prepare('INSERT INTO meaning_translations (meaning_id, text) VALUES (?, ?)');
  for (const m of meanings) {
    const r = insMeaning.run(wordId, m.translation, m.hint ?? null, m.context ?? null, m.example_ko ?? null, m.example_fr ?? null);
    for (const alt of m.alts ?? []) insAlt.run(Number(r.lastInsertRowid), alt);
  }
}

export function createWord(db: DB, input: WordInput): WordDTO {
  const existing = db.prepare('SELECT id FROM words WHERE korean = ?').get(input.korean) as { id: number } | undefined;
  if (existing) throw new ConflictError(`Le mot « ${input.korean} » existe déjà.`);
  const wordId = db.transaction(() => {
    const r = db
      .prepare('INSERT INTO words (korean, romanization, pos, source) VALUES (?, ?, ?, ?)')
      .run(input.korean, input.romanization ?? null, input.pos ?? null, input.source ?? 'personal');
    const newId = Number(r.lastInsertRowid);
    insertMeanings(db, newId, input.meanings);
    return newId;
  });
  return wordById(db, wordId)!;
}

/**
 * Remplacement complet : les significations portant un `id` existant sont
 * mises à jour en place (historique de tentatives conservé), les nouvelles
 * insérées, les absentes supprimées.
 */
export function replaceWord(db: DB, id: number, input: WordInput): WordDTO | null {
  const current = wordById(db, id);
  if (!current) return null;
  db.transaction(() => {
    db.prepare('UPDATE words SET korean = ?, romanization = ?, pos = ?, source = ? WHERE id = ?').run(
      input.korean,
      input.romanization ?? null,
      input.pos ?? null,
      input.source ?? 'personal',
      id
    );
    const keepIds = new Set<number>();
    const updMeaning = db.prepare(
      'UPDATE meanings SET translation = ?, hint = ?, context = ?, example_ko = ?, example_fr = ? WHERE id = ? AND word_id = ?'
    );
    const delAlts = db.prepare('DELETE FROM meaning_translations WHERE meaning_id = ?');
    const insAlt = db.prepare('INSERT INTO meaning_translations (meaning_id, text) VALUES (?, ?)');
    for (const m of input.meanings) {
      if (m.id && current.meanings.some((c) => c.id === m.id)) {
        updMeaning.run(m.translation, m.hint ?? null, m.context ?? null, m.example_ko ?? null, m.example_fr ?? null, m.id, id);
        delAlts.run(m.id);
        for (const alt of m.alts ?? []) insAlt.run(m.id, alt);
        keepIds.add(m.id);
      }
    }
    const stale = current.meanings.filter((c) => !keepIds.has(c.id)).map((c) => c.id);
    const newOnes = input.meanings.filter((m) => !m.id || !keepIds.has(m.id));
    insertMeanings(db, id, newOnes);
    const delMeaning = db.prepare('DELETE FROM meanings WHERE id = ?');
    for (const sid of stale) delMeaning.run(sid);
  });
  return wordById(db, id);
}

export function deleteWord(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM words WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Sessions de quiz
// ---------------------------------------------------------------------------

export interface CreatedSession {
  id: number;
  kind: SessionKind;
  mode: QuizMode;
  contextFilter: string | null;
  sourceFilter: WordSource | null;
  questions: SessionQuestionView[];
}

function quizCandidates(db: DB, source?: WordSource): Candidate[] {
  const sql =
    source === undefined
      ? `SELECT m.id AS meaning_id, m.context FROM meanings m JOIN words w ON w.id = m.word_id`
      : `SELECT m.id AS meaning_id, m.context FROM meanings m JOIN words w ON w.id = m.word_id WHERE w.source = ?`;
  const rows = (source === undefined ? db.prepare(sql).all() : db.prepare(sql).all(source)) as {
    meaning_id: number;
    context: string | null;
  }[];
  const levels = levelsFor(db);
  return rows.map((r) => ({ kind: 'meaning' as const, targetId: r.meaning_id, level: levels.get(r.meaning_id)?.level ?? 'new', context: r.context }));
}

function phraseCandidates(db: DB): Candidate[] {
  const rows = db.prepare('SELECT id, theme FROM phrases').all() as { id: number; theme: string | null }[];
  const levels = phraseLevelsFor(db);
  return rows.map((r) => ({ kind: 'phrase' as const, targetId: r.id, level: levels.get(r.id)?.level ?? 'new', context: r.theme }));
}

interface MeaningQuizInfo {
  meaning_id: number;
  translation: string;
  hint: string | null;
  korean: string;
  romanization: string | null;
  pos: string | null;
}

function meaningQuizInfo(db: DB): Map<number, MeaningQuizInfo> {
  return new Map(
    (
      db
        .prepare(
          `SELECT m.id AS meaning_id, m.translation, m.hint, w.korean, w.romanization, w.pos
           FROM meanings m JOIN words w ON w.id = m.word_id`
        )
        .all() as MeaningQuizInfo[]
    ).map((r) => [r.meaning_id, r])
  );
}

export function createSession(db: DB, mode: QuizMode, context: string | null, source: WordSource | undefined, kind: SessionKind): CreatedSession {
  let selected: Candidate[];
  if (kind === 'vocab') {
    selected = selectQuestions(quizCandidates(db, source), mode, context);
    if (selected.length === 0) throw new ConflictError('Aucune signification disponible — ajoutez des mots au dictionnaire.');
  } else if (kind === 'phrases') {
    selected = selectQuestions(phraseCandidates(db), mode, context);
    if (selected.length === 0) throw new ConflictError('Aucune phrase disponible dans la bibliothèque.');
  } else {
    const mixed = selectMixedQuestions(quizCandidates(db, source), phraseCandidates(db), mode, context);
    if (mixed === null) {
      throw new ConflictError(
        `Quiz mixte : il faut au moins ${MIXED_VOCAB_COUNT} significations de vocabulaire et ${MIXED_PHRASE_COUNT} phrases.`
      );
    }
    selected = mixed;
  }

  const meanings = meaningQuizInfo(db);
  const phrases = new Map(
    (db.prepare('SELECT id, korean, translation, romanization, hint FROM phrases').all() as (PhraseRow & { translation: string })[]).map(
      (p) => [p.id, p]
    )
  );

  const { sessionId, questions } = db.transaction(() => {
    const s = db
      .prepare('INSERT INTO sessions (kind, mode, context_filter, source_filter) VALUES (?, ?, ?, ?)')
      .run(kind, mode, context, source ?? null);
    const sid = Number(s.lastInsertRowid);
    const insMeaningQ = db.prepare(
      `INSERT INTO questions (session_id, kind, meaning_id, position, expected_translation) VALUES (?, 'meaning', ?, ?, ?)`
    );
    const insPhraseQ = db.prepare(
      `INSERT INTO questions (session_id, kind, phrase_id, position, expected_translation) VALUES (?, 'phrase', ?, ?, ?)`
    );
    const questions: SessionQuestionView[] = [];
    selected.forEach((c, i) => {
      let q: { lastInsertRowid: number };
      let view: Omit<SessionQuestionView, 'id' | 'position'>;
      if (c.kind === 'meaning') {
        const m = meanings.get(c.targetId)!;
        q = insMeaningQ.run(sid, c.targetId, i + 1, m.translation);
        view = {
          kind: 'vocab',
          korean: m.korean,
          romanization: m.romanization,
          pos: m.pos,
          hintAvailable: m.hint !== null,
          answered: false,
          userAnswer: null,
          correct: null,
        };
      } else {
        const p = phrases.get(c.targetId)!;
        q = insPhraseQ.run(sid, c.targetId, i + 1, p.translation);
        view = {
          kind: 'phrase',
          korean: p.korean,
          romanization: p.romanization,
          pos: null,
          hintAvailable: p.hint !== null,
          answered: false,
          userAnswer: null,
          correct: null,
        };
      }
      questions.push({ id: Number(q.lastInsertRowid), position: i + 1, ...view });
    });
    return { sessionId: sid, questions };
  });
  return { id: sessionId, kind, mode, contextFilter: context, sourceFilter: source ?? null, questions };
}

interface QuestionRow {
  id: number;
  session_id: number;
  kind: string;
  meaning_id: number | null;
  phrase_id: number | null;
  position: number;
  hint_used: number;
  answered: number;
  user_answer: string | null;
  correct: number | null;
  expected_translation: string;
  matched_meaning_id: number | null;
  answered_at: string | null;
}

interface SessionRow {
  id: number;
  exercise_type: string;
  kind: string;
  mode: string;
  context_filter: string | null;
  source_filter: WordSource | null;
  started_at: string;
  finished_at: string | null;
}

function sessionRow(db: DB, id: number): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

function questionRows(db: DB, sessionId: number): QuestionRow[] {
  return db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY position').all(sessionId) as QuestionRow[];
}

export interface SessionView {
  id: number;
  kind: string;
  mode: string;
  context_filter: string | null;
  source_filter: WordSource | null;
  started_at: string;
  finished_at: string | null;
  questions: SessionQuestionView[];
}

function questionView(row: QuestionRow, info: { korean: string; romanization: string | null; pos: string | null; hint: string | null }): SessionQuestionView {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind === 'phrase' ? 'phrase' : 'vocab',
    korean: info.korean,
    romanization: info.romanization,
    pos: info.pos,
    hintAvailable: info.hint !== null,
    answered: row.answered === 1,
    userAnswer: row.user_answer,
    correct: row.correct === null ? null : row.correct === 1,
  };
}

export function getSessionView(db: DB, id: number): SessionView | null {
  const s = sessionRow(db, id);
  if (!s) return null;
  const meanings = meaningQuizInfo(db);
  const phrases = new Map(
    (db.prepare('SELECT id, korean, romanization, hint FROM phrases').all() as { id: number; korean: string; romanization: string | null; hint: string | null }[]).map(
      (p) => [p.id, p]
    )
  );
  const questions = questionRows(db, id).map((q) => {
    if (q.kind === 'phrase') {
      const p = phrases.get(q.phrase_id!)!;
      return questionView(q, { korean: p.korean, romanization: p.romanization, pos: null, hint: p.hint });
    }
    const m = meanings.get(q.meaning_id!)!;
    return questionView(q, { korean: m.korean, romanization: m.romanization, pos: m.pos, hint: m.hint });
  });
  return {
    id: s.id,
    kind: s.kind,
    mode: s.mode,
    context_filter: s.context_filter,
    source_filter: s.source_filter,
    started_at: s.started_at,
    finished_at: s.finished_at,
    questions,
  };
}

export function getHint(db: DB, sessionId: number, questionId: number): string | null | undefined {
  const q = db
    .prepare(
      `SELECT q.kind, q.hint_used, q.answered, m.hint AS m_hint, p.hint AS p_hint
       FROM questions q
       LEFT JOIN meanings m ON m.id = q.meaning_id
       LEFT JOIN phrases p ON p.id = q.phrase_id
       WHERE q.id = ? AND q.session_id = ?`
    )
    .get(questionId, sessionId) as { kind: string; hint_used: number; answered: number; m_hint: string | null; p_hint: string | null } | undefined;
  if (!q || q.answered) return undefined;
  db.prepare('UPDATE questions SET hint_used = 1 WHERE id = ? AND answered = 0').run(questionId);
  return q.kind === 'phrase' ? q.p_hint : q.m_hint;
}

export type AnswerOutcome =
  | {
      kind: 'meaning';
      correct: boolean;
      expected: string;
      matchedMeaningId: number | null;
      targetMeaning: { id: number; translation: string; hint: string | null; context: string | null };
      otherMeanings: { id: number; translation: string; hint: string | null; context: string | null }[];
      finished: boolean;
    }
  | {
      kind: 'phrase';
      correct: boolean;
      expected: string;
      /** Autres traductions acceptées, affichées dans le retour (itération 2 §5.2/§6). */
      acceptedTranslations: string[];
      theme: string | null;
      finished: boolean;
    };

export interface MeaningForJudge {
  id: number;
  translation: string;
  alts: string[];
}

export interface PhraseForJudge {
  id: number;
  translation: string;
  alts: string[];
}

export function answerQuestion(
  db: DB,
  sessionId: number,
  questionId: number,
  answer: string,
  judge: (answer: string, target: MeaningForJudge, wordMeanings: MeaningForJudge[]) => { correct: boolean; matchedMeaningId: number | null },
  phraseJudge: (answer: string, phrase: PhraseForJudge) => boolean
): AnswerOutcome | null | undefined {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND session_id = ?').get(questionId, sessionId) as QuestionRow | undefined;
  if (!q) return null;
  if (q.answered) return undefined;

  if (q.kind === 'phrase') {
    const phrase = db.prepare('SELECT id, translation, theme FROM phrases WHERE id = ?').get(q.phrase_id!) as
      | { id: number; translation: string; theme: string | null }
      | undefined;
    if (!phrase) return null;
    const alts = db
      .prepare('SELECT text FROM phrase_translations WHERE phrase_id = ? ORDER BY id')
      .all(phrase.id) as { text: string }[];
    const correct = phraseJudge(answer, { id: phrase.id, translation: phrase.translation, alts: alts.map((a) => a.text) });

    db.transaction(() => {
      const res = db
        .prepare(
          `UPDATE questions SET answered = 1, user_answer = ?, correct = ?, answered_at = datetime('now')
           WHERE id = ? AND answered = 0`
        )
        .run(answer, correct ? 1 : 0, questionId);
      if (res.changes === 0) throw new ConflictError('Question déjà répondue.');
      db.prepare(
        `INSERT INTO attempt_log (kind, phrase_id, session_id, user_answer, correct, hint_used) VALUES ('phrase', ?, ?, ?, ?, ?)`
      ).run(phrase.id, sessionId, answer, correct ? 1 : 0, q.hint_used);
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE session_id = ? AND answered = 0').get(sessionId) as { n: number };
      if (remaining.n === 0) db.prepare("UPDATE sessions SET finished_at = datetime('now') WHERE id = ?").run(sessionId);
    });

    const s = sessionRow(db, sessionId)!;
    return {
      kind: 'phrase',
      correct,
      expected: q.expected_translation,
      acceptedTranslations: alts.map((a) => a.text),
      theme: phrase.theme,
      finished: s.finished_at !== null,
    };
  }

  const wordIdRow = db.prepare('SELECT word_id FROM meanings WHERE id = ?').get(q.meaning_id) as { word_id: number };
  const rows = db
    .prepare(
      `SELECT m.id, m.translation, t.text AS alt FROM meanings m
       LEFT JOIN meaning_translations t ON t.meaning_id = m.id
       WHERE m.word_id = ? ORDER BY m.id, t.id`
    )
    .all(wordIdRow.word_id) as { id: number; translation: string; alt: string | null }[];
  const byId = new Map<number, MeaningForJudge>();
  for (const r of rows) {
    const m = byId.get(r.id) ?? { id: r.id, translation: r.translation, alts: [] as string[] };
    if (r.alt) m.alts.push(r.alt);
    byId.set(r.id, m);
  }
  const target = byId.get(q.meaning_id!)!;
  const verdict = judge(answer, target, [...byId.values()]);

  db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE questions SET answered = 1, user_answer = ?, correct = ?, matched_meaning_id = ?, answered_at = datetime('now')
         WHERE id = ? AND answered = 0`
      )
      .run(answer, verdict.correct ? 1 : 0, verdict.matchedMeaningId, questionId);
    if (res.changes === 0) throw new ConflictError('Question déjà répondue.');
    const attemptMeaningId = verdict.matchedMeaningId ?? q.meaning_id!;
    db.prepare(
      `INSERT INTO attempt_log (kind, meaning_id, session_id, user_answer, correct, hint_used) VALUES ('meaning', ?, ?, ?, ?, ?)`
    ).run(attemptMeaningId, sessionId, answer, verdict.correct ? 1 : 0, q.hint_used);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE session_id = ? AND answered = 0').get(sessionId) as { n: number };
    if (remaining.n === 0) db.prepare("UPDATE sessions SET finished_at = datetime('now') WHERE id = ?").run(sessionId);
  });

  const meanings = [...byId.values()].map((m) => {
    const full = db.prepare('SELECT hint, context FROM meanings WHERE id = ?').get(m.id) as { hint: string | null; context: string | null };
    return { id: m.id, translation: m.translation, hint: full.hint, context: full.context };
  });
  const targetFull = meanings.find((m) => m.id === q.meaning_id)!;
  const s = sessionRow(db, sessionId)!;
  return {
    kind: 'meaning',
    correct: verdict.correct,
    expected: q.expected_translation,
    matchedMeaningId: verdict.matchedMeaningId,
    targetMeaning: targetFull,
    otherMeanings: meanings.filter((m) => m.id !== q.meaning_id),
    finished: s.finished_at !== null,
  };
}

export interface SessionSummary {
  id: number;
  kind: string;
  mode: string;
  context_filter: string | null;
  source_filter: WordSource | null;
  started_at: string;
  finished_at: string | null;
  correct: number;
  total: number;
}

export function listSessions(db: DB): SessionSummary[] {
  return db
    .prepare(
      `SELECT s.id, s.kind, s.mode, s.context_filter, s.source_filter, s.started_at, s.finished_at,
              COALESCE(SUM(q.correct), 0) AS correct, COUNT(q.id) AS total
       FROM sessions s LEFT JOIN questions q ON q.session_id = s.id
       GROUP BY s.id ORDER BY s.id DESC`
    )
    .all() as SessionSummary[];
}

export interface SessionResults extends SessionSummary {
  questions: {
    id: number;
    position: number;
    kind: 'vocab' | 'phrase';
    korean: string;
    hint_used: boolean;
    user_answer: string | null;
    correct: boolean;
    expected: string;
    matched: string | null;
    otherMeanings: { translation: string; hint: string | null; context: string | null }[];
    acceptedTranslations: string[];
  }[];
  byCategory: { vocab: { correct: number; total: number }; phrases: { correct: number; total: number } };
  percent: number;
  incorrectCount: number;
  hintsUsed: number;
  correctWithoutHint: number;
}

export function getResults(db: DB, id: number): SessionResults | null {
  const s = sessionRow(db, id);
  if (!s) return null;
  const qs = questionRows(db, id);
  const wordsByMeaning = new Map(
    (db.prepare('SELECT m.id AS meaning_id, m.word_id AS word_id FROM meanings m JOIN words w ON w.id = m.word_id').all() as {
      meaning_id: number;
      word_id: number;
    }[]).map((r) => [r.meaning_id, r.word_id])
  );
  const wordKorean = new Map(
    (db.prepare('SELECT id, korean FROM words').all() as { id: number; korean: string }[]).map((r) => [r.id, r.korean])
  );
  const allMeanings = db.prepare('SELECT id, word_id, translation, hint, context FROM meanings').all() as (MeaningRow & { translation: string })[];
  const phraseKorean = new Map(
    (db.prepare('SELECT id, korean FROM phrases').all() as { id: number; korean: string }[]).map((r) => [r.id, r.korean])
  );
  const phraseAlts = new Map<number, string[]>();
  for (const row of db.prepare('SELECT phrase_id, text FROM phrase_translations ORDER BY id').all() as { phrase_id: number; text: string }[]) {
    const list = phraseAlts.get(row.phrase_id) ?? [];
    list.push(row.text);
    phraseAlts.set(row.phrase_id, list);
  }

  const questions = qs.map((q) => {
    if (q.kind === 'phrase') {
      return {
        id: q.id,
        position: q.position,
        kind: 'phrase' as const,
        korean: phraseKorean.get(q.phrase_id!) ?? '',
        hint_used: q.hint_used === 1,
        user_answer: q.user_answer,
        correct: q.correct === 1,
        expected: q.expected_translation,
        matched: null,
        otherMeanings: [],
        acceptedTranslations: phraseAlts.get(q.phrase_id!) ?? [],
      };
    }
    const wordId = wordsByMeaning.get(q.meaning_id!)!;
    const others = allMeanings
      .filter((m) => m.word_id === wordId && m.id !== q.meaning_id)
      .map((m) => ({ translation: m.translation, hint: m.hint, context: m.context }));
    const matchedRow = q.matched_meaning_id ? allMeanings.find((m) => m.id === q.matched_meaning_id) : undefined;
    return {
      id: q.id,
      position: q.position,
      kind: 'vocab' as const,
      korean: wordKorean.get(wordId)!,
      hint_used: q.hint_used === 1,
      user_answer: q.user_answer,
      correct: q.correct === 1,
      expected: q.expected_translation,
      matched: matchedRow?.translation ?? null,
      otherMeanings: others,
      acceptedTranslations: [],
    };
  });
  const correct = questions.filter((q) => q.correct).length;
  const vocabQs = questions.filter((q) => q.kind === 'vocab');
  const phraseQs = questions.filter((q) => q.kind === 'phrase');
  return {
    id: s.id,
    kind: s.kind,
    mode: s.mode,
    context_filter: s.context_filter,
    source_filter: s.source_filter,
    started_at: s.started_at,
    finished_at: s.finished_at,
    correct,
    total: questions.length,
    percent: questions.length === 0 ? 0 : Math.round((correct / questions.length) * 100),
    incorrectCount: questions.length - correct,
    hintsUsed: questions.filter((q) => q.hint_used).length,
    correctWithoutHint: questions.filter((q) => q.correct && !q.hint_used).length,
    byCategory: {
      vocab: { correct: vocabQs.filter((q) => q.correct).length, total: vocabQs.length },
      phrases: { correct: phraseQs.filter((q) => q.correct).length, total: phraseQs.length },
    },
    questions,
  };
}

// ---------------------------------------------------------------------------
// Analyse des connaissances (PRD §6.2 + itération 2 §7.3)
// ---------------------------------------------------------------------------

export interface PhraseStats {
  total: number;
  byLevel: Record<Level, number>;
  weakPhrases: { phraseId: number; korean: string; translation: string; theme: string | null; score: number; attempts: number }[];
  hintDependent: { phraseId: number; korean: string; translation: string; hintRatio: number; attempts: number }[];
  themes: string[];
}

export interface StatsPayload {
  totalWords: number;
  totalMeanings: number;
  byLevel: Record<Level, number>;
  weakMeanings: { meaningId: number; korean: string; translation: string; context: string | null; score: number; attempts: number }[];
  hintDependent: { meaningId: number; korean: string; translation: string; hintRatio: number; attempts: number }[];
  weakContexts: { context: string; weak: number; total: number }[];
  contexts: string[];
  phrases: PhraseStats;
}

function hintRatio(db: DB, kind: 'meaning' | 'phrase', id: number): { hints: number } {
  const col = kind === 'phrase' ? 'phrase_id' : 'meaning_id';
  const row = db.prepare(`SELECT COUNT(*) AS hints FROM attempt_log WHERE kind = ? AND ${col} = ? AND hint_used = 1`).get(kind, id) as {
    hints: number;
  };
  return row;
}

export function computeStats(db: DB): StatsPayload {
  const words = listWords(db);
  const byLevel: Record<Level, number> = { mastered: 0, reinforce: 0, weak: 0, new: 0 };
  const flat = words.flatMap((w) => w.meanings.map((m) => ({ word: w, meaning: m })));
  for (const { meaning } of flat) byLevel[meaning.level] += 1;

  const weakMeanings = flat
    .filter((x) => x.meaning.level === 'weak')
    .sort((a, b) => (a.meaning.score ?? 0) - (b.meaning.score ?? 0))
    .slice(0, 20)
    .map((x) => ({
      meaningId: x.meaning.id,
      korean: x.word.korean,
      translation: x.meaning.translation,
      context: x.meaning.context,
      score: x.meaning.score ?? 0,
      attempts: x.meaning.attempts,
    }));

  const hintDependent = flat
    .filter((x) => {
      if (x.meaning.attempts < 2) return false;
      return hintRatio(db, 'meaning', x.meaning.id).hints / x.meaning.attempts >= 0.5;
    })
    .map((x) => ({
      meaningId: x.meaning.id,
      korean: x.word.korean,
      translation: x.meaning.translation,
      hintRatio: hintRatio(db, 'meaning', x.meaning.id).hints / x.meaning.attempts,
      attempts: x.meaning.attempts,
    }));

  const contextMap = new Map<string, { weak: number; total: number }>();
  for (const { meaning } of flat) {
    if (!meaning.context) continue;
    const key = meaning.context.trim();
    const e = contextMap.get(key) ?? { weak: 0, total: 0 };
    e.total += 1;
    if (meaning.level === 'weak') e.weak += 1;
    contextMap.set(key, e);
  }

  // Phrases : maîtrise indépendante des mots (itération 2 §7.2).
  const phraseRows = db.prepare('SELECT id, korean, translation, theme FROM phrases ORDER BY id').all() as {
    id: number;
    korean: string;
    translation: string;
    theme: string | null;
  }[];
  const phraseLevels = phraseLevelsFor(db);
  const phraseByLevel: Record<Level, number> = { mastered: 0, reinforce: 0, weak: 0, new: 0 };
  for (const p of phraseRows) phraseByLevel[phraseLevels.get(p.id)?.level ?? 'new'] += 1;
  const weakPhrases = phraseRows
    .map((p) => ({ ...p, l: phraseLevels.get(p.id) }))
    .filter((p) => p.l?.level === 'weak')
    .sort((a, b) => (a.l?.score ?? 0) - (b.l?.score ?? 0))
    .slice(0, 20)
    .map((p) => ({
      phraseId: p.id,
      korean: p.korean,
      translation: p.translation,
      theme: p.theme,
      score: p.l?.score ?? 0,
      attempts: p.l?.attempts ?? 0,
    }));
  const phraseHintDependent = phraseRows
    .map((p) => ({ ...p, l: phraseLevels.get(p.id) }))
    .filter((p) => (p.l?.attempts ?? 0) >= 2 && hintRatio(db, 'phrase', p.id).hints / (p.l?.attempts ?? 1) >= 0.5)
    .map((p) => ({
      phraseId: p.id,
      korean: p.korean,
      translation: p.translation,
      hintRatio: hintRatio(db, 'phrase', p.id).hints / (p.l?.attempts ?? 1),
      attempts: p.l?.attempts ?? 0,
    }));
  const themes = [...new Set(phraseRows.map((p) => p.theme).filter((t): t is string => t !== null))].sort();

  return {
    totalWords: words.length,
    totalMeanings: flat.length,
    byLevel,
    weakMeanings,
    hintDependent,
    weakContexts: [...contextMap.entries()]
      .filter(([, v]) => v.weak > 0)
      .map(([context, v]) => ({ context, ...v }))
      .sort((a, b) => b.weak - a.weak),
    contexts: [...contextMap.keys()].sort(),
    phrases: {
      total: phraseRows.length,
      byLevel: phraseByLevel,
      weakPhrases,
      hintDependent: phraseHintDependent,
      themes,
    },
  };
}

export { QUIZ_LENGTH };
export type { Attempt };
