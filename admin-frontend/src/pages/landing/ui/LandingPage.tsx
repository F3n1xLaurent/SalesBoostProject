import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BrutalModal } from '../../../shared/ui/brutal-modal/BrutalModal';
import { LEGAL_NAV, OPERATOR_ADDRESS } from '../lib/legalDocuments';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import {
  buildDepartmentExampleAudit,
  DEPARTMENT_EXAMPLE_CARDS,
  type DepartmentExampleId,
} from '../lib/departmentExamples';
import { buildLandingExampleAudit } from '../lib/exampleAudit';
import trainerBizUi from '../assets/trainer-biz.png';
import trainerMgrUi from '../assets/trainer-mgr.png';
import { LandingHeader } from './LandingHeader';
import { PdfStructureBlocks } from './PdfStructure';
import { SalsaLogo } from '../../../shared/ui/logo/SalsaLogo';
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

function MiniGlyph({
  name,
}: {
  name: 'pin' | 'call' | 'list' | 'file' | 'box' | 'script' | 'chat' | 'users' | 'gauge' | 'siren';
}) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {name === 'pin' && (
        <>
          <path d="M12 21s6-5.4 6-11a6 6 0 1 0-12 0c0 5.6 6 11 6 11z" />
          <circle cx="12" cy="10" r="1.8" />
        </>
      )}
      {name === 'call' && (
        <path d="M7.2 3.8h3.1l1.2 3.2-1.9 1.1a12.4 12.4 0 0 0 6.3 6.3l1.1-1.9 3.2 1.2v3.1c0 .8-.7 1.5-1.5 1.5C9.8 18.3 5.7 14.2 5.7 5.3c0-.8.7-1.5 1.5-1.5z" />
      )}
      {name === 'list' && (
        <>
          <path d="M8.5 4.5h11v15h-11a2.5 2.5 0 0 1-2.5-2.5V7a2.5 2.5 0 0 1 2.5-2.5z" />
          <path d="M10.5 9.5h6M10.5 12.5h6M10.5 15.5h4" />
        </>
      )}
      {name === 'file' && (
        <>
          <path d="M7 3.8h7.2L18.2 8v12.2H7z" />
          <path d="M14.2 3.8V8h4" />
          <path d="M9.5 12.2h5.2M9.5 15.2h5.2" />
        </>
      )}
      {name === 'box' && (
        <>
          <path d="M3.8 8.2 12 4.2l8.2 4v7.6L12 19.8 3.8 15.8z" />
          <path d="M12 12.2V19.8M3.8 8.2 12 12.2l8.2-4" />
        </>
      )}
      {name === 'script' && (
        <>
          <path d="M7 4.2h10v15.6H7z" />
          <path d="M9.5 8.2h5M9.5 11.2h5M9.5 14.2h3.2" />
        </>
      )}
      {name === 'chat' && (
        <>
          <path d="M5 5.5h14v9.2H9.2L5 18.2z" />
          <path d="M8.5 9.2h7M8.5 12h5" />
        </>
      )}
      {name === 'users' && (
        <>
          <circle cx="9" cy="8.2" r="2.2" />
          <circle cx="15.4" cy="8.8" r="1.8" />
          <path d="M3.8 17.2c.4-2.6 2.4-4 5.2-4s4.8 1.4 5.2 4" />
          <path d="M13.2 14.2c1.4-.6 2.8-.4 4.2.6.8.6 1.3 1.5 1.5 2.4" />
        </>
      )}
      {name === 'gauge' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4.2v1.6M19.8 12h-1.6M12 19.8v-1.6M4.2 12h1.6" />
          <path d="M12 12 L16.8 8.4" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
        </>
      )}
      {name === 'siren' && (
        <>
          <path d="M7.8 15h8.4v3.2H7.8z" />
          <path d="M9 15c0-3.6 1.35-6.4 3-6.4s3 2.8 3 6.4" />
          <path d="M12 4.5v2.4M5.6 7.2l1.7 1.7M18.4 7.2l-1.7 1.7" />
        </>
      )}
    </svg>
  );
}

