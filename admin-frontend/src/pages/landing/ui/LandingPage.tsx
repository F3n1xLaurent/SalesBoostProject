import { useEffect, useMemo, useRef, useState } from 'react';
import { BrutalModal } from '../../../shared/ui/brutal-modal/BrutalModal';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { buildLandingExampleAudit } from '../lib/exampleAudit';
import reportUi from '../assets/report-ui.svg';
import heroDashboardUi from '../assets/hero-dashboard-ui.svg';
import featPhone from '../assets/Phone.png';
import featTrain from '../assets/Train.png';
import featAnalytics from '../assets/Analytics.png';
import setupData from '../assets/Data.png';
import setupRules from '../assets/Rules.png';
import setupProfiles from '../assets/Profiles.png';
import { ShaderBackground } from './ShaderBackground';
import { FlowButton } from './FlowButton';
import { ChartColumn, Database, FileText, PhoneCall } from 'lucide-react';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import './landing.css';

const DEMO_CALL_PATH = '/demo-call';

function DemoCta({
  label = 'Запросить демо',
  variant = 'default',
}: {
  label?: string;
  variant?: 'default' | 'white';
}) {
  return <FlowButton text={label} href={DEMO_CALL_PATH} variant={variant} />;
}

const PROCESS_STEPS = [
  [
    'Онбординг',
    'Загружаем продукт, скрипты и стандарты компании',
  ],
  [
    'Тренировка',
    'Менеджер отрабатывает сценарии с голосовым AI-клиентом',
  ],
  [
    'Проверка',
    'AI звонит как тайный покупатель и оценивает разговор',
  ],
  [
    'Аналитика',
    'Ошибки менеджера, точки и динамика всей сети',
  ],
  [
    'Улучшение',
    'Слабые места — снова в тренировку и проверку',
  ],
] as const;

