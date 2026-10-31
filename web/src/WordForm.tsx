import { useState } from 'react';
import { SOURCE_LABELS, api } from './api';
import type { Word, WordSource } from './api';

interface MeaningDraft {
  id?: number;
  translation: string;
  alts: string;
  hint: string;
  context: string;
  example_ko: string;
  example_fr: string;
}

const emptyMeaning = (): MeaningDraft => ({ translation: '', alts: '', hint: '', context: '', example_ko: '', example_fr: '' });

export function WordForm(props: { initial: Word | null; onDone: () => void; onCancel: () => void }): JSX.Element {
  const { initial, onDone, onCancel } = props;
  const [korean, setKorean] = useState(initial?.korean ?? '');
  const [romanization, setRomanization] = useState(initial?.romanization ?? '');
  const [pos, setPos] = useState(initial?.pos ?? '');
  const [source, setSource] = useState<WordSource>(initial?.source === 'official' ? 'official' : 'personal');
  const [meanings, setMeanings] = useState<MeaningDraft[]>(
    initial
      ? initial.meanings.map((m) => ({
          id: m.id,
          translation: m.translation,
          alts: m.alts.join(', '),
          hint: m.hint ?? '',
          context: m.context ?? '',
          example_ko: m.example_ko ?? '',
          example_fr: m.example_fr ?? '',
        }))
      : [emptyMeaning()]
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setMeaning = (i: number, patch: Partial<MeaningDraft>): void => {
    setMeanings((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      korean,
      romanization: romanization || null,
      pos: pos || null,
      source,
      meanings: meanings.map((m) => ({
        ...(m.id ? { id: m.id } : {}),
        translation: m.translation,
        alts: m.alts
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a.length > 0),
        hint: m.hint || null,
        context: m.context || null,
        example_ko: m.example_ko || null,
        example_fr: m.example_fr || null,
      })),
    };
    try {
      if (initial) await api.updateWord(initial.id, payload);
      else await api.createWord(payload);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>{initial ? `Modifier « ${initial.korean} »` : 'Nouveau mot'}</h2>
      <form onSubmit={(e) => void submit(e)}>
        <div className="form-row">
          <label>
            Mot coréen *
            <input lang="ko" value={korean} onChange={(e) => setKorean(e.target.value)} required autoFocus />
          </label>
          <label>
            Romanisation
            <input value={romanization} onChange={(e) => setRomanization(e.target.value)} placeholder="sagwa" />
          </label>
          <label>
            Catégorie grammaticale
            <input value={pos} onChange={(e) => setPos(e.target.value)} placeholder="nom, verbe…" />
          </label>
          <label>
            Dictionnaire
            <select value={source} onChange={(e) => setSource(e.target.value as WordSource)}>
              <option value="personal">{SOURCE_LABELS.personal}</option>
              <option value="official">{SOURCE_LABELS.official}</option>
            </select>
          </label>
        </div>

        {meanings.map((m, i) => (
          <fieldset key={m.id ?? `new-${i}`}>
            <legend>Signification {i + 1}</legend>
            <div className="form-row">
              <label>
                Traduction principale *
                <input value={m.translation} onChange={(e) => setMeaning(i, { translation: e.target.value })} required />
              </label>
              <label>
                Autres traductions (séparées par des virgules)
                <input value={m.alts} onChange={(e) => setMeaning(i, { alts: e.target.value })} placeholder="fruit, pomme verte" />
              </label>
            </div>
            <div className="form-row">
              <label>
                Indice
                <input value={m.hint} onChange={(e) => setMeaning(i, { hint: e.target.value })} placeholder="Fruit rond" />
              </label>
              <label>
                Contexte
                <input value={m.context} onChange={(e) => setMeaning(i, { context: e.target.value })} placeholder="Alimentation" />
              </label>
            </div>
            <div className="form-row">
              <label>
                Exemple en coréen
                <input lang="ko" value={m.example_ko} onChange={(e) => setMeaning(i, { example_ko: e.target.value })} />
              </label>
              <label>
                Traduction de l'exemple
                <input value={m.example_fr} onChange={(e) => setMeaning(i, { example_fr: e.target.value })} />
              </label>
            </div>
            {meanings.length > 1 && (
              <button type="button" className="secondary danger" onClick={() => setMeanings((prev) => prev.filter((_, idx) => idx !== i))}>
                Retirer cette signification
              </button>
            )}
          </fieldset>
        ))}

        <button type="button" className="secondary" onClick={() => setMeanings((prev) => [...prev, emptyMeaning()])}>
          + Autre signification
        </button>

        <div aria-live="polite">
          {error && (
            <p className="status status-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {initial ? 'Enregistrer' : 'Ajouter'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Annuler
          </button>
        </div>
      </form>
    </section>
  );
}
