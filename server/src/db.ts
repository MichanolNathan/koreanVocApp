import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import initSqlJs from 'sql.js';

/**
 * Pilote SQLite sans module natif (sql.js/WASM) : fonctionne sur tout Node
 * sans chaîne de compilation. La base tient en mémoire et est réécrite sur
 * disque à chaque mutation — suffisant à l'échelle d'un dictionnaire
 * personnel, et conserve l'avantage « un fichier unique » pour la VPS.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DB {
  prepare(sql: string): {
    run(...params: unknown[]): RunResult;
    get<T = never>(...params: unknown[]): T | undefined;
    all<T = never>(...params: unknown[]): T[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

interface RawStatement {
  bind(params: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  reset(): void;
  free(): void;
}

interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  export(): Uint8Array;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    korean TEXT NOT NULL UNIQUE,
    romanization TEXT,
    source TEXT NOT NULL DEFAULT 'personal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meanings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    translation TEXT NOT NULL,
    pos TEXT,
    hint TEXT,
    context TEXT,
    example_ko TEXT,
    example_fr TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Autres traductions acceptées pour une signification (PRD v0.2 §2.1)
  CREATE TABLE IF NOT EXISTS meaning_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );

  -- Bibliothèque de phrases intégrée (itération 2, PRD §4) : identifiants
  -- stables fournis par la bibliothèque, jamais auto-générés.
  CREATE TABLE IF NOT EXISTS phrases (
    id INTEGER PRIMARY KEY,
    korean TEXT NOT NULL UNIQUE,
    translation TEXT NOT NULL,
    romanization TEXT,
    difficulty TEXT NOT NULL DEFAULT 'beginner',
    hint TEXT,
    theme TEXT,
    grammar_point TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Traductions alternatives acceptées pour une phrase (itération 2 §4.3, §5.2)
  CREATE TABLE IF NOT EXISTS phrase_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phrase_id INTEGER NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );

  -- Liens phrase ↔ mots du dictionnaire (itération 2 §4.4) : lecture et
  -- analyse uniquement — jamais utilisés pour modifier la maîtrise des mots.
  CREATE TABLE IF NOT EXISTS phrase_vocab (
    phrase_id INTEGER NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    PRIMARY KEY (phrase_id, word_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_type TEXT NOT NULL DEFAULT 'translation',
    kind TEXT NOT NULL DEFAULT 'vocab',
    mode TEXT NOT NULL,
    context_filter TEXT,
    source_filter TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  -- kind : cible de la question — 'meaning' (mot/signification) ou
  -- 'phrase' (bibliothèque de phrases, itération 2).
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'meaning' CHECK (kind IN ('meaning','phrase')),
    meaning_id INTEGER REFERENCES meanings(id) ON DELETE CASCADE,
    phrase_id INTEGER REFERENCES phrases(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    hint_used INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    user_answer TEXT,
    correct INTEGER,
    expected_translation TEXT NOT NULL,
    matched_meaning_id INTEGER,
    answered_at TEXT,
    CHECK ((kind = 'meaning' AND meaning_id IS NOT NULL) OR (kind = 'phrase' AND phrase_id IS NOT NULL))
  );

  -- Journal des tentatives : source unique du calcul de maîtrise (PRD §6.1)
  CREATE TABLE IF NOT EXISTS attempt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'meaning' CHECK (kind IN ('meaning','phrase')),
    meaning_id INTEGER REFERENCES meanings(id) ON DELETE CASCADE,
    phrase_id INTEGER REFERENCES phrases(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    user_answer TEXT,
    correct INTEGER NOT NULL,
    hint_used INTEGER NOT NULL,
    answered_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((kind = 'meaning' AND meaning_id IS NOT NULL) OR (kind = 'phrase' AND phrase_id IS NOT NULL))
  );

  -- Registre des mots du dictionnaire officiel livrés avec l'application :
  -- chaque korean inséré par le chargeur y est consigné. Si l'utilisateur
  -- supprime ensuite le mot, le registre (tombstone) empêche sa réinjection
  -- au démarrage suivant ; ses éditions ne sont jamais écrasées non plus
  -- (le chargeur n'insère que des korean jamais livrés ni présents).
  CREATE TABLE IF NOT EXISTS shipped_words (
    korean TEXT PRIMARY KEY,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_attempts_meaning ON attempt_log(meaning_id, id);
  CREATE INDEX IF NOT EXISTS idx_attempts_phrase ON attempt_log(phrase_id, id);
  CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_meanings_word ON meanings(word_id);
  CREATE INDEX IF NOT EXISTS idx_phrase_vocab_word ON phrase_vocab(word_id);


`;

function scalar(raw: RawDatabase, sql: string): number {
  const res = raw.exec(sql) as { columns: string[]; values: unknown[][] }[];
  const row = res[0]?.values[0];
  return Number(row?.[0] ?? 0);
}

/** Colonnes d'une table — détection des migrations via PRAGMA table_info. */
function tableColumns(raw: RawDatabase, table: string): Set<string> {
  const res = raw.exec(`PRAGMA table_info(${table})`) as unknown as { columns: string[]; values: unknown[][] }[];
  const nameIdx = res[0]?.columns.indexOf('name') ?? -1;
  return new Set((res[0]?.values ?? []).map((row) => String(row[nameIdx])));
}

