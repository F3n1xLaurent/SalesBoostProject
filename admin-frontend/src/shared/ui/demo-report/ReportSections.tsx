import React, { useMemo } from 'react';
import type { CallInsightDetail } from '../../model/call-insight/types';
import { buildConversationPairs, inferFindingBlock, inferFindingImportance, priorityTone } from '../../lib/demo-report/utils';

function buildImprovementsByOrder(detail: CallInsightDetail) {
  const m = new Map<number, (CallInsightDetail['replyImprovements'] extends Array<infer T> ? T : never)>();
  (detail.replyImprovements || []).forEach((it) => {
    m.set(it.order, it);
  });
  return m;
}

function buildGetIndicator10(detail: CallInsightDetail) {
  const src = detail.dimensionScores || {};
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const to10 = (v: number | null) => (v == null ? null : v <= 1 ? v * 10 : v);
  return {
    contact: () => to10(pick(['контакт', 'rapport', 'contact'])),
    diagnosis: () => to10(pick(['диагностика', 'discovery', 'needs_discovery'])),
    presentation: () => to10(pick(['презентация', 'presentation', 'product_presentation'])),
    objections: () => to10(pick(['возражения', 'objection_handling', 'objections'])),
    next: () => to10(pick(['следующий_шаг', 'closing', 'next_step'])),
  };
}

