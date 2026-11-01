// Génère une base SQLite initiale (schéma + migrations + bibliothèque de
// phrases + dictionnaire officiel) au chemin donné. Utilisé par Dockerfile.db
// pour construire l'image de données ; utilisable en local :
// npx tsx src/make-seed-db.ts [chemin]  (défaut : seed/app.db)
import { openDb } from './db.ts';
import { loadPhraseLibrary } from './phrase-library.ts';
import { loadOfficialDictionary } from './official-dictionary.ts';

const path = process.argv[2] ?? 'seed/app.db';
const db = await openDb(path);
const phrases = loadPhraseLibrary(db);
const official = loadOfficialDictionary(db);
console.log(`Base initiale créée : ${path} (${phrases} phrases, ${official} mots officiels)`);