function ProcessSteps() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setStarted(true);
        io.disconnect();
      },
      { threshold: 0.35 }
    );
    io.observe(root);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    const stepMs = 850;
    const timers = PROCESS_STEPS.map((_, i) =>
      window.setTimeout(() => setPhase(i + 1), i * stepMs)
    );
    return () => timers.forEach(clearTimeout);
  }, [started]);

  return (
    <div className="sl-process" ref={rootRef}>
      {PROCESS_STEPS.map(([label, cap], i) => {
        const shown = phase > i;
        const active = phase === i + 1;
        return (
          <div
            key={label}
            className={[
              'sl-process-step',
              shown || active ? 'is-shown' : '',
              shown ? 'is-done' : '',
              active ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="sl-process-num">{String(i + 1).padStart(2, '0')}</span>
            <div className="sl-process-bar" aria-hidden>
              <span className="sl-process-bar-fill" />
            </div>
            <div className="sl-process-body">
              <span className="sl-process-label">{label}</span>
              <span className="sl-process-cap">{cap}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

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

function UiTrainerBiz() {
  const rows = [
    { name: 'Иванов А.', status: 'Готово', pct: 92, tone: 'done' as const },
    { name: 'Петрова М.', status: 'В работе', pct: 58, tone: 'mid' as const },
    { name: 'Козлов Д.', status: 'Не начал', pct: 8, tone: 'low' as const },
  ];
  return (
    <div className="sl-ui-snip sl-ui-snip-biz" aria-hidden>
      <div className="sl-ui-snip-head">
        <span className="sl-ui-snip-label">Тренировки команды</span>
        <span className="sl-ui-snip-pill">Скрипт · Возражения</span>
      </div>
      <ul className="sl-ui-snip-rows">
        {rows.map((row) => (
          <li key={row.name}>
            <div className="sl-ui-snip-row-top">
              <span className="sl-ui-snip-name">{row.name}</span>
              <span className={`sl-ui-snip-status is-${row.tone}`}>{row.status}</span>
            </div>
            <span className="sl-ui-snip-bar">
              <i style={{ width: `${row.pct}%` }} className={`is-${row.tone}`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UiTrainerMgr() {
  const bars = [8, 18, 12, 26, 14, 30, 16, 22, 28, 12, 24, 10, 20, 15, 27, 11];
  return (
    <div className="sl-ui-snip sl-ui-snip-voice" aria-hidden>
      <div className="sl-ui-snip-head">
        <div className="sl-ui-snip-live">
          <span className="sl-ui-snip-dot" />
          AI-клиент · в эфире
        </div>
        <span className="sl-ui-snip-timer">04:18</span>
      </div>
      <div className="sl-ui-snip-wave">
        {bars.map((h, i) => (
          <span key={i} style={{ height: h }} />
        ))}
      </div>
      <div className="sl-ui-snip-foot">
        <div className="sl-ui-snip-score-block">
          <div className="sl-ui-snip-score">74</div>
          <div className="sl-ui-snip-score-meta">
            <span className="sl-ui-snip-score-title">Оценка сессии</span>
            <span className="sl-ui-snip-score-sub">Средне</span>
          </div>
        </div>
        <div className="sl-ui-snip-chips">
          <span>Цена без вилки</span>
          <span>Нет next step</span>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────── Product UI ─────────────────────── */

type AnalyticsLevelId = 'manager' | 'point' | 'company' | 'calls' | 'recommendations';

const ANALYTICS_LEVELS: {
  id: AnalyticsLevelId;
  icon: 'users' | 'pin' | 'list' | 'call' | 'siren';
  title: string;
  text: string;
}[] = [
  {
    id: 'manager',
    icon: 'users',
    title: 'Менеджер',
    text: 'Профиль с динамикой, сильными сторонами и типовыми ошибками',
  },
  {
    id: 'point',
    icon: 'pin',
    title: 'Точка',
    text: 'Рейтинг, сравнение с сетью и динамика по неделям',
  },
  {
    id: 'company',
    icon: 'list',
    title: 'Компания',
    text: 'Вся сеть на одном экране: лидеры, отстающие, тренды',
  },
  {
    id: 'calls',
    icon: 'call',
    title: 'Звонки',
    text: 'Время ответа, поднял / не поднял, дозвон и другие сигналы по линии',
  },
  {
    id: 'recommendations',
    icon: 'siren',
    title: 'Рекомендации',
    text: 'Системные и свежие проблемы — что чинить и какой прирост AI-рейтинга это даст',
  },
];

const ANALYTICS_CYCLE_MS = 5200;

function UiAnalyticsManager() {
  return (
    <div className="sl-alevels-mock" aria-hidden>
      <div className="sl-alevels-mock-head">
        <div>
          <span className="sl-mock-caption">Профиль менеджера</span>
          <span className="sl-mock-title">Савчюнко Даниил</span>
        </div>
        <div className="sl-alevels-score-pill">74 · Средне</div>
      </div>
      <div className="sl-alevels-mgr-grid">
        <div className="sl-alevels-mgr-col">
          <span className="sl-alevels-mock-cap">Сильные стороны</span>
          <span className="sl-alevels-chip is-good">Диагностика</span>
          <span className="sl-alevels-chip is-good">Коммуникация</span>
        </div>
        <div className="sl-alevels-mgr-col">
          <span className="sl-alevels-mock-cap">Типовые ошибки</span>
          <span className="sl-alevels-chip">Цена без вилки</span>
          <span className="sl-alevels-chip">Нет next step</span>
        </div>
      </div>
      <div className="sl-alevels-spark">
        <span className="sl-alevels-mock-cap">Динамика 4 недели</span>
        <div className="sl-alevels-bars">
          {[42, 55, 48, 68].map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function UiAnalyticsPoint() {
  return (
    <div className="sl-alevels-mock" aria-hidden>
      <div className="sl-alevels-mock-head">
        <div>
          <span className="sl-mock-caption">Точка</span>
          <span className="sl-mock-title">Салон «Центр»</span>
        </div>
        <div className="sl-alevels-score-pill is-good">82 · Выше сети</div>
      </div>
      <div className="sl-alevels-compare">
        <div>
          <span>AI-рейтинг точки</span>
          <strong>82</strong>
        </div>
        <div>
          <span>Среднее по сети</span>
          <strong>74</strong>
        </div>
      </div>
      <div className="sl-alevels-spark">
        <span className="sl-alevels-mock-cap">Недели</span>
        <div className="sl-alevels-bars is-dense">
          {[50, 58, 54, 62, 60, 70, 66, 78].map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function UiAnalyticsCompany() {
  const rows = [
    { name: 'Точка «Центр»', score: 82, tone: 'good' as const },
    { name: 'Точка «Север»', score: 79, tone: 'good' as const },
    { name: 'Точка «Юг»', score: 61, tone: 'bad' as const },
  ];
  return (
    <div className="sl-alevels-mock" aria-hidden>
      <div className="sl-alevels-mock-head">
        <div>
          <span className="sl-mock-caption">Компания · 30 дней</span>
          <span className="sl-mock-title">Дашборд сети</span>
        </div>
      </div>
      <div className="sl-alevels-kpis">
        <div><span>AI-рейтинг</span><strong>74</strong></div>
        <div><span>Дозвон</span><strong>87%</strong></div>
        <div><span>Проверки</span><strong>312</strong></div>
      </div>
      <div className="sl-alevels-table">
        {rows.map((r) => (
          <div key={r.name} className="sl-alevels-table-row">
            <span>{r.name}</span>
            <span className={`sl-tone-${r.tone}`}>{r.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UiAnalyticsCalls() {
  return (
    <div className="sl-alevels-mock" aria-hidden>
      <div className="sl-alevels-mock-head">
        <div>
          <span className="sl-mock-caption">Линия · сегодня</span>
          <span className="sl-mock-title">Сигналы по звонкам</span>
        </div>
      </div>
      <div className="sl-alevels-kpis sl-alevels-kpis-4">
        <div><span>Ответ</span><strong>12с</strong></div>
        <div><span>Поднял</span><strong>81%</strong></div>
        <div><span>Дозвон</span><strong>87%</strong></div>
        <div><span>Пропущено</span><strong>19%</strong></div>
      </div>
      <div className="sl-alevels-call-list">
        {[
          ['09:14', 'Поднял · 42с', 'good'],
          ['09:31', 'Не поднял', 'bad'],
          ['10:02', 'Поднял · 1м 08с', 'good'],
        ].map(([time, status, tone]) => (
          <div key={time} className="sl-alevels-call-row">
            <span>{time}</span>
            <span className={`sl-tone-${tone}`}>{status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UiAnalyticsRecommendations() {
  return (
    <div className="sl-alevels-mock" aria-hidden>
      <div className="sl-alevels-mock-head">
        <div>
          <span className="sl-mock-caption">Приоритеты</span>
          <span className="sl-mock-title">Рекомендации</span>
        </div>
        <div className="sl-alevels-score-pill">5 действий</div>
      </div>
      <div className="sl-alevels-rec-list">
        {[
          ['systemic', 'Системные', 'Возражения по цене', 'Обучение · +6 AI'],
          ['systemic', 'Системные', 'Нет следующего шага', 'Регламент · +4 AI'],
          ['recent', 'Недавние', 'Точка «Юг» — упал дозвон', 'Сегодня'],
          ['recent', 'Недавние', 'Новый сотрудник — рейтинг 51', '2 дня'],
        ].map(([kind, tag, title, meta]) => (
          <div key={title} className={`sl-alevels-rec-row is-${kind}`}>
            <div>
              <span className="sl-alevels-rec-tag">{tag}</span>
              <strong>{title}</strong>
              <span>{meta}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsLevelVisual({ id }: { id: AnalyticsLevelId }) {
  if (id === 'manager') return <UiAnalyticsManager />;
  if (id === 'point') return <UiAnalyticsPoint />;
  if (id === 'company') return <UiAnalyticsCompany />;
  if (id === 'calls') return <UiAnalyticsCalls />;
  return <UiAnalyticsRecommendations />;
}

function AnalyticsMock() {
  const best = [
    { n: '01', name: 'Точка «Центр»', score: 82, delta: '↑ 4', tone: 'good' as const },
    { n: '02', name: 'Точка «Север»', score: 79, delta: '↑ 2', tone: 'good' as const },
    { n: '03', name: 'Точка «Восток»', score: 77, delta: '↑ 1', tone: 'good' as const },
  ];
  const worst = [
    { n: '01', name: 'Точка «Юг»', score: 61, delta: '↓ 3', tone: 'bad' as const },
    { n: '02', name: 'Точка «Запад»', score: 64, delta: '↓ 1', tone: 'bad' as const },
    { n: '03', name: 'Точка «Река»', score: 66, delta: '→ 0', tone: 'mid' as const },
  ];
  const line = '12,78 48,70 84,74 120,58 156,52 192,40 228,34';

  return (
    <div className="sl-analytics-mock sl-analytics-mock-wide" aria-hidden>
      <div className="sl-analytics-mock-head">
        <div>
          <span className="sl-mock-caption">Аналитика · сеть за 30 дней</span>
          <span className="sl-mock-title">Дашборд компании</span>
        </div>
        <div className="sl-analytics-mock-filters">
          <span>Все точки</span>
          <span>30 дней</span>
        </div>
      </div>

      <div className="sl-analytics-kpis">
        <div className="sl-analytics-kpi">
          <span>AI-рейтинг</span>
          <strong>74 <em className="sl-tone-good">↑ 2.1</em></strong>
        </div>
        <div className="sl-analytics-kpi">
          <span>Дозвон</span>
          <strong>87%</strong>
        </div>
        <div className="sl-analytics-kpi">
          <span>Проверки</span>
          <strong>312</strong>
        </div>
        <div className="sl-analytics-kpi">
          <span>Точки</span>
          <strong>24</strong>
        </div>
      </div>

      <div className="sl-analytics-mock-body">
        <div className="sl-analytics-chart-card">
          <div className="sl-analytics-table-cap">Динамика AI-рейтинга</div>
          <svg className="sl-analytics-chart" viewBox="0 0 240 96" preserveAspectRatio="none">
            {[24, 48, 72].map((y) => (
              <line key={y} x1="0" y1={y} x2="240" y2={y} stroke="rgba(22,22,19,0.06)" strokeWidth="1" />
            ))}
            <polyline points={line} fill="none" stroke="var(--tb-status-green)" strokeWidth="2" />
            {line.split(' ').map((p) => {
              const [x, y] = p.split(',');
              return <circle key={p} cx={x} cy={y} r="2.5" fill="var(--tb-status-green)" />;
            })}
          </svg>
          <div className="sl-analytics-chart-x">
            {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => <span key={d}>{d}</span>)}
          </div>
        </div>

        <div className="sl-analytics-tables">
          <div>
            <div className="sl-analytics-table-cap">Лучшие точки</div>
            {best.map((r) => (
              <div key={r.name} className="sl-analytics-row">
                <span className="sl-analytics-n">{r.n}</span>
                <span className="sl-analytics-name">{r.name}</span>
                <span className="sl-analytics-score">{r.score}</span>
                <span className={`sl-analytics-delta sl-tone-${r.tone}`}>{r.delta}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="sl-analytics-table-cap">Точки с низким результатом</div>
            {worst.map((r) => (
              <div key={r.name} className="sl-analytics-row">
                <span className="sl-analytics-n">{r.n}</span>
                <span className="sl-analytics-name">{r.name}</span>
                <span className="sl-analytics-score">{r.score}</span>
                <span className={`sl-analytics-delta sl-tone-${r.tone}`}>{r.delta}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalyticsLevels() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inViewRef = useRef(false);
  const [active, setActive] = useState(0);
  const [cycleKey, setCycleKey] = useState(0);
  const [inView, setInView] = useState(false);
  const count = ANALYTICS_LEVELS.length;
  const current = ANALYTICS_LEVELS[active]!;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting);
        const entered = visible && !inViewRef.current;
        inViewRef.current = visible;
        setInView(visible);
        if (entered) {
          setActive(0);
          setCycleKey((k) => k + 1);
        }
      },
      { threshold: 0.28, rootMargin: '0px 0px -10% 0px' },
    );

    io.observe(root);
    return () => io.disconnect();
  }, []);

  const select = (index: number) => {
    setActive(index);
    setCycleKey((k) => k + 1);
  };

  const advance = () => {
    if (!inViewRef.current) return;
    setActive((i) => (i + 1) % count);
    setCycleKey((k) => k + 1);
  };

  return (
    <div className="sl-alevels" ref={rootRef}>
      <div className="sl-alevels-nav" role="tablist" aria-label="Уровни аналитики">
        {ANALYTICS_LEVELS.map((item, i) => {
          const isActive = i === active;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`sl-alevels-item${isActive ? ' is-active' : ''}`}
              onClick={() => select(i)}
            >
              <span className="sl-alevels-ico-wrap">
                {isActive && inView ? (
                  <svg
                    key={cycleKey}
                    className="sl-alevels-ring"
                    viewBox="0 0 56 56"
                    aria-hidden
                  >
                    <circle className="sl-alevels-ring-track" cx="28" cy="28" r="25" />
                    <circle
                      className="sl-alevels-ring-prog"
                      cx="28"
                      cy="28"
                      r="25"
                      style={{ animationDuration: `${ANALYTICS_CYCLE_MS}ms` }}
                      onAnimationEnd={advance}
                    />
                  </svg>
                ) : null}
                <span className="sl-alevels-ico">
                  <MiniGlyph name={item.icon} />
                </span>
              </span>
              <span className="sl-alevels-name">{item.title}</span>
            </button>
          );
        })}
      </div>

      <div className="sl-alevels-panel" role="tabpanel">
        <div className="sl-alevels-visual">
          <AnalyticsLevelVisual id={current.id} />
        </div>
        <div className="sl-alevels-copy">
          <h3 className="sl-alevels-title">{current.title}</h3>
          <p className="sl-alevels-text">{current.text}</p>
        </div>
      </div>
    </div>
  );
}

function ReportPreview({ onShowExample }: { onShowExample: () => void }) {
  return (
    <div className="sl-report-shot">
      <ShaderBackground className="sl-report-shot-canvas" variant="forest" />
      <img
        className="sl-report-shot-ui"
        src={reportUi}
        alt="Пример отчёта по звонку тайного покупателя"
      />
      <div className="sl-report-shot-action">
        <FlowButton
          text="Показать пример отчёта"
          variant="white"
          onClick={onShowExample}
        />

      </div>
    </div>
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

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.14, rootMargin: '0px 0px -6% 0px' },
    );

    nodes.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ─────────────────────────────────── Page ─────────────────────────────────── */

export function LandingPage() {
  const [reportOpen, setReportOpen] = useState(false);
  const exampleAudit = useMemo(() => buildLandingExampleAudit(), []);
  useSoftReveal();

  return (
    <div className="theme-brutal sl-page">
      {/* Header */}
      <header className="sl-header">
        <div className="sl-inner sl-header-shell">
          <a className="sl-logo" href="#top">Salsa</a>
          <nav className="sl-nav">
            <a href="#product">Продукт</a>
            <a href="#shopper">Тайный покупатель</a>
            <a href="#trainer">Тренажёр</a>
            <a href="#analytics">Аналитика</a>
            <a href="#why">Почему Salsa</a>
          </nav>
          <div className="sl-header-cta">
            <DemoCta />
          </div>
          <GridEnds />
        </div>
      </header>

      <div className="sl-inner sl-body">
      <main id="top">
        {/* Hero */}
        <section className="sl-sec sl-hero">
          <div className="sl-hero-center">
            <h1 className="sl-h1">
              Проверка, обучение и контроль
              <br />
              качества продаж с AI
            </h1>
            <p className="sl-lede">
              Salsa звонит как реальный клиент, оценивает каждый разговор
              и показывает, где вы теряете продажи
            </p>
            <div className="sl-hero-actions">
              <DemoCta label="Попробовать демо" />
            </div>
          </div>
          <div className="sl-well-cell">
            <div className="sl-hero-shot">
              <ShaderBackground className="sl-hero-shot-canvas" />
              <img
                className="sl-hero-shot-ui"
                src={heroDashboardUi}
                alt="Дашборд Salsa: ключевые метрики и аналитика сети"
              />
            </div>
          </div>
          <div className="sl-hero-features">
            {(
              [
                { Icon: PhoneCall, label: 'AI тайный покупатель' },
                { Icon: FileText, label: 'Отчёт после звонка' },
                { Icon: Database, label: 'Реальные данные компании' },
                { Icon: ChartColumn, label: 'Аналитика всей сети' },
              ] as const
            ).map(({ Icon, label }) => (
              <div key={label} className="sl-hero-feature">
                <span className="sl-hero-feature-icon" aria-hidden>
                  <Icon strokeWidth={1.6} />
                </span>
                <span className="sl-hero-feature-label">{label}</span>
              </div>
            ))}
          </div>
          <GridEnds />
        </section>

        {/* End-to-end cycle */}
        <section className="sl-sec sl-reveal" id="product">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">End-to-end процесс</div>
              <h2 className="sl-h2">Один цикл вместо набора разрозненных инструментов</h2>
            </div>
            <p className="sl-lede">От онбординга нового менеджера до устойчивого роста продаж</p>
          </div>
          <ProcessSteps />
          <GridEnds />
        </section>

        {/* Three components */}
        <section className="sl-sec sl-reveal" id="capabilities">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">Основные возможности</div>
              <h2 className="sl-h2">Контроль, тренировка и аналитика в одной системе</h2>
            </div>
            <p className="sl-lede">Три части продукта, которые работают на одних данных и одних сценариях</p>
          </div>
          <div className="sl-feat-row">
            <article className="sl-feat-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={featPhone} alt="" />
              </div>
              <h3 className="sl-feat-title">AI-тайный покупатель</h3>
              <p className="sl-feat-text">
                Звонит на точки как обычный клиент. Реалистичный голос — менеджер
                не догадается, что это проверка
              </p>
            </article>
            <article className="sl-feat-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={featTrain} alt="" />
              </div>
              <h3 className="sl-feat-title">AI-тренажёр</h3>
              <p className="sl-feat-text">
                Менеджер отрабатывает сценарии с голосовым AI-клиентом.
                Ошибаться можно сколько угодно — но не на ваших клиентах
              </p>
            </article>
            <article className="sl-feat-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={featAnalytics} alt="" />
              </div>
              <h3 className="sl-feat-title">Аналитика</h3>
              <p className="sl-feat-text">
                Каждый звонок превращается в оценку по вашим критериям.
                Видно менеджера, точку и всю сеть — постоянно и автоматически
              </p>
            </article>
          </div>
          <GridEnds />
        </section>

        {/* Secret shopper */}
        <section className="sl-sec sl-reveal" id="shopper">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">Тайный покупатель</div>
              <h2 className="sl-h2">Проверяйте реальную работу менеджеров в любое время</h2>
            </div>
            <p className="sl-lede">
              AI звонит на точки как клиент, ведёт живой диалог и оценивает
              разговор по вашим стандартам
            </p>
          </div>
          <ReportPreview onShowExample={() => setReportOpen(true)} />
          <div className="sl-step-cards">
            {([
              ['pin', 'Выберите, кого проверить', 'Точку, направление или всю сеть — одним запуском'],
              ['call', 'AI звонит как клиент', 'Реалистичный голос, ваши данные, живые возражения'],
              ['list', 'Оценка по вашим стандартам', 'Не универсальный чек-лист — ваши критерии продаж'],
              ['file', 'Отчёт за минуты', 'AI-рейтинг, сильные стороны и конкретные улучшения'],
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

        {/* Trainer */}
        <section className="sl-sec sl-reveal" id="trainer">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">Тренажёр</div>
              <h2 className="sl-h2">Тренируйте менеджеров на реальных ситуациях вашего бизнеса</h2>
            </div>
            <p className="sl-lede">
              Симуляция общения с клиентом и реальные рабочие ситуации
              до первого реального диалога
            </p>
          </div>
          <div className="sl-audience-row sl-trainer-audience">
            <article className="sl-audience-card sl-audience-card--stack sl-audience-card--shader">
              <ShaderBackground className="sl-audience-shader" variant="amber" />
              <div className="sl-audience-copy">
                <span className="sl-audience-kicker">Для бизнеса</span>
                <h3 className="sl-audience-title">Ваши скрипты. Видимый прогресс</h3>
                <p className="sl-audience-text">
                  Сценарии на ваших стандартах. Видно, кто тренируется, а кто нет
                </p>
              </div>
              <div className="sl-audience-illu" aria-hidden><UiTrainerBiz /></div>
            </article>
            <article className="sl-audience-card sl-audience-card--stack sl-audience-card--shader">
              <ShaderBackground className="sl-audience-shader" variant="dusk" />
              <div className="sl-audience-copy">
                <span className="sl-audience-kicker">Для менеджера</span>
                <h3 className="sl-audience-title">Голосовой AI-клиент без подсказок</h3>
                <p className="sl-audience-text">
                  Живой диалог голосом. После сессии — оценка и разбор ошибок
                </p>
              </div>
              <div className="sl-audience-illu" aria-hidden><UiTrainerMgr /></div>
            </article>
          </div>
          <div className="sl-step-cards">
            {([
              ['box', 'Знание ассортимента', 'Продукт и условия — до первого звонка клиенту'],
              ['script', 'Разговор по скрипту', 'Сценарий компании голосом, без подсказок и вариантов'],
              ['chat', 'Работа с возражениями', '«Дорого», сравнения и жёсткие вопросы клиентов'],
              ['users', 'Сложные клиенты', 'Разные типы клиентов и эмоциональные состояния'],
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

        {/* Setup under your business */}
        <section className="sl-sec sl-reveal" id="setup">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">Настройка под ваш бизнес</div>
              <h2 className="sl-h2">Реальные данные. Ваши стандарты. Любые сценарии</h2>
            </div>
            <p className="sl-lede">
              Тренировки и проверки строятся на ваших данных,
              правилах и сценариях продаж
            </p>
          </div>
          <div className="sl-feat-row sl-setup-row">
            <article className="sl-feat-cell sl-setup-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={setupData} alt="" />
              </div>
              <h3 className="sl-feat-title">Данные из ваших систем</h3>
              <p className="sl-feat-text">
                Информация подтягивается из ваших систем и используется в разговорах
              </p>
              <ul className="sl-setup-list">
                <li>Автомобили и комплектации</li>
                <li>Наличие и склад</li>
                <li>Цены, акции и кредит</li>
                <li>Фиды склада и товарные матрицы</li>
              </ul>
            </article>
            <article className="sl-feat-cell sl-setup-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={setupRules} alt="" />
              </div>
              <h3 className="sl-feat-title">Настройка правил оценки</h3>
              <p className="sl-feat-text">
                AI оценивает разговор по правилам вашего бизнеса
              </p>
              <ul className="sl-setup-list">
                <li>Скрипты продаж</li>
                <li>Регламенты</li>
                <li>Чек-листы</li>
                <li>Критерии оценки</li>
              </ul>
            </article>
            <article className="sl-feat-cell sl-setup-cell sl-squircle">
              <div className="sl-feat-illu">
                <img className="sl-feat-img" src={setupProfiles} alt="" />
              </div>
              <h3 className="sl-feat-title">Профили и сценарии</h3>
              <p className="sl-feat-text">
                Разные профили клиентов и сценарии — для тренировок и проверок
              </p>
              <ul className="sl-setup-list">
                <li>Новый клиент</li>
                <li>Кредит и trade-in</li>
                <li>Возражение по цене</li>
                <li>Повторная покупка</li>
              </ul>
            </article>
          </div>
          <GridEnds />
        </section>

        {/* Analytics + recommendations */}
        <section className="sl-sec sl-reveal" id="analytics">
          <div className="sl-band">
            <div>
              <div className="sl-section-tag">Аналитика и рекомендации</div>
              <h2 className="sl-h2">Контролируйте качество — и получайте умные рекомендации</h2>
            </div>
            <p className="sl-lede">
              От менеджера и точки до всей сети. Цифры превращаются
              в приоритеты: системные и свежие проблемы
            </p>
          </div>

          <div className="sl-analytics-shot">
            <ShaderBackground className="sl-analytics-shot-canvas" variant="forest" />
            <div className="sl-analytics-shot-ui">
              <AnalyticsMock />
            </div>
          </div>

          <AnalyticsLevels />
          <GridEnds />
        </section>

        {/* Why Salsa */}
        <section className="sl-sec sl-reveal" id="why">
          <div className="sl-band sl-band--title">
            <div>
              <div className="sl-section-tag">Почему Salsa</div>
              <h2 className="sl-h2">Всё для контроля качества продаж</h2>
            </div>
          </div>

          <div className="sl-why-grid">
            {([
              ['call', 'AI-тайный покупатель', 'Звонит на точки как реальный клиент. Проверка без шаблонов и сюрпризов'],
              ['chat', 'Эмоции как в разговоре', 'От спокойного до раздражённого клиента. Менеджер отвечает как обычно'],
              ['users', 'AI-тренажёр', 'Сценарии на ваших стандартах. Ошибки — в тренировке, не у клиента'],
              ['box', 'Ваши данные', 'Ассортимент, скрипты, регламенты. Разговоры на материалах бизнеса'],
              ['list', 'Аналитика на всех уровнях', 'Менеджер, точка, компания. Слабые места видны сразу'],
              ['gauge', 'Рейтинг сотрудников', 'Сравнение по ключевым метрикам. Кого учить — понятно'],
              ['pin', 'Рейтинг точек', 'Лидеры и отстающие в сети. Лучшие практики — на всю компанию'],
              ['siren', 'Умные рекомендации', 'Что чинить и какой прирост это даст. Данные превращаются в действия'],
            ] as const).map(([icon, title, text]) => (
              <article key={title} className="sl-why-cell">
                <span className="sl-why-ico" aria-hidden>
                  <MiniGlyph name={icon} />
                </span>
                <h3 className="sl-why-title">{title}</h3>
                <p className="sl-why-text">{text}</p>
              </article>
            ))}
          </div>
          <GridEnds />
        </section>

        {/* Final CTA */}
        <section className="sl-sec sl-final sl-reveal">
          <div className="sl-final-shot">
            <ShaderBackground className="sl-final-shot-canvas" variant="warm" />
            <div className="sl-final-shot-inner">
              <h2 className="sl-final-title">Посмотрите Salsa в деле</h2>
              <p className="sl-final-sub">
                Оставьте номер — AI позвонит вам как тайный покупатель
                и пришлёт отчёт через пару минут. Это и есть демо
              </p>
              <DemoCta label="Запросить демо-звонок" variant="white" />
            </div>
          </div>
          <GridEnds />
        </section>

        {/* Footer */}
        <footer className="sl-footer sl-reveal">
          <div className="sl-footer-main">
            <div className="sl-footer-brand">
              <span className="sl-footer-logo">Salsa</span>
              <span className="sl-footer-note">AI-платформа контроля качества продаж</span>
            </div>
            <nav className="sl-footer-nav" aria-label="Навигация">
              <a href="#product">Продукт</a>
              <a href="#shopper">Тайный покупатель</a>
              <a href="#trainer">Тренажёр</a>
              <a href="#analytics">Аналитика</a>
              <a href="#why">Почему Salsa</a>
            </nav>
          </div>
          <div className="sl-footer-meta">
            <span className="sl-footer-address">
              Юридический адрес: тест тест тест
            </span>
            <div className="sl-footer-legal">
              <a href="#privacy">Политика конфиденциальности</a>
              <a href="#terms">Пользовательское соглашение</a>
            </div>
            <span className="sl-footer-copy">© {new Date().getFullYear()}</span>
          </div>
          <GridEnds />
        </footer>
      </main>
      </div>

      <BrutalModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Пример отчёта"
        subtitle="Тот же разбор, что открывается после проверки в Salsa"
        width="wide"
      >
        <div className="sl-report-modal">
          <AuditAnalyticsReport detail={exampleAudit} />
        </div>
      </BrutalModal>
    </div>
  );
}
