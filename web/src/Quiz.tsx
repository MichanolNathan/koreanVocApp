import { useEffect, useRef, useState } from 'react';
import { KIND_LABELS, SOURCE_LABELS, api } from './api';
import type { AnswerFeedback, SessionCreated, SessionKind, SessionQuestion, SessionResults, WordSource } from './api';

type Phase =
  | { step: 'setup' }
  | { step: 'run'; session: SessionCreated; index: number; feedback: AnswerFeedback | null; hint: string | null }
  | { step: 'results'; sessionId: number };

const KINDS: Array<{ value: SessionKind; label: string; description: string }> = [
  { value: 'vocab', label: 'Vocabulaire', description: 'Mots du dictionnaire (comme avant)' },
  { value: 'phrases', label: 'Phrases', description: 'Phrases coréennes débutant à traduire' },
  { value: 'mixed', label: 'Mixte', description: '8 questions de vocabulaire + 7 phrases, mélangées' },
];

const MODES: Array<{ value: string; label: string; description: string }> = [
  { value: 'standard', label: 'Standard', description: 'Pondéré par tes faiblesses (recommandé)' },
  { value: 'weak', label: 'Non maîtrisées', description: 'Concentre-toi sur ce qui est raté' },
  { value: 'reinforce', label: 'À renforcer', description: 'Les questions fragiles' },
  { value: 'mixed', label: 'Priorité faibles', description: '70 % difficultés + 30 % acquis' },
  { value: 'context', label: 'Par contexte', description: 'Un contexte ou thème précis' },
];

export function Quiz(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ step: 'setup' });
  const [results, setResults] = useState<SessionResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase.step === 'results') {
      api
        .results(phase.sessionId)
        .then(setResults)
        .catch((e) => setError(e instanceof Error ? e.message : 'Erreur inconnue'));
    }
  }, [phase]);

  return (
    <>
      <div aria-live="polite">
        {error && (
          <p className="status status-error" role="alert">
            {error}{' '}
            <button type="button" className="secondary" onClick={() => { setError(null); setPhase({ step: 'setup' }); }}>
              Retour
            </button>
          </p>
        )}
      </div>
      {phase.step === 'setup' && <QuizSetup onStart={(s) => setPhase({ step: 'run', session: s, index: 0, feedback: null, hint: null })} />}
      {phase.step === 'run' && <QuizRunner phase={phase} setPhase={setPhase} setError={setError} />}
      {phase.step === 'results' && results && <ResultsView results={results} onRestart={() => { setResults(null); setPhase({ step: 'setup' }); }} />}
    </>
  );
}

