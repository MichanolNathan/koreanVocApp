import type { DB } from './db.ts';
import type { Attempt, Level } from './mastery.ts';
import { aggregateWord, levelOf, masteryScore } from './mastery.ts';
import type { Candidate, QuizMode } from './engine.ts';
import { QUIZ_LENGTH, selectQuestions } from './engine.ts';

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

interface AttemptRow {
  meaning_id: number;
  correct: number;
  hint_used: number;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function attemptsByMeaning(db: DB): Map<number, AttemptRow[]> {
  const map = new Map<number, AttemptRow[]>();
  for (const row of db.prepare('SELECT meaning_id, correct, hint_used FROM attempt_log ORDER BY id').all() as AttemptRow[]) {
    const list = map.get(row.meaning_id) ?? [];
    list.push(row);
    map.set(row.meaning_id, list);
  }
  return map;
}

function levelsFor(db: DB): Map<number, { level: Level; attempts: number; score: number | null }> {
  const out = new Map<number, { level: Level; attempts: number; score: number | null }>();
  for (const [meaningId, attempts] of attemptsByMeaning(db)) {
    out.set(meaningId, {
      level: levelOf(attempts),
      attempts: attempts.length,
      score: masteryScore(attempts),
    });
  }
  return out;
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
  return rows.map((r) => ({ meaningId: r.meaning_id, level: levels.get(r.meaning_id)?.level ?? 'new', context: r.context }));
}

export function createSession(db: DB, mode: QuizMode, context: string | null, source?: WordSource): CreatedSession | null {
  const candidates = quizCandidates(db, source);
  const selected = selectQuestions(candidates, mode, context);
  if (selected.length === 0) return null;
  const info = new Map(
    (
      db
        .prepare(
          `SELECT m.id AS meaning_id, m.translation, m.hint, w.korean, w.romanization, w.pos
           FROM meanings m JOIN words w ON w.id = m.word_id`
        )
        .all() as {
        meaning_id: number;
        translation: string;
        hint: string | null;
        korean: string;
        romanization: string | null;
        pos: string | null;
      }[]
    ).map((r) => [r.meaning_id, r])
  );
  const { sessionId, questions } = db.transaction(() => {
    const s = db.prepare('INSERT INTO sessions (mode, context_filter, source_filter) VALUES (?, ?, ?)').run(mode, context, source ?? null);
    const sid = Number(s.lastInsertRowid);
    const insQ = db.prepare(
      'INSERT INTO questions (session_id, meaning_id, position, expected_translation) VALUES (?, ?, ?, ?)'
    );
    const questions: SessionQuestionView[] = [];
    selected.forEach((c, i) => {
      const m = info.get(c.meaningId)!;
      const q = insQ.run(sid, c.meaningId, i + 1, m.translation);
      questions.push({
        id: Number(q.lastInsertRowid),
        position: i + 1,
        korean: m.korean,
        romanization: m.romanization,
        pos: m.pos,
        hintAvailable: m.hint !== null,
        answered: false,
        userAnswer: null,
        correct: null,
      });
    });
    return { sessionId: sid, questions };
  });
  return { id: sessionId, mode, contextFilter: context, sourceFilter: source ?? null, questions };
}

interface QuestionRow {
  id: number;
  session_id: number;
  meaning_id: number;
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
  mode: string;
  context_filter: string | null;
  source_filter: WordSource | null;
  started_at: string;
  finished_at: string | null;
  questions: SessionQuestionView[];
}

export function getSessionView(db: DB, id: number): SessionView | null {
  const s = sessionRow(db, id);
  if (!s) return null;
  const info = new Map(
    (
      db
        .prepare(
          `SELECT m.id AS meaning_id, w.korean, w.romanization, w.pos, m.hint
           FROM meanings m JOIN words w ON w.id = m.word_id`
        )
        .all() as { meaning_id: number; korean: string; romanization: string | null; pos: string | null; hint: string | null }[]
    ).map((r) => [r.meaning_id, r])
  );
  const questions: SessionQuestionView[] = questionRows(db, id).map((q) => {
    const m = info.get(q.meaning_id)!;
    return {
      id: q.id,
      position: q.position,
      korean: m.korean,
      romanization: m.romanization,
      pos: m.pos,
      hintAvailable: m.hint !== null,
      answered: q.answered === 1,
      userAnswer: q.user_answer,
      correct: q.correct === null ? null : q.correct === 1,
    };
  });
  return {
    id: s.id,
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
    .prepare('SELECT hint_used, answered, m.hint AS hint FROM questions q JOIN meanings m ON m.id = q.meaning_id WHERE q.id = ? AND q.session_id = ?')
    .get(questionId, sessionId) as { hint_used: number; answered: number; hint: string | null } | undefined;
  if (!q || q.answered) return undefined;
  db.prepare('UPDATE questions SET hint_used = 1 WHERE id = ? AND answered = 0').run(questionId);
  return q.hint;
}

export interface AnswerOutcome {
  correct: boolean;
  expected: string;
  matchedMeaningId: number | null;
  targetMeaning: { id: number; translation: string; hint: string | null; context: string | null };
  otherMeanings: { id: number; translation: string; hint: string | null; context: string | null }[];
  finished: boolean;
}

export function answerQuestion(db: DB, sessionId: number, questionId: number, answer: string, judge: (answer: string, target: { id: number; translation: string; alts: string[] }, wordMeanings: { id: number; translation: string; alts: string[] }[]) => { correct: boolean; matchedMeaningId: number | null }): AnswerOutcome | null | undefined {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND session_id = ?').get(questionId, sessionId) as QuestionRow | undefined;
  if (!q) return null;
  if (q.answered) return undefined;
  const wordIdRow = db.prepare('SELECT word_id FROM meanings WHERE id = ?').get(q.meaning_id) as { word_id: number };
  const rows = db
    .prepare(
      `SELECT m.id, m.translation, t.text AS alt FROM meanings m
       LEFT JOIN meaning_translations t ON t.meaning_id = m.id
       WHERE m.word_id = ? ORDER BY m.id, t.id`
    )
    .all(wordIdRow.word_id) as { id: number; translation: string; alt: string | null }[];
  const byId = new Map<number, { id: number; translation: string; alts: string[] }>();
  for (const r of rows) {
    const m = byId.get(r.id) ?? { id: r.id, translation: r.translation, alts: [] as string[] };
    if (r.alt) m.alts.push(r.alt);
    byId.set(r.id, m);
  }
  const target = byId.get(q.meaning_id)!;
  const verdict = judge(answer, target, [...byId.values()]);

  db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE questions SET answered = 1, user_answer = ?, correct = ?, matched_meaning_id = ?, answered_at = datetime('now')
         WHERE id = ? AND answered = 0`
      )
      .run(answer, verdict.correct ? 1 : 0, verdict.matchedMeaningId, questionId);
    if (res.changes === 0) throw new ConflictError('Question déjà répondue.');
    const attemptMeaningId = verdict.matchedMeaningId ?? q.meaning_id;
    db.prepare('INSERT INTO attempt_log (meaning_id, session_id, user_answer, correct, hint_used) VALUES (?, ?, ?, ?, ?)').run(
      attemptMeaningId,
      sessionId,
      answer,
      verdict.correct ? 1 : 0,
      q.hint_used
    );
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
  mode: string;
  context_filter: string | null;
  source_filter: WordSource | null;
  started_at: string;
  finished_at: string | null;
  correct: number;
  total: number;
}

export function listSessions(db: DB): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.mode, s.context_filter, s.source_filter, s.started_at, s.finished_at,
              COALESCE(SUM(q.correct), 0) AS correct, COUNT(q.id) AS total
       FROM sessions s LEFT JOIN questions q ON q.session_id = s.id
       GROUP BY s.id ORDER BY s.id DESC`
    )
    .all() as (Omit<SessionSummary, 'correct' | 'total'> & { correct: number; total: number })[];
  return rows;
}

export interface SessionResults extends SessionSummary {
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
    (
      db
        .prepare(
          `SELECT m.id AS meaning_id, m.word_id AS word_id FROM meanings m JOIN words w ON w.id = m.word_id`
        )
        .all() as { meaning_id: number; word_id: number }[]
    ).map((r) => [r.meaning_id, r.word_id])
  );
  const wordKorean = new Map(
    (db.prepare('SELECT id, korean FROM words').all() as { id: number; korean: string }[]).map((r) => [r.id, r.korean])
  );
  const allMeanings = db.prepare('SELECT id, word_id, translation, hint, context FROM meanings').all() as (MeaningRow & { translation: string })[];
  const questions = qs.map((q) => {
    const wordId = wordsByMeaning.get(q.meaning_id)!;
    const others = allMeanings
      .filter((m) => m.word_id === wordId && m.id !== q.meaning_id)
      .map((m) => ({ translation: m.translation, hint: m.hint, context: m.context }));
    const matchedRow = q.matched_meaning_id ? allMeanings.find((m) => m.id === q.matched_meaning_id) : undefined;
    return {
      id: q.id,
      position: q.position,
      korean: wordKorean.get(wordId)!,
      hint_used: q.hint_used === 1,
      user_answer: q.user_answer,
      correct: q.correct === 1,
      expected: q.expected_translation,
      matched: matchedRow?.translation ?? null,
      otherMeanings: others,
    };
  });
  const correct = questions.filter((q) => q.correct).length;
  return {
    id: s.id,
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
    questions,
  };
}

