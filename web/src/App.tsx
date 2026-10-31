import { useState } from 'react';
import { Dictionary } from './Dictionary';

export function App(): JSX.Element {
  const [view, setView] = useState<'dictionary'>('dictionary');
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
        </nav>
      </header>
      <main>{view === 'dictionary' && <Dictionary />}</main>
    </div>
  );
}
