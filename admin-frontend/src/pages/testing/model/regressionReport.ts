import type { RealtimeRegressionCheck } from '../../../shared/api/adminPanel';
import { TRAINER_TEST_GROUPS } from '../../../../../src/testing/trainerTestCatalog';

export const checkStatusLabels = { pass: 'Пройдено', fail: 'Ошибка', review: 'Нужно проверить', not_run: 'Не проверено' };
export type CheckFilter = 'all' | 'attention' | RealtimeRegressionCheck['status'];
export const checkGroups = [
  { id: 'connection', title: 'Начало и качество связи', description: 'IVR, слышимость и произношение', checks: ['automation', 'audio', 'pronunciation'] },
  { id: 'conversation', title: 'Темп и ведение диалога', description: 'Паузы, перебивания и развёрнутые ответы', checks: ['turns', 'interruption', 'long-answer', 'loops'] },
  { id: 'understanding', title: 'Понимание и легенда', description: 'Контекст, ответы на вопросы и непротиворечивость', checks: ['identity', 'legend', 'changes', 'relevance', 'answers', 'questions'] },
  { id: 'scenario', title: 'Сценарий и завершение', description: 'Порядок разговора, нестандартные ситуации и прощание', checks: ['situations', 'script', 'technical', 'ending'] },
];
export function countChecks(items: RealtimeRegressionCheck[]) {
  return items.reduce((counts, item) => { counts[item.status] += 1; return counts; }, { pass: 0, fail: 0, review: 0, not_run: 0 });
}
export function matchesCheckFilter(item: RealtimeRegressionCheck, filter: CheckFilter) {
  return filter === 'all' || (filter === 'attention' ? item.status === 'fail' || item.status === 'review' : item.status === filter);
}
export function groupChecks(items: RealtimeRegressionCheck[]) {
  const groups = [...checkGroups, ...TRAINER_TEST_GROUPS];
  const known = new Set(groups.flatMap((group) => group.checks));
  return [
    ...groups.map((group) => ({ ...group, items: items.filter((item) => (group.checks as string[]).includes(item.id)) })),
    { id: 'other', title: 'Другие проверки', description: 'Дополнительные критерии', checks: [], items: items.filter((item) => !known.has(item.id)) },
  ].filter((group) => group.items.length > 0);
}
export const timingLabel = (value: number | null) => value == null ? '—' : `${value} мс`;
