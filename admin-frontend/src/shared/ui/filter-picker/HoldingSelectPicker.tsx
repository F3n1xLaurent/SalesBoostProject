import { useMemo } from 'react';
import { SingleSelectFilterPicker } from './SingleSelectFilterPicker';

type HoldingOption = {
  id: string;
  name: string;
};

type Props = {
  holdings: HoldingOption[];
  value: string;
  onChange: (holdingId: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  compact?: boolean;
};

export function HoldingSelectPicker(props: Props) {
  const options = useMemo(
    () => props.holdings.map((holding) => ({ value: holding.id, label: holding.name })),
    [props.holdings],
  );

  const isDisabled = props.disabled || props.loading || props.holdings.length === 0;

  return (
    <div className="sa-tag-filter-picker-wrap">
      <SingleSelectFilterPicker
        options={options}
        value={props.value}
        onChange={props.onChange}
        disabled={isDisabled}
        compact={props.compact}
        placeholder={props.holdings.length === 0 ? (props.emptyLabel ?? 'Нет компаний') : (props.placeholder ?? 'Компания')}
      />
    </div>
  );
}
