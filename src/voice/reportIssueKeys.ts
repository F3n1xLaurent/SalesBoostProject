/** Stable links between scored criteria and report problems. Titles are display text. */
export const CHECKLIST_REPORT_PROBLEM: Record<string, string> = {
  INTRODUCTION: 'NO_INTRO_COMPANY', SALON_NAME: 'NO_INTRO_COMPANY',
  CAR_IDENTIFICATION: 'NO_REQUEST_CLARIFICATION', NEEDS_DISCOVERY: 'NO_NEEDS_DISCOVERY',
  INITIATIVE: 'PASSIVE_STYLE', PRODUCT_PRESENTATION: 'WEAK_BENEFIT_PRESENTATION',
  CREDIT_EXPLANATION: 'CREDIT_EXPLANATION', TRADEIN_OFFER: 'TRADEIN_OFFER',
  OBJECTION_HANDLING: 'WEAK_OBJECTION_HANDLING', NEXT_STEP_PROPOSAL: 'NO_NEXT_STEP',
  DATE_FIXATION: 'NO_CONCRETE_NEXT_STEP', FOLLOW_UP_AGREEMENT: 'NO_FOLLOW_UP',
  COMMUNICATION_TONE: 'BAD_TONE',
};

export type ReportWeaknessEntry = { key: string; text: string; relatedKeys?: string[] };
export function mergeReportWeaknessEntries(primary: ReportWeaknessEntry[], secondary: ReportWeaknessEntry[], limit = 8): string[] {
  const result: ReportWeaknessEntry[] = [];
  for (const entry of primary) {
    const existing = result.find((item) => item.key === entry.key);
    if (!existing) result.push({ ...entry });
    else {
      const detail = entry.text.includes(':') ? entry.text.slice(entry.text.indexOf(':') + 1).trim() : entry.text;
      if (!existing.text.includes(detail)) existing.text += ` ${detail}`;
    }
  }
  for (const entry of secondary) if (!result.some((item) => item.key === entry.key || item.relatedKeys?.includes(entry.key))) result.push({ ...entry });
  return result.slice(0, limit).map((item) => item.text);
}
