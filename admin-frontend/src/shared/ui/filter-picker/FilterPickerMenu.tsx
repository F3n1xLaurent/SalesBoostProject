import React, { useLayoutEffect, useRef, useState } from 'react';

type Props = {
  open: boolean;
  children: React.ReactNode;
  role?: string;
  menuClassName?: string;
  zIndex?: number;
};

export function FilterPickerMenu(props: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [maxHeight, setMaxHeight] = useState(260);

  useLayoutEffect(() => {
    if (!props.open) return undefined;

    const updatePlacement = () => {
      const menu = menuRef.current;
      const anchor = menu?.parentElement;
      if (!menu || !anchor) return;

      const anchorRect = anchor.getBoundingClientRect();
      const viewportMargin = 8;
      const menuGap = 6;
      const availableBelow = window.innerHeight - anchorRect.bottom - menuGap - viewportMargin;
      const availableAbove = anchorRect.top - menuGap - viewportMargin;
      const desiredHeight = Math.min(menu.scrollHeight, 260);
      const openAbove = availableBelow < desiredHeight && availableAbove > availableBelow;
      const availableHeight = openAbove ? availableAbove : availableBelow;

      setPlacement(openAbove ? 'above' : 'below');
      setMaxHeight(Math.max(64, Math.min(260, availableHeight)));
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div
      ref={menuRef}
      className={[
        'sa-tag-filter-menu',
        placement === 'above' ? 'sa-tag-filter-menu--above' : '',
        props.menuClassName,
      ].filter(Boolean).join(' ')}
      role={props.role}
      style={{ zIndex: props.zIndex, maxHeight }}
    >
      {props.children}
    </div>
  );
}
