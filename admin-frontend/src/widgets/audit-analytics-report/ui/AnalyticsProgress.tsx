import React from 'react';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import './analytics-progress.css';

const STEPS = [
  { id: 'transcription', title: 'Расшифровка диалога', description: 'Собираем реплики участников разговора' },
  { id: 'evaluation', title: 'Первоначальная аналитика', description: 'Оцениваем ответы и выполнение сценария' },
  { id: 'report', title: 'Подготовка отчёта', description: 'Формируем выводы, примеры и рекомендации' },
] as const;

export function AnalyticsProgress({ detail, connectionLost = false }: {
  detail: Pick<AuditDetailItem, 'analyticsProgress' | 'transcript'>;
  connectionLost?: boolean;
}) {
  const progress = detail.analyticsProgress ?? {
    stage: detail.transcript.length >= 2 ? 'evaluation' : 'transcription', status: 'waiting',
    transcriptReady: detail.transcript.length >= 2, evaluationReady: false,
    message: 'Ожидаем подтверждения следующего этапа обработки.',
  };
  const failed = progress.status === 'failed';
  const unavailable = progress.status === 'unavailable';
  const processing = progress.status === 'processing';
  const title = failed ? 'Не удалось подготовить аналитику' : unavailable ? 'Нет разговора для анализа' : 'Готовим аналитику';
  return <section className={`sa-analytics-progress${failed ? ' is-failed' : ''}${processing ? ' is-processing' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    <header className="sa-analytics-progress-head">
      <span className="sa-analytics-progress-emblem" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((bar) => <i key={bar} style={{ '--bar': bar } as React.CSSProperties} />)}
      </span>
      <div><h2>{title}</h2><p>{progress.message}</p></div>
      <span className="sa-analytics-progress-badge">{failed ? 'Нужна проверка' : unavailable ? 'Без оценки' : processing ? 'В работе' : 'Ожидание'}</span>
    </header>
    {!unavailable && <ol className="sa-analytics-progress-steps">
      {STEPS.map((step, index) => {
        const done = progress.status === 'ready' || (step.id === 'transcription' ? progress.transcriptReady : step.id === 'evaluation' ? progress.evaluationReady : false);
        const current = !done && progress.stage === step.id;
        const state = done ? 'done' : current && failed ? 'failed' : current && processing ? 'active' : 'pending';
        return <li key={step.id} className={`sa-analytics-progress-step is-${state}`} aria-current={current ? 'step' : undefined}>
          <span className="sa-analytics-progress-step-icon" aria-hidden="true">{done ? <svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-8" /></svg> : state === 'active' ? <span className="sa-analytics-progress-spinner" /> : state === 'failed' ? '!' : index + 1}</span>
          <div><h3>{step.title}</h3><p>{step.description}</p></div>
          <span className="sa-analytics-progress-step-state">{done ? 'Готово' : state === 'active' ? 'Выполняется' : state === 'failed' ? 'Ошибка' : 'Ожидание'}</span>
        </li>;
      })}
    </ol>}
    {!failed && !unavailable && <footer className="sa-analytics-progress-foot">
      <span className="sa-analytics-progress-dot" aria-hidden="true" />
      {connectionLost ? 'Не удалось обновить статус. Повторим проверку соединения автоматически.' : 'Можно оставить страницу открытой — готовый отчёт появится автоматически. Обработка может занять несколько минут.'}
    </footer>}
  </section>;
}
