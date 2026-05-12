import React from 'react';

export type ViewMode = 'ceo' | 'hr' | 'operations';

type Props = {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
};

export function ViewModeToggle({ value, onChange }: Props) {
  return (
    <div className="sa-view-toggle">
      <button
        type="button"
        className={value === 'ceo' ? 'active' : ''}
        onClick={() => onChange('ceo')}
      >
        CEO View
      </button>
      <button
        type="button"
        className={value === 'hr' ? 'active' : ''}
        onClick={() => onChange('hr')}
      >
        HR View
      </button>
      <button
        type="button"
        className={value === 'operations' ? 'active' : ''}
        onClick={() => onChange('operations')}
      >
        Operations View
      </button>
    </div>
  );
}
