import type { AuditDetailItem } from '../../../shared/api/adminPanel';

type UnifiedReport = NonNullable<AuditDetailItem['unifiedReport']>;
export type DialogLine = UnifiedReport['dialog'][number] & { betterExample?: string | null };

export function enrichDialogExamples(dialog: UnifiedReport['dialog'], findings: UnifiedReport['keyFindings']): DialogLine[] {
  return dialog.map((line) => {
    const existing = (line as DialogLine).betterExample?.trim() || null;
    if (line.role !== 'manager' || (line.mark !== 'negative' && line.mark !== 'normal')) return { ...line, betterExample: null };
    if (existing) return { ...line, betterExample: existing };
    const text = line.text.trim().toLowerCase();
    const matched = findings.find((finding) => {
      const quote = finding.quote.trim().toLowerCase();
      return quote && text && (text.includes(quote) || quote.includes(text));
    });
    return { ...line, betterExample: matched?.betterExample?.trim() || null };
  });
}
