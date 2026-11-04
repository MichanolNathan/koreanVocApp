import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { normalizeFr } from './normalize.ts';
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

  -- (v0.5) La table meaning_translations (« autres traductions » par
  -- signification) a été supprimée : chaque ancienne traduction alternative
  -- est devenue une signification à part entière du même mot.

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

function tableExists(raw: RawDatabase, name: string): boolean {
  const res = raw.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`) as unknown[];
  return res.length > 0;
}

function allRows(raw: RawDatabase, sql: string): Record<string, unknown>[] {
  const stmt = raw.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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
 * - v0.5 : le champ « autres traductions » (meaning_translations) dupliquait
 *   la multi-signification. Chaque traduction alternative devient une
 *   signification du même mot — catégorie et contexte hérités, pas l'indice
 *   (il décrivait la traduction principale et pourrait divulguer la réponse).
 *   Les doublons (traduction déjà portée par le mot) sont écartés, puis la
 *   table est supprimée.
 *
 * Le fichier base est sauvegardé avant toute migration destructrice.
 */
function convertLegacyAlts(raw: RawDatabase): number {
  const alts = allRows(
    raw,
    `SELECT t.meaning_id AS meaning_id, t.text AS text, m.word_id AS word_id, m.pos AS pos, m.context AS context
     FROM meaning_translations t JOIN meanings m ON m.id = t.meaning_id
     ORDER BY m.word_id, m.id, t.id`
  );
  const known = new Map<number, Set<string>>();
  for (const m of allRows(raw, 'SELECT word_id, translation FROM meanings')) {
    const set = known.get(Number(m.word_id)) ?? new Set<string>();
    set.add(normalizeFr(String(m.translation)));
    known.set(Number(m.word_id), set);
  }
  const ins = raw.prepare('INSERT INTO meanings (word_id, translation, pos, context) VALUES (?, ?, ?, ?)');
  let converted = 0;
  for (const a of alts) {
    const wordId = Number(a.word_id);
    const text = String(a.text).trim();
    const seen = known.get(wordId)!;
    const key = normalizeFr(text);
    if (key.length === 0 || seen.has(key)) continue;
    ins.bind([wordId, text, a.pos ?? null, a.context ?? null]);
    ins.step();
    ins.reset();
    seen.add(key);
    converted++;
  }
  ins.free();
  raw.exec('DROP TABLE meaning_translations');
  return converted;
}

function migrate(raw: RawDatabase, path: string): void {
  const sessionCols = tableColumns(raw, 'sessions');
  if (!sessionCols.has('source_filter')) raw.exec('ALTER TABLE sessions ADD COLUMN source_filter TEXT');
  if (!sessionCols.has('kind')) raw.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'vocab'");

  const hasKindCols = tableColumns(raw, 'questions').has('kind') && tableColumns(raw, 'attempt_log').has('kind');
  const hasMeaningPos = tableColumns(raw, 'meanings').has('pos');
  const hasLegacyAlts = tableExists(raw, 'meaning_translations');
  const legacyAltCount = hasLegacyAlts ? scalar(raw, 'SELECT COUNT(*) FROM meaning_translations') : 0;
  if (hasKindCols && hasMeaningPos && !hasLegacyAlts) return;
  if (path !== ':memory:' && (!hasKindCols || !hasMeaningPos || legacyAltCount > 0)) {
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
    raw.exec('PRAGMA foreign_keys = ON');
  }

  // Après v0.4 : meanings possède pos, hérité par les significations créées.
  if (hasLegacyAlts) {
    const converted = convertLegacyAlts(raw);
    if (converted > 0) console.warn(`Migration v0.5 : ${converted} autres traductions converties en significations.`);
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
