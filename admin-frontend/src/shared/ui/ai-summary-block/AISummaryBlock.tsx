import React from 'react';
import type { AnalyticsAISummary } from '../../api/adminPanel';

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
  badgePrimary,
  badgeSecondary,
}: Props) {
  const hasBadges = badgePrimaryLabel || badgePrimary || badgeSecondaryLabel || badgeSecondary;
  const text = summary?.summary || body || '';
  const recommendations = summary?.recommendations ?? [];

  return (
    <div className="sa-card sa-ai-summary-card">
      <div className="sa-ai-summary-inner">
        <div className="sa-ai-summary-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </div>
        <div className="sa-ai-summary-content">
          <h3 className="sa-ai-summary-title">{title}</h3>
          {loading ? (
            <div className="sa-ai-summary-loading">
              <span className="sa-ai-summary-spinner" />
              <span>Формируем сводку...</span>
            </div>
          ) : error ? (
            <p className="sa-ai-summary-text sa-ai-summary-error">{error}</p>
          ) : (
            <>
              <p className="sa-ai-summary-text">{text || 'Нет данных для AI-сводки.'}</p>
              {recommendations.length > 0 && (
                <ol className="sa-ai-summary-recommendations">
                  {recommendations.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ol>
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
        </div>
      </div>
    </div>
  );
}
