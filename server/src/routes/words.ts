import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DB } from '../db.ts';
import { ConflictError, createWord, deleteWord, getWord, listWords, replaceWord } from '../repo.ts';
import type { MeaningInput, WordInput } from '../repo.ts';

/**
 * API dictionnaire personnel (PRD §2). Validation d'entrée stricte :
 * mot coréen obligatoire/unique, ≥ 1 signification avec traduction.
 */

type ParseResult = { ok: true; value: WordInput } | { ok: false; errors: string[] };

function strOrNU(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : null;
}

function parseMeaning(m: unknown, errors: string[], idx: number): MeaningInput {
  if (typeof m !== 'object' || m === null) {
    errors.push(`Signification ${idx + 1} : objet attendu.`);
    return { translation: '' };
  }
  const o = m as Record<string, unknown>;
  const translation = typeof o.translation === 'string' ? o.translation.trim() : '';
  if (translation.length === 0) errors.push(`Signification ${idx + 1} : traduction principale obligatoire.`);
  const alts = Array.isArray(o.alts)
    ? o.alts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [];
  const out: MeaningInput = {
    translation,
    alts,
    hint: strOrNU(o.hint),
    context: strOrNU(o.context),
    example_ko: strOrNU(o.example_ko),
    example_fr: strOrNU(o.example_fr),
  };
  if (o.pos !== undefined) out.pos = strOrNU(o.pos);
  if (typeof o.id === 'number') out.id = o.id;
  return out;
}

function parseWordInput(body: unknown): ParseResult {
  const errors: string[] = [];
  if (typeof body !== 'object' || body === null) return { ok: false, errors: ['Corps JSON objet attendu.'] };
  const o = body as Record<string, unknown>;
  const korean = typeof o.korean === 'string' ? o.korean.trim() : '';
  if (korean.length === 0) errors.push('Mot coréen obligatoire.');
  if (o.source !== undefined && o.source !== 'personal' && o.source !== 'official') {
    errors.push('source doit valoir « personal » ou « official ».');
  }
  let meanings: MeaningInput[] = [];
  if (Array.isArray(o.meanings) && o.meanings.length > 0) {
    meanings = o.meanings.map((m, i) => parseMeaning(m, errors, i));
  } else {
    errors.push('Au moins une signification est requise.');
  }
  // Ancien champ « pos » au niveau du mot (≤ v0.3) : repris comme catégorie
  // par défaut des significations qui n'en définissent pas.
  const legacyPos = strOrNU(o.pos);
  if (legacyPos !== null) {
    meanings = meanings.map((m) => (m.pos === undefined && m.translation.length > 0 ? { ...m, pos: legacyPos } : m));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      korean,
      romanization: strOrNU(o.romanization),
      source: o.source === 'official' ? 'official' : 'personal',
      meanings,
    },
  };
}

export function wordsRouter(db: DB): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const source = req.query.source;
    res.json(listWords(db, source === 'personal' || source === 'official' ? source : undefined));
  });

  router.post('/', (req, res) => {
    const parsed = parseWordInput(req.body);
    if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
    try {
      res.status(201).json(createWord(db, parsed.value));
    } catch (err) {
      nextIfConflict(err, res);
    }
  });

  router.get('/:id(\\d+)', (req, res) => {
    const word = getWord(db, Number(req.params.id));
    if (!word) return res.status(404).json({ error: 'Mot introuvable.' });
    res.json(word);
  });

  router.put('/:id(\\d+)', (req, res) => {
    const parsed = parseWordInput(req.body);
    if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
    try {
      const word = replaceWord(db, Number(req.params.id), parsed.value);
      if (!word) return res.status(404).json({ error: 'Mot introuvable.' });
      res.json(word);
    } catch (err) {
      nextIfConflict(err, res);
    }
  });

  router.delete('/:id(\\d+)', (req, res) => {
    if (!deleteWord(db, Number(req.params.id))) return res.status(404).json({ error: 'Mot introuvable.' });
    res.status(204).end();
  });

  return router;
}

function nextIfConflict(err: unknown, res: Response): void {
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  throw err;
}
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);
  res.status(500).json({ error: 'Erreur interne.' });
}
