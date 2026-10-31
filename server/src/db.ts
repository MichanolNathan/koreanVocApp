import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    pos TEXT,
    source TEXT NOT NULL DEFAULT 'personal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meanings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    translation TEXT NOT NULL,
    hint TEXT,
    context TEXT,
    example_ko TEXT,
    example_fr TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Autres traductions acceptées pour une signification (PRD §2.1)
  CREATE TABLE IF NOT EXISTS meaning_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_type TEXT NOT NULL DEFAULT 'translation',
    mode TEXT NOT NULL,
    context_filter TEXT,
    source_filter TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    hint_used INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    user_answer TEXT,
    correct INTEGER,
    expected_translation TEXT NOT NULL,
    matched_meaning_id INTEGER,
    answered_at TEXT
  );

  -- Journal des tentatives : source unique du calcul de maîtrise (PRD §6.1)
  CREATE TABLE IF NOT EXISTS attempt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meaning_id INTEGER NOT NULL REFERENCES meanings(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    user_answer TEXT,
    correct INTEGER NOT NULL,
    hint_used INTEGER NOT NULL,
    answered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_meaning ON attempt_log(meaning_id, id);
  CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_meanings_word ON meanings(word_id);
`;

function scalar(raw: RawDatabase, sql: string): number {
  const res = raw.exec(sql) as { columns: string[]; values: unknown[][] }[];
  const row = res[0]?.values[0];
  return Number(row?.[0] ?? 0);
}

export async function openDb(path: string): Promise<DB> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database(path !== ':memory:' && existsSync(path) ? readFileSync(path) : undefined) as unknown as RawDatabase;
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  // Bases créées avant la v0.2.1 : ajout de sessions.source_filter
  const pragma = raw.exec('PRAGMA table_info(sessions)') as unknown as { columns: string[]; values: unknown[][] }[];
  const nameIdx = pragma[0]?.columns.indexOf('name') ?? -1;
  const tableCols = new Set((pragma[0]?.values ?? []).map((row) => String(row[nameIdx])));
  if (!tableCols.has('source_filter')) {
    raw.exec('ALTER TABLE sessions ADD COLUMN source_filter TEXT');
  }

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
