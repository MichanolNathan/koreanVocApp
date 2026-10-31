import { Router } from 'express';
import type { DB } from '../db.ts';
import { computeStats } from '../repo.ts';

/**
 * Analyse des connaissances (PRD §6.2) : niveaux, significations faibles,
 * dépendance aux indices, contextes problématiques. Alimente les quiz ciblés.
 */
export function statsRouter(db: DB): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(computeStats(db));
  });
  return router;
}
