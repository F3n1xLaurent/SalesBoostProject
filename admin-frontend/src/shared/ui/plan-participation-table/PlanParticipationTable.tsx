import React from 'react';
import type { AnalyticsPlanParticipation } from '../../api/adminPanel';

type Variant = 'dealership' | 'employee';

type Props = {
  plans: AnalyticsPlanParticipation[];
  excludingPlanId: string | null;
  onOpenPlan: (id: string) => void;
  onExcludePlan: (plan: AnalyticsPlanParticipation) => void;
  readOnly?: boolean;
  variant?: Variant;
};

function planFrequencyLabel(value: AnalyticsPlanParticipation['frequency']): string {
  if (value === 'manual') return 'Вручную';
  return value === 'weekly' ? 'Еженедельно' : 'Ежедневно';
}

function planTargetLabel(plan: AnalyticsPlanParticipation, variant: Variant): string {
  if (variant === 'employee') {
    return plan.targetMatch === 'dealership' ? 'Через расписание точки' : 'Лично в расписании';
  }
  if (plan.targetMatch === 'dealership') return 'Точка целиком';
  return plan.targetsCount === 1 ? '1 сотрудник точки' : `${plan.targetsCount} сотрудников точки`;
}

function planCallTimeLabel(plan: AnalyticsPlanParticipation): string {
  if (plan.frequency === 'manual') return '—';
  return `${plan.callTimeFrom}–${plan.callTimeTo}`;
}

function planLastRunLabel(plan: AnalyticsPlanParticipation): string {
  if (!plan.lastInitiatedAt) return '—';
  return new Date(plan.lastInitiatedAt).toLocaleDateString('ru-RU');
}

function canExcludePlan(plan: AnalyticsPlanParticipation, variant: Variant): boolean {
  if (variant === 'employee' && plan.targetMatch === 'dealership') return false;
  return true;
}

function excludePlanTitle(plan: AnalyticsPlanParticipation, variant: Variant): string | undefined {
  if (variant === 'employee' && plan.targetMatch === 'dealership') {
    return 'Менеджер участвует через расписание всей точки. Откройте настройки плана.';
  }
  return undefined;
}

export function PlanParticipationTable({
  plans,
  excludingPlanId,
  onOpenPlan,
  onExcludePlan,
  readOnly = false,
  variant = 'dealership',
}: Props) {
  if (plans.length === 0) {
    return (
      <div className="sa-table-wrap sa-plan-participation-table">
        <div className="sa-table-empty">Нет активных расписаний</div>
      </div>
    );
  }

  return (
    <div className="sa-table-wrap sa-plan-participation-table">
      <table className="sa-table">
        <thead>
          <tr>
            <th>Расписание</th>
            <th>Охват</th>
            <th>Периодичность</th>
            <th>Время</th>
            <th>Последний запуск</th>
            {!readOnly && <th className="sa-text-right sa-plan-participation-actions-col">Действия</th>}
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => {
            const excludeDisabled = !canExcludePlan(plan, variant) || excludingPlanId === plan.id;
            return (
              <tr key={plan.id}>
                <td style={{ fontWeight: 650 }}>{plan.name}</td>
                <td>{planTargetLabel(plan, variant)}</td>
                <td>{planFrequencyLabel(plan.frequency)}</td>
                <td className="sa-table-mono">{planCallTimeLabel(plan)}</td>
                <td className="sa-table-mono">{planLastRunLabel(plan)}</td>
                {!readOnly && (
                  <td className="sa-text-right sa-plan-participation-actions-col">
                    <div className="sa-plan-participation-actions">
                      <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => onOpenPlan(plan.id)}>
                        Настроить
                      </button>
                      <button
                        type="button"
                        className="sa-btn-outline sa-btn-sm"
                        disabled={excludeDisabled}
                        title={excludePlanTitle(plan, variant)}
                        onClick={() => onExcludePlan(plan)}
                      >
                        {excludingPlanId === plan.id ? 'Исключаем...' : 'Исключить'}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
