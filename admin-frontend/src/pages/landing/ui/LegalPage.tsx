import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { FlowButton } from './FlowButton';
import { SalsaLogo } from './SalsaLogo';
import {
  LANDING_HOME,
  LEGAL_DOCS,
  LEGAL_NAV,
  OPERATOR_ADDRESS,
  type LegalBlock,
  type LegalSlug,
} from '../lib/legalDocuments';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import './landing.css';

function GridEnds() {
  return (
    <>
      <span className="sl-x sl-x-l" aria-hidden>+</span>
      <span className="sl-x sl-x-r" aria-hidden>+</span>
    </>
  );
}

function LegalBlocks({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'meta') {
          return <p key={i} className="sl-legal-meta">{block.text}</p>;
        }
        if (block.type === 'h2') {
          return <h2 key={i} className="sl-legal-h2">{block.text}</h2>;
        }
        if (block.type === 'p') {
          return <p key={i} className="sl-legal-p">{block.text}</p>;
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="sl-legal-list">
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'kv') {
          return (
            <dl key={i} className="sl-legal-kv">
              {block.rows.map((row) => (
                <div key={row.label} className="sl-legal-kv-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          );
        }
        return (
          <div key={i} className="sl-legal-table-block">
            <div className="sl-legal-table-wrap" tabIndex={0}>
              <table className="sl-legal-table">
                <thead>
                  <tr>
                    {block.headers.map((header) => (
                      <th key={header} scope="col">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row[0]}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${row[0]}-${cellIndex}`}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ol className="sl-legal-cards">
              {block.rows.map((row) => (
                <li key={row[0]} className="sl-legal-card">
                  {row.map((cell, cellIndex) => (
                    <div key={`${row[0]}-${cellIndex}`} className="sl-legal-card-field">
                      <span>{block.headers[cellIndex]}</span>
                      <p>{cell}</p>
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </>
  );
}

export function LegalPage({ slug }: { slug: LegalSlug }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const doc = LEGAL_DOCS[slug];

  useEffect(() => {
    window.scrollTo(0, 0);
    const prev = document.title;
    document.title = `${doc.title} — Salsa`;
    return () => {
      document.title = prev;
    };
  }, [doc.title]);

  useEffect(() => {
    setMenuOpen(false);
  }, [slug]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="theme-brutal sl-page sl-legal-page">
      <header className={`sl-header${menuOpen ? ' is-menu' : ''}`}>
        <div className="sl-inner sl-header-inner">
          <div className="sl-header-shell">
            <Link className="sl-logo" to={LANDING_HOME} aria-label="Salsa">
              <SalsaLogo className="sl-logo-svg" />
            </Link>
            <nav className="sl-nav sl-legal-topnav" aria-label="Документы">
              {LEGAL_NAV.map((item) => (
                <Link
                  key={item.slug}
                  to={item.path}
                  aria-current={item.slug === slug ? 'page' : undefined}
                >
                  {item.navLabel}
                </Link>
              ))}
            </nav>
            <div className="sl-header-cta">
              <FlowButton text="Получить демо" href={`${LANDING_HOME}#demo`} />
            </div>
            <button
              type="button"
              className="sl-burger"
              aria-expanded={menuOpen}
              aria-controls="sl-legal-mobile-nav"
              aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
          <GridEnds />
        </div>
        <nav id="sl-legal-mobile-nav" className="sl-mobile-nav" aria-label="Меню" hidden={!menuOpen}>
          <Link to={LANDING_HOME} onClick={() => setMenuOpen(false)}>На главную</Link>
          {LEGAL_NAV.map((item) => (
            <Link
              key={item.slug}
              to={item.path}
              aria-current={item.slug === slug ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {item.navLabel}
            </Link>
          ))}
          <div className="sl-mobile-nav-cta" onClick={() => setMenuOpen(false)}>
            <FlowButton text="Записаться на демо" href={`${LANDING_HOME}#demo`} variant="solid" />
          </div>
        </nav>
      </header>

      <div className="sl-inner sl-body">
        <main className="sl-legal" id="top">
          <nav className="sl-legal-crumbs" aria-label="Навигация">
            <Link to={LANDING_HOME}>Главная</Link>
            <span aria-hidden>/</span>
            <span>{doc.navLabel}</span>
          </nav>
          <h1 className="sl-legal-title">{doc.title}</h1>
          <nav className="sl-legal-tabs" aria-label="Юридические документы">
            {LEGAL_NAV.map((item) => (
              <Link
                key={item.slug}
                className={`sl-legal-tab${item.slug === slug ? ' is-active' : ''}`}
                to={item.path}
                aria-current={item.slug === slug ? 'page' : undefined}
              >
                {item.navLabel}
              </Link>
            ))}
          </nav>
          <article className="sl-legal-article">
            <LegalBlocks blocks={doc.blocks} />
          </article>
        </main>

        <footer className="sl-footer">
          <div className="sl-footer-main">
            <div className="sl-footer-brand">
              <span className="sl-footer-logo">
                <SalsaLogo className="sl-footer-logo-svg" />
              </span>
              <span className="sl-footer-note">AI-платформа контроля качества продаж</span>
            </div>
          </div>
          <div className="sl-footer-meta">
            <span className="sl-footer-address">Юридический адрес: {OPERATOR_ADDRESS}</span>
            <div className="sl-footer-legal">
              {LEGAL_NAV.map((item) => (
                <Link key={item.slug} to={item.path}>{item.navLabel}</Link>
              ))}
            </div>
            <span className="sl-footer-copy">© {new Date().getFullYear()}</span>
          </div>
          <GridEnds />
        </footer>
      </div>
    </div>
  );
}
