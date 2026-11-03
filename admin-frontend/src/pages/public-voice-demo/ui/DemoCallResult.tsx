import React from 'react';
import type { CallInsightDetail } from '../../../shared/model/call-insight/types';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { CallInsightCard } from '../../../widgets/call-insight-card';
import { FlowButton } from '../../landing/ui/FlowButton';
import { getUnavailableCall } from '../model/unavailableCall';
import { DemoCallUnavailable } from './DemoCallUnavailable';

export function DemoCallResult({ detail, auditDetail, phone, loading, onRetry, onReset }: {
  detail: CallInsightDetail & { isProcessing: boolean };
  auditDetail: AuditDetailItem | null;
  phone: string;
  loading: boolean;
  onRetry: () => void;
  onReset: () => void;
}) {
  const unavailable = getUnavailableCall(detail);
  if (unavailable) {
    return <DemoCallUnavailable kind={unavailable} phone={phone} loading={loading} onRetry={onRetry} onReset={onReset} />;
  }
  return (
    <div className="demo-stand-stack">
      <div className="demo-stand-report">
        {auditDetail ? <AuditAnalyticsReport detail={auditDetail} /> : (
          <div className="demo-brutal-insight-wrap"><CallInsightCard detail={detail} /></div>
        )}
      </div>
      <FlowButton text="Запустить новый звонок" type="button" variant="solid" onClick={onReset} className="demo-stand-action" />
    </div>
  );
}
