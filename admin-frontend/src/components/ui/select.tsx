import React from 'react';
import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
export function Select({ value, onValueChange, disabled, label, items }: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  items: {
    value: string;
    label: string;
  }[];
}) {
  return <label className="av-select-label"><span>{label}</span><Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}><Primitive.Trigger className="av-select" aria-label={label}><Primitive.Value /><Primitive.Icon><ChevronDown size={15} /></Primitive.Icon></Primitive.Trigger><Primitive.Portal><Primitive.Content className="av-select-content" position="popper" sideOffset={5}><Primitive.Viewport>{items.map(item => <Primitive.Item className="av-select-item" key={item.value} value={item.value}><Primitive.ItemText>{item.label}</Primitive.ItemText><Primitive.ItemIndicator><Check size={14} /></Primitive.ItemIndicator></Primitive.Item>)}</Primitive.Viewport></Primitive.Content></Primitive.Portal></Primitive.Root></label>;
}
