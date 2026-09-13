import { FormEvent, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Orb } from '@/components/ui/orb';
import featAnalytics from '../assets/Analytics.png';
import featPhone from '../assets/Phone.png';
import featTrain from '../assets/Train.png';
import heroDashboardUi from '../assets/hero-dashboard-ui.svg';
import reportUi from '../assets/report-ui.svg';
import { FlowButton } from './FlowButton';
import { SalsaLogo } from './SalsaLogo';
import { MeshGradient } from './MeshGradient';
import { ShaderBackground } from './ShaderBackground';

const DEMO_CALL_PATH = '/demo-call';

const HOW_MODULES = [
  {
    title: 'AI-тренажёр',
    steps: ['Обучение', 'Экзамен', 'Допуск'],
    text: 'Отрабатывает продукт и скрипт голосом. К клиентам выходит только тот, кто сдал.',
    img: featTrain,
  },
  {
    title: 'AI-тайный покупатель',
    steps: ['Контроль'],
    text: 'Звонит в салоны как обычный клиент. Менеджер должен довести разговор до следующего шага.',
    img: featPhone,
  },
  {
    title: 'Аналитика',
    steps: ['Исправление', 'Снова контроль'],
    text: 'Кому что чинить и задачи РОПу. Проблема закрыта, когда при повторной проверке не повторяется.',
    img: featAnalytics,
  },
] as const;

const DIFF_ROWS = [
  ['LMS', 'Знает, что курс пройден', 'Проверяет навык в живом разговоре'],
  ['CRM', 'Знает, что случилось с лидом', 'Показывает, почему так вышло'],
  ['Телефония', 'Знает, что звонок состоялся', 'Оценивает качество разговора'],
  ['Речевая аналитика', 'Разбирает разговор постфактум', 'Встраивает проверку в ежедневный цикл'],
  ['Тайный покупатель', 'Один момент несколько раз в год', 'Постоянный контроль всей сети'],
] as const;

const DEALER_BARS = [
  ['Москва · Юг', 92, 3],
  ['Санкт-Петербург', 86, 1],
  ['Казань', 81, 6],
  ['Екатеринбург', 74, -2],
  ['Краснодар', 66, 4],
  ['Ростов-на-Дону', 58, -5],
] as const;

const NETWORK_ROWS = [
  { point: 'Варшавское ш.', score: '94%', reason: 'стабильно', action: 'плановые проверки', tone: 'good', systemic: false, avatars: false },
  { point: 'Ярославское ш.', score: '78%', reason: 'знание кредитных программ', action: 'обучение шести менеджерам', tone: 'mid', systemic: false, avatars: true },
  { point: 'Химки', score: '66%', reason: 'дозвон — телефония', action: 'IT: проверить IVR', tone: 'warn', systemic: false, avatars: false },
  { point: 'Подольск', score: '58%', reason: 'нет следующего шага', action: 'тренировка «Следующий шаг»', tone: 'bad', systemic: true, avatars: false },
] as const;

function GridEnds() {
  return (
    <>
      <span className="sl-x sl-x-l" aria-hidden>
        +
      </span>
      <span className="sl-x sl-x-r" aria-hidden>
        +
      </span>
    </>
  );
}

function DemoLeadForm() {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !company.trim() || !phone.trim()) return;
    setSent(true);
  };

  if (sent) {
    return (
      <div className="sl-lead-done">
        <strong>Заявка отправлена</strong>
        <p>Свяжемся, чтобы согласовать время демо</p>
      </div>
    );
  }

  return (
    <form className="sl-lead-form" onSubmit={onSubmit}>
      <label className="sl-lead-field">
        <span>Имя</span>
        <input
          className="sl-lead-input"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>Компания</span>
        <input
          className="sl-lead-input"
          type="text"
          autoComplete="organization"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>Телефон</span>
        <input
          className="sl-lead-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+7 999 000-00-00"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>
          Комментарий <em>необязательно</em>
        </span>
        <textarea
          className="sl-lead-area"
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <div className="sl-lead-actions">
        <FlowButton text="Записаться на демо" type="submit" variant="solid" />
      </div>
    </form>
  );
}

