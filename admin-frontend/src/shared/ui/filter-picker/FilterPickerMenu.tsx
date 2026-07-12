import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  role?: string;
  menuClassName?: string;
  zIndex?: number;
};

export function FilterPickerMenu(props: Props) {
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!props.open || !props.anchorRef.current) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = () => {
      const anchor = props.anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setMenuStyle({
        position: 'fixed',
        top: rect.bottom + 6,
        left: rect.left,
        minWidth: rect.width,
        zIndex: props.zIndex ?? 1200,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [props.open, props.anchorRef, props.zIndex]);

  if (!props.open || !menuStyle) return null;

  return createPortal(
    <div
      className={['theme-brutal', 'sa-tag-filter-menu', 'sa-tag-filter-menu--portal', props.menuClassName].filter(Boolean).join(' ')}
      style={menuStyle}
      role={props.role}
    >
      {props.children}
    </div>,
    document.body,
  );
}
