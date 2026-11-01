import type { ReportTestRun } from './reportAutoTesting';
import { REPORT_TEST_CHECKS } from './reportTestCatalog';

export function reportRunTiming(run: Pick<ReportTestRun, 'cases'>) {
  const values = run.cases.map((item) => item.output?.timings.totalMs).filter((value): value is number => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  return { samples: values.length, medianMs: values.length ? Math.round((values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2) : null, p95Ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
}
export function compareReportRuns(before: ReportTestRun, after: ReportTestRun) {
  const warnings = before.configurationHash !== after.configurationHash || before.evaluatorVersion !== after.evaluatorVersion ? ['Различаются модель, режимы reasoning, справочник проблем, версия эталонов или оценщика. Сравнение не доказывает исправление при разных условиях.'] : [];
  return { beforeId: before.id, afterId: after.id, warnings, rows: REPORT_TEST_CHECKS.map(([id, title]) => {
    const a = before.checklist.find((item) => item.id === id) ?? null, b = after.checklist.find((item) => item.id === id) ?? null;
    const coverage = (run: ReportTestRun) => run.cases.filter((item) => item.checks.some((point) => point.id === id)).map((item) => item.id).sort();
    const coverageBefore = coverage(before), coverageAfter = coverage(after);
    const comparable = !warnings.length && coverageBefore.length > 0 && JSON.stringify(coverageBefore) === JSON.stringify(coverageAfter);
    const change = !b || b.status === 'not_run' ? 'not_rerun' : !a || a.status === 'not_run' ? 'new' : a.status === b.status ? 'unchanged' : comparable && a.status === 'fail' && b.status === 'pass' ? 'fixed' : comparable && a.status === 'pass' && b.status === 'fail' ? 'regressed' : 'changed';
    const timingBefore = reportRunTiming({ cases: before.cases.filter((item) => coverageBefore.includes(item.id)) }), timingAfter = reportRunTiming({ cases: after.cases.filter((item) => coverageAfter.includes(item.id)) });
    return { id, title, before: a, after: b, change, comparable, coverageBefore, coverageAfter, timingBefore, timingAfter, medianDeltaMs: comparable && timingBefore.medianMs != null && timingAfter.medianMs != null ? timingAfter.medianMs - timingBefore.medianMs : null };
  }) };
}
