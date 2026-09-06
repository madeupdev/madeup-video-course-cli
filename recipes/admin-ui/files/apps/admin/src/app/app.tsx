import { useEffect, useState } from 'react';

import { listRentals, listTitles } from './api';
import type { RentalSummary, TitleSummary } from './contracts';
import './app.css';

type View = 'titles' | 'copies' | 'rentals';
type LoadState = 'loading' | 'ready' | 'error';

function TitlesPage({ titles }: { titles: TitleSummary[] }) {
  return (
    <section aria-labelledby="titles-heading">
      <p className="eyebrow">Catalogue</p>
      <h1 id="titles-heading">Inventory desk</h1>
      <p>Review the titles currently available through the rental API.</p>
      <div className="inventory-grid">
        {titles.map((title) => (
          <article key={title.id}>
            <h2>{title.name}</h2>
            <p>{title.genre} · {title.releaseYear}</p>
            <strong>{title.availability.available} available of {title.availability.total} total</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function CopiesPage({ titles }: { titles: TitleSummary[] }) {
  return (
    <section aria-labelledby="copies-heading">
      <p className="eyebrow">Stock</p>
      <h1 id="copies-heading">Physical copies</h1>
      <p>Availability is grouped by title; the API remains the source of stock truth.</p>
      <div className="inventory-grid">
        {titles.map((title) => (
          <article key={title.id}>
            <h2>{title.name}</h2>
            <p>{title.availability.available} available of {title.availability.total} total</p>
            <meter
              min="0"
              max={title.availability.total}
              value={title.availability.available}
            >
              {title.availability.available}
            </meter>
          </article>
        ))}
      </div>
    </section>
  );
}

function RentalsPage({ rentals }: { rentals: RentalSummary[] }) {
  return (
    <section aria-labelledby="rentals-heading">
      <p className="eyebrow">Loans</p>
      <h1 id="rentals-heading">Active rentals</h1>
      {rentals.length === 0 ? (
        <p className="empty-state">No active rentals</p>
      ) : (
        <div className="inventory-grid">
          {rentals.map((rental) => (
            <article key={rental.id}>
              <h2>{rental.titleName}</h2>
              <p>{rental.copyBarcode} · {rental.customerName}</p>
              <p>Due {new Date(rental.dueAt).toLocaleDateString()}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function App() {
  const [view, setView] = useState<View>('titles');
  const [titles, setTitles] = useState<TitleSummary[]>([]);
  const [rentals, setRentals] = useState<RentalSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  useEffect(() => {
    let current = true;

    void Promise.all([listTitles(), listRentals()])
      .then(([nextTitles, nextRentals]) => {
        if (!current) return;
        setTitles(nextTitles);
        setRentals(nextRentals);
        setLoadState('ready');
      })
      .catch(() => {
        if (current) setLoadState('error');
      });

    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="site-header">
        <a className="wordmark" href="#titles" onClick={() => setView('titles')}>
          <span aria-hidden="true">MUV</span>
          <span>Made Up Video</span>
        </a>
        <p>Staff inventory</p>
        <nav aria-label="Admin views">
          {(['titles', 'copies', 'rentals'] as const).map((item) => (
            <a
              aria-current={view === item ? 'page' : undefined}
              href={`#${item}`}
              key={item}
              onClick={(event) => {
                event.preventDefault();
                setView(item);
              }}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </a>
          ))}
        </nav>
      </header>
      <main id="content">
        {loadState === 'loading' && <p role="status">Loading inventory…</p>}
        {loadState === 'error' && (
          <p role="alert">Inventory data is unavailable. Check the API connection and try again.</p>
        )}
        {loadState === 'ready' && view === 'titles' && <TitlesPage titles={titles} />}
        {loadState === 'ready' && view === 'copies' && <CopiesPage titles={titles} />}
        {loadState === 'ready' && view === 'rentals' && <RentalsPage rentals={rentals} />}
      </main>
    </>
  );
}
export default App;