const TRY_CLIENTS = [
  {
    id: 'mikhail',
    name: 'Михаил',
    temper: 'Спокойный и дотошный',
    colors: ['#BFE0F5', '#2F6FBE'] as [string, string],
    ring: '#2F6FBE',
    seed: 41,
  },
  {
    id: 'sergey',
    name: 'Сергей',
    temper: 'Торопится и давит',
    colors: ['#FFC38A', '#E8590C'] as [string, string],
    ring: '#E8590C',
    seed: 2000,
  },
  {
    id: 'anna',
    name: 'Анна',
    temper: 'Сомневается и сравнивает',
    colors: ['#EFC3F2', '#9D4EDD'] as [string, string],
    ring: '#9D4EDD',
    seed: 7,
  },
] as const;

function TryLiveDemo() {
  const [selected, setSelected] = useState(1);
  const [phone, setPhone] = useState('');
  const client = TRY_CLIENTS[selected]!;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (phone.trim()) params.set('phone', phone.trim());
    params.set('client', client.id);
    window.location.href = `${DEMO_CALL_PATH}?${params.toString()}`;
  };

  return (
    <section className="sl-sec sl-try sl-reveal" id="try">
      <div className="sl-band sl-try-band">
        <div>
          <div className="sl-section-tag">Живая проверка</div>
          <h2 className="sl-h2">
            Проверьте отдел продаж
            <br />
            за 30 секунд
          </h2>
        </div>
        <p className="sl-lede">
          Выберите клиента — он позвонит вашему менеджеру как тайный покупатель
          и разберёт разговор как строгий РОП
        </p>
      </div>

      <div className="sl-try-panel">
        <div className="sl-try-picker" role="radiogroup" aria-label="Выберите AI-клиента">
          {TRY_CLIENTS.map((c, i) => {
            const isActive = i === selected;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`sl-try-client${isActive ? ' is-active' : ''}`}
                style={{ '--sl-client-ring': c.ring } as CSSProperties}
                onClick={() => setSelected(i)}
              >
                <span className="sl-try-client-orb" aria-hidden>
                  <span className="sl-try-client-orb-core">
                    <Orb colors={c.colors} seed={c.seed} agentState={isActive ? 'talking' : null} />
                  </span>
                </span>
                <strong>{c.name}</strong>
                <em>{c.temper}</em>
              </button>
            );
          })}
        </div>

        <form className="sl-try-call" onSubmit={onSubmit}>
          <label className="sl-try-call-label" htmlFor="sl-try-phone">
            Телефон менеджера или отдела продаж
          </label>
          <div className="sl-try-call-row">
            <input
              id="sl-try-phone"
              className="sl-phone-input sl-try-call-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+7 999 000-00-00"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <FlowButton text="Получить звонок" type="submit" variant="solid" />
          </div>
        </form>
      </div>
      <GridEnds />
    </section>
  );
}

function HeroCallReview() {
  const bars = [
    22, 38, 28, 52, 44, 68, 36, 58, 48, 72, 40, 62, 34, 55, 46, 70, 42, 60, 32, 50,
    44, 66, 38, 54, 48, 64, 36, 58, 30, 62, 44, 70, 40, 56, 34, 64, 48, 72, 38, 58,
    42, 66, 36, 54, 46, 68, 40, 60, 32, 52, 44, 70, 38, 56, 46, 64,
  ];

  return (
    <aside className="sl-hero-review" aria-hidden>
      <div className="sl-hero-review-head">
        <span className="sl-hero-review-live">
          <i />
          Проверка звонка
        </span>
        <span className="sl-hero-review-meta">01:24</span>
      </div>

      <strong className="sl-hero-review-title">Кредит + трейд-ин · спокойный клиент</strong>

      <div className="sl-hero-review-wave">
        <span className="sl-hero-review-play" />
        <div className="sl-hero-review-bars">
          {bars.map((h, i) => (
            <i key={i} style={{ ['--h' as string]: `${h}%`, animationDelay: `${(i % 12) * -0.12}s` }} />
          ))}
        </div>
      </div>

      <div className="sl-hero-review-score">
        <div className="sl-hero-review-ring">
          <strong>74</strong>
          <span>балл</span>
        </div>
        <div className="sl-hero-review-score-copy">
          <em>Оценка по стандарту</em>
          <p>13 критериев · вес по сценарию</p>
        </div>
      </div>

      <div className="sl-hero-review-cols">
        <div>
          <span className="sl-hero-review-label">Диагностика</span>
          <ul className="sl-hero-review-list">
            <li className="is-good">Контакт и тон</li>
            <li className="is-good">Выявление потребности</li>
            <li className="is-bad">Следующий шаг не зафиксирован</li>
          </ul>
        </div>
        <div>
          <span className="sl-hero-review-label">Рекомендации</span>
          <ul className="sl-hero-review-recs">
            <li>Зафиксировать визит в салоне</li>
            <li>Уточнить условия трейд-ин</li>
          </ul>
        </div>
      </div>
    </aside>
  );
}

