import React from 'react';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';

type UnifiedReport = NonNullable<AuditDetailItem['unifiedReport']>;

const STATUS_LABELS: Record<AuditDetailItem['status'], string> = {
  completed: 'Завершён',
  failed: 'Провал',
  interrupted: 'Прерван',
};

const STATUS_CLASS: Record<AuditDetailItem['status'], string> = {
  completed: 'sa-audit-status-completed',
  failed: 'sa-audit-status-failed',
  interrupted: 'sa-audit-status-interrupted',
};

const IMPORTANCE_CLASS: Record<UnifiedReport['keyFindings'][number]['importance'], string> = {
  Критично: 'critical',
  Важно: 'important',
  Средне: 'medium',
};

const MARK_LABELS: Record<NonNullable<UnifiedReport['dialog'][number]['mark']>, string> = {
  positive: 'Положительно',
  normal: 'Можно лучше',
  negative: 'Плохо',
};

const MARK_CLASS: Record<NonNullable<UnifiedReport['dialog'][number]['mark']>, string> = {
  positive: 'good',
  normal: 'normal',
  negative: 'bad',
};

function formatDuration(seconds: number) {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function scoreTone(score: number) {
  if (score >= 76) return 'good';
  if (score >= 50) return 'mid';
  return 'bad';
}

export function AuditAnalyticsReport({
  detail,
  onOpenEmployee,
}: {
  detail: AuditDetailItem;
  onOpenEmployee?: (id: string) => void;
}) {
  const report = detail.unifiedReport;
  const date = new Date(detail.dateTime);
  const dateStr = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="sa-call-report">
      <div className="sa-call-report-header">
        <div>
          <div className="sa-call-report-eyebrow">{detail.type === 'trainer' ? 'Отчёт по тренировке' : 'Отчёт по звонку'}</div>
          <h1 className="sa-page-title sa-call-report-title">{detail.employeeName}</h1>
          <div className="sa-call-report-meta">
            {detail.type === 'call' ? (
              <>
                <span>{detail.dealershipName}</span>
                <span>{detail.city}</span>
                <span>{dateStr}, {timeStr}</span>
                <span>Длительность: {formatDuration(detail.duration)}</span>
              </>
            ) : (
              <>
                <span>{detail.dealershipName}</span>
                <span>Сценарий: {detail.scenarioName || '—'}</span>
                <span>{dateStr}, {timeStr}</span>
              </>
            )}
          </div>
        </div>
        <div className="sa-call-report-header-actions">
          <span className={`sa-status-badge ${STATUS_CLASS[detail.status]}`}>{STATUS_LABELS[detail.status]}</span>
          {detail.employeeId && (
            <button className="sa-btn-text" onClick={() => onOpenEmployee?.(detail.employeeId)}>
              Профиль сотрудника →
            </button>
          )}
        </div>
      </div>

      {!report ? (
        <section className="sa-card sa-call-report-section">
          <h2>Единый отчёт ещё не сформирован</h2>
          <p className="sa-meta" style={{ margin: 0 }}>
            Для полного отчёта нужны transcript и AI-оценка звонка. Если данные уже есть, откройте страницу позже: backend догенерирует отчёт и сохранит его.
          </p>
        </section>
      ) : (
        <>
          <section className="sa-card sa-call-report-score">
            <div className={`sa-call-report-score-main sa-call-report-score-main--${scoreTone(report.totalScore)}`}>
              <div className="sa-call-report-score-value">{report.totalScore}</div>
              <div className="sa-call-report-score-label">Общий балл / 100</div>
            </div>
            <div className="sa-call-report-score-body">
              <div className="sa-call-report-verdict">{report.verdict}</div>
              <p>{report.summary}</p>
              {detail.failReason && <div className="sa-audit-fail-reason">{detail.failReason}</div>}
            </div>
          </section>

          <section className="sa-card sa-call-report-section">
            <div className="sa-call-report-section-head">
              <h2>Категории</h2>
              <span>Единая шкала 0–100</span>
            </div>
            <div className="sa-call-report-category-grid">
              {report.categories.map((item) => (
                <div key={item.name} className="sa-call-report-category">
                  <div className="sa-call-report-category-top">
                    <strong>{item.name}</strong>
                    <span className={ratingClass(item.score)}>{item.score}</span>
                  </div>
                  <div className="sa-call-report-category-bar"><i className={ratingClass(item.score)} style={{ width: `${item.score}%` }} /></div>
                  <p>{item.comment}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="sa-call-report-two-col">
            <div className="sa-card sa-call-report-section">
              <h2>Сильные стороны</h2>
              {report.strengths.length ? (
                <ul className="sa-call-report-list">{report.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : (
                <div className="sa-chart-empty">Сильные стороны не выделены</div>
              )}
            </div>
            <div className="sa-card sa-call-report-section">
              <h2>Слабые стороны</h2>
              {report.weaknesses.length ? (
                <ul className="sa-call-report-list">{report.weaknesses.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : (
                <div className="sa-chart-empty">Слабые стороны не выделены</div>
              )}
            </div>
          </section>

          <section className="sa-card sa-call-report-section">
            <div className="sa-call-report-section-head">
              <h2>Ключевые находки</h2>
              <span>Названия из фиксированного справочника проблем</span>
            </div>
            {report.keyFindings.length ? (
              <div className="sa-call-report-findings">
                {report.keyFindings.map((finding) => (
                  <article key={`${finding.problemTitle}-${finding.category}`} className="sa-call-report-finding">
                    <div className="sa-call-report-finding-head">
                      <div>
                        <h3>{finding.problemTitle}</h3>
                        <span>{finding.category}</span>
                      </div>
                      <b className={`sa-call-report-priority sa-call-report-priority--${IMPORTANCE_CLASS[finding.importance]}`}>{finding.importance}</b>
                    </div>
                    <blockquote>{finding.quote}</blockquote>
                    <p>{finding.comment}</p>
                    <div className="sa-call-report-better">
                      <strong>Пример правильного ответа</strong>
                      <span>{finding.betterExample}</span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="sa-chart-empty">Значимые проблемы не выделены</div>
            )}
          </section>

          <section className="sa-card sa-call-report-section">
            <h2>Диалог с построчной разметкой</h2>
            <div className="sa-call-report-dialog">
              {report.dialog.length ? report.dialog.map((line, index) => (
                <div key={`${index}-${line.role}`} className={`sa-call-report-turn sa-call-report-turn--${line.role}`}>
                  <div className="sa-call-report-turn-meta">
                    <strong>{line.role === 'client' ? 'Клиент' : 'Менеджер'}</strong>
                    {line.mark && <b className={`sa-call-report-mark sa-call-report-mark--${MARK_CLASS[line.mark]}`}>{MARK_LABELS[line.mark]}</b>}
                  </div>
                  <div className="sa-call-report-turn-text">{line.text}</div>
                  {line.comment && <div className="sa-call-report-turn-comment">{line.comment}</div>}
                </div>
              )) : <div className="sa-chart-empty">Диалог недоступен</div>}
            </div>
          </section>

          <section className="sa-card sa-call-report-section">
            <h2>Рекомендации / план действий</h2>
            {report.recommendations.length ? (
              <ol className="sa-call-report-actions">
                {report.recommendations.map((item) => (
                  <li key={`${item.category}-${item.text}`}>
                    {item.text}
                    <span className="sa-call-report-action-meta"> {item.category}{item.problemTitle ? ` · ${item.problemTitle}` : ''}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="sa-chart-empty">Рекомендации не сформированы</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