/** Sauvegarde horodatée du fichier base, avant toute migration destructrice. */
function backupDbFile(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let target = `${path}.backup-${stamp}`;
  let n = 2;
  while (existsSync(target)) target = `${path}.backup-${stamp}-${n++}`;
  copyFileSync(path, target);
  return target;
}

/**
 * Migrations incrémentales détectées via PRAGMA table_info :
 *
 * - v0.3 (itération 2) : généralisation des cibles de questions et de
 *   tentatives (mots ET phrases). SQLite ne peut ni relâcher un NOT NULL ni
 *   modifier une contrainte par ALTER : questions et attempt_log sont
 *   reconstruites à l'identique (les lignes existantes deviennent kind
 *   'meaning').
 *
 * - v0.4 : la catégorie grammaticale descend au niveau de la signification
 *   (un même mot peut avoir un sens verbal et un sens nominal). meanings
 *   gagne une colonne pos remplie depuis words.pos ; words est reconstruit
 *   sans pos. Les clés étrangères sont désactivées pendant la reconstruction
 *   (le DROP d'une table parente déclencherait sinon les ON DELETE CASCADE).
 *
 * Le fichier base est sauvegardé avant toute migration destructrice.
 */
function migrate(raw: RawDatabase, path: string): void {
  const sessionCols = tableColumns(raw, 'sessions');
  if (!sessionCols.has('source_filter')) raw.exec('ALTER TABLE sessions ADD COLUMN source_filter TEXT');
  if (!sessionCols.has('kind')) raw.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'vocab'");

  const hasKindCols = tableColumns(raw, 'questions').has('kind') && tableColumns(raw, 'attempt_log').has('kind');
  const hasMeaningPos = tableColumns(raw, 'meanings').has('pos');
  if (hasKindCols && hasMeaningPos) return;
  if (path !== ':memory:') {
    console.warn(`Sauvegarde de la base avant migration : ${backupDbFile(path)}`);
  }

  if (!hasKindCols) {
    raw.exec(`
      CREATE TABLE questions_v03 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'meaning' CHECK (kind IN ('meaning','phrase')),
        meaning_id INTEGER REFERENCES meanings(id) ON DELETE CASCADE,
        phrase_id INTEGER REFERENCES phrases(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        hint_used INTEGER NOT NULL DEFAULT 0,
        answered INTEGER NOT NULL DEFAULT 0,
        user_answer TEXT,
        correct INTEGER,
        expected_translation TEXT NOT NULL,
        matched_meaning_id INTEGER,
        answered_at TEXT,
        CHECK ((kind = 'meaning' AND meaning_id IS NOT NULL) OR (kind = 'phrase' AND phrase_id IS NOT NULL))
      );
      INSERT INTO questions_v03 (id, session_id, kind, meaning_id, phrase_id, position, hint_used, answered, user_answer, correct, expected_translation, matched_meaning_id, answered_at)
        SELECT id, session_id, 'meaning', meaning_id, NULL, position, hint_used, answered, user_answer, correct, expected_translation, matched_meaning_id, answered_at FROM questions;
      DROP TABLE questions;
      ALTER TABLE questions_v03 RENAME TO questions;

      CREATE TABLE attempt_log_v03 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'meaning' CHECK (kind IN ('meaning','phrase')),
        meaning_id INTEGER REFERENCES meanings(id) ON DELETE CASCADE,
        phrase_id INTEGER REFERENCES phrases(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        user_answer TEXT,
        correct INTEGER NOT NULL,
        hint_used INTEGER NOT NULL,
        answered_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((kind = 'meaning' AND meaning_id IS NOT NULL) OR (kind = 'phrase' AND phrase_id IS NOT NULL))
      );
      INSERT INTO attempt_log_v03 (id, kind, meaning_id, phrase_id, session_id, user_answer, correct, hint_used, answered_at)
        SELECT id, 'meaning', meaning_id, NULL, session_id, user_answer, correct, hint_used, answered_at FROM attempt_log;
      DROP TABLE attempt_log;
      ALTER TABLE attempt_log_v03 RENAME TO attempt_log;
    `);
  }

  if (!hasMeaningPos) {
    raw.exec(`
      ALTER TABLE meanings ADD COLUMN pos TEXT;
      UPDATE meanings SET pos = (SELECT w.pos FROM words w WHERE w.id = meanings.word_id);
    `);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(`
      CREATE TABLE words_v04 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        korean TEXT NOT NULL UNIQUE,
        romanization TEXT,
        source TEXT NOT NULL DEFAULT 'personal',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO words_v04 (id, korean, romanization, source, created_at)
        SELECT id, korean, romanization, source, created_at FROM words;
      DROP TABLE words;
      ALTER TABLE words_v04 RENAME TO words;
      DELETE FROM sqlite_sequence WHERE name = 'words_v04';
    `);
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

export async function openDb(path: string): Promise<DB> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database(path !== ':memory:' && existsSync(path) ? readFileSync(path) : undefined) as unknown as RawDatabase;
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  migrate(raw, path);
  raw.exec(INDEXES);

  const persist = (): void => {
    if (path === ':memory:') return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(raw.export()));
  };
  persist(); // crée le fichier dès l'ouverture

  let inTransaction = false;
  const saveIfWrite = (sql: string, changes: number): void => {
    if (inTransaction || changes === 0) return;
    if (!/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)) return;
    persist();
  };

  const db: DB = {
    prepare(sql: string) {
      return {
        run(...params: unknown[]): RunResult {
          const stmt = raw.prepare(sql);
          stmt.bind(params);
          stmt.step();
          const changes = scalar(raw, 'SELECT changes()');
          const lastInsertRowid = scalar(raw, 'SELECT last_insert_rowid()');
          stmt.reset();
          stmt.free();
          saveIfWrite(sql, changes);
          return { changes, lastInsertRowid };
        },
        get<T>(...params: unknown[]): T | undefined {
          const stmt = raw.prepare(sql);
          stmt.bind(params);
          const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
          stmt.reset();
          stmt.free();
          return row;
        },
        all<T>(...params: unknown[]): T[] {
          const stmt = raw.prepare(sql);
          stmt.bind(params);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          stmt.reset();
          stmt.free();
          return rows;
        },
      };
    },
    exec(sql: string): void {
      raw.exec(sql);
      saveIfWrite(sql, 1);
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) return fn();
      inTransaction = true;
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        persist();
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },
  };
  return db;
}
