import React, { useRef } from 'react';
import type { CallInsightDetail } from '../../../shared/model/call-insight/types';
import { exportReportPdf } from '../../../shared/lib/demo-report/exportPdf';
import { ReportHeader } from '../../../shared/ui/demo-report/ReportHeader';
import { ReportSections } from '../../../shared/ui/demo-report/ReportSections';
import { CallError } from '../../call-error/ui/CallError';

export function CallInsightCard(props: { detail: CallInsightDetail }) {
  const { detail } = props;
  const reportExportRef = useRef<HTMLDivElement | null>(null);

  async function handleExportReportPdf() {
    const root = reportExportRef.current;
    if (!root) return;
    try {
      await exportReportPdf(root);
    } catch (e) {
      console.error('PDF export failed', e);
    }
  }

  return (
    <div ref={reportExportRef} className="demo-report-export-root space-y-4">
      <ReportHeader detail={detail} onExportPdf={() => void handleExportReportPdf()} />

      <CallError message={detail.processingError} className="rounded-xl admin-card-inner px-3 py-2 text-xs text-danger" />

      <ReportSections detail={detail} />
    </div>
  );
}
