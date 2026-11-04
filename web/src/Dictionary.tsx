import { useCallback, useEffect, useState } from 'react';
import { LEVEL_LABELS, SOURCE_LABELS, api } from './api';
import type { Word, WordSource } from './api';
import { WordForm } from './WordForm';

type Category = 'all' | WordSource;

/** Recherche insensible à la casse, aux accents et à la composition coréenne (jamo/syllabes). */
function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
}

function matchesQuery(w: Word, query: string): boolean {
  const q = normalizeSearch(query);
  if (q.length === 0) return true;
  const fields = [w.korean, w.romanization ?? '', ...w.meanings.map((m) => m.translation)];
  return fields.some((f) => normalizeSearch(f).includes(q));
}

export function Dictionary(): JSX.Element {
  const [words, setWords] = useState<Word[] | null>(null);
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Word | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setWords(await api.listWords());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);


  const remove = async (word: Word) => {
    if (!window.confirm(`Supprimer « ${word.korean} » et son historique ?`)) return;
    try {
      await api.deleteWord(word.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  if (words === null) return <p className="empty">Chargement…</p>;

  const showForm = creating || editing !== null;
  const filtered = words.filter((w) => (category === 'all' || w.source === category) && matchesQuery(w, query));
  return (
    <>
      <section className="card toolbar" aria-label="Actions du dictionnaire">
        <h2>Dictionnaire ({filtered.length} mot{filtered.length > 1 ? 's' : ''})</h2>
        {!showForm && (
          <input
            type="search"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher — 사과, pomme, sagwa…"
            aria-label="Rechercher un mot (coréen ou français)"
          />
        )}
        {!showForm && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Ajouter un mot
          </button>
        )}
      </section>
      {!showForm && (
        <div className="category-chips" role="group" aria-label="Filtrer par dictionnaire">
          {(['all', 'personal', 'official'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={category === c ? 'chip chip-active' : 'chip'}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c === 'all' ? 'Tous' : SOURCE_LABELS[c]} ({c === 'all' ? words.length : words.filter((w) => w.source === c).length})
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

      {showForm && (
        <WordForm
          key={editing?.id ?? 'new'}
          initial={editing}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            void refresh();
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {words.length === 0 && !showForm && (
        <p className="empty">
          Aucun mot pour l'instant. Ajoutez votre premier mot coréen pour commencer à réviser.
        </p>
      )}
      {query.trim().length > 0 && filtered.length === 0 && !showForm && (
        <p className="empty">Aucun mot ne correspond à « {query.trim()} ».</p>
      )}

      <ul className="word-list">
        {filtered.map((w) => (
          <li key={w.id} className="word-item">
            <div className="word-head">
              <span className="word-korean" lang="ko">
                {w.korean}
              </span>
              {w.romanization && <span className="word-meta">{w.romanization}</span>}
              <span className={`badge badge-${w.level}`}>{LEVEL_LABELS[w.level]}</span>
              <span className={`badge badge-src-${w.source}`}>{SOURCE_LABELS[w.source] ?? w.source}</span>
              <span className="word-actions">
                <button type="button" className="secondary" onClick={() => setEditing(w)}>
                  Modifier
                </button>
                <button type="button" className="secondary danger" onClick={() => remove(w)}>
                  Supprimer
                </button>
              </span>
            </div>
            <ul className="meanings">
              {w.meanings.map((m) => (
                <li key={m.id} className="meaning">
                  <div className="meaning-main">
                    <span className="meaning-translation">{m.translation}</span>
                    {m.pos && <span className="meaning-pos">{m.pos}</span>}
                    <span className={`badge badge-${m.level}`}>{LEVEL_LABELS[m.level]}</span>
                  </div>
                  {m.context && <p className="meaning-detail">Contexte : {m.context}</p>}
                  {m.hint && <p className="meaning-detail">Indice : {m.hint}</p>}
                  {m.example_ko && (
                    <p className="meaning-detail" lang="ko">
                      {m.example_ko}
                      {m.example_fr ? ` — ${m.example_fr}` : ''}
                    </p>
                  )}
                  <p className="meaning-detail">
                    {m.attempts} tentative{m.attempts > 1 ? 's' : ''}
                    {m.score !== null && m.attempts > 0 ? ` · score ${(m.score * 100).toFixed(0)} %` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}
