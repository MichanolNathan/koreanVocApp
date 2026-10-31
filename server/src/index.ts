import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { sessionsRouter } from './routes/sessions.ts';
import { statsRouter } from './routes/stats.ts';
import { apiErrorHandler, wordsRouter } from './routes/words.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? join(here, '..', 'data', 'app.db');
const db = await openDb(dbPath);

const app = express();
app.use(express.json());
app.use('/api/words', wordsRouter(db));
app.use('/api/sessions', sessionsRouter(db));
app.use('/api/stats', statsRouter(db));

// Production : un seul processus sert l'API et le build statique du client.
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(webDist, 'index.html'));
  });
}
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
app.use(apiErrorHandler);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`API myflashcardapp sur http://localhost:${port} (données : ${dbPath})`);
});