function QuizSetup(props: { onStart: (s: SessionCreated) => void }): JSX.Element {
  const { onStart } = props;
  const [kind, setKind] = useState<SessionKind>('vocab');
  const [mode, setMode] = useState('standard');
  const [contexts, setContexts] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [context, setContext] = useState('');
  const [source, setSource] = useState<'all' | WordSource>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .stats()
      .then((s) => {
        setContexts(s.contexts);
        setThemes(s.phrases.themes);
      })
      .catch(() => {
        setContexts([]);
        setThemes([]);
      });
  }, []);

  const changeKind = (k: SessionKind): void => {
    setKind(k);
    if (k === 'mixed' && mode === 'context') setMode('standard'); // pas de filtre contexte en mixte
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onStart(
        await api.createSession(kind, mode, mode === 'context' ? context : undefined, source === 'all' ? undefined : source)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const availableModes = MODES.filter((m) => m.value !== 'context' || kind !== 'mixed');
  const contextOptions = kind === 'phrases' ? themes : contexts;

  return (
    <section className="card">
      <h2>Nouveau quiz — traduction</h2>
      <p className="word-meta">15 questions (ou moins si le dictionnaire est petit). Une seule réponse par question.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <fieldset>
          <legend>Type de questions</legend>
          {KINDS.map((k) => (
            <label key={k.value} className="radio-line">
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => changeKind(k.value)}
              />
              <span>
                <strong>{k.label}</strong> — {k.description}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Mode de sélection</legend>
          {availableModes.map((m) => (
            <label key={m.value} className="radio-line">
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <span>
                <strong>{m.label}</strong> — {m.description}
              </span>
            </label>
          ))}
        </fieldset>
        {mode === 'context' && (
          <label>
            {kind === 'phrases' ? 'Thème' : 'Contexte'}
            <select value={context} onChange={(e) => setContext(e.target.value)} required>
              <option value="">{kind === 'phrases' ? 'Choisir un thème…' : 'Choisir un contexte…'}</option>
              {contextOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind !== 'phrases' && (
          <label>
            Dictionnaire {kind === 'mixed' && <span className="word-meta">(partie vocabulaire)</span>}
            <select value={source} onChange={(e) => setSource(e.target.value as 'all' | WordSource)}>
              <option value="all">Tous les dictionnaires</option>
              <option value="personal">{SOURCE_LABELS.personal}</option>
              <option value="official">{SOURCE_LABELS.official}</option>
            </select>
          </label>
        )}
        {error && (
          <p className="status status-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          Commencer
        </button>
      </form>
    </section>
  );
}

function QuizRunner(props: {
  phase: Extract<Phase, { step: 'run' }>;
  setPhase: (p: Phase) => void;
  setError: (e: string) => void;
}): JSX.Element {
  const { phase, setPhase, setError } = props;
  const { session, index } = phase;
  const question: SessionQuestion | undefined = session.questions[index];
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    (question?.kind === 'phrase' ? areaRef.current : inputRef.current)?.focus();
  }, [index, question]);

  if (!question) return <p className="empty">Session terminée.</p>;

  const { feedback, hint } = phase;

  const submit = async (): Promise<void> => {
    if (answer.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const fb = await api.answer(session.id, question.id, answer);
      setPhase({ ...phase, feedback: fb, hint });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const useHint = async (): Promise<void> => {
    if (hint !== null || feedback) return;
    try {
      const h = await api.hint(session.id, question.id);
      setPhase({ ...phase, hint: h.hint ?? '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  const next = (): void => {
    if (index + 1 >= session.questions.length) {
      setPhase({ step: 'results', sessionId: session.id });
    } else {
      setPhase({ step: 'run', session, index: index + 1, feedback: null, hint: null });
      setAnswer('');
    }
  };

  const isPhrase = question.kind === 'phrase';

  return (
    <section className="card quiz-card" aria-label={`Question ${index + 1} sur ${session.questions.length}`}>
      <p className="quiz-progress" aria-live="polite">
        Question {index + 1} / {session.questions.length} · {isPhrase ? 'Phrase' : 'Mot'}
      </p>
      <p className={isPhrase ? 'quiz-sentence' : 'quiz-word'} lang="ko">
        {question.korean}
      </p>
      <p className="word-meta">
        {question.romanization}
        {question.romanization && question.pos ? ' · ' : ''}
        {question.pos}
      </p>

      {!feedback && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Traduction en français
            {isPhrase ? (
              <textarea
                ref={areaRef}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={2}
                autoComplete="off"
                lang="fr"
              />
            ) : (
              <input
                ref={inputRef}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                autoComplete="off"
                lang="fr"
              />
            )}
          </label>
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy || answer.trim().length === 0}>
              Valider
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void useHint()}
              disabled={!question.hintAvailable || hint !== null}
            >
              {hint !== null ? 'Indice utilisé' : 'Indice'}
            </button>
          </div>
        </form>
      )}

      {hint !== null && !feedback && <p className="status status-ok">Indice : {hint}</p>}

      {feedback && (
        <div className="feedback" aria-live="polite">
          <p className={`status ${feedback.correct ? 'status-ok' : 'status-error'}`}>
            {feedback.correct ? `Correct — ${feedback.expected}` : `Incorrect. Attendu : ${feedback.expected}`}
          </p>
          {feedback.kind === 'meaning' && feedback.matchedMeaningId !== null && feedback.matchedMeaningId !== feedback.targetMeaning.id && (
            <p className="word-meta">(autre sens du mot accepté)</p>
          )}
          {feedback.kind === 'meaning' && feedback.otherMeanings.length > 0 && (
            <div>
              <p className="word-meta">Autres sens du mot :</p>
              <ul className="meanings">
                {feedback.otherMeanings.map((m) => (
                  <li key={m.id} className="meaning-detail">
                    {m.translation}
                    {m.context ? ` — ${m.context}` : ''}
                    {m.hint ? ` (indice : ${m.hint})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {feedback.kind === 'phrase' && feedback.acceptedTranslations.length > 0 && (
            <p className="word-meta">Autres traductions acceptées : {feedback.acceptedTranslations.join(' · ')}</p>
          )}
          <button type="button" className="primary" onClick={next} autoFocus>
            {index + 1 >= session.questions.length ? 'Voir les résultats' : 'Question suivante'}
          </button>
        </div>
      )}
    </section>
  );
}

function ResultsView(props: { results: SessionResults; onRestart: () => void }): JSX.Element {
  const { results, onRestart } = props;
  const hasBoth = results.byCategory.vocab.total > 0 && results.byCategory.phrases.total > 0;
  return (
    <>
      <section className="card">
        <h2>Résultats — {results.correct} / {results.total}</h2>
        <ul className="result-stats">
          <li>{results.percent} % de réussite</li>
          <li>{results.incorrectCount} erreur{results.incorrectCount > 1 ? 's' : ''}</li>
          <li>{results.hintsUsed} indice{results.hintsUsed > 1 ? 's' : ''} utilisé{results.hintsUsed > 1 ? 's' : ''}</li>
          <li>{results.correctWithoutHint} bonne{results.correctWithoutHint > 1 ? 's' : ''} réponse{results.correctWithoutHint > 1 ? 's' : ''} sans indice</li>
        </ul>
        {hasBoth && (
          <ul className="result-stats">
            <li>Vocabulaire : {results.byCategory.vocab.correct} / {results.byCategory.vocab.total}</li>
            <li>Phrases : {results.byCategory.phrases.correct} / {results.byCategory.phrases.total}</li>
          </ul>
        )}
        <button type="button" className="primary" onClick={onRestart}>
          Nouveau quiz
        </button>
      </section>
      <section className="card" aria-label="Détail des questions">
        <h2>Détail</h2>
        <ol className="result-list">
          {results.questions.map((q) => (
            <li key={q.id} className={q.correct ? 'result-ok' : 'result-ko'}>
              <span className="word-meta">{q.kind === 'phrase' ? 'Phrase' : 'Mot'} · </span>
              <span lang="ko">{q.korean}</span> — ta réponse : « {q.user_answer} » · attendu : « {q.expected} »
              {q.hint_used && ' · avec indice'}
              {!q.correct && q.kind === 'vocab' && q.otherMeanings.length > 0 && (
                <span className="word-meta"> · autres sens : {q.otherMeanings.map((m) => m.translation).join(', ')}</span>
              )}
              {q.kind === 'phrase' && q.acceptedTranslations.length > 0 && (
                <span className="word-meta"> · aussi accepté : {q.acceptedTranslations.join(', ')}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
