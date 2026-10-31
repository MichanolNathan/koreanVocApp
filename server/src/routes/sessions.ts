import { Router } from 'express';
import type { DB } from '../db.ts';
import { answerQuestion, createSession, getHint, getResults, getSessionView, listSessions } from '../repo.ts';
import { checkAnswer } from '../engine.ts';
import type { QuizMode } from '../engine.ts';

/**
 * API sessions de quiz (PRD §4, §6). Les traductions attendues ne sont
 * jamais exposées avant la réponse : validation côté serveur uniquement.
 */

const MODES: QuizMode[] = ['standard', 'weak', 'reinforce', 'mixed', 'context'];

export function sessionsRouter(db: DB): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode ?? 'standard';
    if (typeof mode !== 'string' || !MODES.includes(mode as QuizMode)) {
      return res.status(400).json({ error: `Mode invalide. Modes : ${MODES.join(', ')}.` });
    }
    const context = typeof body.context === 'string' && body.context.trim().length > 0 ? body.context.trim() : null;
    if (mode === 'context' && !context) return res.status(400).json({ error: 'Mode « context » : précisez un contexte.' });
    if (body.source !== undefined && body.source !== 'personal' && body.source !== 'official') {
      return res.status(400).json({ error: 'source doit valoir « personal » ou « official ».' });
    }
    const source = body.source === 'personal' || body.source === 'official' ? body.source : undefined;
    const session = createSession(db, mode as QuizMode, context, source);
    if (!session) return res.status(409).json({ error: 'Aucune signification disponible — ajoutez des mots au dictionnaire.' });
    res.status(201).json(session);
  });

  router.get('/', (_req, res) => {
    res.json(listSessions(db));
  });

  router.get('/:id(\\d+)', (req, res) => {
    const view = getSessionView(db, Number(req.params.id));
    if (!view) return res.status(404).json({ error: 'Session introuvable.' });
    res.json(view);
  });

  router.post('/:id(\\d+)/questions/:qid(\\d+)/hint', (req, res) => {
    const hint = getHint(db, Number(req.params.id), Number(req.params.qid));
    if (hint === undefined) return res.status(409).json({ error: 'Question introuvable ou déjà répondue.' });
    res.json({ hint });
  });

  router.post('/:id(\\d+)/questions/:qid(\\d+)/answer', (req, res) => {
    const answer = (req.body ?? {}) as Record<string, unknown>;
    if (typeof answer.answer !== 'string') return res.status(400).json({ error: 'Champ « answer » (chaîne) requis.' });
    try {
      const outcome = answerQuestion(db, Number(req.params.id), Number(req.params.qid), answer.answer, checkAnswer);
      if (outcome === null) return res.status(404).json({ error: 'Question introuvable.' });
      if (outcome === undefined) return res.status(409).json({ error: 'Question déjà répondue.' });
      res.json(outcome);
    } catch (err) {
      if (err instanceof Error && err.message === 'Question déjà répondue.') return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.get('/:id(\\d+)/results', (req, res) => {
    const results = getResults(db, Number(req.params.id));
    if (!results) return res.status(404).json({ error: 'Session introuvable.' });
    if (!results.finished_at) return res.status(409).json({ error: 'Session en cours — résultats disponibles à la fin.' });
    res.json(results);
  });

  return router;
}
