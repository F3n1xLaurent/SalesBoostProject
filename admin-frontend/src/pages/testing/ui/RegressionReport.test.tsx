import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RealtimeRegressionCheck, RealtimeRegressionComparison, RealtimeRegressionRun } from '../../../shared/api/adminPanel';
import { REGRESSION_CHECKLIST } from '../../../../../src/voice/realtimeRegressionScenarios';
import { TRAINER_TEST_CHECKS } from '../../../../../src/testing/trainerTestCatalog';
import { countChecks, groupChecks, matchesCheckFilter, timingLabel } from '../model/regressionReport';
import { CheckRows, ComparisonResults, RegressionReport, ScenarioResults } from './RegressionReport';

const { fetchAudio } = vi.hoisted(() => ({ fetchAudio: vi.fn() }));
vi.mock('../../../shared/api/autoTesting', () => ({ fetchCallPlanAutoTestAudio: fetchAudio }));

function check(id: string, status: RealtimeRegressionCheck['status'] = 'pass'): RealtimeRegressionCheck {
  return { id, title: `Критерий ${id}`, status, evidence: [`Вывод для ${id}`] };
}
function makeRun(patch: Partial<RealtimeRegressionRun> = {}): RealtimeRegressionRun {
  return { id: 'run', planId: 'plan', planName: 'Проверяемый план', model: 'model', status: 'completed', createdAt: '2026-10-30T00:00:00Z',
    progress: 'Готово', target: 'call_plan', cases: [], checklist: REGRESSION_CHECKLIST.map(([id]) => check(id)), ...patch };
}
function renderReport(run: RealtimeRegressionRun) {
  return renderToStaticMarkup(<RegressionReport run={run} disabled={false} comparison={null} baselineId="" baselines={[]} onBaselineChange={() => {}} onTest={() => {}} />);
}