function HowCycleModules() {
  return (
    <div className="sl-feat-row sl-how-modules">
      {HOW_MODULES.map((mod) => (
        <article key={mod.title} className="sl-feat-cell sl-squircle">
          <div className="sl-how-tags">
            {mod.steps.map((step) => (
              <span key={step} className="sl-how-tag">
                {step}
              </span>
            ))}
          </div>
          <div className="sl-feat-illu">
            <img className="sl-feat-img" src={mod.img} alt="" />
          </div>
          <h3 className="sl-feat-title">{mod.title}</h3>
          <p className="sl-feat-text">{mod.text}</p>
        </article>
      ))}
    </div>
  );
}

function ReportCards() {
  const items = [
    {
      title: 'Стандарт компании',
      text: 'Контакт, диагностика, продукт и закрытие — ваши критерии',
      icon: (
        <>
          <path d="M5.2 7.2 6.6 8.6 9 5.8M5.2 12.2 6.6 13.6 9 10.8M5.2 17.2 6.6 18.6 9 15.8" />
          <path d="M11.2 7h8M11.2 12h8M11.2 17h6" />
        </>
      ),
    },
    {
      title: 'Разбор диалога',
      text: 'Сильные и слабые стороны этого звонка, не общие впечатления',
      icon: (
        <>
          <path d="M5 5.5h14v9.2H9.2L5 18.2z" />
          <path d="M8.5 9.2h7M8.5 12h5" />
        </>
      ),
    },
    {
      title: 'Оценка и рекомендации',
      text: '13 критериев с весами. По каждому — цитата и что сказать иначе',
      icon: (
        <>
          <path d="M9.2 15.2h5.6" />
          <path d="M9.8 17.4h4.4" />
          <path d="M12 4.6a4.4 4.4 0 0 0-2.3 8.2c.3.2.5.6.5 1v.6h3.6v-.6c0-.4.2-.8.5-1A4.4 4.4 0 0 0 12 4.6z" />
        </>
      ),
    },
    {
      title: 'Одни правила на сеть',
      text: 'Одна шкала для всей сети: точка, менеджер и дилер',
      icon: (
        <>
          <circle cx="12" cy="5.6" r="2" />
          <circle cx="6.2" cy="16.6" r="2" />
          <circle cx="17.8" cy="16.6" r="2" />
          <path d="M12 7.6v3.2M12 10.8 6.2 14.6M12 10.8l5.8 3.8" />
        </>
      ),
    },
  ] as const;

  return (
    <div className="sl-step-cards sl-report-cards">
      {items.map((item) => (
        <article key={item.title} className="sl-step-card sl-squircle">
          <span className="sl-step-ico" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </svg>
          </span>
          <h3 className="sl-step-title">{item.title}</h3>
          <p className="sl-step-text">{item.text}</p>
        </article>
      ))}
    </div>
  );
}

