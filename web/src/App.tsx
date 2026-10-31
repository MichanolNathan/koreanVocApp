import { useState } from 'react';
import { Dictionary } from './Dictionary';
import { Quiz } from './Quiz';

export function App(): JSX.Element {
  const [view, setView] = useState<'dictionary' | 'quiz'>('dictionary');
  return (
    <div className="app">
      <header className="app-header">
        <h1>MyFlashcardApp</h1>
        <nav aria-label="Sections">
          <button
            type="button"
            className={view === 'dictionary' ? 'nav-active' : ''}
            onClick={() => setView('dictionary')}
          >
            Dictionnaire
          </button>
          <button type="button" className={view === 'quiz' ? 'nav-active' : ''} onClick={() => setView('quiz')}>
            Réviser
          </button>
        </nav>
      </header>
      <main>
        {view === 'dictionary' && <Dictionary />}
        {view === 'quiz' && <Quiz />}
      </main>
    </div>
  );
}
