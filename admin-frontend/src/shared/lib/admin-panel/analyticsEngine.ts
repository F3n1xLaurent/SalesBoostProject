/**
 * Client-side aggregation engine for the Analytics AI Summary.
 *
 * Computes insights, trends, and action items from existing
 * mock data (MOCK_EMPLOYEES, MOCK_AUDITS, MOCK_DEALERSHIPS).
 * No backend calls — pure derived state.
 */

import {
  MOCK_EMPLOYEES,
  MOCK_AUDITS,
  MOCK_DEALERSHIPS,
  COMM_LABELS,
  type EmployeeFullRow,
  type AuditListRow,
  type DealershipRow,
  type CommunicationFlag,
} from './mockData';

/* ────────────────────── Types ────────────────────── */

export type ImpactLevel = 'high' | 'medium' | 'low';
export type Priority = 'P0' | 'P1' | 'P2';

export interface KeyInsight {
  fact: string;
  interpretation: string;
  impact: ImpactLevel;
  delta?: string;
}

export interface ActionItem {
  priority: Priority;
  target: string;
  action: string;
  reason: string;
  expectedEffect: string;
  drillType?: 'employees' | 'dealership' | 'audits';
  drillFilter?: string;
}

export interface SectionInsight {
  fact: string;
  interpretation: string;
  action: string;
  stable?: boolean;
}

export interface AnalyticsSummary {
  keyInsights: KeyInsight[];
  actions: ActionItem[];
  errorsInsight: SectionInsight;
  commInsight: SectionInsight;
  scriptInsight: SectionInsight;
  trendInsight: SectionInsight;
  avgScore: number;
  totalAudits: number;
  failRate: number;
  commBreakdown: { label: string; percent: number; color: string }[];
  topErrors: { error: string; count: number; percent: number }[];
  dealershipComparison: { name: string; score: number; delta: number }[];
  scriptCompliance: { block: string; rate: number }[];
}

/* ────────────────────── Helpers ────────────────────── */

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

/* ────────────────────── Main computation ────────────────────── */

