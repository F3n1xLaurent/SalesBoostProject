import React, { useMemo, useState } from 'react';
import { Table } from '../../../../components/ui/table';
import { Formula } from '../../../../components/ui/tooltip';
import { Panel, StatusBadge, activityDate, number, percent, signed } from './shared';
import type { ActivityResponse } from './types';
type Row = ActivityResponse['table']['rows'][number];
export function EntitiesTable({ data, companyName, onSelect }: {
  data: ActivityResponse['table'];
  companyName?: string;
  onSelect: (id: string) => void;
}) {
  const [sort, setSort] = useState<{
    key: string;
    ascending: boolean;
  } | null>(null);
  const rows = useMemo(() => {
    if (!sort)
      return data.rows;
    const value = (row: Row): string | number => sort.key === 'northStar' ? row.northStar.value ?? -Infinity : sort.key === 'status' ? ['active', 'fading', 'inactive', 'not_started'].indexOf(row.status) : (row as unknown as Record<string, string | number>)[sort.key] ?? -Infinity;
    return [...data.rows].sort((a, b) => { const av = value(a), bv = value(b); return (typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv, 'ru') : Number(av) - Number(bv)) * (sort.ascending ? 1 : -1); });
  }, [data.rows, sort]);
  const columns = [
    ['name', data.kind === 'companies' ? 'Компания' : 'Точка', 'Название компании или точки.'], ['status', 'Статус', 'Последнее действие: до 7 дней — активна, 8–14 — затихает, больше 14 — неактивна; без действий — не начала.'],
    [data.kind === 'companies' ? 'branchesCount' : 'employeesTotal', data.kind === 'companies' ? 'Точки' : 'Сотрудников', 'Число неудалённых точек компании или активных аккаунтов сотрудников точки.'], ['activeLeaders', 'Акт. руководители', 'Уникальные аккаунты руководителей с действием за период.'], ['activeEmployees', 'Акт. сотрудники', 'Уникальные аккаунты сотрудников с действием за период.'], ['callsLaunched', 'Звонки', 'Все запущенные звонки, кроме демо.'], ['answerRate', 'Дозвон', 'Звонки с connectedAt, делённые на все запущенные звонки.'], ['trainingsStarted', 'Тренировки', 'Все начатые тренировки сотрудников за период.'], ['northStar', 'Рост качества', 'Рост качества к базовому уровню; нужно 20 базовых и 10 последующих звонков по одному скрипту.'], ['lastActionAt', 'Активность', 'Последнее действие пользователя за всю историю.'],
  ];
  return <Panel title={data.kind === 'companies' ? 'Компании' : `Точки${companyName ? ` · ${companyName}` : ''}`} help="Показатели за выбранный период; статус и последняя активность — на сегодня."><Table><thead><tr>{columns.map(([key, label, help]) => <th key={key} aria-sort={sort?.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => setSort({ key, ascending: sort?.key === key ? !sort.ascending : true })}>{label}{sort?.key === key ? sort.ascending ? ' ↑' : ' ↓' : ''}</button><Formula>{help}</Formula></th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} onClick={() => onSelect(row.id)}><td><button className="av-entity-link" type="button" onClick={event => { event.stopPropagation(); onSelect(row.id); }}>{row.name}</button></td><td><StatusBadge status={row.status} /></td><td>{number(data.kind === 'companies' ? row.branchesCount : row.employeesTotal)}</td><td>{number(row.activeLeaders)}</td><td>{number(row.activeEmployees)}</td><td>{number(row.callsLaunched)}</td><td>{percent(row.answerRate)}</td><td>{number(row.trainingsStarted)}</td><td className={row.northStar.value === null ? 'av-muted' : row.northStar.value >= 5 ? 'av-positive' : row.northStar.value <= -5 ? 'av-negative' : ''}>{row.northStar.value === null ? 'мало звонков' : signed(row.northStar.value)}</td><td className="av-muted">{activityDate(row.lastActionAt)}</td></tr>)}{!rows.length && <tr><td colSpan={10} className="av-empty">Нет компаний или точек в выбранной области</td></tr>}</tbody></Table></Panel>;
}
