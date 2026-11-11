import React from 'react';
import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { ChartContainer } from '../../../../components/ui/chart';
import { Panel } from './shared';
import type { ActivityResponse } from './types';
export function DailyActive({ data }: {
  data: ActivityResponse['dailyActive'];
}) {
  return <Panel title="Активные люди по дням" help={`Уникальные аккаунты с действиями пользователя за ${data.granularity === 'week' ? 'неделю' : 'день'} по Москве, отдельно по ролям.`}><ChartContainer label="Активные сотрудники и руководители"><ComposedChart data={data.points} margin={{ top: 12, right: 12, bottom: 0, left: -22 }}><defs><linearGradient id="av-activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#606c47" stopOpacity={0.22} /><stop offset="100%" stopColor="#606c47" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e8e8e2" /><XAxis dataKey="date" tickFormatter={date => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' }).format(new Date(`${date}T12:00:00+03:00`))} minTickGap={32} tickLine={false} axisLine={false} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} /><Tooltip labelFormatter={date => `${data.granularity === 'week' ? 'Неделя с ' : ''}${date}`} /><Legend /><Area name="Сотрудники" dataKey="employees" stroke="#606c47" fill="url(#av-activity-fill)" strokeWidth={2} /><Line name="Руководители" dataKey="leaders" stroke="#b37845" strokeWidth={2} strokeDasharray="5 5" dot={false} /></ComposedChart></ChartContainer></Panel>;
}
