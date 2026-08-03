import React from 'react';

type Props = {
  open: boolean;
  children: React.ReactNode;
  role?: string;
  menuClassName?: string;
  zIndex?: number;
};

export function FilterPickerMenu(props: Props) {
  if (!props.open) return null;

  return (
    <div
      className={['sa-tag-filter-menu', props.menuClassName].filter(Boolean).join(' ')}
      role={props.role}
      style={props.zIndex ? { zIndex: props.zIndex } : undefined}
    >
      {props.children}
    </div>
  );
}
