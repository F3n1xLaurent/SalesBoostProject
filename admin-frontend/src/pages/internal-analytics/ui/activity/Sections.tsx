import React from 'react';
import { Panel, number } from './shared';
import type { ActivityResponse } from './types';
export function Sections({ data }: {
  data: ActivityResponse['sections'];
}) {
  return <Panel title="Разделы" help="Уникальные аккаунты роли, открывшие раздел за период; детальные страницы относятся к разделу своего списка."><div className="av-two">{([['leaders', 'Руководители'], ['employees', 'Сотрудники']] as const).map(([key, label]) => <div key={key}><h3>{label}</h3><div className="av-section-bars">{data[key].map(item => <div key={item.section}><span>{item.label}</span><div className="av-track"><span style={{ width: `${data[key][0]?.people ? item.people / data[key][0].people * 100 : 0}%` }} /></div><strong>{number(item.people)}</strong></div>)}</div></div>)}</div></Panel>;
}