function ReportShot({ onShowExample }: { onShowExample: () => void }) {
  return (
    <div className="sl-report-shot">
      <ShaderBackground className="sl-report-shot-canvas" variant="forest" />
      <img
        className="sl-report-shot-ui"
        src={reportUi}
        alt="Пример отчёта по звонку тайного покупателя"
      />
      <div className="sl-report-shot-action">
        <FlowButton text="Показать пример отчёта" variant="white" onClick={onShowExample} />
      </div>
    </div>
  );
}

const BRAND_STANDARD = 80;

function DealerChart() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setOn(true);
        io.disconnect();
      },
      { threshold: 0.25 },
    );
    io.observe(root);
    return () => io.disconnect();
  }, []);

  return (
    <div className={['sl-dealer-chart', on ? 'is-on' : ''].join(' ')} ref={rootRef} aria-hidden>
      <div className="sl-dealer-axis">
        <span>Стандарт бренда · {BRAND_STANDARD}</span>
      </div>
      <div className="sl-dealer-rows">
        {DEALER_BARS.map(([name, score, delta], i) => {
          const tone = score >= BRAND_STANDARD ? 'good' : score >= 65 ? 'mid' : 'bad';
          return (
            <div
              key={name}
              className="sl-dealer-row"
              style={{ animationDelay: `${0.06 * i}s` }}
            >
              <span className="sl-dealer-name">{name}</span>
              <div className="sl-dealer-track">
                <span
                  className={`sl-dealer-fill is-${tone}`}
                  style={{ '--w': `${score}%` } as CSSProperties}
                />
              </div>
              <strong className={`sl-dealer-score is-${tone}`}>{score}</strong>
              <em className={delta >= 0 ? 'is-up' : 'is-down'}>
                {delta >= 0 ? `↑ ${delta}` : `↓ ${Math.abs(delta)}`}
              </em>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TRAINING_AVATARS = [
  ['АК', '#F3D9A4'],
  ['ДС', '#C9DFF5'],
  ['МП', '#E5D3F0'],
] as const;

function NetworkMark({ tone }: { tone: 'good' | 'mid' | 'warn' | 'bad' }) {
  return (
    <span className={`sl-net-mark is-${tone}`} aria-hidden>
      {tone === 'good' ? (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <circle cx="8" cy="8" r="8" />
          <path d="M4.8 8.2 7 10.3l4.3-4.6" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <circle cx="8" cy="8" r="8" />
          <path d="M8 4.4v5.1" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11.6" r="0.85" fill="#fff" />
        </svg>
      )}
    </span>
  );
}

function NetworkTable() {
  return (
    <div className="sl-net-block">
      <div className="sl-net-table">
        <div className="sl-net-table-cols" aria-hidden>
          <span>Точка</span>
          <span>Стандарт</span>
          <span>Причина</span>
          <span>Действие</span>
        </div>
        {NETWORK_ROWS.map((row) => (
          <div
            key={row.point}
            className={`sl-net-table-row is-${row.tone}${row.systemic ? ' is-systemic' : ''}`}
          >
            <strong className="sl-net-point">
              <NetworkMark tone={row.tone} />
              <span>
                {row.point}
                {row.systemic ? <em className="sl-net-sys">Системная проблема</em> : null}
              </span>
            </strong>
            <span className={`sl-net-score is-${row.tone}`}>{row.score}</span>
            <span className="sl-net-reason">{row.reason}</span>
            <span className="sl-net-action">
              {row.action}
              {row.avatars ? (
                <span className="sl-net-avatars" aria-hidden>
                  {TRAINING_AVATARS.map(([initials, bg]) => (
                    <i key={initials} style={{ background: bg }}>{initials}</i>
                  ))}
                  <i className="sl-net-ava-more">+3</i>
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PdfStructureBlocks({
  onShowExample,
  afterManager,
}: {
  onShowExample: () => void;
  afterManager?: ReactNode;
}) {
  return (
    <>
      {/* Hero — copy + visual inside product mesh panel */}
      <section className="sl-sec sl-hero-v2">
        <div className="sl-hero-v2-shot">
          <ShaderBackground className="sl-hero-v2-shot-canvas" />
          <div className="sl-hero-v2-grid">
            <div className="sl-hero-v2-copy">
              <h1 className="sl-h1 sl-hero-v2-title">РОП как технология</h1>
              <p className="sl-lede sl-hero-v2-lede">
                AI обучает, допускает к работе, проверяет разговоры
                <br className="sl-hero-v2-lede-br" />
                и исправляет ошибки — каждый день во всей сети
              </p>
              <div className="sl-hero-v2-actions">
                <FlowButton text="Получить демо" href="#try" variant="solid" />
                <FlowButton text="Пример отчёта" variant="white" onClick={onShowExample} />
              </div>
            </div>
            <HeroCallReview />
          </div>
        </div>
        <GridEnds />
      </section>

      <TryLiveDemo />

      {/* Как это работает */}
      <section className="sl-sec sl-reveal" id="how">
        <div className="sl-band">
          <div>
            <div className="sl-section-tag">Как это работает</div>
            <h2 className="sl-h2">Один цикл — от найма до клиента</h2>
          </div>
          <p className="sl-lede">
            Не набор инструментов, а один контур: менеджер проходит его в первый месяц —
            и дальше каждый день
          </p>
        </div>
        <HowCycleModules />
        <GridEnds />
      </section>

      {/* Продукт */}
      <section className="sl-sec sl-reveal" id="pdf-product">
        <div className="sl-band">
          <div>
            <div className="sl-section-tag">Продукт</div>
            <h2 className="sl-h2">
              Работающая система,
              <br />
              а не концепция
            </h2>
          </div>
          <p className="sl-lede">
            Аналитика сети: рейтинг, дозвон, динамика — из реальных звонков и проверок,
            без ручных отчётов снизу
          </p>
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
        <GridEnds />
      </section>

      {/* Разбор звонка */}
      <section className="sl-sec sl-reveal" id="report">
        <div className="sl-band">
          <div>
            <div className="sl-section-tag">Разбор звонка</div>
            <h2 className="sl-h2">
              Оценка по вашим стандартам
              <br />
              в любое время
            </h2>
          </div>
          <p className="sl-lede sl-report-lede">
            <span>Каждый звонок — по критериям вашей компании.</span>
            <span>Что вышло, что нет и что менеджеру сделать иначе</span>
          </p>
        </div>
        <ReportShot onShowExample={onShowExample} />
        <ReportCards />
        <GridEnds />
      </section>

      {/* Руководитель */}
      <section className="sl-sec sl-reveal" id="manager">
        <div className="sl-band">
          <div>
            <div className="sl-section-tag">Что видит руководитель</div>
            <h2 className="sl-h2">
              Не тысячи звонков,
              <br />
              а несколько причин
            </h2>
          </div>
          <p className="sl-lede">
            Где проблема и что с ней делать. По фактической работе сети, а не со слов
            руководителей
          </p>
        </div>
        <NetworkTable />
        <GridEnds />
      </section>

      {afterManager}

      {/* Импортёры */}
      <section className="sl-sec sl-reveal" id="importers">
        <div className="sl-band">
          <div>
            <div className="sl-section-tag">Импортёрам и дистрибьюторам</div>
            <h2 className="sl-h2">
              Стандарт живёт в разговоре,
              <br />
              а не в регламенте
            </h2>
          </div>
          <p className="sl-lede">
            Регламент подписан — ещё не ответ. Salsa проверяет, умеют ли продавать по
            стандарту сегодня
          </p>
        </div>
        <DealerChart />
        <GridEnds />
      </section>

      {/* Diff */}
      <section className="sl-sec sl-reveal" id="diff">
        <div className="sl-band sl-band--title">
          <div>
            <div className="sl-section-tag">Преимущества</div>
            <h2 className="sl-h2">Чем Salsa отличается</h2>
          </div>
        </div>
        <div className="sl-diff-panel">
          <div className="sl-diff-table" role="table">
            <div className="sl-diff-table-head" role="row">
              <span role="columnheader">Инструмент</span>
              <span role="columnheader">Обычно</span>
              <span role="columnheader" className="sl-diff-head-us" aria-label="Salsa">
                <SalsaLogo className="sl-diff-logo" />
              </span>
            </div>
            {DIFF_ROWS.map(([label, them, us], i) => (
              <div key={label} className="sl-diff-table-row" role="row">
                <strong role="cell">{label}</strong>
                <div className="sl-diff-cell is-no" role="cell">
                  <span className="sl-diff-mark" aria-hidden>
                    ✕
                  </span>
                  <span>{them}</span>
                </div>
                <div
                  className={`sl-diff-cell is-yes${i === DIFF_ROWS.length - 1 ? ' is-last' : ''}`}
                  role="cell"
                >
                  <span className="sl-diff-mark" aria-hidden>
                    ✓
                  </span>
                  <span>{us}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <GridEnds />
      </section>

      {/* Панч — отдельный блок */}
      <section className="sl-sec sl-punch sl-reveal">
        <p className="sl-diff-punch">
          <span className="sl-diff-punch-line">Все инструменты заканчиваются отчётом.</span>
          <span className="sl-diff-punch-line is-accent">Salsa — следующим действием</span>
        </p>
        <GridEnds />
      </section>

      {/* Демо */}
      <section className="sl-sec sl-final sl-reveal" id="demo">
        <div className="sl-final-shot sl-demo-stage">
          <MeshGradient className="sl-final-shot-canvas" />
          <div className="sl-final-shot-grid">
            <div className="sl-final-shot-copy">
              <div>
                <SalsaLogo className="sl-final-logo" />
                <h2 className="sl-final-title">
                  Протестируйте
                  <br />
                  на своей сети
                </h2>
                <p className="sl-final-sub">
                  За 30 минут покажем весь цикл на вашем бизнесе:
                  автомобили и склад, кредит, стандарты, точки и сценарии
                </p>
              </div>
              <a className="sl-final-quiet" href="#try">
                Получить демо-звонок сейчас
              </a>
            </div>
            <div className="sl-final-card">
              <DemoLeadForm />
            </div>
          </div>
        </div>
        <GridEnds />
      </section>

      <FaqBlock />
    </>
  );
}

const FAQ_ITEMS = [
  {
    q: 'Сколько занимает внедрение?',
    a: 'Обычно несколько дней: загружаем стандарты, скрипты и данные компании и запускаем первые проверки.',
  },
  {
    q: 'Нужно ли менять CRM или телефонию?',
    a: 'Нет. Salsa работает поверх ваших систем и подтягивает из них автомобили, склад, кредит и скрипты.',
  },
  {
    q: 'На каких данных строится проверка?',
    a: 'На ваших: стандарты продаж, скрипты, точки, сценарии и актуальные данные по автомобилям и складу.',
  },
  {
    q: 'Чем это отличается от речевой аналитики?',
    a: 'Речевая аналитика разбирает звонок постфактум. Salsa встраивает проверку в ежедневный цикл и сразу даёт следующее действие.',
  },
  {
    q: 'Можно ли начать с одной точки?',
    a: 'Да. Часто стартуют с одного салона, смотрят первые разборы и затем масштабируют на всю сеть.',
  },
  {
    q: 'Что я увижу за 30 минут демо?',
    a: 'Весь цикл на вашем бизнесе: как проходит проверка, как выглядит разбор и какое действие назначается дальше.',
  },
] as const;

function FaqBlock() {
  const [open, setOpen] = useState(0);

  return (
    <section className="sl-sec sl-faq sl-reveal" id="faq">
      <div className="sl-band sl-band--title">
        <div>
          <div className="sl-section-tag">FAQ</div>
          <h2 className="sl-h2">
            Вопросы,
            <br />
            которые задают чаще всего
          </h2>
        </div>
      </div>
      <div className="sl-faq-list">
        {FAQ_ITEMS.map((item, i) => {
          const isOpen = open === i;
          return (
            <div key={item.q} className={`sl-faq-item${isOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="sl-faq-q"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                {item.q}
                <span aria-hidden>{isOpen ? '−' : '+'}</span>
              </button>
              {isOpen ? <p className="sl-faq-a">{item.a}</p> : null}
            </div>
          );
        })}
      </div>
      <GridEnds />
    </section>
  );
}