export function computeAnalyticsSummary(): AnalyticsSummary {
  const employees = MOCK_EMPLOYEES;
  const audits = MOCK_AUDITS;
  const dealerships = MOCK_DEALERSHIPS;

  const totalAudits = audits.length;
  const avgScore = totalAudits > 0
    ? Math.round(audits.reduce((s, a) => s + a.totalScore, 0) / totalAudits)
    : 0;

  const failedCount = audits.filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  const failRate = pct(failedCount, totalAudits);

  const lowScoreEmployees = employees.filter((e) => e.aiRating < 50);
  const riskEmployees = employees.filter((e) => e.aiRating >= 50 && e.aiRating < 65);
  const noNextStepPercent = 42;

  const commCounts: Record<CommunicationFlag, number> = { ok: 0, fillers: 0, aggression: 0, profanity: 0, 'low-engagement': 0 };
  for (const e of employees) commCounts[e.communicationFlag]++;
  const totalEmps = employees.length;

  const commBreakdown: AnalyticsSummary['commBreakdown'] = [
    { label: 'Нормальный тон', percent: pct(commCounts.ok, totalEmps), color: '#34D399' },
    { label: 'Паразиты', percent: pct(commCounts.fillers, totalEmps), color: '#FBBF24' },
    { label: 'Слабая вовлечённость', percent: pct(commCounts['low-engagement'], totalEmps), color: '#F59E0B' },
    { label: 'Агрессия', percent: pct(commCounts.aggression, totalEmps), color: '#F87171' },
    { label: 'Ненормативная лексика', percent: pct(commCounts.profanity, totalEmps), color: '#DC2626' },
  ];

  const errorMap = new Map<string, number>();
  for (const e of employees) {
    errorMap.set(e.topMistakeLabel, (errorMap.get(e.topMistakeLabel) || 0) + 1);
  }
  const topErrors = [...errorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([error, count]) => ({ error, count, percent: pct(count, totalEmps) }));

  const worstDealership = [...dealerships].sort((a, b) => a.aiRating - b.aiRating)[0];
  const bestDealership = [...dealerships].sort((a, b) => b.aiRating - a.aiRating)[0];

  const dealershipComparison = dealerships
    .map((d) => ({ name: d.name, score: d.aiRating, delta: d.deltaRating ?? 0 }))
    .sort((a, b) => a.score - b.score);

  const badCommPercent = pct(commCounts.aggression + commCounts.profanity + commCounts.fillers + commCounts['low-engagement'], totalEmps);

  const scriptCompliance = [
    { block: 'Приветствие', rate: 88 },
    { block: 'Выявление потребностей', rate: 62 },
    { block: 'Презентация', rate: 74 },
    { block: 'Работа с возражениями', rate: 55 },
    { block: 'Закрытие / следующий шаг', rate: 48 },
  ];

  /* ── Key insights ── */

  const keyInsights: KeyInsight[] = [
    {
      fact: `Доля проверок без следующего шага — ${noNextStepPercent}%`,
      interpretation: 'Менеджеры не фиксируют визит и теряют лидов',
      impact: 'high',
      delta: '+12% за период',
    },
    {
      fact: `AI-рейтинг «${worstDealership.name}» — ${worstDealership.aiRating}`,
      interpretation: 'Критический уровень, требуется вмешательство',
      impact: worstDealership.aiRating < 50 ? 'high' : 'medium',
      delta: worstDealership.deltaRating !== null ? `${worstDealership.deltaRating > 0 ? '+' : ''}${worstDealership.deltaRating}` : undefined,
    },
    {
      fact: `${lowScoreEmployees.length} сотрудников с рейтингом ниже 50`,
      interpretation: `${pct(lowScoreEmployees.length, totalEmps)}% команды ниже допустимого уровня`,
      impact: lowScoreEmployees.length > 5 ? 'high' : 'medium',
    },
    {
      fact: `Проблемы коммуникации у ${badCommPercent}% сотрудников`,
      interpretation: 'Рост паразитов и агрессии снижает качество сервиса',
      impact: badCommPercent > 30 ? 'high' : badCommPercent > 15 ? 'medium' : 'low',
      delta: '+18% за период',
    },
    {
      fact: `Провальных проверок: ${failRate}%`,
      interpretation: failRate > 10 ? 'Высокая доля — системная проблема' : 'Уровень в пределах нормы',
      impact: failRate > 10 ? 'high' : 'low',
    },
  ];

  /* ── Action items ── */

  const actions: ActionItem[] = [];

  if (noNextStepPercent > 30) {
    actions.push({
      priority: 'P0',
      target: `Сотрудники с рейтингом < 65 (${riskEmployees.length + lowScoreEmployees.length} чел.)`,
      action: 'Назначить тренировку по фиксации визита и следующему шагу',
      reason: `${noNextStepPercent}% проверок без следующего шага`,
      expectedEffect: '+5–10 к рейтингу за 2 недели',
      drillType: 'employees',
      drillFilter: 'training',
    });
  }

  if (worstDealership.aiRating < 50) {
    actions.push({
      priority: 'P0',
      target: `Автосалон «${worstDealership.name}»`,
      action: 'Провести аудит процессов и назначить индивидуальные тренировки',
      reason: `AI-рейтинг ${worstDealership.aiRating} — критический уровень`,
      expectedEffect: 'Вывести рейтинг выше 60 за 3–4 недели',
      drillType: 'dealership',
      drillFilter: worstDealership.id,
    });
  }

  if (badCommPercent > 20) {
    actions.push({
      priority: 'P1',
      target: 'Сотрудники с проблемами коммуникации',
      action: 'Подключить модуль контроля формулировок + тренировка речевого этикета',
      reason: `${badCommPercent}% сотрудников с отклонениями в коммуникации`,
      expectedEffect: 'Снижение жалоб на 20–30%',
      drillType: 'employees',
      drillFilter: 'comm',
    });
  }

  if (failRate > 8) {
    actions.push({
      priority: 'P1',
      target: 'Все сотрудники с провальными проверками',
      action: 'Назначить повторную тренировку по слабым блокам',
      reason: `${failRate}% проверок завершены провалом`,
      expectedEffect: 'Снижение доли провалов до <5%',
      drillType: 'audits',
      drillFilter: 'fails',
    });
  }

  actions.push({
    priority: 'P2',
    target: `Автосалон «${bestDealership.name}»`,
    action: 'Выделить лучшие практики и распространить на другие салоны',
    reason: `AI-рейтинг ${bestDealership.aiRating} — лучший в сети`,
    expectedEffect: 'Повышение среднего по холдингу на 3–5 баллов',
    drillType: 'dealership',
    drillFilter: bestDealership.id,
  });

  /* ── Section insights ── */

  const errorsInsight: SectionInsight = topErrors.length > 0
    ? {
        fact: `Ошибка «${topErrors[0].error}» встречается в ${topErrors[0].percent}% проверок`,
        interpretation: 'Высокий риск потери лидов на этом этапе',
        action: 'Назначить целевую тренировку по этой теме',
      }
    : { fact: 'Нет выраженных ошибок', interpretation: 'Стабильная динамика', action: '', stable: true };

  const commInsight: SectionInsight = badCommPercent > 15
    ? {
        fact: `Проблемы коммуникации у ${badCommPercent}% сотрудников`,
        interpretation: 'Снижение качества клиентского восприятия',
        action: 'Добавить контроль формулировок в тренировки',
      }
    : { fact: `Проблемы коммуникации у ${badCommPercent}%`, interpretation: 'Стабильная динамика, действий не требуется', action: '', stable: true };

  const worstScript = scriptCompliance.reduce((min, b) => b.rate < min.rate ? b : min, scriptCompliance[0]);
  const scriptInsight: SectionInsight = worstScript.rate < 60
    ? {
        fact: `Блок «${worstScript.block}» выполняется только в ${worstScript.rate}% случаев`,
        interpretation: 'Системный пропуск этапа скрипта',
        action: 'Включить обязательный чек на этом этапе',
      }
    : { fact: 'Соблюдение скрипта в пределах нормы', interpretation: 'Стабильная динамика, действий не требуется', action: '', stable: true };

  const trendInsight: SectionInsight = worstDealership.deltaRating !== null && worstDealership.deltaRating < -5
    ? {
        fact: `«${worstDealership.name}» потерял ${Math.abs(worstDealership.deltaRating)} баллов за период`,
        interpretation: 'Наиболее быстрое снижение в сети',
        action: 'Провести аудит и назначить план восстановления',
      }
    : { fact: 'Динамика без выраженных аномалий', interpretation: 'Стабильная динамика, действий не требуется', action: '', stable: true };

  return {
    keyInsights,
    actions,
    errorsInsight,
    commInsight,
    scriptInsight,
    trendInsight,
    avgScore,
    totalAudits,
    failRate,
    commBreakdown,
    topErrors,
    dealershipComparison,
    scriptCompliance,
  };
}
