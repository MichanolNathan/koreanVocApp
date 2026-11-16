import { Router } from 'express';
import type { DB } from '../db.ts';
import { THEMES } from '../phrase-library.ts';
import { ConflictError, getPhrase, listPhrases, replacePhrase } from '../repo.ts';
import type { PhraseInput } from '../repo.ts';

/**
 * API bibliothèque de phrases (v0.6) : consultation complète et édition.
 * Validation d'entrée stricte : phrase coréenne et traduction obligatoires,
 * thème parmi les thèmes livrés, alternatives = tableau de chaînes non vides.
 */

type ParseResult = { ok: true; value: PhraseInput } | { ok: false; errors: string[] };

function strOrNU(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v.trim() : null;
}

function parsePhraseInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) return { ok: false, errors: ['Corps JSON objet attendu.'] };
  const o = body as Record<string, unknown>;
  const errors: string[] = [];

  const korean = strOrNU(o.korean) ?? '';
  if (korean.length === 0) errors.push('Phrase coréenne obligatoire.');
  const translation = strOrNU(o.translation) ?? '';
  if (translation.length === 0) errors.push('Traduction principale obligatoire.');

  const theme = strOrNU(o.theme);
  if (theme !== null && !(THEMES as readonly string[]).includes(theme)) {
    errors.push(`Thème inconnu — thèmes valides : ${THEMES.join(', ')}.`);
  }

  let alts: string[] = [];
  if (Array.isArray(o.alts)) {
    alts = o.alts
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .map((a) => a.trim());
  } else if (o.alts !== undefined && o.alts !== null) {
    errors.push('alts doit être un tableau de chaînes.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { korean, translation, alts, theme, romanization: strOrNU(o.romanization), hint: strOrNU(o.hint), grammarPoint: strOrNU(o.grammarPoint) },
  };
}

export function phrasesRouter(db: DB): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listPhrases(db));
  });

  router.get('/:id(\\d+)', (req, res) => {
    const phrase = getPhrase(db, Number(req.params.id));
    if (!phrase) return res.status(404).json({ error: 'Phrase introuvable.' });
    res.json(phrase);
  });

  router.put('/:id(\\d+)', (req, res) => {
    const parsed = parsePhraseInput(req.body);
    if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
    try {
      const phrase = replacePhrase(db, Number(req.params.id), parsed.value);
      if (!phrase) return res.status(404).json({ error: 'Phrase introuvable.' });
      res.json(phrase);
    } catch (err) {
      if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