export function ReportSections(props: { detail: CallInsightDetail }) {
  const { detail } = props;
  const summary = detail.callSummary || null;

  const improvementsByOrder = useMemo(() => buildImprovementsByOrder(detail), [detail.replyImprovements]);
  const conversationPairs = useMemo(() => buildConversationPairs(detail), [detail.transcript]);
  const getIndicator10 = useMemo(() => buildGetIndicator10(detail), [detail.dimensionScores]);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {(summary?.detailedAnalysis?.trim() || (summary?.keyFindings && summary.keyFindings.length > 0) || (summary?.actionPlan && summary.actionPlan.length > 0)) && (
          <details className="demo-section rounded-xl admin-card-inner px-3 py-3">
            <summary className="demo-section__summary">
              <span>Сводка и разбор</span>
              <span className="demo-section__plus" aria-hidden>+</span>
            </summary>
            <div className="demo-section__body space-y-3">
              {summary?.detailedAnalysis?.trim() && (
                <div className="demo-body-text whitespace-pre-line">
                  {summary.detailedAnalysis}
                </div>
              )}

              {(detail.strengths?.length || detail.weaknesses?.length) && (
                <div className="space-y-6" style={{ marginTop: '1.25rem' }}>
                  <div>
                    <div className="demo-result-head">
                      <span className="demo-result-icon demo-result-icon--good" aria-hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24">
                          <path
                            fill="currentColor"
                            d="M2 21h4V9H2v12Zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13 1 6.59 7.41C6.22 7.78 6 8.3 6 8.83V19c0 1.1.9 2 2 2h9c.82 0 1.54-.5 1.84-1.22l3-7.05c.1-.23.16-.47.16-.73V10Z"
                          />
                        </svg>
                      </span>
                      <div className="demo-subhead" style={{ marginTop: 0 }}>
                        Сильные стороны
                      </div>
                    </div>
                    {detail.strengths?.length ? (
                      <ul className="text-xs text-default-600 list-disc pl-4 space-y-1">
                        {detail.strengths.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="demo-body-text">Нет выделенных сильных сторон.</p>
                    )}
                  </div>

                  <div>
                    <div className="demo-result-head">
                      <span className="demo-result-icon demo-result-icon--bad" aria-hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24">
                          <path
                            fill="currentColor"
                            d="M22 3h-4v12h4V3ZM2 14c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L11 23l6.41-6.41c.37-.37.59-.89.59-1.42V5c0-1.1-.9-2-2-2H7c-.82 0-1.54.5-1.84 1.22l-3 7.05c-.1.23-.16.47-.16.73V14Z"
                          />
                        </svg>
                      </span>
                      <div className="demo-subhead" style={{ marginTop: 0 }}>
                        Зоны роста
                      </div>
                    </div>
                    {detail.weaknesses?.length ? (
                      <ul className="text-xs text-default-600 list-disc pl-4 space-y-1">
                        {detail.weaknesses.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="demo-body-text">Зоны роста не выделены.</p>
                    )}
                  </div>
                </div>
              )}

              {summary?.keyFindings?.length ? (
                <div className="space-y-2">
                  {summary?.detailedAnalysis?.trim() && <div className="demo-divider demo-divider--lg" />}
                  <div className="demo-subhead">Ключевые находки</div>
                  <div className="demo-subcard">
                    <div className="demo-flat-list">
                      {summary.keyFindings.slice(0, 6).map((f, idx) => (
                        <div key={idx} className="demo-flat-item">
                          {(() => {
                            const combined = `${f.title || ''}\n${f.description || ''}`;
                            const block = inferFindingBlock(combined);
                            const importance = inferFindingImportance(getIndicator10, block.key, combined);
                            return (
                              <>
                                <div className="demo-flat-item__row demo-flat-item__row--finding">
                                  <div className="demo-flat-item__title">{f.title || 'Находка'}</div>
                                  <div className={`demo-priority demo-priority--${importance.tone}`}>
                                    {importance.label}
                                  </div>
                                </div>
                              </>
                            );
                          })()}
                          <div className="demo-flat-item__text">{f.description || ''}</div>
                          {(() => {
                            const combined = `${f.title || ''}\n${f.description || ''}`;
                            const block = inferFindingBlock(combined);
                            return (
                              <div className="demo-flat-item__meta" style={{ marginTop: '0.25rem' }}>
                                Блок: {block.label}
                              </div>
                            );
                          })()}
                          {Array.isArray(f.examples) && f.examples.length > 0 && (
                            <ul className="demo-flat-item__examples">
                              {f.examples.slice(0, 2).map((ex, i) => (
                                <li key={i}>{ex}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {summary?.actionPlan?.length ? (
                <div className="space-y-2">
                  {(summary?.detailedAnalysis?.trim() || summary?.keyFindings?.length) && <div className="demo-divider demo-divider--lg" />}
                  <div className="demo-subhead">План действий</div>
                  <div className="demo-body-text">
                    Цель плана — закрыть ключевые провалы из разговора и повысить конверсию: сначала диагностика и
                    фиксация следующего шага, затем — отработка возражений и презентация.
                  </div>
                  <div className="demo-flat-list demo-flat-list--cards">
                    {summary.actionPlan.slice(0, 6).map((a, idx) => (
                      <div key={idx} className="demo-flat-item demo-flat-item--card">
                        <div className="demo-plan-row">
                          <div className="demo-plan-left">
                            <div className="demo-flat-item__title">{a.action || 'Действие'}</div>
                            <div className="demo-flat-item__meta">Блок: {a.target || '—'}</div>
                          </div>
                          <div className={`demo-priority demo-priority--${priorityTone(a.priority)}`}>
                            {a.priority || '—'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        )}

        <details className="demo-section rounded-xl admin-card-inner px-3 py-3">
          <summary className="demo-section__summary">
            <span>Диалог</span>
            <span className="demo-section__plus" aria-hidden>+</span>
          </summary>
          <div className="demo-section__body space-y-2">
            {conversationPairs.length ? (
              conversationPairs.map((p) => {
                const improvement = improvementsByOrder.get(p.order);
                const isOptimal = improvement ? Boolean(improvement.isOptimal) : true;
                const tone = isOptimal ? 'good' : 'bad';
                return (
                  <div key={p.order} className="demo-dialog-pair">
                    <div className="demo-dialog-line demo-dialog-line--client">
                      <div className="demo-dialog-role">Клиент</div>
                      <div className="demo-dialog-text">{p.customerMessage}</div>
                    </div>

                    <div className="demo-dialog-line demo-dialog-line--manager">
                      <div className="demo-dialog-role">Менеджер</div>
                      <div className="demo-dialog-text">{p.managerAnswer}</div>
                      <div className={`demo-dialog-sticker demo-dialog-sticker--${tone}`}>
                        {isOptimal ? 'OK' : 'Улучшить'}
                      </div>
                    </div>

                    {!isOptimal && improvement && (
                      <div className="demo-dialog-coach">
                        {improvement.feedback?.trim() && (
                          <div className="demo-dialog-coach-row demo-dialog-coach-row--weak">
                            <div className="demo-dialog-coach-k">Что было слабо</div>
                            <div className="demo-dialog-coach-v">{improvement.feedback}</div>
                          </div>
                        )}
                        {improvement.betterExample?.trim() && (
                          <div className="demo-dialog-coach-row demo-dialog-coach-row--strong">
                            <div className="demo-dialog-coach-k">Пример сильного ответа</div>
                            <div className="demo-dialog-coach-v">{improvement.betterExample}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            ) : detail.transcript?.length ? (
              detail.transcript.slice(0, 200).map((t, idx) => (
                <div
                  key={idx}
                  className={`demo-dialog-line ${t.role === 'manager' ? 'demo-dialog-line--manager' : 'demo-dialog-line--client'}`}
                >
                  <div className="demo-dialog-role">{t.role === 'manager' ? 'Менеджер' : 'Клиент'}</div>
                  <div className="demo-dialog-text">{t.text}</div>
                </div>
              ))
            ) : (
              <div className="text-xs text-default-500">Диалог недоступен.</div>
            )}
          </div>
        </details>
      </div>

      <div className="space-y-3">
        {/* (moved into "Сводка и разбор") */}
      </div>
    </div>
  );
}
