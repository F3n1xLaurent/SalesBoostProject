import React from 'react';
import { Card } from '../../../../components/ui/card';
import { Formula } from '../../../../components/ui/tooltip';
import { activityDate, nsFormula, number, percent, signed, StatusBadge } from './shared';
import type { ActivityResponse } from './types';
export function Kpis({ data }: {
  data: ActivityResponse;
}) {
  const { kpis: k, scope, periodDays } = data;
  const count = (value: {
    value: number;
    total: number;
  }) => <>{number(value.value)} <small>/ {number(value.total)}</small></>;
  const items = [
    { label: scope.view === 'branch' ? 'Статус точки' : scope.view === 'company' ? 'Активные точки' : 'Активные компании', value: k.activeEntities ? count(k.activeEntities) : k.branchStatus ? <StatusBadge status={k.branchStatus.status} /> : '—', delta: k.activeEntities?.delta, sub: k.branchStatus ? activityDate(k.branchStatus.lastActionAt) : undefined, help: 'Хотя бы один руководитель или сотрудник совершил действие за выбранный период; статус точки определяется последним действием за всю историю.' },
    { label: 'Активные руководители', value: count(k.activeLeaders), delta: k.activeLeaders.delta, help: 'Уникальные аккаунты руководителей с действием пользователя за период; после дроби — все активные аккаунты этой роли.' },
    { label: 'Активные сотрудники', value: count(k.activeEmployees), delta: k.activeEmployees.delta, help: 'Уникальные аккаунты сотрудников с действием пользователя или начатой тренировкой за период; звонок бота не считается активностью.' },
    { label: 'Дозвон', value: <>{percent(k.answerRate.rate)} <small>{number(k.answerRate.connected)} / {number(k.answerRate.launched)}</small></>, delta: k.answerRate.deltaPp, unit: 'п.п.', help: 'Число звонков с заполненным connectedAt делим на все запущенные звонки, кроме демо.' },
    { label: 'North Star · рост качества', value: <>{signed(k.northStar.value)} <small>баллов</small></>, delta: k.northStar.delta, unit: 'балл.', sub: k.northStar.value === null ? 'Нужно 20 звонков для базы и 10 за последние 30 дней' : undefined, help: nsFormula },
  ];
  return <div className="av-kpis">{items.map(item => <Card key={item.label} className="av-kpi"><div className="av-kpi-label">{item.label}<Formula>{item.help}</Formula></div><div className="av-kpi-value">{item.value}</div>{item.sub ? <p className="av-muted">{item.sub}</p> : <p className={item.delta == null || Math.round(item.delta) === 0 ? 'av-muted' : item.delta > 0 ? 'av-positive' : 'av-negative'}>{signed(item.delta)} {item.unit} <span>к прошлым {periodDays} дням</span></p>}</Card>)}</div>;
}
