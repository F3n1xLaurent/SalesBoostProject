import React from 'react';
import * as Primitive from '@radix-ui/react-toggle-group';
export function ToggleGroup({ value, onValueChange }: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return <Primitive.Root className="av-period" type="single" value={value} onValueChange={v => {
    if (v)
      onValueChange(v);
  }} aria-label="Период аналитики">{['7', '30', '90'].map(v => <Primitive.Item key={v} value={v}>{v} дней</Primitive.Item>)}</Primitive.Root>;
}
