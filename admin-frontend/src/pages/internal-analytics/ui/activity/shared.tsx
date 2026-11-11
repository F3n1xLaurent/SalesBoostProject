import React from 'react';
import { Card, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Formula } from '../../../../components/ui/tooltip';
import { Badge } from '../../../../components/ui/badge';
export const number = (value: number | null | undefined, digits = 0) => value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export const signed = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${number(Math.round(value))}`;
export const percent = (value: number | null | undefined) => value == null ? '—' : `${number(value)}%`;
export const duration = (value: number | null) => value === null ? '—' : `${Math.floor(Math.round(value) / 60)}:${String(Math.round(value) % 60).padStart(2, '0')}`;
export const statusLabels = { active: 'Активна', fading: 'Затихает', inactive: 'Неактивна', not_started: 'Не начала' } as const;
export const nsFormula = 'Первые 20 завершённых звонков точки по каждому скрипту — база; сравниваем с минимум 10 последующими звонками за последние 30 дней, точки имеют равный вес.';
export function StatusBadge({ status }: {
  status: keyof typeof statusLabels;
}) { return <Badge variant={status === 'active' ? 'default' : status === 'fading' ? 'secondary' : 'outline'}>{statusLabels[status]}</Badge>; }
export function activityDate(value: string | null) {
  if (!value)
    return '—';
  const moscow = (d: Date) => new Date(d.getTime() + 10800000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(moscow(new Date())) - Date.parse(moscow(new Date(value)))) / 86400000);
  return days <= 0 ? 'сегодня' : days === 1 ? 'вчера' : `${days} дней назад`;
}
export function Panel({ title, help, children, className = '' }: {
  title: string;
  help: string;
  children: React.ReactNode;
  className?: string;
}) { return <Card className={className}><CardHeader><CardTitle>{title}</CardTitle><Formula>{help}</Formula></CardHeader>{children}</Card>; }
export function SmallMetric({ label, value, help }: {
  label: string;
  value: React.ReactNode;
  help: string;
}) { return <div className="av-small-metric"><span>{label}<Formula>{help}</Formula></span><strong>{value}</strong></div>; }
export function Breakdown({ items }: {
  items: {
    label: string;
    count: number;
    color: string;
  }[];
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return <div className="av-breakdown"><div className="av-stack" aria-label={items.map(item => `${item.label}: ${item.count}`).join(', ')}>{items.map(item => <span key={item.label} style={{ width: `${total ? item.count / total * 100 : 0}%`, background: item.color }} />)}</div><div className="av-legend">{items.map(item => <span key={item.label}><i style={{ background: item.color }} />{item.label}<strong>{number(item.count)}</strong></span>)}</div></div>;
}
