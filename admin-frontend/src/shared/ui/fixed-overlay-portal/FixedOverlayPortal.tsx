import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll, unlockBodyScroll } from '../../lib/body-scroll-lock';

type Props = {
  children: React.ReactNode;
};

export function FixedOverlayPortal({ children }: Props) {
  useEffect(() => {
    lockBodyScroll();
    return () => {
      unlockBodyScroll();
    };
  }, []);

  return createPortal(
    <div className="theme-brutal">
      {children}
    </div>,
    document.body,
  );
}
