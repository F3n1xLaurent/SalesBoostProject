import React, { useMemo } from 'react';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import type { AuditItem } from '../../../shared/api/adminPanel';

const statusLabel: Record<string, string> = {
  Good: 'Хорошо',
  Medium: 'Средне',
  Bad: 'Плохо',
};

type TrainerProps = {
  audits: AuditItem[];
  summary: PlatformSummary | null;
  loading?: boolean;
};

export function Trainer({ audits, summary, loading = false }: TrainerProps) {
  const trainingAudits = useMemo(() => audits.filter((a) => a.type === 'training'), [audits]);
  const sessionsCompleted = trainingAudits.length;
  const avgScore = useMemo(() => {
    if (trainingAudits.length === 0) return 0;
    const sum = trainingAudits.reduce((s, a) => s + a.aiScore, 0);
    return Math.round((sum / trainingAudits.length) * 10) / 10;
  }, [trainingAudits]);
  const topWeakAreas = summary?.topWeaknesses?.slice(0, 5) ?? [];

  return (
    <>
      <h1 className="sa-page-title">Тренажёр</h1>
      <AISummaryBlock body="Обзор эффективности тренировок. Завершённые сессии, средний балл, прогресс." />

      <section style={{ marginBottom: 40 }}>
        <h2 className="sa-section-title">Обзор</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 24 }}>
          <div className="sa-card">
            <div className="sa-meta">Завершённых сессий</div>
            <div className="sa-kpi-value">{loading ? '—' : sessionsCompleted}</div>
          </div>
          <div className="sa-card">
            <div className="sa-meta">Средний балл</div>
            <div className="sa-kpi-value">{loading ? '—' : avgScore.toFixed(1)}</div>
          </div>
          <div className="sa-card">
            <div className="sa-meta">Прогресс (до → после)</div>
            <div className="sa-kpi-value" style={{ fontSize: 28 }}>—</div>
            <div className="sa-meta">Требуется отслеживание</div>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2 className="sa-section-title">Последние тренировки</h2>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Дата</th>
                <th>Балл</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 24 }}>Загрузка…</td></tr>
              ) : trainingAudits.length === 0 ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 24 }}>Нет тренировочных сессий</td></tr>
              ) : (
                trainingAudits.slice(0, 10).map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{a.userName ?? '—'}</td>
                    <td>{new Date(a.date).toLocaleDateString('ru-RU')}</td>
                    <td>{a.aiScore}</td>
                    <td>{statusLabel[a.status] ?? a.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2 className="sa-section-title">Частые слабые зоны</h2>
        <div className="sa-card">
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {(topWeakAreas.length > 0 ? topWeakAreas : [{ weakness: 'Нет данных', count: 0 }]).map((w, i) => (
              <li
                key={i}
                style={{
                  padding: '14px 0',
                  borderBottom: i < topWeakAreas.length - 1 ? '1px solid var(--sa-divider)' : 'none',
                  fontSize: 14,
                  color: 'var(--sa-text)',
                }}
              >
                {i + 1}. {w.weakness} {w.count > 0 ? `(${w.count})` : ''}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
