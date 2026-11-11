import React from 'react';
import { Table } from '../../../../components/ui/table';
import { Panel, SmallMetric, number } from './shared';
import type { ActivityResponse, RoleBlock } from './types';
function Role({ title, data, reports }: {
  title: string;
  data: RoleBlock;
  reports?: ActivityResponse['roles']['employees']['reports'];
}) {
  return <Panel title={title} help="Люди считаются по уникальным аккаунтам, только по действиям пользователя."><div className="av-metrics av-metrics-three"><SmallMetric label="Активные" value={<>{number(data.active)} <small>/ {number(data.total)}</small></>} help="Уникальные активные аккаунты роли / все активные аккаунты роли в выбранной области." /><SmallMetric label="Не заходили" value={number(data.notVisited)} help="Все активные аккаунты роли минус аккаунты с действием за период." /><SmallMetric label="Дней с активностью в неделю" value={number(data.activeDaysPerWeek, 1)} help="Сумма активных дней по Москве, делённая на число активных людей и число недель периода." /></div><h3>Функции</h3><Table><thead><tr><th>Функция</th><th>Людей</th><th>Действий</th></tr></thead><tbody>{data.features.map(item => <tr key={item.key}><td>{item.label}</td><td>{number(item.people)}</td><td>{number(item.actions)}</td></tr>)}</tbody></Table>{reports && <><h3>Отчёты, людей</h3><Table><thead><tr><th>Действие</th><th>Тренировка</th><th>Звонок</th></tr></thead><tbody>{([['viewed', 'Открыли'], ['findings', 'Раскрыли ключевые находки'], ['recommendations', 'Раскрыли рекомендации']] as const).map(([key, label]) => <tr key={key}><td>{label}</td><td>{number(reports[key].training)}</td><td>{number(reports[key].call)}</td></tr>)}</tbody></Table></>}</Panel>;
}
export function Roles({ data }: {
  data: ActivityResponse['roles'];
}) { return <div className="av-two"><Role title="Руководители" data={data.leaders} /><Role title="Сотрудники" data={data.employees} reports={data.employees.reports} /></div>; }