describe('compact regression report grouping and filters', () => {
  it('renders the twenty trainer checks in the four agreed groups with a trainer-specific saved link', () => {
    const run = makeRun({ target: 'trainer', checklist: TRAINER_TEST_CHECKS.map(([id, title]) => ({ id, title, status: 'review', evidence: [] })) });
    const html = renderReport(run);
    expect(html.match(/class="testing-report-group"/g)).toHaveLength(4);
    for (const title of ['Голос и подача', 'Роль клиента', 'Работа с ответами менеджера', 'Ход тренировки']) expect(html).toContain(title);
    expect(html).toContain('target=trainer'); expect(html).not.toContain('Телефонную сеть и реальные буферы Voximplant');
  });
  it('groups every current criterion exactly once into four sections', () => {
    const items = makeRun().checklist;
    const groups = groupChecks(items);
    expect(groups).toHaveLength(4);
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toHaveLength(items.length);
    expect(new Set(ids).size).toBe(items.length);
    expect(ids.sort()).toEqual(items.map((item) => item.id).sort());
  });
  it('preserves unknown future checks and omits empty groups for targeted runs', () => {
    expect(groupChecks([check('future')])).toEqual([expect.objectContaining({ id: 'other', items: [check('future')] })]);
    expect(groupChecks([check('ending')]).map((group) => group.id)).toEqual(['scenario']);
    expect(groupChecks([])).toEqual([]);
  });
  it('separates review from failure and does not count untested points as problems', () => {
    const items = [check('1', 'pass'), check('2', 'fail'), check('3', 'review'), check('4', 'not_run')];
    expect(countChecks(items)).toEqual({ pass: 1, fail: 1, review: 1, not_run: 1 });
    expect(items.filter((item) => matchesCheckFilter(item, 'attention')).map((item) => item.id)).toEqual(['2', '3']);
    for (const status of ['pass', 'fail', 'review', 'not_run'] as const) expect(items.filter((item) => matchesCheckFilter(item, status))).toEqual([items.find((item) => item.status === status)]);
    expect(items.filter((item) => matchesCheckFilter(item, 'all'))).toEqual(items);
    expect(countChecks([])).toEqual({ pass: 0, fail: 0, review: 0, not_run: 0 });
    expect(timingLabel(0)).toBe('0 мс'); expect(timingLabel(null)).toBe('—');
  });
  it('starts with four compact group headers, not all the evidence unfolded', () => {
    const html = renderReport(makeRun());
    expect(html.match(/class="testing-report-group"/g)).toHaveLength(4);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(html).toContain('Фильтр результатов'); expect(html).toContain('Требуют внимания · 0');
    expect(html).toContain('Сравнение с прошлым тестом');
    expect(html).toContain('Перепроверить только этот пункт');
    expect(html).toContain('ID проверки:'); expect(html).toContain('<code>run</code>');
    expect(html).toContain('/testing?tab=autotesting&amp;runId=run'); expect(html).toContain('Копировать ID');
    expect(fetchAudio).not.toHaveBeenCalled();
  });
  it('opens only one priority group initially and keeps other sections folded', () => {
    const run = makeRun();
    run.checklist = run.checklist.map((item) => ({ ...item, status: item.id === 'ending' || item.id === 'turns' ? 'fail' : 'review' }));
    const html = renderReport(run);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="true"[^>]*>[\s\S]*?Темп и ведение диалога/);
    expect(html).toContain('Требуют внимания: 17');
  });
  it('keeps each check collapsed, with evidence and disabled targeted rerun inside', () => {
    const html = renderToStaticMarkup(<CheckRows items={[check('ending', 'fail')]} disabled onTest={() => {}} />);
    expect(html).not.toContain('open='); expect(html).toContain('Вывод для ending');
    expect(html).toContain('Что проверяем:'); expect(html).toMatch(/<button[^>]*disabled/);
  });
  it('does not announce success for a failed or cancelled series', () => {
    for (const status of ['failed', 'cancelled'] as const) expect(renderReport(makeRun({ status }))).not.toContain('Нет замечаний по проверенным пунктам');
    expect(renderReport(makeRun({ checklist: [] }))).toContain('Есть непроверенные пункты');
  });
  it('shows scenario phase and counts while dialogue and tools stay folded', () => {
    const run = makeRun({ status: 'running', cases: [{ id: 'case', title: 'Сценарий 1', status: 'running', phase: 'dialogue', step: { current: 2, total: 4 }, audioFile: 'private.mp3', checks: [check('ending', 'review')] }] });
    const html = renderToStaticMarkup(<ScenarioResults run={run} disabled onTest={() => {}} />);
    expect(html).toContain('Диалог · шаг 2/4'); expect(html).toContain('Нужно проверить: 1');
    expect(html).toContain('Диалог · 0 реплик'); expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(html).not.toContain('private.mp3'); expect(fetchAudio).not.toHaveBeenCalled();
  });
});

describe('compact run comparison', () => {
  const row = (id: string, change: RealtimeRegressionComparison['rows'][number]['change'], comparable = true) => ({
    id, title: `Проверка ${id}`, before: check(id, 'fail'), after: check(id, 'pass'), change, comparable,
    coverageBefore: ['case'], coverageAfter: ['case'], timingBefore: { samples: 1, medianMs: 1000, p95Ms: 1000 },
    timingAfter: { samples: 1, medianMs: 800, p95Ms: 800 }, medianDeltaMs: -200,
  });
  it('hides unchanged rows by default but keeps changes and comparability warnings', () => {
    const comparison: RealtimeRegressionComparison = { beforeId: 'before', afterId: 'after', warnings: ['Различается профиль'], rows: [row('old', 'unchanged'), row('fixed', 'fixed'), row('different', 'fixed', false)] };
    const html = renderToStaticMarkup(<ComparisonResults comparison={comparison} />);
    expect(html).not.toContain('Проверка old'); expect(html).toContain('Проверка fixed');
    expect(html).toContain('Исправлено: 1 · ухудшилось: 0'); expect(html).toContain('Различается профиль');
    expect(html).toContain('Статус изменился'); expect(html).toContain('Условия отличаются или не подтверждены');
    expect(html).toContain('-200 мс'); expect(html).toContain('Показать без изменений');
  });
  it('explains an empty diff instead of leaving an empty table', () => {
    const html = renderToStaticMarkup(<ComparisonResults comparison={{ beforeId: 'b', afterId: 'a', warnings: [], rows: [row('old', 'unchanged')] }} />);
    expect(html).toContain('Изменений статуса нет'); expect(html).not.toContain('<table');
  });
});