function useSoftReveal() {
  useEffect(() => {
    const root = document.querySelector('.sl-page');
    if (!root) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.sl-reveal'));
    if (reduce) {
      nodes.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      },
      {
        threshold: 0.02,
        // Slightly early so the fade is visible as the block enters — not
        // 32% (animation finishes off-screen) and not negative (late pop).
        rootMargin: mobile ? '0px 0px 10% 0px' : '0px 0px 8% 0px',
      },
    );

    nodes.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ─────────────────────────────────── Page ─────────────────────────────────── */

export function LandingPage() {
  const [reportId, setReportId] = useState<DepartmentExampleId | 'classic' | null>(null);
  const classicAudit = useMemo(() => buildLandingExampleAudit(), []);
  const departmentAudits = useMemo(
    () => ({
      sales: buildDepartmentExampleAudit('sales'),
      appraisal: buildDepartmentExampleAudit('appraisal'),
      service: buildDepartmentExampleAudit('service'),
    }),
    [],
  );
  useSoftReveal();

  const openReport = (id: DepartmentExampleId | 'classic') => {
    // Defer so the opening click cannot hit the freshly mounted overlay.
    window.setTimeout(() => setReportId(id), 0);
  };

  const activeAudit =
    reportId === 'classic'
      ? classicAudit
      : reportId
        ? departmentAudits[reportId]
        : null;
  const modalTitle =
    reportId && reportId !== 'classic'
      ? DEPARTMENT_EXAMPLE_CARDS.find((c) => c.id === reportId)?.modalTitle ?? 'Пример отчёта'
      : 'Пример отчёта';

  return (
    <div className="theme-brutal sl-page">
      <LandingHeader />
      <div className="sl-inner sl-body">
      <main id="top">
        <PdfStructureBlocks
          onShowExample={() => openReport('classic')}
          onOpenDepartmentReport={(id) => openReport(id)}
          afterManager={
            <section className="sl-sec sl-reveal" id="trainer">
              <div className="sl-band">
                <div>
                  <div className="sl-section-tag">Тренажёр</div>
                  <h2 className="sl-h2">
                    Тренируйте менеджеров
                    <br />
                    на реальных ситуациях
                  </h2>
                </div>
                <p className="sl-lede">
                  Симуляция общения с клиентом и реальные рабочие ситуации
                  до первого реального диалога
                </p>
              </div>
              <div className="sl-audience-row sl-trainer-audience sl-reveal sl-reveal-delay-1">
                <article className="sl-audience-card sl-audience-card--stack sl-audience-card--muted">
                  <div className="sl-audience-copy">
                    <span className="sl-audience-kicker">Для бизнеса</span>
                    <h3 className="sl-audience-title">Ваши скрипты. Видимый прогресс</h3>
                    <p className="sl-audience-text">
                      Сценарии на ваших стандартах. Видно, кто тренируется, а кто нет
                    </p>
                  </div>
                  <div className="sl-audience-illu" aria-hidden>
                    <img className="sl-trainer-ui" src={trainerBizUi} width={1024} height={563} alt="" />
                  </div>
                </article>
                <article className="sl-audience-card sl-audience-card--stack sl-audience-card--muted">
                  <div className="sl-audience-copy">
                    <span className="sl-audience-kicker">Для менеджера</span>
                    <h3 className="sl-audience-title">Голосовой AI-клиент без подсказок</h3>
                    <p className="sl-audience-text">
                      Живой диалог голосом. После сессии — оценка и разбор ошибок
                    </p>
                  </div>
                  <div className="sl-audience-illu" aria-hidden>
                    <img className="sl-trainer-ui" src={trainerMgrUi} width={1024} height={563} alt="" />
                  </div>
                </article>
              </div>
              <div className="sl-step-cards sl-reveal sl-reveal-delay-2">
                {([
                  ['box', 'Знание ассортимента', 'Продукт и условия — до первого звонка клиенту'],
                  ['script', 'Разговор по скрипту', 'Сценарий компании голосом, без подсказок и вариантов'],
                  ['chat', 'Работа с возражениями', '«Дорого», сравнения и жёсткие вопросы клиентов'],
                  ['users', 'Сложные клиенты', 'Разные типы клиентов и эмоциональных состояний'],
                ] as const).map(([icon, title, text]) => (
                  <article key={title} className="sl-step-card sl-squircle">
                    <span className="sl-step-ico" aria-hidden>
                      <MiniGlyph name={icon} />
                    </span>
                    <h3 className="sl-step-title">{title}</h3>
                    <p className="sl-step-text">{text}</p>
                  </article>
                ))}
              </div>
              <GridEnds />
            </section>
          }
        />

        {/* Footer */}
        <footer className="sl-footer sl-reveal">
          <div className="sl-footer-main">
            <div className="sl-footer-brand">
              <span className="sl-footer-logo">
                <SalsaLogo className="sl-footer-logo-svg" />
              </span>
              <span className="sl-footer-note">AI-платформа контроля качества продаж</span>
            </div>
            <nav className="sl-footer-nav" aria-label="Навигация">
              <a href="#how">Как это работает</a>
              <a href="#pdf-product">Продукт</a>
              <a href="#report">Разбор звонка</a>
              <a href="#manager">Руководителю</a>
              <a href="#trainer">Тренажёр</a>
              <a href="#importers">Импортёрам</a>
              <a href="#faq">FAQ</a>
            </nav>
          </div>
          <div className="sl-footer-meta">
            <span className="sl-footer-address">
              Юридический адрес: {OPERATOR_ADDRESS}
            </span>
            <div className="sl-footer-legal">
              {LEGAL_NAV.map((item) => (
                <Link key={item.slug} to={item.path}>{item.navLabel}</Link>
              ))}
            </div>
            <span className="sl-footer-copy">© {new Date().getFullYear()}</span>
          </div>
          <GridEnds />
        </footer>
      </main>
      </div>

      <BrutalModal
        open={reportId !== null}
        onClose={() => setReportId(null)}
        title={modalTitle}
        width="wide"
        className="sl-landing-modal"
        overlayClassName="sl-landing-modal-overlay"
        exitDurationMs={420}
      >
        <div className="sl-report-modal">
          {activeAudit ? <AuditAnalyticsReport detail={activeAudit} /> : null}
        </div>
      </BrutalModal>
    </div>
  );
}
