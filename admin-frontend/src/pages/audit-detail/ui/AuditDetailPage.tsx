import React, { useEffect, useState } from 'react';
import { fetchAuditDetail, type AuditDetailItem } from '../../../shared/api/adminPanel';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';

type Props = {
  auditId: string;
  onBack: () => void;
  onNavigate?: (id: string) => void;
  onOpenEmployee?: (id: string) => void;
};

export function AuditDetail({ auditId, onBack, onOpenEmployee }: Props) {
  const [detail, setDetail] = useState<AuditDetailItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAuditDetail(auditId)
      .then((item) => {
        if (!cancelled) setDetail(item);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setDetail(null);
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить проверку.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auditId]);

  if (loading) {
    return (
      <div className="sa-detail-root">
        <button className="sa-btn-text" onClick={onBack}>← Проверки</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загрузка проверки...</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="sa-detail-root">
        <button className="sa-btn-text" onClick={onBack}>← Проверки</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>{error || 'Проверка не найдена'}</div>
      </div>
    );
  }

  return (
    <div className="sa-detail-root">
      <div className="sa-breadcrumb">
        <button className="sa-btn-text" onClick={onBack}>Проверки</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>Разбор #{detail.id.replace('call-', '')}</span>
      </div>

      <AuditAnalyticsReport detail={detail} onOpenEmployee={onOpenEmployee} />

      <div className="sa-audit-nav">
        <span />
        <button className="sa-btn-outline" onClick={onBack}>К списку проверок</button>
      </div>
    </div>
  );
}
