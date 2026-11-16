import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Phrase } from './api';

/** Recherche insensible à la casse, aux accents et à la composition coréenne (jamo/syllabes). */
function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
}

function matchesQuery(p: Phrase, query: string): boolean {
  const q = normalizeSearch(query);
  if (q.length === 0) return true;
  const fields = [p.korean, p.romanization ?? '', p.translation, ...p.alts, p.theme ?? '', p.grammarPoint ?? ''];
  return fields.some((f) => normalizeSearch(f).includes(q));
}

function PhraseForm(props: { initial: Phrase; themes: string[]; onDone: () => void; onCancel: () => void }): JSX.Element {
  const { initial, themes, onDone, onCancel } = props;
  const [korean, setKorean] = useState(initial.korean);
  const [romanization, setRomanization] = useState(initial.romanization ?? '');
  const [translation, setTranslation] = useState(initial.translation);
  const [theme, setTheme] = useState(initial.theme ?? themes[0] ?? '');
  const [grammarPoint, setGrammarPoint] = useState(initial.grammarPoint ?? '');
  const [hint, setHint] = useState(initial.hint ?? '');
  const [alts, setAlts] = useState(initial.alts.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      korean,
      translation,
      romanization: romanization || null,
      theme: theme || null,
      grammarPoint: grammarPoint || null,
      hint: hint || null,
      alts: alts.split('\n').map((a) => a.trim()).filter((a) => a.length > 0),
    };
    try {
      await api.updatePhrase(initial.id, payload);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Modifier la phrase n° {initial.id}</h2>
      <form onSubmit={(e) => void submit(e)}>
        <div className="form-row">
          <label>
            Phrase coréenne *
            <input lang="ko" value={korean} onChange={(e) => setKorean(e.target.value)} required autoFocus />
          </label>
          <label>
            Romanisation
            <input value={romanization} onChange={(e) => setRomanization(e.target.value)} placeholder="annyeonghaseyo." />
          </label>
        </div>
        <div className="form-row">
          <label>
            Traduction principale *
            <input value={translation} onChange={(e) => setTranslation(e.target.value)} required />
          </label>
          <label>
            Thème
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              {themes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Point de grammaire
            <input value={grammarPoint} onChange={(e) => setGrammarPoint(e.target.value)} placeholder="passé -았/었어요" />
          </label>
          <label>
            Indice
            <input value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Traductions alternatives acceptées (une par ligne)
            <textarea rows={3} value={alts} onChange={(e) => setAlts(e.target.value)} />
          </label>
        </div>

        <div aria-live="polite">
          {error && (
            <p className="status status-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            Enregistrer
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Annuler
          </button>
        </div>
      </form>
    </section>
  );
}

export function Phrases(): JSX.Element {
  const [phrases, setPhrases] = useState<Phrase[] | null>(null);
  const [theme, setTheme] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Phrase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPhrases(await api.listPhrases());
    } catch {
      setError('Impossible de charger la bibliothèque de phrases.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (phrases === null) return <p className="empty">Chargement…</p>;

  const themes = [...new Set(phrases.map((p) => p.theme).filter((t): t is string => t !== null))];
  const filtered = phrases.filter((p) => (theme === 'all' || p.theme === theme) && matchesQuery(p, query));

  return (
    <>
      <section className="card toolbar" aria-label="Actions de la bibliothèque">
        <h2>Bibliothèque de phrases ({filtered.length} phrase{filtered.length > 1 ? 's' : ''})</h2>
        {!editing && (
          <input
            type="search"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher — 안녕하세요, bonjour, annyeong…"
            aria-label="Rechercher une phrase (coréen ou français)"
          />
        )}
      </section>
      {!editing && (
        <div className="category-chips" role="group" aria-label="Filtrer par thème">
          <button
            type="button"
            className={theme === 'all' ? 'chip chip-active' : 'chip'}
            aria-pressed={theme === 'all'}
            onClick={() => setTheme('all')}
          >
            Tous ({phrases.length})
          </button>
          {themes.map((t) => (
            <button
              key={t}
              type="button"
              className={theme === t ? 'chip chip-active' : 'chip'}
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
            >
              {t} ({phrases.filter((p) => p.theme === t).length})
            </button>
          ))}
        </div>
      )}

      <div aria-live="polite">
        {error && (
          <p className="status status-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {editing && (
        <PhraseForm
          key={editing.id}
          initial={editing}
          themes={themes}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {query.trim().length > 0 && filtered.length === 0 && !editing && (
        <p className="empty">Aucune phrase ne correspond à « {query.trim()} ».</p>
      )}

      <ul className="word-list">
        {filtered.map((p) => (
          <li key={p.id} className="word-item">
            <div className="word-head">
              <span className="word-korean" lang="ko">
                {p.korean}
              </span>
              {p.romanization && <span className="word-meta">{p.romanization}</span>}
              {p.theme && <span className="badge badge-theme">{p.theme}</span>}
              <span className="word-actions">
                <button type="button" className="secondary" onClick={() => setEditing(p)}>
                  Modifier
                </button>
              </span>
            </div>
            <ul className="meanings">
              <li className="meaning">
                <div className="meaning-main">
                  <span className="meaning-translation">{p.translation}</span>
                  {p.grammarPoint && <span className="meaning-pos">{p.grammarPoint}</span>}
                </div>
                {p.alts.length > 0 && (
                  <p className="meaning-detail">Autres traductions acceptées : {p.alts.join(' · ')}</p>
                )}
                {p.hint && <p className="meaning-detail">Indice : {p.hint}</p>}
              </li>
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}