// ---------------------------------------------------------------------------
// Analyse des connaissances (PRD §6.2)
// ---------------------------------------------------------------------------

export interface StatsPayload {
  totalWords: number;
  totalMeanings: number;
  byLevel: Record<Level, number>;
  weakMeanings: { meaningId: number; korean: string; translation: string; context: string | null; score: number; attempts: number }[];
  hintDependent: { meaningId: number; korean: string; translation: string; hintRatio: number; attempts: number }[];
  weakContexts: { context: string; weak: number; total: number }[];
  contexts: string[];
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
      const hintRows = db
        .prepare('SELECT COUNT(*) AS n FROM attempt_log WHERE meaning_id = ? AND hint_used = 1')
        .get(x.meaning.id) as { n: number };
      return hintRows.n / x.meaning.attempts >= 0.5;
    })
    .map((x) => {
      const hintRows = db
        .prepare('SELECT COUNT(*) AS n FROM attempt_log WHERE meaning_id = ? AND hint_used = 1')
        .get(x.meaning.id) as { n: number };
      return {
        meaningId: x.meaning.id,
        korean: x.word.korean,
        translation: x.meaning.translation,
        hintRatio: hintRows.n / x.meaning.attempts,
        attempts: x.meaning.attempts,
      };
    });

  const contextMap = new Map<string, { weak: number; total: number }>();
  for (const { meaning } of flat) {
    if (!meaning.context) continue;
    const key = meaning.context.trim();
    const e = contextMap.get(key) ?? { weak: 0, total: 0 };
    e.total += 1;
    if (meaning.level === 'weak') e.weak += 1;
    contextMap.set(key, e);
  }
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
  };
}

export { QUIZ_LENGTH };
export type { Attempt };
