import React from 'react';
import type { AnalyticsAISummary } from '../../api/adminPanel';
import { LetsIcon } from '../icons/LetsIcon';

type Props = {
  title?: string;
  body?: string;
  summary?: AnalyticsAISummary | null;
  loading?: boolean;
  error?: string | null;
  badgePrimaryLabel?: string;
  badgePrimaryValue?: string;
  badgeSecondaryLabel?: string;
  badgeSecondaryValue?: string;
  variant?: 'default' | 'brutal' | 'outlined';
  /** Legacy compat */
  badgePrimary?: string;
  badgeSecondary?: string;
};

export function AISummaryBlock({
  title = 'AI Резюме',
  body,
  summary,
  loading = false,
  error = null,
  badgePrimaryLabel,
  badgePrimaryValue,
  badgeSecondaryLabel,
  badgeSecondaryValue,
  variant = 'default',
  badgePrimary,
  badgeSecondary,
}: Props) {
  const hasBadges = badgePrimaryLabel || badgePrimary || badgeSecondaryLabel || badgeSecondary;
  const text = summary?.summary || body || '';
  const recommendations = summary?.recommendations ?? [];

  const content = (
    <>
      {loading ? (
        <div className="sa-ai-summary-loading">
          <span className="sa-ai-summary-spinner" />
          <span>Формируем сводку...</span>
        </div>
      ) : error ? (
        <p className="sa-ai-summary-text sa-ai-summary-error">{error}</p>
      ) : (
        <>
          {variant === 'outlined' ? (
            <div className="sa-ai-summary-section">
              <div className="sa-ai-summary-section-label">Вывод</div>
              <p className="sa-ai-summary-text">{text || 'Нет данных для AI-сводки.'}</p>
            </div>
          ) : (
            <p className="sa-ai-summary-text">{text || 'Нет данных для AI-сводки.'}</p>
          )}
          {recommendations.length > 0 && (
            variant === 'outlined' ? (
              <div className="sa-ai-summary-section">
                <div className="sa-ai-summary-section-label">Рекомендации</div>
                <ol className="sa-ai-summary-recommendations sa-ai-summary-recommendations--cards">
                  {recommendations.map((item, index) => (
                    <li key={`${index}-${item}`}>
                      <span className="sa-ai-summary-rec-index" aria-hidden="true">{index + 1}</span>
                      <span className="sa-ai-summary-rec-text">{item}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <ol className="sa-ai-summary-recommendations">
                {recommendations.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ol>
            )
          )}
        </>
      )}
      {hasBadges && (
        <div className="sa-ai-summary-badges">
          {(badgePrimaryLabel && badgePrimaryValue) ? (
            <div className="sa-ai-badge sa-ai-badge-primary">
              <span className="sa-ai-badge-label">{badgePrimaryLabel}:</span>
              <span className="sa-ai-badge-value">{badgePrimaryValue}</span>
            </div>
          ) : badgePrimary ? (
            <span className="sa-ai-badge sa-ai-badge-primary">{badgePrimary}</span>
          ) : null}
          {(badgeSecondaryLabel && badgeSecondaryValue) ? (
            <div className="sa-ai-badge sa-ai-badge-secondary">
              <span className="sa-ai-badge-label">{badgeSecondaryLabel}:</span>
              <span className="sa-ai-badge-value">{badgeSecondaryValue}</span>
            </div>
          ) : badgeSecondary ? (
            <span className="sa-ai-badge sa-ai-badge-secondary">{badgeSecondary}</span>
          ) : null}
        </div>
      )}
    </>
  );

  if (variant === 'brutal') {
    return (
      <div className="sa-card sa-ai-summary-card sa-brutal-card">
        <div className="sa-brutal-card-header sa-brutal-card-header--with-icon">
          <div className="sa-ai-summary-icon">
            <LetsIcon name="star" size={20} />
          </div>
          <h2 className="sa-section-title">{title}</h2>
        </div>
        <div className="sa-brutal-card-body sa-ai-summary-content">{content}</div>
      </div>
    );
  }

  if (variant === 'outlined') {
    return (
      <div className="sa-ai-summary-card sa-ai-summary-card--outlined">
        <div className="sa-ai-summary-header">
          <h3 className="sa-ai-summary-title">{title}</h3>
        </div>
        <div className="sa-ai-summary-content">{content}</div>
      </div>
    );
  }

  return (
    <div className="sa-card sa-ai-summary-card">
      <div className="sa-ai-summary-inner">
        <div className="sa-ai-summary-icon">
          <LetsIcon name="star" size={20} />
        </div>
        <div className="sa-ai-summary-content">
          <h3 className="sa-ai-summary-title">{title}</h3>
          {content}
        </div>
      </div>
    </div>
  );
}
