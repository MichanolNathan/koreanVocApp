import { useEffect, useState } from 'react';
import { KIND_LABELS, LEVEL_LABELS, SOURCE_LABELS, api } from './api';
import type { SessionKind, SessionSummary, Stats, WordSource } from './api';

const MODE_LABELS: Record<string, string> = {
  standard: 'Standard',
  weak: 'Non maîtrisées',
  reinforce: 'À renforcer',
  mixed: 'Mixte',
  context: 'Par contexte',
};

function formatDate(iso: string): string {
  return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function History(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.stats(), api.listSessions()])
      .then(([s, list]) => {
        setStats(s);
        setSessions(list);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Erreur inconnue'));
  }, []);

  if (error)
    return (
      <p className="status status-error" role="alert">
        {error}
      </p>
    );
  if (!stats || !sessions) return <p className="empty">Chargement…</p>;

  return (
    <>
      <section className="card" aria-label="Progrès">
        <h2>Progrès</h2>
        <p className="word-meta">
          {stats.totalWords} mots · {stats.totalMeanings} significations suivies
        </p>
        <ul className="level-grid">
          {(['mastered', 'reinforce', 'weak', 'new'] as const).map((lvl) => (
            <li key={lvl}>
              <span className={`badge badge-${lvl}`}>{LEVEL_LABELS[lvl]}</span>
              <strong> {stats.byLevel[lvl]}</strong>
            </li>
          ))}
        </ul>

        {stats.weakMeanings.length > 0 && (
          <div>
            <h3>Significations à retravailler</h3>
            <ul className="meanings">
              {stats.weakMeanings.map((m) => (
                <li key={m.meaningId} className="meaning-detail">
                  <span lang="ko">{m.korean}</span> — {m.translation}
                  {m.context ? ` (${m.context})` : ''} · {m.attempts} tentative{m.attempts > 1 ? 's' : ''} · score{' '}
                  {(m.score * 100).toFixed(0)} %
                </li>
              ))}
            </ul>
          </div>
        )}

        {stats.hintDependent.length > 0 && (
          <div>
            <h3>Dépendance aux indices</h3>
            <ul className="meanings">
              {stats.hintDependent.map((m) => (
                <li key={m.meaningId} className="meaning-detail">
                  <span lang="ko">{m.korean}</span> — {m.translation} · {Math.round(m.hintRatio * 100)} % de réponses avec
                  indice
                </li>
              ))}
            </ul>
          </div>
        )}

        {stats.weakContexts.length > 0 && (
          <div>
            <h3>Contextes problématiques</h3>
            <ul className="meanings">
              {stats.weakContexts.map((c) => (
                <li key={c.context} className="meaning-detail">
                  {c.context} — {c.weak} non maîtrisée{c.weak > 1 ? 's' : ''} sur {c.total}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card" aria-label="Progrès des phrases">
        <h2>Phrases</h2>
        <p className="word-meta">
          {stats.phrases.total} phrases débutantes dans la bibliothèque · suivi indépendant du vocabulaire
        </p>
        <ul className="level-grid">
          {(['mastered', 'reinforce', 'weak', 'new'] as const).map((lvl) => (
            <li key={lvl}>
              <span className={`badge badge-${lvl}`}>{LEVEL_LABELS[lvl]}</span>
              <strong> {stats.phrases.byLevel[lvl]}</strong>
            </li>
          ))}
        </ul>

        {stats.phrases.weakPhrases.length > 0 && (
          <div>
            <h3>Phrases à retravailler</h3>
            <ul className="meanings">
              {stats.phrases.weakPhrases.map((p) => (
                <li key={p.phraseId} className="meaning-detail">
                  <span lang="ko">{p.korean}</span> — {p.translation}
                  {p.theme ? ` (${p.theme})` : ''} · {p.attempts} tentative{p.attempts > 1 ? 's' : ''} · score{' '}
                  {(p.score * 100).toFixed(0)} %
                </li>
              ))}
            </ul>
          </div>
        )}

        {stats.phrases.hintDependent.length > 0 && (
          <div>
            <h3>Phrases dépendantes des indices</h3>
            <ul className="meanings">
              {stats.phrases.hintDependent.map((p) => (
                <li key={p.phraseId} className="meaning-detail">
                  <span lang="ko">{p.korean}</span> — {p.translation} · {Math.round(p.hintRatio * 100)} % de réponses avec
                  indice
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card" aria-label="Historique des sessions">
        <h2>Historique</h2>
        {sessions.length === 0 && <p className="empty">Aucune session pour l'instant.</p>}
        <ul className="meanings">
          {sessions.map((s) => (
            <li key={s.id} className="meaning">
              <div className="meaning-main">
                <strong>
                  {s.correct} / {s.total}
                </strong>
                <span className="word-meta">
                  {KIND_LABELS[s.kind as SessionKind] ?? s.kind} · {MODE_LABELS[s.mode] ?? s.mode}
                </span>
                {s.context_filter && <span className="word-meta">· {s.context_filter}</span>}
                {s.source_filter && <span className="word-meta">· {SOURCE_LABELS[s.source_filter as WordSource] ?? s.source_filter}</span>}
              </div>
              <p className="meaning-detail">{formatDate(s.started_at)}{s.finished_at ? '' : ' (en cours)'}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
