import { useEffect, useState } from 'react';
import { FlowButton } from './FlowButton';
import { SalsaLogo } from '../../../shared/ui/logo/SalsaLogo';

const MOBILE_NAV = [
  ['#how', 'Как это работает'],
  ['#pdf-product', 'Система'],
  ['#manager', 'Руководителю'],
  ['#report', 'Разбор звонка'],
  ['#trainer', 'Тренажёр'],
  ['#importers', 'Импортёрам'],
  ['#diff', 'Чем отличается'],
  ['#faq', 'FAQ'],
] as const;

function GridEnds() {
  return (
    <>
      <span className="sl-x sl-x-l" aria-hidden>+</span>
      <span className="sl-x sl-x-r" aria-hidden>+</span>
    </>
  );
}

function hashHref(home: string, hash: string) {
  return `${home}${hash}`;
}

export function LandingHeader({ home = '' }: { home?: string }) {
  const [productOpen, setProductOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openProduct = () => setProductOpen(true);
  const closeProduct = () => setProductOpen(false);
  const closeMenu = () => setMenuOpen(false);

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
    <header
      className={`sl-header${productOpen ? ' is-open' : ''}${menuOpen ? ' is-menu' : ''}`}
      onMouseLeave={closeProduct}
    >
      <div className="sl-inner sl-header-inner">
        <div className="sl-header-shell">
          <a className="sl-logo" href={home || '#top'} aria-label="Salsa">
            <SalsaLogo className="sl-logo-svg" />
          </a>
          <nav className="sl-nav">
            <a href={hashHref(home, '#how')} onMouseEnter={closeProduct}>Как это работает</a>
            <a
              className="sl-nav-trigger"
              href={hashHref(home, '#pdf-product')}
              onMouseEnter={openProduct}
              onFocus={openProduct}
            >
              Продукт
            </a>
            <a href={hashHref(home, '#manager')} onMouseEnter={closeProduct}>Руководителю</a>
            <a href={hashHref(home, '#importers')} onMouseEnter={closeProduct}>Импортёрам</a>
            <a href={hashHref(home, '#faq')} onMouseEnter={closeProduct}>FAQ</a>
          </nav>
          <div className="sl-header-cta">
            <FlowButton text="Получить демо" href={hashHref(home, '#demo')} />
          </div>
          <button
            type="button"
            className="sl-burger"
            aria-expanded={menuOpen}
            aria-controls="sl-mobile-nav"
            aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        <div className="sl-mega" aria-label="Разделы продукта" onMouseEnter={openProduct}>
          <div className="sl-mega-panel">
            <a href={hashHref(home, '#how')}>
              <strong>Как это работает</strong>
              <em>Допуск, контроль, исправление</em>
            </a>
            <a href={hashHref(home, '#pdf-product')}>
              <strong>Система</strong>
              <em>Дашборд сети, рейтинг точек и динамика</em>
            </a>
            <a href={hashHref(home, '#report')}>
              <strong>Разбор звонка</strong>
              <em>Оценка по вашим стандартам в любое время</em>
            </a>
            <a href={hashHref(home, '#trainer')}>
              <strong>Тренажёр</strong>
              <em>Реальные ситуации до первого клиента</em>
            </a>
            <a href={hashHref(home, '#diff')}>
              <strong>Чем отличается</strong>
              <em>Salsa рядом с CRM, LMS и речевой аналитикой</em>
            </a>
          </div>
        </div>
        <GridEnds />
      </div>
      <nav id="sl-mobile-nav" className="sl-mobile-nav" aria-label="Меню" hidden={!menuOpen}>
        {MOBILE_NAV.map(([href, label]) => (
          <a key={href} href={hashHref(home, href)} onClick={closeMenu}>
            {label}
          </a>
        ))}
        <div className="sl-mobile-nav-cta" onClick={closeMenu}>
          <FlowButton text="Записаться на демо" href={hashHref(home, '#demo')} variant="solid" />
          <FlowButton text="Получить демо-звонок сейчас" href={hashHref(home, '#try')} />
        </div>
      </nav>
    </header>
  );
}
