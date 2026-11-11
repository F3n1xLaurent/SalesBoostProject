import React from 'react';
import { ResponsiveContainer } from 'recharts';
export function ChartContainer({ children, label, height = 240 }: {
  children: React.ComponentProps<typeof ResponsiveContainer>['children'];
  label: string;
  height?: number;
}) {
  return <div className="av-chart" role="img" aria-label={label} style={{ height }}><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;
}
