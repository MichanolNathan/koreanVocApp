// Génère une base SQLite initiale (schéma + migrations) au chemin donné.
// Utilisé par Dockerfile.db pour construire l'image de données ; utilisable
// en local : npx tsx src/make-seed-db.ts [chemin]  (défaut : seed/app.db)
import { openDb } from './db.ts';

const path = process.argv[2] ?? 'seed/app.db';
await openDb(path);
console.log(`Base initiale créée : ${path}`);
