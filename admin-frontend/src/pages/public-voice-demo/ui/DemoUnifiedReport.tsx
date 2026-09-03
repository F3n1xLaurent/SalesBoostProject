import React from 'react';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';

type UnifiedReport = NonNullable<AuditDetailItem['unifiedReport']>;

const verdictClass: Record<UnifiedReport['verdict'], string> = {
  Хорошо: 'good',
  Средне: 'medium',
  Плохо: 'bad',
};

const markLabel = {
  positive: 'Сильная реплика',
  normal: 'Можно усилить',
  negative: 'Ошибка',
} as const;

export function DemoUnifiedReport({ report }: { report: UnifiedReport }) {
  const tone = verdictClass[report.verdict];

  return (
    <article className="demo-unified-report">
      <header className="demo-unified-report__hero">
        <div className={`demo-unified-report__score demo-unified-report__score--${tone}`}>
          <strong>{report.totalScore}</strong>
          <span>из 100</span>
        </div>
        <div>
          <div className={`demo-unified-report__verdict demo-unified-report__verdict--${tone}`}>
            {report.verdict}
          </div>
          <h2>Разбор звонка</h2>
          <p>{report.summary}</p>
        </div>
      </header>

      <section className="demo-unified-report__section">
        <h3>Пять ключевых навыков</h3>
        <div className="demo-unified-report__categories">
          {report.categories.map((category) => (
            <div className="demo-unified-report__category" key={category.name}>
              <div className="demo-unified-report__category-head">
                <strong>{category.name}</strong>
                <span>{category.score}/100</span>
              </div>
              <div className="demo-unified-report__bar" aria-hidden>
                <i style={{ width: `${category.score}%` }} />
              </div>
              <p>{category.comment}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="demo-unified-report__columns">
        <section className="demo-unified-report__section demo-unified-report__section--good">
          <h3>Что получилось</h3>
          {report.strengths.length ? (
            <ul>{report.strengths.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          ) : <p className="demo-unified-report__empty">Сильные стороны не выделены.</p>}
        </section>
        <section className="demo-unified-report__section demo-unified-report__section--bad">
          <h3>Что мешает продаже</h3>
          {report.weaknesses.length ? (
            <ul>{report.weaknesses.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          ) : <p className="demo-unified-report__empty">Критичные слабые стороны не найдены.</p>}
        </section>
      </div>

      {report.keyFindings.length > 0 && (
        <section className="demo-unified-report__section">
          <h3>Главные находки</h3>
          <div className="demo-unified-report__findings">
            {report.keyFindings.map((finding, index) => (
              <details key={`${finding.problemTitle}-${index}`} open={index === 0}>
                <summary>
                  <span>{finding.problemTitle}</span>
                  <small>{finding.importance} · {finding.category}</small>
                </summary>
                <div className="demo-unified-report__finding-body">
                  {finding.quote && <blockquote>«{finding.quote}»</blockquote>}
                  <p>{finding.comment}</p>
                  {finding.betterExample && (
                    <div className="demo-unified-report__better"><strong>Как лучше:</strong> {finding.betterExample}</div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="demo-unified-report__section">
        <h3>Диалог с комментариями</h3>
        <div className="demo-unified-report__dialog">
          {report.dialog.map((line, index) => (
            <div className={`demo-unified-report__line demo-unified-report__line--${line.role}`} key={index}>
              <div className="demo-unified-report__speaker">{line.role === 'manager' ? 'Менеджер' : 'Клиент'}</div>
              <p>{line.text}</p>
              {line.role === 'manager' && line.mark && (
                <div className={`demo-unified-report__mark demo-unified-report__mark--${line.mark}`}>
                  <strong>{markLabel[line.mark]}</strong>{line.comment ? ` — ${line.comment}` : ''}
                </div>
              )}
              {line.betterExample && <div className="demo-unified-report__better"><strong>Лучше сказать:</strong> {line.betterExample}</div>}
            </div>
          ))}
        </div>
      </section>

      {report.recommendations.length > 0 && (
        <section className="demo-unified-report__section demo-unified-report__section--recommendations">
          <h3>Что делать дальше</h3>
          <ol>
            {report.recommendations.map((item, index) => (
              <li key={`${index}-${item.text}`}><span>{item.text}</span><small>{item.category}</small></li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
