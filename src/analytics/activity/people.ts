import { dayKey, unique } from './config';
import type { Event, Person, RoleBlock } from './types';
export const LEADER_FEATURES = [
  ['analytics_opened', 'Аналитика'], ['company_viewed', 'Карточка компании'], ['employee_viewed', 'Карточка сотрудника'], ['branch_viewed', 'Карточка точки'], ['comparison_used', 'Сравнение'], ['report_viewed:call', 'Отчёт по звонку'], ['report_viewed:training', 'Отчёт по тренировке'], ['branch_recommendation_opened', 'Открыли AI-рекомендацию по точке'],
];
export const LEADER_SECTIONS = [['dashboard', 'Дашборд'], ['analytics', 'Аналитика'], ['companies', 'Компании'], ['branches', 'Точки'], ['employees', 'Сотрудники'], ['audits', 'Проверки'], ['data', 'Данные'], ['checklists', 'Чек-листы'], ['branch_directions', 'Направления точек'], ['number_types', 'Типы номеров'], ['call_settings', 'Настройки обзвона'], ['billing', 'Биллинг']];
export const EMPLOYEE_SECTIONS = [['profile', 'Профиль'], ['trainer', 'Тренажёр']];
export function roleBlock(events: Event[], people: Person[], period: number, employee: boolean): RoleBlock {
  const matching = events.filter(item => (item.role === 'employee') === employee);
  const active = unique(matching.map(item => item.accountId));
  const total = unique(people.filter(item => (item.role === 'employee') === employee).map(item => item.accountId));
  const features = employee ? [['trainer_opened', 'Тренажёр']] : LEADER_FEATURES;
  return {
    active, total, notVisited: Math.max(0, total - active),
    activeDaysPerWeek: active ? unique(matching.map(item => `${item.accountId}:${item.date}`)) / active / (period / 7) : null,
    features: features.map(([key, label]) => {
      const [name, report] = key.split(':');
      const rows = matching.filter(item => item.eventName === name && (!report || item.reportType === report));
      return { key, label, people: unique(rows.map(item => item.accountId)), actions: rows.reduce((sum, item) => sum + item.actions, 0) };
    }),
  };
}
export function sectionUsage(events: Event[], employee: boolean) {
  return (employee ? EMPLOYEE_SECTIONS : LEADER_SECTIONS).map(([section, label]) => ({ section, label, people: unique(events.filter(item => (item.role === 'employee') === employee && item.eventName === 'page_viewed' && item.section === section).map(item => item.accountId)) })).sort((a, b) => b.people - a.people);
}
export function reportUsage(events: Event[]) {
  const result = {} as Record<'viewed' | 'findings' | 'recommendations', {
    training: number;
    call: number;
  }>;
  for (const [key, name] of [['viewed', 'report_viewed'], ['findings', 'report_findings_opened'], ['recommendations', 'report_recommendations_opened']] as const) {
    result[key] = { training: 0, call: 0 };
    for (const type of ['training', 'call'] as const)
      result[key][type] = unique(events.filter(item => item.role === 'employee' && item.eventName === name && item.reportType === type).map(item => item.accountId));
  }
  return result;
}
export function withTrainingActivity(events: Event[], trainings: import('./types').Training[]): Event[] {
  // Start facts supplement legacy missing events without counting a second action in feature tables.
  return [...events, ...trainings.map(item => ({ accountId: item.accountId, role: 'employee' as const, companyId: item.companyId, branchId: item.branchId, eventName: '_training_activity', date: dayKey(item.startedAt), reportType: null, section: null, actions: 0, lastAt: item.startedAt }))];
}
